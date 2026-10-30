import { Prisma } from '@prisma/client';

import type {
  PiAgentMissionNodeSpec,
  PiAgentMissionNodeStatus,
  PiAgentMissionSpec,
} from '@/lib/agent/mission';
import {
  admitPiAgentDagConcurrency,
  evaluatePiAgentDag,
} from '@/lib/agent/orchestration';
import { prisma } from '@/lib/db/client';
import { hashPiAgentProvenance } from '@/lib/services/pi-agent-provenance';

const ACTIVE_NODE_STATUSES = new Set<PiAgentMissionNodeStatus>([
  'ready',
  'claimed',
  'running',
  'waiting_approval',
  'retry_wait',
]);
const MAX_NODE_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

type NodeTransaction = Prisma.TransactionClient;

export interface PiAgentNodeFence {
  jobId: string;
  attemptId: string;
  leaseOwner: string;
  fencingToken: number;
}

export interface PiAgentNodeClaim extends PiAgentNodeFence {
  missionId: string;
  nodeId: string;
  nodeKey: string;
  attempt: number;
  executionEnvelope: Prisma.JsonValue;
  leaseExpiresAt: string;
}

export class PiAgentNodeOrchestrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PiAgentNodeOrchestrationError';
  }
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function assertLeaseInput(leaseOwner: string, leaseTtlMs: number): void {
  if (!leaseOwner || Buffer.byteLength(leaseOwner, 'utf8') > 256 || /[\r\n]/u.test(leaseOwner)) {
    throw new PiAgentNodeOrchestrationError(
      'NODE_LEASE_INVALID',
      'Node leaseOwner must be a bounded single-line identifier.',
    );
  }
  if (
    !Number.isSafeInteger(leaseTtlMs) ||
    leaseTtlMs < 1_000 ||
    leaseTtlMs > MAX_NODE_LEASE_TTL_MS
  ) {
    throw new PiAgentNodeOrchestrationError(
      'NODE_LEASE_INVALID',
      'Node lease TTL must be between one second and one day.',
    );
  }
}

