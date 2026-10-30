import { describe, expect, it } from 'vitest';

import type { PiAgentMissionNodeSpec } from '@/lib/agent/mission';
import { admitPiAgentDagConcurrency, evaluatePiAgentDag } from './dag-scheduler';

function node(
  key: string,
  dependencies: string[] = [],
  options: Partial<PiAgentMissionNodeSpec> = {},
): PiAgentMissionNodeSpec {
  return {
    key,
    type: 'analyst',
    executor: 'model_agent',
    effect: 'artifact_write',
    workspacePolicy: 'artifact_only',
    dependencies,
    allowedTools: [],
    requiredSkillSections: [],
    inputArtifacts: [],
    outputArtifacts: [`artifacts/${key}.json`],
    budget: {
      maxAttempts: 1,
      maxToolCalls: 0,
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      timeoutMs: 10_000,
    },
    acceptancePredicates: [],
    ...options,
  };
}

describe('PI Agent DAG scheduler', () => {
  it('fans out independent specialists after their shared dependency passes', () => {
    const specs = [
      node('data_prefetch'),
      node('fundamental', ['data_prefetch']),
      node('technical', ['data_prefetch']),
      node('risk', ['data_prefetch']),
    ];
    const result = evaluatePiAgentDag(specs, [
      { key: 'data_prefetch', status: 'passed' },
      { key: 'fundamental', status: 'pending' },
      { key: 'technical', status: 'pending' },
      { key: 'risk', status: 'pending' },
    ]);
    expect(result.ready.map((item) => item.key)).toEqual(['fundamental', 'risk', 'technical']);
  });

  it('does not admit an all-join after a required dependency fails', () => {
    const synthesis = node('synthesis', ['fundamental', 'technical']);
    const result = evaluatePiAgentDag([synthesis], [
      { key: 'synthesis', status: 'pending' },
      { key: 'fundamental', status: 'succeeded' },
      { key: 'technical', status: 'failed' },
    ]);
    expect(result.ready).toEqual([]);
    expect(result.blocked[0]?.reason).toBe('DEPENDENCY_FAILED');
  });

  it('honors quorum and degraded-input policy', () => {
    const synthesis = node('synthesis', ['a', 'b', 'c'], {
      joinPolicy: { type: 'quorum', quorum: 2, allowDegradedInputs: true },
    });
    const result = evaluatePiAgentDag([synthesis], [
      { key: 'synthesis', status: 'pending' },
      { key: 'a', status: 'succeeded' },
      { key: 'b', status: 'degraded' },
      { key: 'c', status: 'failed' },
    ]);
    expect(result.ready.map((item) => item.key)).toEqual(['synthesis']);
  });

  it('keeps the writer group single-slot while admitting read-only specialists', () => {
    const writer = node('writer', [], {
      concurrency: { group: 'workspace-writer', maxParallel: 1, priority: 100 },
    });
    const repair = node('repair', [], {
      concurrency: { group: 'workspace-writer', maxParallel: 1, priority: 90 },
    });
    const specialist = node('specialist', [], {
      concurrency: { group: 'research', maxParallel: 3, priority: 50 },
    });
    expect(admitPiAgentDagConcurrency({
      candidates: [writer, repair, specialist],
      active: [writer],
      missionLimit: 3,
    }).map((item) => item.key)).toEqual(['specialist']);
  });
});
