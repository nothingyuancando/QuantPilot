import { describe, expect, it } from 'vitest';

import { compilePiAgentMissionSpec } from '@/lib/agent/mission';

import { createFinanceMultiAgentMissionDefinition } from './mission-definition';

describe('finance multi-Agent Mission definition', () => {
  it('compiles the trusted fan-out and single-writer join', () => {
    const spec = compilePiAgentMissionSpec({
      definition: createFinanceMultiAgentMissionDefinition({ maxRepairAttempts: 1 }),
      projectId: 'project-multi-agent',
      requestId: 'request-multi-agent',
      objective: 'Create an evidence-bound finance dashboard.',
      capabilityId: 'finance.research',
      runPlanId: 'run-plan-multi-agent',
      composition: {
        profileId: 'quantpilot.finance',
        profileVersion: '1.0.0',
        domainPacks: [{ id: 'finance', version: '1.0.0' }],
        deliveryPackId: 'workspace.next-dashboard',
        deliveryPackVersion: '1.0.0',
        compositionSha256: `sha256:${'a'.repeat(64)}`,
      },
      createdAt: '2026-07-15T04:00:00.000Z',
      maxRepairAttempts: 1,
    });
    const byKey = new Map(spec.nodes.map((node) => [node.key, node]));

    expect(byKey.get('fundamental_research')).toMatchObject({
      executor: 'model_agent',
      workspacePolicy: 'artifact_only',
      dependencies: ['data_prefetch'],
    });
    expect(byKey.get('technical_analysis')?.concurrency?.group).toBe('finance-research');
    expect(byKey.get('risk_crosscheck')?.dependencies).toEqual([
      'fundamental_research',
      'technical_analysis',
      'risk_precheck',
    ]);
    expect(byKey.get('workspace_generation')).toMatchObject({
      workspacePolicy: 'single_writer',
      dependencies: ['synthesis'],
    });
  });
});
