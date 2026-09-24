import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  compactDate,
  parseArgs,
  runMaintenance,
  shanghaiDate,
  shiftDate,
} = require('../../../scripts/ops/refresh-market-data.js');

beforeEach(() => {
  for (const name of ['QUANTPILOT_MARKET_CALENDAR_LOOKBACK_DAYS', 'QUANTPILOT_MARKET_HISTORY_LOOKBACK_DAYS',
    'QUANTPILOT_MARKET_MAINTENANCE_MAX_SYMBOLS', 'QUANTPILOT_MARKET_MAINTENANCE_BATCH_SIZE']) vi.stubEnv(name, '');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ total: 300 }))));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('market maintenance scheduler', () => {
  it('uses Shanghai calendar dates', () => {
    expect(shanghaiDate(new Date('2026-07-21T16:30:00.000Z'))).toBe('2026-07-22');
  });

  it('builds stable ISO and provider dates', () => {
    expect(shiftDate('2026-07-22', -14)).toBe('2026-07-08');
    expect(compactDate('2026-07-22')).toBe('20260722');
  });

  it('never asks the calendar provider for future dates', async () => {
    const result = await runMaintenance({ today: '2026-07-22', dryRun: true });
    expect(result.calendarBody.end).toBe('2026-07-22');
  });

  it('parses safe operational modes', () => {
    expect(parseArgs(['--dry-run', '--calendar-only'])).toEqual({
      calendarOnly: true,
      dryRun: true,
      skipFreshness: false,
    });
  });

  it('rejects misspelled dry-run switches before any operation', () => {
    expect(() => parseArgs(['--dry-rnu'])).toThrow('Unknown');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['0', '2.5', '25oops', '-1'])('rejects invalid batch size %s instead of silently changing the write scope', async value => {
    vi.stubEnv('QUANTPILOT_MARKET_MAINTENANCE_BATCH_SIZE', value);
    await expect(runMaintenance({ dryRun: true })).rejects.toThrow('integer');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a counted scope and enforces a batch bound without writing during dry run', async () => {
    const result = await runMaintenance({ today: '2026-07-22', dryRun: true });
    expect(result.scope).toEqual({ universeId: 'a-share-sample-research-pool', totalSymbols: 300, maxSymbols: 300, maxRows: 9000 });
    expect(result.historyBody.max_batches).toBe(12);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBeUndefined();
  });

  it('rejects a larger universe before refreshing the calendar or creating jobs', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ total: 301 })));
    await expect(runMaintenance()).rejects.toThrow('exceeds');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not round the batch write bound above the configured maximum', async () => {
    vi.stubEnv('QUANTPILOT_MARKET_MAINTENANCE_MAX_SYMBOLS', '310');
    const result = await runMaintenance({ dryRun: true });
    expect(result.scope.maxSymbols).toBe(300);
  });

  it('allows a calendar-only plan without a universe or history write', async () => {
    const result = await runMaintenance({ dryRun: true, calendarOnly: true });
    expect(result.historyBody).toBeNull();
    expect(result.scope).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['partial', 'stopped', 'failed'])('does not report a %s ingestion as maintenance success', async status => {
    let listCalls = 0;
    vi.mocked(fetch).mockImplementation(async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/members')) return Response.json({ total: 300 });
      if (pathname.endsWith('/jobs')) return Response.json({ jobs: listCalls++ === 0 ? [] : [{ id: 'bounded-job', status, completed_symbols: 10, failed_symbols: 1 }] });
      if (pathname.endsWith('/autofill')) return Response.json({ job_id: 'bounded-job' });
      return Response.json({ written_days: 1 });
    });
    await expect(runMaintenance({ skipFreshness: true })).rejects.toThrow('did not complete');
  });

  it('does not adopt or cancel a running job with a different scope', async () => {
    vi.mocked(fetch).mockImplementation(async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/members')) return Response.json({ total: 300 });
      if (pathname.endsWith('/jobs')) return Response.json({ jobs: [{ id: 'other-job', provider: 'baostock-autofill', status: 'running', metadata: {} }] });
      return Response.json({ written_days: 1 });
    });
    await expect(runMaintenance({ skipFreshness: true })).rejects.toThrow('different scope');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/control') || String(url).includes('/autofill'))).toBe(false);
  });
});
