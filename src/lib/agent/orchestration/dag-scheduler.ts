import type {
  PiAgentMissionJoinPolicy,
  PiAgentMissionNodeKey,
  PiAgentMissionNodeSpec,
  PiAgentMissionNodeStatus,
} from '@/lib/agent/mission';

export interface PiAgentDagNodeSnapshot {
  key: PiAgentMissionNodeKey;
  status: PiAgentMissionNodeStatus;
}

export interface PiAgentDagAdmission {
  ready: PiAgentMissionNodeSpec[];
  blocked: Array<{ node: PiAgentMissionNodeSpec; reason: string }>;
}

const SUCCESS = new Set<PiAgentMissionNodeStatus>([
  'candidate_complete',
  'passed',
  'succeeded',
  'degraded',
  'skipped',
]);

const FAILURE = new Set<PiAgentMissionNodeStatus>(['failed', 'cancelled']);

const ACTIVE = new Set<PiAgentMissionNodeStatus>([
  'ready',
  'claimed',
  'running',
  'waiting_approval',
  'retry_wait',
]);

function defaultJoinPolicy(): PiAgentMissionJoinPolicy {
  return { type: 'all', allowDegradedInputs: false };
}

function dependencySatisfied(
  policy: PiAgentMissionJoinPolicy,
  statuses: PiAgentMissionNodeStatus[],
): boolean {
  const accepted = statuses.filter((status) =>
    SUCCESS.has(status) && (policy.allowDegradedInputs || status !== 'degraded'),
  ).length;
  if (policy.type === 'all') return accepted === statuses.length;
  if (policy.type === 'any') return accepted > 0;
  return accepted >= (policy.quorum ?? statuses.length);
}

function permanentlyBlocked(
  policy: PiAgentMissionJoinPolicy,
  statuses: PiAgentMissionNodeStatus[],
): boolean {
  const accepted = statuses.filter((status) =>
    SUCCESS.has(status) && (policy.allowDegradedInputs || status !== 'degraded'),
  ).length;
  const unresolved = statuses.filter((status) => status === 'pending' || ACTIVE.has(status)).length;
  if (policy.type === 'all') return statuses.some((status) => FAILURE.has(status));
  if (policy.type === 'any') return accepted === 0 && unresolved === 0;
  return accepted + unresolved < (policy.quorum ?? statuses.length);
}

/**
 * Pure DAG admission calculation. Durable claims, quotas and capacity are
 * applied after this step by the orchestration store.
 */
export function evaluatePiAgentDag(
  specs: readonly PiAgentMissionNodeSpec[],
  snapshots: readonly PiAgentDagNodeSnapshot[],
): PiAgentDagAdmission {
  const states = new Map(snapshots.map((node) => [node.key, node.status]));
  const ready: PiAgentMissionNodeSpec[] = [];
  const blocked: PiAgentDagAdmission['blocked'] = [];

  for (const node of specs) {
    if (states.get(node.key) !== 'pending') continue;
    if (node.dependencies.length === 0) {
      ready.push(node);
      continue;
    }
    const statuses = node.dependencies.map((key) => states.get(key));
    if (statuses.some((status) => status === undefined)) {
      blocked.push({ node, reason: 'DEPENDENCY_STATE_MISSING' });
      continue;
    }
    const resolved = statuses as PiAgentMissionNodeStatus[];
    const policy = node.joinPolicy ?? defaultJoinPolicy();
    if (dependencySatisfied(policy, resolved)) {
      ready.push(node);
    } else if (permanentlyBlocked(policy, resolved)) {
      blocked.push({ node, reason: 'DEPENDENCY_FAILED' });
    }
  }

  return {
    ready: ready.sort((left, right) =>
      (right.concurrency?.priority ?? 0) - (left.concurrency?.priority ?? 0) ||
      left.key.localeCompare(right.key)),
    blocked,
  };
}

/** Enforces per-group limits without conflating them with global Worker slots. */
export function admitPiAgentDagConcurrency(input: {
  candidates: readonly PiAgentMissionNodeSpec[];
  active: readonly PiAgentMissionNodeSpec[];
  missionLimit: number;
}): PiAgentMissionNodeSpec[] {
  const admitted: PiAgentMissionNodeSpec[] = [];
  const groupCounts = new Map<string, number>();
  for (const node of input.active) {
    const group = node.concurrency?.group ?? 'default';
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }
  let remaining = Math.max(0, input.missionLimit - input.active.length);
  for (const node of input.candidates) {
    if (remaining === 0) break;
    const group = node.concurrency?.group ?? 'default';
    const current = groupCounts.get(group) ?? 0;
    const limit = node.concurrency?.maxParallel ?? input.missionLimit;
    if (current >= limit) continue;
    admitted.push(node);
    groupCounts.set(group, current + 1);
    remaining -= 1;
  }
  return admitted;
}
