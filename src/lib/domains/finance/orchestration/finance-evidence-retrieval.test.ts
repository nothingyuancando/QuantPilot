import { describe, expect, it } from 'vitest';
import { retrieveFinanceEvidence } from './finance-evidence-retrieval';

const documents = [{
  path: 'data_file/final/dashboard-data.json',
  content: JSON.stringify({
    financials: { revenue: 120, profit: 18, reportPeriod: '2026Q3' },
    market: { close: 10.2, volume: 3_000, date: '2026-10-28' },
  }),
}];

describe('finance evidence retrieval', () => {
  it('ranks fundamental fields for the fundamental specialist', () => {
    const passages = retrieveFinanceEvidence({ role: 'fundamental_research', documents, limit: 3 });
    expect(passages.some((passage) => /revenue|profit/u.test(passage.text))).toBe(true);
    expect(passages.every((passage) => passage.id.startsWith('evidence:'))).toBe(true);
  });

  it('is deterministic and bounded', () => {
    const first = retrieveFinanceEvidence({ role: 'technical_analysis', documents, limit: 2 });
    const second = retrieveFinanceEvidence({ role: 'technical_analysis', documents, limit: 2 });
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });
});
