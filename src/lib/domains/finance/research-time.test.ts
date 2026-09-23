import { describe, expect, it } from 'vitest';
import { constrainHistoricalQuery, researchTimeForPlan, resolveResearchTime } from './research-time';

describe('historical research time contract', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const range = { unit: 'date_range', startDate: '2025-07-01', endDate: '2025-12-31' };
  it('freezes Shanghai end-of-day and preserves the cutoff on resume', () => {
    const time = resolveResearchTime(range, now)!;
    expect(time).toEqual({ schemaVersion: 1, startDate: '2025-07-01', endDate: '2025-12-31',
      asOf: '2025-12-31T15:59:59.999Z', timezone: 'Asia/Shanghai' });
    expect(researchTimeForPlan({ researchTime: time })).toEqual(time);
    expect(resolveResearchTime({ unit: 'trading_day' }, now)).toBeNull();
  });
  it('excludes partial daily bars, including timezone-crossing UTC cutoffs', () => {
    const time = resolveResearchTime({ ...range, asOf: '2025-12-31T01:00:00Z' }, now)!;
    expect(time.endDate).toBe('2025-12-30');
    expect(researchTimeForPlan({ researchTime: time })).toEqual(time);
  });
  it.each([
    { unit: 'date_range' },
    { ...range, endDate: '2025-02-29' },
    { ...range, asOf: '2025-12-30T23:59:59+08:00' },
    { ...range, asOf: '2025-12-31T12:00:00' },
    { ...range, endDate: '2027-01-01' },
    { ...range, startDate: '2020-01-01' },
    { ...range, startDate: '2025-12-31', asOf: '2025-12-31T01:00:00Z' },
  ])('rejects missing, invalid, future, partial-only or oversized windows: %j', (invalid) => {
    expect(() => resolveResearchTime(invalid, now)).toThrow();
  });
  it('enforces matching parameters and denies endpoints without historical support', () => {
    const time = resolveResearchTime(range, now)!;
    expect(constrainHistoricalQuery('/api/v1/quotes/history/600519', { limit: 200 }, time)).toEqual({
      limit: 200, start: '20250701', end: '20251231', period: 'daily', adjustment: 'none',
    });
    expect(constrainHistoricalQuery('/api/v1/fundamentals/financials/600519', {}, time)).toEqual({ as_of: time.asOf });
    const conflicts: Record<string, string | string[]>[] = [{ adjustment: 'qfq' }, { end: '20500101' }, { end: ['20251231'] }];
    for (const query of conflicts) {
      expect(() => constrainHistoricalQuery('/api/v1/quotes/history/600519', query, time)).toThrow();
    }
    expect(() => constrainHistoricalQuery('/api/v1/quotes/realtime/600519', {}, time)).toThrow();
    expect(() => researchTimeForPlan({ queryRewrite: { timeRange: { unit: 'date_range' } } })).toThrow();
  });
});
