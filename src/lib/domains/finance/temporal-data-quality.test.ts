import { describe, expect, it } from 'vitest';
import { assessQuantDataResponse } from './data-quality';

describe('temporal response validation', () => {
  it.each([
    ['quotes/history', 'bars'], ['indicators/technical', 'points'], ['backtests/ma-crossover', 'equity_curve'],
  ])('rejects %s that ignores the requested boundaries', (endpoint, field) => {
    const assess = (date: string) => assessQuantDataResponse({
      path: `/api/v1/${endpoint}/600519`, query: { start: '20250102', end: '20250103', period: 'daily', adjustment: 'none' },
      payload: { symbol: '600519', period: 'daily', adjustment: 'none', [field]: [{ date, close: 10 }] },
    });
    expect(assess('2025-01-02')).toMatchObject({ usable: true, status: 'warning' });
    for (const date of ['2025-01-01', '2025-01-04', 'invalid']) expect(assess(date)).toMatchObject({ usable: false, status: 'failed' });
  });
  it('requires the archive cutoff, version and pre-cutoff vintages for historical financials', () => {
    const asOf = '2025-01-03T15:59:59.999Z';
    const knowledge = { point_in_time: true, cutoff: asOf, data_version: 'a'.repeat(64),
      vintages: [{ observed_at: '2025-01-02T00:00:00Z', available_at: '2025-01-02T00:00:00Z' }] };
    const assess = (snapshot: unknown) => assessQuantDataResponse({ path: '/api/v1/fundamentals/financials/600519',
      query: { as_of: asOf }, payload: { symbol: '600519', as_of: asOf, knowledge: snapshot } });
    expect(assess(knowledge).usable).toBe(true);
    expect(assess(undefined).usable).toBe(false);
    expect(assess({ ...knowledge, point_in_time: false }).usable).toBe(false);
    expect(assess({ ...knowledge, vintages: [{ ...knowledge.vintages[0], observed_at: '2026-01-01T00:00:00Z' }] }).usable).toBe(false);
  });
});
