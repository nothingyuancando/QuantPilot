import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PiAgentNodeClaim } from '@/lib/services/pi-agent-node-orchestration-store';

const mocks = vi.hoisted(() => ({
  executeSpecialist: vi.fn(),
  schedule: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  heartbeat: vi.fn(),
}));

vi.mock('./finance-specialist-runner', () => ({
  executePiAgentSpecialist: mocks.executeSpecialist,
}));

vi.mock('@/lib/services/pi-agent-node-orchestration-store', () => ({
  schedulePiAgentMissionNodes: mocks.schedule,
  claimPiAgentNodeJob: mocks.claim,
  completePiAgentNodeJob: mocks.complete,
  failPiAgentNodeJob: mocks.fail,
  heartbeatPiAgentNodeJob: mocks.heartbeat,
}));

import {
  isFinanceMultiAgentEnabled,
  runFinanceMultiAgentResearch,
} from './finance-multi-agent';

const waveKeys = [
  ['fundamental_research', 'technical_analysis', 'risk_precheck'],
  ['risk_crosscheck'],
  ['synthesis'],
] as const;

function claim(nodeKey: string): PiAgentNodeClaim {
  return {
    jobId: `job-${nodeKey}`,
    attemptId: `attempt-${nodeKey}`,
    missionId: 'mission-1',
    nodeId: `node-${nodeKey}`,
    nodeKey,
    attempt: 1,
    leaseOwner: `worker-${nodeKey}`,
    fencingToken: 1,
    executionEnvelope: {},
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function mission() {
  return {
    id: 'mission-1',
    projectId: 'project-1',
    requestId: 'request-1',
    generationId: 'generation-1',
    status: 'running',
    version: 1,
    candidateVersion: 0,
    specHash: `sha256:${'a'.repeat(64)}`,
    acceptedReceiptId: null,
    projectPath: '/tmp/project-1',
  } as const;
}

function arrangeSuccessfulWaves(options: { blockingRisk?: boolean } = {}) {
  mocks.schedule.mockImplementation(async () => ({
    scheduledNodeKeys: [...waveKeys[mocks.schedule.mock.calls.length - 1]],
    failedNodeKeys: [],
  }));
  const claims = waveKeys.flat().map(claim);
  mocks.claim.mockImplementation(async () => claims.shift() ?? null);
  mocks.executeSpecialist.mockImplementation(async ({ claim: nodeClaim }) => ({
    runId: `run-${nodeClaim.nodeKey}`,
    artifactType: nodeClaim.nodeKey,
    schemaId: `schema-${nodeClaim.nodeKey}`,
    schemaVersion: 1,
    storagePath: `.data-agent/multi-agent/${nodeClaim.nodeKey}.json`,
    contentSha256: `sha256:${'b'.repeat(64)}`,
    byteLength: 100,
    manifest: nodeClaim.nodeKey === 'risk_crosscheck'
      ? { blocking: options.blockingRisk ?? false }
      : {},
  }));
}

describe('finance multi-Agent orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockResolvedValue(undefined);
    mocks.fail.mockResolvedValue({ retryScheduled: false });
    mocks.heartbeat.mockResolvedValue({
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  });

  it('keeps the rollout disabled unless the flag is explicitly true', () => {
    expect(isFinanceMultiAgentEnabled({})).toBe(false);
    expect(isFinanceMultiAgentEnabled({ QUANTPILOT_MULTI_AGENT_ENABLED: 'false' })).toBe(false);
    expect(isFinanceMultiAgentEnabled({ QUANTPILOT_MULTI_AGENT_ENABLED: ' TRUE ' })).toBe(true);
    expect(isFinanceMultiAgentEnabled({ QUANTPILOT_MULTI_AGENT_ENABLED: 'enabled' })).toBe(true);
  });

  it('runs the three specialists, risk cross-check and synthesis as ordered waves', async () => {
    arrangeSuccessfulWaves();
    const assertActive = vi.fn().mockResolvedValue(undefined);

    await runFinanceMultiAgentResearch({
      mission: mission(),
      selectedModel: 'deepseek-chat',
      assertActive,
    });

    expect(mocks.schedule.mock.calls.map(([input]) => input)).toEqual([
      { missionId: 'mission-1', missionConcurrency: 3 },
      { missionId: 'mission-1', missionConcurrency: 3 },
      { missionId: 'mission-1', missionConcurrency: 3 },
    ]);
    expect(mocks.executeSpecialist.mock.calls.map(([input]) => input.claim.nodeKey)).toEqual([
      'fundamental_research',
      'technical_analysis',
      'risk_precheck',
      'risk_crosscheck',
      'synthesis',
    ]);
    expect(mocks.complete).toHaveBeenCalledTimes(5);
    expect(assertActive).toHaveBeenCalledTimes(6);
  });

  it('carries model-reported blocking risks into synthesis instead of granting the model abort authority', async () => {
    arrangeSuccessfulWaves({ blockingRisk: true });

    await expect(runFinanceMultiAgentResearch({
      mission: mission(),
      selectedModel: 'deepseek-chat',
    })).resolves.toBeUndefined();

    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    expect(mocks.executeSpecialist.mock.calls.map(([input]) => input.claim.nodeKey)).toContain('synthesis');
  });

  it('records a fenced node failure when a specialist fails', async () => {
    arrangeSuccessfulWaves();
    mocks.executeSpecialist.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(runFinanceMultiAgentResearch({
      mission: mission(),
      selectedModel: 'deepseek-chat',
    })).rejects.toThrow('provider unavailable');

    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SPECIALIST_EXECUTION_FAILED',
      message: 'provider unavailable',
      retryable: true,
    }));
  });

  it('reclaims and completes a transiently failed specialist attempt', async () => {
    const initialClaims = waveKeys.flat().map(claim);
    const retryClaim = { ...claim('fundamental_research'), attempt: 2, fencingToken: 2 };
    let scheduleCall = 0;
    let retryClaimed = false;
    mocks.schedule.mockImplementation(async () => {
      scheduleCall += 1;
      if (scheduleCall === 1) {
        return { scheduledNodeKeys: [...waveKeys[0]], failedNodeKeys: [] };
      }
      if (scheduleCall === 2) {
        return { scheduledNodeKeys: ['fundamental_research'], failedNodeKeys: [] };
      }
      return {
        scheduledNodeKeys: [...waveKeys[scheduleCall - 2]],
        failedNodeKeys: [],
      };
    });
    mocks.claim.mockImplementation(async () => {
      if (initialClaims.length === 2 && !retryClaimed) {
        retryClaimed = true;
        return retryClaim;
      }
      return initialClaims.shift() ?? null;
    });
    mocks.executeSpecialist
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockImplementation(async ({ claim: nodeClaim }) => ({
        runId: `run-${nodeClaim.nodeKey}-${nodeClaim.attempt}`,
        artifactType: nodeClaim.nodeKey,
        schemaId: `schema-${nodeClaim.nodeKey}`,
        schemaVersion: 1,
        storagePath: `.data-agent/multi-agent/${nodeClaim.nodeKey}.json`,
        contentSha256: `sha256:${'b'.repeat(64)}`,
        byteLength: 100,
        manifest: nodeClaim.nodeKey === 'risk_crosscheck' ? { blocking: false } : {},
      }));
    mocks.fail.mockResolvedValueOnce({ retryScheduled: true });

    await runFinanceMultiAgentResearch({
      mission: mission(),
      selectedModel: 'deepseek-chat',
    });

    expect(mocks.fail).toHaveBeenCalledTimes(1);
    expect(mocks.executeSpecialist).toHaveBeenCalledTimes(6);
    expect(mocks.complete).toHaveBeenCalledTimes(5);
  });
});
