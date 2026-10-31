import { describe, expect, it } from 'vitest';
import type { QuantEvalRun } from './types';
import { buildMultiAgentComparison } from './multi-agent-comparison';

function run(input: {
  id: string;
  orchestrationMode: 'single_agent' | 'multi_agent';
  passRate: number;
  score: number;
  durationMs: number;
  tokens: number;
}): QuantEvalRun {
  return {
    id: input.id,
    passRate: input.passRate,
    averageScore: input.score,
    durationMs: input.durationMs,
    metadata: {
      evaluator: { id: 'agent-review', version: '1', rubricVersion: '1' },
      provenance: { experimentId: 'paired-1', casesSha256: 'cases', promptsSha256: 'prompts', snapshotManifestSha256: 'snapshots', frozenInputsSha256: 'inputs', toolConfigSha256: 'tools' },
      skillLockSnapshot: { schemaVersion: 1, skills: {} },
      runtime: { configuredModel: 'deepseek-chat', orchestrationMode: input.orchestrationMode },
      suite: { mode: 'e2e' },
      selection: { selectedCases: ['case-a'] },
    },
    results: [{ id: 'case-a', agentExecution: { usage: { totalTokens: input.tokens } } }],
  } as QuantEvalRun;
}

describe('multi-Agent evaluation comparison', () => {
  it('pairs identical E2E selections and reports multi-Agent deltas', () => {
    const comparison = buildMultiAgentComparison([
      run({ id: 'multi', orchestrationMode: 'multi_agent', passRate: 90, score: 88, durationMs: 20_000, tokens: 15_000 }),
      run({ id: 'single', orchestrationMode: 'single_agent', passRate: 70, score: 80, durationMs: 10_000, tokens: 9_000 }),
    ]);
    expect(comparison).toMatchObject({
      available: true,
      passRateDelta: 20,
      averageScoreDelta: 8,
      durationDeltaMs: 10_000,
      totalTokenDelta: 6_000,
    });
  });

  it('does not compare unmatched case selections', () => {
    const multi = run({ id: 'multi', orchestrationMode: 'multi_agent', passRate: 90, score: 88, durationMs: 20_000, tokens: 15_000 });
    multi.metadata.selection.selectedCases = ['case-b'];
    expect(buildMultiAgentComparison([
      multi,
      run({ id: 'single', orchestrationMode: 'single_agent', passRate: 70, score: 80, durationMs: 10_000, tokens: 9_000 }),
    ]).available).toBe(false);
  });
});
