import { describe, it } from 'vitest';
import { researchBusinessCases } from '../../../../benchmarks/quantpilot/research-business-cases';

describe('research business benchmark', () => {
  for (const testCase of researchBusinessCases) it(`${testCase.category}: ${testCase.id}`, testCase.check);
});
