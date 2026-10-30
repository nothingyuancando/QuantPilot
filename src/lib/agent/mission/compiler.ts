import { createHash } from 'node:crypto';

import type {
  PiAgentArtifactRequirement,
  PiAgentMissionDefinition,
  PiAgentExpectedEntityRef,
  PiAgentMissionCompositionRef,
  PiAgentMissionNodeKey,
  PiAgentMissionNodeSpec,
  PiAgentMissionSpec,
} from './types';

const NODE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_MISSION_NODES = 32;
const MAX_MISSION_DEPTH = 12;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedIdentifier(value: string, label: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > max) {
    throw new Error(`${label} must be between 1 and ${max} UTF-8 bytes.`);
  }
  return normalized;
}

function boundedSha256(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 identity.`);
  }
  return normalized;
}

function safeArtifactPattern(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    Buffer.byteLength(normalized, 'utf8') > 1_024
  ) {
    throw new Error(`Invalid MissionSpec artifact path: ${value}`);
  }
  return normalized;
}

function compileArtifacts(
  artifacts: readonly PiAgentArtifactRequirement[],
): PiAgentArtifactRequirement[] {
  const compiled = new Map<string, PiAgentArtifactRequirement>();
  for (const artifact of artifacts) {
    const artifactPath = safeArtifactPattern(artifact.path);
    const existing = compiled.get(artifactPath);
    const normalized = { ...artifact, path: artifactPath };
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error(`Conflicting MissionSpec artifact contract: ${artifactPath}`);
    }
    compiled.set(artifactPath, normalized);
  }
  return [...compiled.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function compileNodes(nodes: readonly PiAgentMissionNodeSpec[]): PiAgentMissionNodeSpec[] {
  if (nodes.length === 0 || nodes.length > MAX_MISSION_NODES) {
    throw new Error(`MissionSpec must contain between 1 and ${MAX_MISSION_NODES} nodes.`);
  }
  const byKey = new Map<PiAgentMissionNodeKey, PiAgentMissionNodeSpec>();
  for (const node of nodes) {
    if (!NODE_KEY_PATTERN.test(node.key)) {
      throw new Error(`Invalid Mission node key: ${node.key}`);
    }
    if (byKey.has(node.key)) throw new Error(`Duplicate Mission node: ${node.key}`);
    if (
      !Number.isSafeInteger(node.budget.maxAttempts) || node.budget.maxAttempts <= 0 ||
      !Number.isSafeInteger(node.budget.maxToolCalls) || node.budget.maxToolCalls < 0 ||
      !Number.isSafeInteger(node.budget.maxInputTokens) || node.budget.maxInputTokens < 0 ||
      !Number.isSafeInteger(node.budget.maxOutputTokens) || node.budget.maxOutputTokens < 0 ||
      !Number.isSafeInteger(node.budget.timeoutMs) || node.budget.timeoutMs <= 0
    ) {
      throw new Error(`Mission node ${node.key} contains an invalid budget.`);
    }
    const executor = node.executor ?? (
      node.type === 'validator' || node.type === 'preview'
        ? 'validator'
        : node.type === 'verifier'
          ? 'verifier'
          : node.type === 'writer'
            ? 'model_agent'
            : 'platform'
    );
    const workspacePolicy = node.workspacePolicy ?? (
      node.effect === 'workspace_write'
        ? 'single_writer'
        : node.effect === 'artifact_write'
          ? 'artifact_only'
          : node.effect === 'read'
            ? 'read_only'
            : 'none'
    );
    if (workspacePolicy === 'single_writer' && node.effect !== 'workspace_write') {
      throw new Error(`Mission node ${node.key} declares single_writer without workspace_write.`);
    }
    if (node.effect === 'workspace_write' && workspacePolicy !== 'single_writer') {
      throw new Error(`Mission node ${node.key} must use the single_writer workspace policy.`);
    }
    if (executor === 'model_agent' && node.type !== 'writer' && !node.agentProfileId) {
      throw new Error(`Model Agent node ${node.key} requires agentProfileId.`);
    }
    const joinPolicy = node.joinPolicy ?? { type: 'all' as const, allowDegradedInputs: false };
    if (
      joinPolicy.type === 'quorum' &&
      (!Number.isSafeInteger(joinPolicy.quorum) ||
        joinPolicy.quorum! <= 0 ||
        joinPolicy.quorum! > node.dependencies.length)
    ) {
      throw new Error(`Mission node ${node.key} contains an invalid quorum.`);
    }
    const failurePolicy = node.failurePolicy ?? {
      mode: node.budget.maxAttempts > 1 ? 'retry' as const : 'fail_fast' as const,
      maxAttempts: node.budget.maxAttempts,
      retryBackoffMs: 1_000,
    };
    if (
      !Number.isSafeInteger(failurePolicy.maxAttempts) ||
      failurePolicy.maxAttempts <= 0 ||
      failurePolicy.maxAttempts > node.budget.maxAttempts ||
      !Number.isSafeInteger(failurePolicy.retryBackoffMs) ||
      failurePolicy.retryBackoffMs < 0 ||
      failurePolicy.retryBackoffMs > 86_400_000
    ) {
      throw new Error(`Mission node ${node.key} contains an invalid failure policy.`);
    }
    const concurrency = node.concurrency ?? {
      group: workspacePolicy === 'single_writer' ? 'workspace-writer' : 'default',
      ...(workspacePolicy === 'single_writer' ? { maxParallel: 1 } : {}),
      priority: 0,
    };
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(concurrency.group) ||
      !Number.isSafeInteger(concurrency.priority) ||
      concurrency.priority < -1_000 ||
      concurrency.priority > 1_000 ||
      (concurrency.maxParallel !== undefined &&
        (!Number.isSafeInteger(concurrency.maxParallel) || concurrency.maxParallel <= 0))
    ) {
      throw new Error(`Mission node ${node.key} contains an invalid concurrency policy.`);
    }
    byKey.set(node.key, {
      ...node,
      executor,
      workspacePolicy,
      dependencies: [...node.dependencies],
      joinPolicy: { ...joinPolicy },
      failurePolicy: { ...failurePolicy },
      concurrency: { ...concurrency },
      allowedTools: [...node.allowedTools],
      requiredSkillSections: [...node.requiredSkillSections],
      inputArtifacts: node.inputArtifacts.map(safeArtifactPattern),
      outputArtifacts: node.outputArtifacts.map(safeArtifactPattern),
      budget: { ...node.budget },
      acceptancePredicates: [...node.acceptancePredicates],
    });
  }
  for (const node of byKey.values()) {
    for (const dependency of node.dependencies) {
      if (!byKey.has(dependency)) {
        throw new Error(`Mission node ${node.key} references missing dependency ${dependency}.`);
      }
      if (dependency === node.key) {
        throw new Error(`Mission node ${node.key} cannot depend on itself.`);
      }
    }
  }
  const visiting = new Set<PiAgentMissionNodeKey>();
  const visited = new Set<PiAgentMissionNodeKey>();
  const depthByKey = new Map<PiAgentMissionNodeKey, number>();
  const visit = (key: PiAgentMissionNodeKey): number => {
    if (visiting.has(key)) throw new Error(`MissionSpec contains a dependency cycle at ${key}.`);
    if (visited.has(key)) return depthByKey.get(key)!;
    visiting.add(key);
    const node = byKey.get(key)!;
    const depth = node.dependencies.length === 0
      ? 1
      : 1 + Math.max(...node.dependencies.map(visit));
    if (depth > MAX_MISSION_DEPTH) {
      throw new Error(`MissionSpec exceeds maximum DAG depth ${MAX_MISSION_DEPTH}.`);
    }
    visiting.delete(key);
    visited.add(key);
    depthByKey.set(key, depth);
    return depth;
  };
  for (const key of byKey.keys()) visit(key);

  const artifactProducer = new Map<string, PiAgentMissionNodeKey>();
  let singleWriterCount = 0;
  for (const node of byKey.values()) {
    if (node.workspacePolicy === 'single_writer') singleWriterCount += 1;
    for (const artifact of node.outputArtifacts) {
      const existing = artifactProducer.get(artifact);
      if (existing) {
        throw new Error(`Mission artifact ${artifact} has multiple producers: ${existing}, ${node.key}.`);
      }
      artifactProducer.set(artifact, node.key);
    }
  }
  if (singleWriterCount > 1) {
    throw new Error('MissionSpec may declare at most one single_writer node.');
  }
  return [...byKey.values()];
}

export function compilePiAgentMissionSpec(input: {
  projectId: string;
  requestId: string;
  objective: string;
  capabilityId: string;
  runPlanId: string;
  composition: PiAgentMissionCompositionRef;
  entities?: readonly PiAgentExpectedEntityRef[];
  maxRepairAttempts: number;
  definition: PiAgentMissionDefinition;
  createdAt?: string;
}): PiAgentMissionSpec {
  if (!Number.isSafeInteger(input.maxRepairAttempts) || input.maxRepairAttempts < 0) {
    throw new Error('maxRepairAttempts must be a non-negative safe integer.');
  }
  const objective = input.objective.trim();
  if (!objective) throw new Error('Mission objective cannot be empty.');
  boundedIdentifier(input.definition.id, 'missionDefinition.id');
  boundedIdentifier(input.definition.version, 'missionDefinition.version', 64);
  const requiredValidationCheckIds = Array.from(new Set(
    input.definition.requiredValidationCheckIds.map((id) =>
      boundedIdentifier(id, 'validation check ID', 128)),
  ));
  const allowedValidationWarnings = Array.from(new Set(
    input.definition.allowedValidationWarnings.map((id) =>
      boundedIdentifier(id, 'validation warning ID', 128)),
  ));
  if (allowedValidationWarnings.some((id) => !requiredValidationCheckIds.includes(id))) {
    throw new Error('Allowed validation warnings must reference required validation checks.');
  }
  const acceptancePredicateIds = new Set<string>();
  const acceptancePredicates = input.definition.acceptancePredicates.map((predicate) => {
    const id = boundedIdentifier(predicate.id, 'acceptance predicate ID', 128);
    if (acceptancePredicateIds.has(id)) throw new Error(`Duplicate acceptance predicate: ${id}`);
    acceptancePredicateIds.add(id);
    return {
      ...predicate,
      id,
      ...(predicate.parameters ? { parameters: structuredClone(predicate.parameters) } : {}),
    };
  });
  const nodes = compileNodes(input.definition.nodes);
  const expectedEntities = new Map<string, PiAgentExpectedEntityRef>();
  for (const entity of input.entities ?? []) {
    const normalized = {
      entityType: boundedIdentifier(entity.entityType, 'entityType', 128),
      canonicalId: boundedIdentifier(entity.canonicalId, 'canonicalId', 256),
    };
    expectedEntities.set(`${normalized.entityType}\0${normalized.canonicalId}`, normalized);
  }
  return {
    schemaVersion: 1,
    framework: 'PI Agent',
    projectId: boundedIdentifier(input.projectId, 'projectId'),
    requestId: boundedIdentifier(input.requestId, 'requestId'),
    objectiveSha256: `sha256:${sha256(objective)}`,
    composition: {
      profileId: boundedIdentifier(input.composition.profileId, 'profileId'),
      profileVersion: boundedIdentifier(input.composition.profileVersion, 'profileVersion', 64),
      domainPacks: Array.from(
        new Map(input.composition.domainPacks.map((pack) => {
          const id = boundedIdentifier(pack.id, 'domainPackId');
          return [id, {
            id,
            version: boundedIdentifier(pack.version, 'domainPackVersion', 64),
          }] as const;
        })).values(),
      ).sort((left, right) => left.id.localeCompare(right.id)),
      deliveryPackId: boundedIdentifier(input.composition.deliveryPackId, 'deliveryPackId'),
      deliveryPackVersion: boundedIdentifier(
        input.composition.deliveryPackVersion,
        'deliveryPackVersion',
        64,
      ),
      compositionSha256: boundedSha256(
        input.composition.compositionSha256,
        'compositionSha256',
      ),
    },
    capabilityId: boundedIdentifier(input.capabilityId, 'capabilityId'),
    runPlanId: boundedIdentifier(input.runPlanId, 'runPlanId'),
    validationReportPath: safeArtifactPattern(input.definition.validationReportPath),
    expectedEntities: [...expectedEntities.values()].sort((left, right) =>
      left.entityType.localeCompare(right.entityType) ||
      left.canonicalId.localeCompare(right.canonicalId)),
    artifacts: compileArtifacts(input.definition.artifacts),
    requiredValidationCheckIds,
    allowedValidationWarnings,
    maxRepairAttempts: input.maxRepairAttempts,
    nodes,
    acceptancePredicates,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
