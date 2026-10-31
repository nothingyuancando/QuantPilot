from __future__ import annotations

import asyncio
from datetime import date
from unittest.mock import AsyncMock

import pytest

from quantpilot_market_data.contracts.analytics import AShareScreenerResponse
from quantpilot_market_data.repositories import screener
from quantpilot_market_data.repositories.screener import (
    _is_known_tradable,
    _screener_coverage,
)


def test_screener_requires_explicit_safe_tri_state() -> None:
    safe = {
        "latest_trade_status": "1",
        "latest_is_st": False,
        "latest_limit_up": False,
        "latest_limit_down": False,
    }
    assert _is_known_tradable(safe)
    for field in (
        "latest_trade_status",
        "latest_is_st",
        "latest_limit_up",
        "latest_limit_down",
    ):
        candidate = dict(safe)
        candidate[field] = None
        assert not _is_known_tradable(candidate)


def test_screener_rejects_explicit_risk_flags() -> None:
    base = {
        "latest_trade_status": "normal",
        "latest_is_st": False,
        "latest_limit_up": False,
        "latest_limit_down": False,
    }
    for field in ("latest_is_st", "latest_limit_up", "latest_limit_down"):
        candidate = dict(base)
        candidate[field] = True
        assert not _is_known_tradable(candidate)
    assert not _is_known_tradable({**base, "latest_trade_status": "0"})


def test_screener_reports_full_pool_coverage_and_exclusions() -> None:
    target_date = date(2026, 6, 15)
    safe = {
        "symbol": "600519.SH",
        "code": "600519",
        "name": "贵州茅台",
        "exchange": "SH",
        "latest_trade_date": target_date,
        "sample_count": 60,
        "latest_close": 1500,
        "latest_trade_status": "1",
        "latest_is_st": False,
        "latest_limit_up": False,
        "latest_limit_down": False,
    }
    missing_safety = {
        **safe,
        "symbol": "000001.SZ",
        "code": "000001",
        "latest_trade_status": None,
        "latest_is_st": None,
        "latest_limit_up": None,
        "latest_limit_down": None,
    }
    explicit_risk = {
        **safe,
        "symbol": "600000.SH",
        "code": "600000",
        "latest_is_st": True,
    }

    eligible, reasons, complete, coverage_pct, warning = _screener_coverage(
        [safe, missing_safety, explicit_risk],
        total_symbols=3,
        target_trade_date=target_date,
    )

    assert [row["symbol"] for row in eligible] == ["600519.SH"]
    assert complete == 2
    assert coverage_pct == 66.67
    assert reasons["missing_trade_status"] == 1
    assert reasons["missing_is_st"] == 1
    assert reasons["missing_limit_up"] == 1
    assert reasons["missing_limit_down"] == 1
    assert reasons["is_st"] == 1
    assert warning is not None
    assert "2/3" in warning


def test_screener_response_scanned_symbols_is_total_pool() -> None:
    response = AShareScreenerResponse(
        universe_id="test",
        scanned_symbols=5,
        total_symbols=298,
        eligible_symbols=5,
        excluded_reasons={"missing_is_st": 293},
        safety_complete_symbols=5,
        safety_coverage_pct=1.68,
        coverage_warning="覆盖不足",
    )

    assert response.scanned_symbols == 298
    assert response.total_symbols == 298
    assert response.eligible_symbols == 5
    assert response.excluded_symbols == 293
    assert response.data_quality.status == "warning"


@pytest.mark.parametrize("clickhouse", [False, True])
def test_scoped_screener_filters_before_limit_and_does_not_leak_cache(
    monkeypatch: pytest.MonkeyPatch, clickhouse: bool,
) -> None:
    target = date(2026, 6, 15)
    symbols = ["600519.SH", "000001.SZ"]
    members = [
        {"symbol": symbol, "code": symbol[:6], "name": symbol,
         "exchange": symbol[-2:], "security_metadata": {}}
        for symbol in symbols
    ]
    features = [
        {**member, "latest_trade_date": target, "sample_count": 60,
         "latest_close": 20, "latest_open": 19, "previous_close": 19,
         "latest_amount": 300_000_000, "avg_amount_20d": 100_000_000,
         "latest_turnover": 3, "latest_change_percent": 10 - index,
         "ma5": 19, "ma10": 18, "ma20": 17, "ma30": 16, "ma60": 15,
         "close_20d": 15, "latest_trade_status": "1", "latest_is_st": False,
         "latest_limit_up": False, "latest_limit_down": False}
        for index, member in enumerate(members)
    ]

    class Cursor:
        query = ""

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def execute(self, query, _params):
            self.query = query

        async def fetchone(self):
            return {"trade_date": target}

        async def fetchall(self):
            return features if "WITH universe_config" in self.query else members

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def cursor(self, **_kwargs):
            return Cursor()

    monkeypatch.setattr(screener, "connect", AsyncMock(return_value=Connection()))
    monkeypatch.setattr(screener, "is_clickhouse_enabled", lambda: clickhouse)
    monkeypatch.setattr(screener, "query_screener_feature_rows",
                        AsyncMock(return_value=(target, features)))
    redis: dict[str, dict] = {}

    async def read(key):
        return redis.get(key)

    async def write(key, *, ttl_seconds, payload):
        redis[key] = payload

    monkeypatch.setattr(screener._SCREENER_REDIS_CACHE, "read", read)
    monkeypatch.setattr(screener._SCREENER_REDIS_CACHE, "write", write)
    monkeypatch.setattr(screener, "_SCREENER_CACHE", {})
    monkeypatch.setattr(screener, "_SCREENER_TRADE_DATE_CACHE", {})

    async def run():
        # A global top-1 cache must not mask the lower-ranked watchlist member.
        global_result = await screener.screen_a_share_short_term_candidates(
            trade_date=target, limit=1,
        )
        assert global_result.candidates[0].symbol == symbols[0]
        for selected in ([symbols[1]], [symbols[0]]):
            result = await screener.screen_a_share_short_term_candidates(
                trade_date=target, limit=1, symbols=selected, markets=["A股"],
            )
            assert [candidate.symbol for candidate in result.candidates] == selected
            assert result.total_symbols == 1
        # Exercise Redis after dropping the process-local cache.
        screener._SCREENER_CACHE.clear()
        result = await screener.screen_a_share_short_term_candidates(
            trade_date=target, limit=1, symbols=[symbols[1]], markets=["A股"],
        )
        assert result.candidates[0].symbol == symbols[1]
        etf = await screener.screen_a_share_short_term_candidates(
            trade_date=target, limit=1, markets=["ETF"],
        )
        assert etf.total_symbols == 0
        assert etf.candidates == []

    asyncio.run(run())