async function databaseNow(tx: NodeTransaction): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "databaseNow"
  `);
  const now = rows[0]?.databaseNow;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new PiAgentNodeOrchestrationError(
      'NODE_DATABASE_CLOCK_UNAVAILABLE',
      'Database clock is unavailable for node fencing.',
    );
  }
  return now;
}

function nodeStatus(value: string): PiAgentMissionNodeStatus {
  const statuses: readonly PiAgentMissionNodeStatus[] = [
    'pending', 'ready', 'claimed', 'running', 'waiting_approval', 'retry_wait',
    'candidate_complete', 'passed', 'succeeded', 'degraded', 'failed',
    'cancelled', 'skipped',
  ];
  if (statuses.includes(value as PiAgentMissionNodeStatus)) {
    return value as PiAgentMissionNodeStatus;
  }
  throw new PiAgentNodeOrchestrationError(
    'NODE_STATUS_INVALID',
    `Unsupported durable node status: ${value}`,
  );
}

function specByKey(spec: PiAgentMissionSpec): Map<string, PiAgentMissionNodeSpec> {
  return new Map(spec.nodes.map((node) => [node.key, node]));
}

/**
 * Materializes currently-ready nodes as durable attempts and jobs. Repeated
 * scheduler ticks are idempotent because only pending nodes are admitted and
 * their state transition is protected by a version/status CAS.
 */
export async function schedulePiAgentMissionNodes(input: {
  missionId: string;
  missionConcurrency: number;
}): Promise<{ scheduledNodeKeys: string[]; failedNodeKeys: string[] }> {
  if (!Number.isSafeInteger(input.missionConcurrency) || input.missionConcurrency <= 0) {
    throw new PiAgentNodeOrchestrationError(
      'MISSION_CONCURRENCY_INVALID',
      'Mission concurrency must be a positive safe integer.',
    );
  }
  return prisma.$transaction(async (tx) => {
    const mission = await tx.agentMission.findUnique({
      where: { id: input.missionId },
      include: { nodes: true },
    });
    if (!mission) {
      throw new PiAgentNodeOrchestrationError('MISSION_NOT_FOUND', 'Mission was not found.');
    }
    if (!['running', 'repairing'].includes(mission.status)) {
      return { scheduledNodeKeys: [], failedNodeKeys: [] };
    }
    const spec = mission.spec as unknown as PiAgentMissionSpec;
    const definitions = specByKey(spec);
    const now = await databaseNow(tx);
    const snapshots = mission.nodes.map((node) => ({
      key: node.nodeKey,
      status: nodeStatus(node.status),
    }));
    const evaluated = evaluatePiAgentDag(spec.nodes, snapshots);
    const activeDefinitions = mission.nodes
      .filter((node) => ACTIVE_NODE_STATUSES.has(nodeStatus(node.status)))
      .map((node) => definitions.get(node.nodeKey))
      .filter((node): node is PiAgentMissionNodeSpec => Boolean(node));
    const admitted = admitPiAgentDagConcurrency({
      candidates: evaluated.ready.filter((definition) => {
        const durableNode = mission.nodes.find((node) => node.nodeKey === definition.key);
        return !durableNode?.availableAt || durableNode.availableAt <= now;
      }),
      active: activeDefinitions,
      missionLimit: input.missionConcurrency,
    });
    const scheduledNodeKeys: string[] = [];

    for (const definition of admitted) {
      const durableNode = mission.nodes.find((node) => node.nodeKey === definition.key);
      if (!durableNode) continue;
      const dependencyNodeIds = mission.nodes
        .filter((node) => definition.dependencies.includes(node.nodeKey))
        .map((node) => node.id);
      const artifacts = dependencyNodeIds.length === 0
        ? []
        : await tx.agentNodeArtifact.findMany({
            where: { missionId: mission.id, nodeId: { in: dependencyNodeIds }, status: 'accepted' },
            select: {
              id: true,
              artifactType: true,
              schemaId: true,
              storagePath: true,
              contentSha256: true,
            },
            orderBy: [{ artifactType: 'asc' }, { id: 'asc' }],
          });
      const nextAttempt = durableNode.attemptCount + 1;
      const inputManifestHash = `sha256:${hashPiAgentProvenance({
        missionSpecHash: mission.specHash,
        nodeKey: definition.key,
        dependencies: definition.dependencies,
        artifacts,
      })}`;
      const transitioned = await tx.agentMissionNode.updateMany({
        where: { id: durableNode.id, status: 'pending', version: durableNode.version },
        data: {
          status: 'ready',
          readyAt: now,
          availableAt: now,
          attemptCount: nextAttempt,
          version: { increment: 1 },
          errorCode: null,
          errorMessage: null,
        },
      });
      if (transitioned.count !== 1) continue;
      const attempt = await tx.agentMissionNodeAttempt.create({
        data: {
          missionId: mission.id,
          nodeId: durableNode.id,
          attempt: nextAttempt,
          status: 'pending',
          inputManifestHash,
        },
      });
      const job = await tx.agentNodeJob.create({
        data: {
          missionId: mission.id,
          nodeId: durableNode.id,
          attemptId: attempt.id,
          status: 'pending',
          priority: definition.concurrency?.priority ?? 0,
          availableAt: now,
          envelope: inputJson({
            schemaVersion: 1,
            missionId: mission.id,
            projectId: mission.projectId,
            requestId: mission.requestId,
            nodeKey: definition.key,
            nodeSpec: definition,
            inputManifestHash,
            inputArtifacts: artifacts,
          }),
          eventSequence: 1,
          events: {
            create: {
              missionId: mission.id,
              nodeId: durableNode.id,
              sequence: 1,
              eventType: 'node_scheduled',
              payload: inputJson({ nodeKey: definition.key, attempt: nextAttempt }),
              occurredAt: now,
            },
          },
        },
      });
      void job;
      scheduledNodeKeys.push(definition.key);
    }

    const failedNodeKeys: string[] = [];
    for (const blocked of evaluated.blocked) {
      const durableNode = mission.nodes.find((node) => node.nodeKey === blocked.node.key);
      if (!durableNode || blocked.node.failurePolicy?.mode === 'continue_degraded') continue;
      const failed = await tx.agentMissionNode.updateMany({
        where: { id: durableNode.id, status: 'pending', version: durableNode.version },
        data: {
          status: 'failed',
          finishedAt: now,
          errorCode: blocked.reason,
          errorMessage: 'A required dependency did not produce an accepted result.',
          version: { increment: 1 },
        },
      });
      if (failed.count === 1) failedNodeKeys.push(blocked.node.key);
    }
    return { scheduledNodeKeys, failedNodeKeys };
  });
}

/** Claims one globally available node job using SKIP LOCKED fairness. */
export async function claimPiAgentNodeJob(input: {
  leaseOwner: string;
  leaseTtlMs: number;
  missionId?: string;
}): Promise<PiAgentNodeClaim | null> {
  assertLeaseInput(input.leaseOwner, input.leaseTtlMs);
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const missionFilter = input.missionId
      ? Prisma.sql`AND "mission_id" = ${input.missionId}`
      : Prisma.empty;
    const rows = await tx.$queryRaw<Array<{
      id: string;
      missionId: string;
      nodeId: string;
      attemptId: string;
      status: string;
      fencingToken: number;
      envelope: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT
        "id",
        "mission_id" AS "missionId",
        "node_id" AS "nodeId",
        "attempt_id" AS "attemptId",
        "status",
        "fencing_token" AS "fencingToken",
        "envelope"
      FROM "agent_node_jobs"
      WHERE (
          ("status" IN ('pending', 'retry_wait') AND "available_at" <= ${now})
          OR ("status" = 'running' AND "lease_expires_at" <= ${now})
        )
        ${missionFilter}
      ORDER BY "priority" DESC, "available_at" ASC, "created_at" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const candidate = rows[0];
    if (!candidate) return null;
    const envelope = candidate.envelope as Record<string, unknown>;
    const nodeKey = typeof envelope.nodeKey === 'string' ? envelope.nodeKey : '';
    if (!nodeKey) {
      throw new PiAgentNodeOrchestrationError(
        'NODE_ENVELOPE_INVALID',
        'Node execution envelope is missing nodeKey.',
      );
    }
    const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const fencingToken = candidate.fencingToken + 1;
    const updated = await tx.agentNodeJob.updateMany({
      where: {
        id: candidate.id,
        fencingToken: candidate.fencingToken,
        OR: [
          { status: { in: ['pending', 'retry_wait'] } },
          { status: 'running', leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'running',
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        fencingToken,
      },
    });
    if (updated.count !== 1) return null;
    const reclaimed = candidate.status === 'running';
    if (reclaimed) {
      const previousAttempt = await tx.agentMissionNodeAttempt.findUnique({
        where: { id: candidate.attemptId },
        select: { agentRunId: true },
      });
      if (previousAttempt?.agentRunId) {
        await tx.agentRun.updateMany({
          where: {
            id: previousAttempt.agentRunId,
            status: { in: ['pending', 'running', 'reconciling', 'waiting'] },
          },
          data: {
            status: 'interrupted',
            errorCode: 'NODE_LEASE_EXPIRED_REPLAN_REQUIRED',
            errorMessage: 'Expired specialist node lease was fenced by a replacement attempt.',
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: now,
            version: { increment: 1 },
          },
        });
      }
    }
    await tx.agentMissionNodeAttempt.update({
      where: { id: candidate.attemptId },
      data: {
        status: 'running',
        ...(reclaimed ? { agentRunId: null } : {}),
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        fencingToken,
        startedAt: now,
      },
    });
    const attempt = await tx.agentMissionNodeAttempt.findUniqueOrThrow({
      where: { id: candidate.attemptId },
      select: { attempt: true },
    });
    await tx.agentMissionNode.update({
      where: { id: candidate.nodeId },
      data: { status: 'running', startedAt: now, version: { increment: 1 } },
    });
    await tx.agentNodeOutboxEvent.create({
      data: {
        jobId: candidate.id,
        missionId: candidate.missionId,
        nodeId: candidate.nodeId,
        sequence: await nextNodeEventSequence(tx, candidate.id),
        eventType: reclaimed ? 'node_reclaimed' : 'node_claimed',
        payload: inputJson({ nodeKey, attempt: attempt.attempt, fencingToken }),
        occurredAt: now,
      },
    });
    return {
      jobId: candidate.id,
      attemptId: candidate.attemptId,
      missionId: candidate.missionId,
      nodeId: candidate.nodeId,
      nodeKey,
      attempt: attempt.attempt,
      leaseOwner: input.leaseOwner,
      fencingToken,
      executionEnvelope: candidate.envelope,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    };
  });
}

export async function failPiAgentNodeJob(input: {
  fence: PiAgentNodeFence;
  code: string;
  message: string;
  retryable: boolean;
  retryBackoffMs?: number;
}): Promise<{ retryScheduled: boolean }> {
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const job = await tx.agentNodeJob.findUnique({ where: { id: input.fence.jobId } });
    if (
      !job || job.attemptId !== input.fence.attemptId || job.status !== 'running' ||
      job.leaseOwner !== input.fence.leaseOwner ||
      job.fencingToken !== input.fence.fencingToken ||
      !job.leaseExpiresAt || job.leaseExpiresAt <= now
    ) {
      throw new PiAgentNodeOrchestrationError('NODE_LEASE_LOST', 'Node failure lost its fence.');
    }
    const node = await tx.agentMissionNode.findUniqueOrThrow({ where: { id: job.nodeId } });
    const retryScheduled = input.retryable && node.attemptCount < node.maxAttempts;
    const availableAt = new Date(now.getTime() + Math.max(0, input.retryBackoffMs ?? 1_000));
    await tx.agentMissionNodeAttempt.update({
      where: { id: job.attemptId },
      data: {
        status: 'failed',
        errorCode: input.code,
        errorMessage: input.message.slice(0, 2_048),
        finishedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: { increment: 1 },
      },
    });
    await tx.agentMissionNode.update({
      where: { id: job.nodeId },
      data: retryScheduled
        ? {
            status: 'pending',
            availableAt,
            errorCode: input.code,
            errorMessage: input.message.slice(0, 2_048),
            version: { increment: 1 },
          }
        : {
            status: 'failed',
            finishedAt: now,
            errorCode: input.code,
            errorMessage: input.message.slice(0, 2_048),
            version: { increment: 1 },
          },
    });
    const sequence = await nextNodeEventSequence(tx, job.id);
    await tx.agentNodeJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorCode: input.code,
        errorMessage: input.message.slice(0, 2_048),
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: { increment: 1 },
      },
    });
    await tx.agentNodeOutboxEvent.create({
      data: {
        jobId: job.id,
        missionId: job.missionId,
        nodeId: job.nodeId,
        sequence,
        eventType: retryScheduled ? 'node_retry_scheduled' : 'node_failed',
        payload: inputJson({ code: input.code, retryScheduled, availableAt: availableAt.toISOString() }),
        occurredAt: now,
      },
    });
    return { retryScheduled };
  });
}

async function nextNodeEventSequence(tx: NodeTransaction, jobId: string): Promise<number> {
  const job = await tx.agentNodeJob.update({
    where: { id: jobId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  return job.eventSequence;
}

export async function heartbeatPiAgentNodeJob(input: {
  fence: PiAgentNodeFence;
  leaseTtlMs: number;
}): Promise<{ leaseExpiresAt: string }> {
  assertLeaseInput(input.fence.leaseOwner, input.leaseTtlMs);
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const updated = await tx.agentNodeJob.updateMany({
      where: {
        id: input.fence.jobId,
        attemptId: input.fence.attemptId,
        status: 'running',
        leaseOwner: input.fence.leaseOwner,
        fencingToken: input.fence.fencingToken,
        leaseExpiresAt: { gt: now },
      },
      data: { leaseExpiresAt, lastHeartbeatAt: now },
    });
    if (updated.count !== 1) {
      throw new PiAgentNodeOrchestrationError('NODE_LEASE_LOST', 'Node heartbeat lost its fence.');
    }
    await tx.agentMissionNodeAttempt.updateMany({
      where: {
        id: input.fence.attemptId,
        leaseOwner: input.fence.leaseOwner,
        fencingToken: input.fence.fencingToken,
      },
      data: { leaseExpiresAt, lastHeartbeatAt: now },
    });
    const attempt = await tx.agentMissionNodeAttempt.findUnique({
      where: { id: input.fence.attemptId },
      select: { agentRunId: true },
    });
    if (attempt?.agentRunId) {
      await tx.agentRun.updateMany({
        where: {
          id: attempt.agentRunId,
          status: { in: ['pending', 'running', 'reconciling', 'waiting'] },
          leaseOwner: input.fence.leaseOwner,
          fencingToken: input.fence.fencingToken,
        },
        data: { leaseExpiresAt, lastHeartbeatAt: now },
      });
    }
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  });
}

export async function completePiAgentNodeJob(input: {
  fence: PiAgentNodeFence;
  artifact: {
    artifactType: string;
    schemaId: string;
    schemaVersion: number;
    storagePath: string;
    contentSha256: string;
    byteLength: number;
    sourceRunId?: string | null;
    manifest: unknown;
  };
}): Promise<{ artifactId: string }> {
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const job = await tx.agentNodeJob.findUnique({ where: { id: input.fence.jobId } });
    if (
      !job || job.attemptId !== input.fence.attemptId || job.status !== 'running' ||
      job.leaseOwner !== input.fence.leaseOwner ||
      job.fencingToken !== input.fence.fencingToken ||
      !job.leaseExpiresAt || job.leaseExpiresAt <= now
    ) {
      throw new PiAgentNodeOrchestrationError('NODE_LEASE_LOST', 'Node completion lost its fence.');
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.artifact.contentSha256)) {
      throw new PiAgentNodeOrchestrationError('NODE_ARTIFACT_INVALID', 'Artifact hash is invalid.');
    }
    if (
      !input.artifact.storagePath || input.artifact.storagePath.startsWith('/') ||
      input.artifact.storagePath.split('/').includes('..') ||
      !Number.isSafeInteger(input.artifact.byteLength) || input.artifact.byteLength < 0
    ) {
      throw new PiAgentNodeOrchestrationError('NODE_ARTIFACT_INVALID', 'Artifact metadata is invalid.');
    }
    const artifact = await tx.agentNodeArtifact.create({
      data: {
        missionId: job.missionId,
        nodeId: job.nodeId,
        attemptId: job.attemptId,
        artifactType: input.artifact.artifactType,
        schemaId: input.artifact.schemaId,
        schemaVersion: input.artifact.schemaVersion,
        storagePath: input.artifact.storagePath,
        contentSha256: input.artifact.contentSha256,
        byteLength: input.artifact.byteLength,
        sourceRunId: input.artifact.sourceRunId ?? null,
        manifest: inputJson(input.artifact.manifest),
      },
    });
    await tx.agentMissionNodeAttempt.update({
      where: { id: job.attemptId },
      data: {
        status: 'succeeded',
        resultArtifactId: artifact.id,
        finishedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await tx.agentMissionNode.update({
      where: { id: job.nodeId },
      data: {
        status: 'succeeded',
        resultArtifactId: artifact.id,
        finishedAt: now,
        version: { increment: 1 },
      },
    });
    const sequence = await nextNodeEventSequence(tx, job.id);
    await tx.agentNodeJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await tx.agentNodeOutboxEvent.create({
      data: {
        jobId: job.id,
        missionId: job.missionId,
        nodeId: job.nodeId,
        sequence,
        eventType: 'node_completed',
        payload: inputJson({ artifactId: artifact.id, contentSha256: artifact.contentSha256 }),
        occurredAt: now,
      },
    });
    return { artifactId: artifact.id };
  });
}
