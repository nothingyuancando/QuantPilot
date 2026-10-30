import { describe, expect, it } from 'vitest';

import { summarizeMultiAgentError } from './multi-agent-progress';

describe('multi-Agent progress error summaries', () => {
  it('turns Zod issue JSON into bounded field diagnostics', () => {
    const message = JSON.stringify([
      { path: ['asOf'], message: 'Invalid ISO datetime' },
      { path: ['claims', 0, 'id'], message: 'Expected string' },
    ]);

    expect(summarizeMultiAgentError(message)).toBe(
      'Specialist output schema mismatch: asOf: Invalid ISO datetime; claims.0.id: Expected string',
    );
  });

  it('never exposes an unbounded opaque error', () => {
    expect(summarizeMultiAgentError('x'.repeat(1_000))?.length).toBeLessThanOrEqual(360);
  });
});
