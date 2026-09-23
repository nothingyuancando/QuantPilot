import type { QuantDataIssue } from './data-quality';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : {};
const day = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = /^\d{8}$/.test(value) ? value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === normalized ? normalized : null;
};

/** Reject successful HTTP responses that did not honor the requested temporal contract. */
export function assessTemporalData(input: {
  path: string; query?: RecordValue; payload: RecordValue;
}): QuantDataIssue[] {
  const { path, query = {}, payload } = input;
  const issues: QuantDataIssue[] = [];
  const issue = (code: string, path: string, severity: QuantDataIssue['severity'] = 'error') => {
    if (issues.length < 24) issues.push({ code, path, severity });
  };
  if (query.as_of !== undefined && /\/(?:fundamentals\/financials|indicators\/fundamental)\//.test(path)) {
    const cutoff = typeof query.as_of === 'string' ? Date.parse(query.as_of) : NaN;
    const knowledge = record(payload.knowledge);
    if (!Number.isFinite(cutoff) || Date.parse(String(payload.as_of)) !== cutoff
      || Date.parse(String(knowledge.cutoff)) !== cutoff || knowledge.point_in_time !== true
      || typeof knowledge.data_version !== 'string' || !/^[a-f0-9]{64}$/.test(knowledge.data_version)) {
      issue('historical_snapshot_mismatch', 'knowledge');
    }
    if (!Array.isArray(knowledge.vintages)) issue('historical_vintages_missing', 'knowledge.vintages');
    else for (const value of knowledge.vintages) {
      const vintage = record(value);
      for (const key of ['observed_at', 'available_at']) {
        const timestamp = Date.parse(String(vintage[key]));
        if (!Number.isFinite(timestamp) || timestamp > cutoff) issue('vintage_after_cutoff', `knowledge.vintages.${key}`);
      }
    }
  }
  if (query.trade_date !== undefined && path.endsWith('/screeners/a-share/short-term-candidates')
    && payload.trade_date !== query.trade_date) issue('historical_trade_date_mismatch', 'trade_date');
  if (query.end === undefined || !/\/(?:quotes\/history|indicators\/technical|backtests\/(?:ma-crossover|strategies\/[^/]+))\//.test(path)) return issues;
  const upper = day(query.end);
  const lower = query.start === undefined ? null : day(query.start);
  if (!upper || (query.start !== undefined && (!lower || lower > upper))) {
    issue('historical_window_invalid', '$query');
    return issues;
  }
  if (query.period === 'daily' && payload.period !== 'daily') issue('historical_period_missing', 'period');
  if (query.adjustment === 'none' && payload.adjustment !== 'none') issue('historical_adjustment_missing', 'adjustment');
  const checkDate = (value: unknown, at: string) => {
    const date = day(value);
    if (!date || date > upper || (lower && date < lower)) issue('outside_research_window', at);
  };
  const rowsKey = path.includes('/quotes/history/') ? 'bars' : path.includes('/indicators/technical/') ? 'points' : 'equity_curve';
  if (!Array.isArray(payload[rowsKey]) || !payload[rowsKey].length) issue('historical_series_missing', rowsKey);
  else for (const [index, value] of payload[rowsKey].entries()) checkDate(record(value).date, `${rowsKey}[${index}].date`);
  if (Array.isArray(payload.trades)) for (const [index, value] of payload.trades.entries()) {
    const trade = record(value);
    checkDate(trade.entry_date, `trades[${index}].entry_date`);
    if (trade.exit_date != null) checkDate(trade.exit_date, `trades[${index}].exit_date`);
  }
  issue('historical_trade_dates_only', 'metadata', 'warning');
  return issues;
}
