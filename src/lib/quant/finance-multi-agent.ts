import { randomUUID } from 'node:crypto';

import type { PiAgentMissionContext } from '@/lib/services/pi-agent-mission-control';
import {
  claimPiAgentNodeJob,
  completePiAgentNodeJob,
  failPiAgentNodeJob,
  heartbeatPiAgentNodeJob,
  schedulePiAgentMissionNodes,
  type PiAgentNodeClaim,
} from '@/lib/services/pi-agent-node-orchestration-store';

import { executePiAgentSpecialist } from './finance-specialist-runner';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const NODE_LEASE_TTL_MS = 10 * 60 * 1_000;
const NODE_HEARTBEAT_MS = 60_000;
const NODE_RETRY_BACKOFF_MS = 1_000;

export function isFinanceMultiAgentEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return TRUE_VALUES.has(environment.QUANTPILOT_MULTI_AGENT_ENABLED?.trim().toLowerCase() ?? '');
}

async function claimWave(missionId: string, expectedKeys: readonly string[]): Promise<PiAgentNodeClaim[]> {
  const claims: PiAgentNodeClaim[] = [];
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const claim = await claimPiAgentNodeJob({
      missionId,
      leaseOwner: `multi-agent:${process.pid}:${randomUUID()}`,
      leaseTtlMs: NODE_LEASE_TTL_MS,
    });
    if (!claim) break;
    claims.push(claim);
  }
  const actual = new Set(claims.map((claim) => claim.nodeKey));
  const missing = expectedKeys.filter((key) => !actual.has(key));
  if (missing.length > 0) {
    throw new Error(`Multi-Agent wave could not claim required nodes: ${missing.join(', ')}.`);
  }
  return claims;
}

function retryableSpecialistFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/unsafe|escapes workspace|hash changed|missing|not a bounded regular file|risk.blocking/iu.test(message);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeClaim(input: {
  mission: PiAgentMissionContext;
  selectedModel: string;
  missionConcurrency: number;
  claim: PiAgentNodeClaim;
  assertActive?: () => Promise<void>;
}): Promise<{ nodeKey: string; manifest: Record<string, unknown> }> {
  let claim = input.claim;
  while (true) {
    let heartbeatFailure: unknown = null;
    const heartbeat = setInterval(() => {
      void heartbeatPiAgentNodeJob({ fence: claim, leaseTtlMs: NODE_LEASE_TTL_MS })
        .catch((error) => { heartbeatFailure = error; });
    }, NODE_HEARTBEAT_MS);
    try {
      const artifact = await executePiAgentSpecialist({
        claim,
        projectPath: input.mission.projectPath,
        selectedModel: input.selectedModel,
      });
      if (heartbeatFailure) throw heartbeatFailure;
      await completePiAgentNodeJob({
        fence: claim,
        artifact: {
          artifactType: artifact.artifactType,
          schemaId: artifact.schemaId,
          schemaVersion: artifact.schemaVersion,
          storagePath: artifact.storagePath,
          contentSha256: artifact.contentSha256,
          byteLength: artifact.byteLength,
          sourceRunId: artifact.runId,
          manifest: artifact.manifest,
        },
      });
      return { nodeKey: claim.nodeKey, manifest: artifact.manifest };
    } catch (error) {
      const failure = heartbeatFailure ?? error;
      const message = failure instanceof Error ? failure.message : 'Specialist Agent failed.';
      const result = await failPiAgentNodeJob({
        fence: claim,
        code: 'SPECIALIST_EXECUTION_FAILED',
        message,
        retryable: retryableSpecialistFailure(failure),
        retryBackoffMs: NODE_RETRY_BACKOFF_MS,
      }).catch(() => ({ retryScheduled: false }));
      if (!result.retryScheduled) throw failure;

      await input.assertActive?.();
      await delay(NODE_RETRY_BACKOFF_MS);
      const scheduled = await schedulePiAgentMissionNodes({
        missionId: input.mission.id,
        missionConcurrency: input.missionConcurrency,
      });
      if (!scheduled.scheduledNodeKeys.includes(claim.nodeKey)) {
        throw new Error(`Multi-Agent retry could not schedule ${claim.nodeKey}.`);
      }
      const [replacement] = await claimWave(input.mission.id, [claim.nodeKey]);
      if (!replacement || replacement.nodeKey !== claim.nodeKey) {
        throw new Error(`Multi-Agent retry claimed the wrong node for ${claim.nodeKey}.`);
      }
      claim = replacement;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

async function executeWave(input: {
  mission: PiAgentMissionContext;
  selectedModel: string;
  expectedKeys: readonly string[];
  missionConcurrency: number;
  assertActive?: () => Promise<void>;
}): Promise<Array<{ nodeKey: string; manifest: Record<string, unknown> }>> {
  await input.assertActive?.();
  const scheduled = await schedulePiAgentMissionNodes({
    missionId: input.mission.id,
    missionConcurrency: input.missionConcurrency,
  });
  const scheduledSet = new Set(scheduled.scheduledNodeKeys);
  const absent = input.expectedKeys.filter((key) => !scheduledSet.has(key));
  if (absent.length > 0) {
    throw new Error(`Multi-Agent DAG did not schedule required nodes: ${absent.join(', ')}.`);
  }
  const claims = await claimWave(input.mission.id, input.expectedKeys);
  const results = await Promise.all(claims.map((claim) => executeClaim({ ...input, claim })));
  await input.assertActive?.();
  return results;
}

/** Runs the trusted fixed DAG up to synthesis; the existing Writer remains the sole workspace mutator. */
export async function runFinanceMultiAgentResearch(input: {
  mission: PiAgentMissionContext;
  selectedModel: string;
  assertActive?: () => Promise<void>;
}): Promise<void> {
  await executeWave({
    ...input,
    expectedKeys: ['fundamental_research', 'technical_analysis', 'risk_precheck'],
    missionConcurrency: 3,
  });
  await executeWave({
    ...input,
    expectedKeys: ['risk_crosscheck'],
    missionConcurrency: 3,
  });
  await executeWave({
    ...input,
    expectedKeys: ['synthesis'],
    missionConcurrency: 3,
  });
}
