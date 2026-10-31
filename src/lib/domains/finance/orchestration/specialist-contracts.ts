import { z } from 'zod';

const evidenceRef = z.object({
  id: z.string().trim().min(1).max(256),
  source: z.string().trim().min(1).max(512),
}).strict();

const claim = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  statement: z.string().trim().min(1).max(4_096),
  evidenceIds: z.array(z.string().trim().min(1).max(256)).max(32),
  confidence: z.number().min(0).max(1),
}).strict();

const baseSpecialistResult = z.object({
  schemaVersion: z.literal(1),
  agentRole: z.string().trim().min(1).max(64),
  asOf: z.string().datetime({ offset: true }),
  summary: z.string().trim().min(1).max(8_000),
  claims: z.array(claim).max(100),
  evidence: z.array(evidenceRef).max(200),
  uncertainties: z.array(z.string().trim().min(1).max(2_048)).max(50),
}).strict();

const riskCategories = [
  'lookahead_bias',
  'survivorship_bias',
  'data_gap',
  'unsupported_claim',
  'concentration',
  'model_uncertainty',
] as const;

const riskCategoryAliases: Readonly<Record<string, typeof riskCategories[number]>> = {
  lookahead: 'lookahead_bias',
  future_leakage: 'lookahead_bias',
  leakage: 'lookahead_bias',
  survivorship: 'survivorship_bias',
  missing_data: 'data_gap',
  stale_data: 'data_gap',
  data_quality: 'data_gap',
  insufficient_data: 'data_gap',
  unsupported: 'unsupported_claim',
  unsupported_assumption: 'unsupported_claim',
  concentration_risk: 'concentration',
  portfolio_concentration: 'concentration',
  uncertainty: 'model_uncertainty',
  model_risk: 'model_uncertainty',
};

function normalizeRiskCategory(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((riskCategories as readonly string[]).includes(key)) return key;
  return riskCategoryAliases[key] ?? 'model_uncertainty';
}

const riskFinding = z.object({
  category: z.preprocess(normalizeRiskCategory, z.enum(riskCategories)),
  severity: z.enum(['info', 'warning', 'blocking']),
  targetClaimId: z.string().trim().min(1).max(128).optional(),
  explanation: z.string().trim().min(1).max(4_096),
  evidenceIds: z.array(z.string().trim().min(1).max(256)).max(32),
}).strict();

const riskResult = z.object({
  schemaVersion: z.literal(1),
  agentRole: z.enum(['risk_precheck', 'risk_crosscheck']),
  asOf: z.string().datetime({ offset: true }),
  summary: z.string().trim().min(1).max(8_000),
  reviewedArtifactHashes: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(16),
  findings: z.array(riskFinding).max(100),
  blocking: z.boolean(),
}).strict();

function synthesisPositionText(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const text = [record.position, record.statement, record.summary, record.text, record.claim]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  if (!text) return JSON.stringify(record);
  const source = [record.agentRole, record.role, record.source, record.side]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  return source ? `${source}: ${text}` : text;
}

function normalizeDisputedClaims(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return {
      statement: record.statement,
      positions: Array.isArray(record.positions)
        ? record.positions.map(synthesisPositionText)
        : record.positions,
    };
  });
}

const synthesisResult = z.object({
  schemaVersion: z.literal(1),
  agentRole: z.literal('synthesis'),
  asOf: z.string().datetime({ offset: true }),
  summary: z.string().trim().min(1).max(12_000),
  sourceArtifacts: z.array(z.object({
    artifactId: z.string().uuid(),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict()).min(1).max(16),
  consensusClaims: z.array(claim).max(100),
  disputedClaims: z.preprocess(normalizeDisputedClaims, z.array(z.object({
    statement: z.string().trim().min(1).max(4_096),
    positions: z.array(z.string().trim().min(1).max(2_048)).min(2).max(8),
  }).strict()).max(50)),
  rejectedClaims: z.array(z.object({
    claimId: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(2_048),
  }).strict()).max(100),
  dashboardBrief: z.object({
    title: z.string().trim().min(1).max(160),
    sections: z.array(z.string().trim().min(1).max(160)).min(1).max(12),
    riskDisclosure: z.string().trim().min(1).max(4_096),
  }).strict(),
  unresolvedRisks: z.array(z.string().trim().min(1).max(2_048)).max(50),
}).strict();

export type PiAgentSpecialistRole =
  | 'fundamental_research'
  | 'technical_analysis'
  | 'risk_precheck'
  | 'risk_crosscheck'
  | 'synthesis';

export class PiAgentSpecialistContractError extends Error {
  constructor(
    readonly role: PiAgentSpecialistRole,
    readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    const visible = issues.slice(0, 8);
    const summary = visible
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    const remaining = issues.length - visible.length;
    super(
      `Specialist ${role} returned an invalid result: ${summary}` +
      (remaining > 0 ? `; +${remaining} more issue(s)` : ''),
    );
    this.name = 'PiAgentSpecialistContractError';
  }
}

function contractExample(role: PiAgentSpecialistRole): Record<string, unknown> {
  const asOf = '2026-10-29T00:00:00+08:00';
  if (role === 'risk_precheck' || role === 'risk_crosscheck') {
    return {
      schemaVersion: 1,
      agentRole: role,
      asOf,
      summary: 'Bounded risk review summary.',
      reviewedArtifactHashes: [],
      findings: [{
        category: 'data_gap',
        severity: 'warning',
        ...(role === 'risk_crosscheck' ? { targetClaimId: 'copy-an-exact-referenceCatalog-claimId-or-omit-this-key' } : {}),
        explanation: 'Describe the concrete risk or gap.',
        evidenceIds: ['evidence:copy-an-exact-supplied-id'],
      }],
      blocking: false,
    };
  }
  if (role === 'synthesis') {
    return {
      schemaVersion: 1,
      agentRole: 'synthesis',
      asOf,
      summary: 'Evidence-bound synthesis.',
      sourceArtifacts: [{
        artifactId: 'copy-an-exact-input-artifact-uuid',
        sha256: 'copy-the-matching-sha256:hash',
      }],
      consensusClaims: [{
        id: 'copy-an-exact-upstream-claim-id',
        statement: 'Copy the exact upstream statement without paraphrasing.',
        evidenceIds: ['evidence:copy-an-upstream-id'],
        confidence: 0.8,
      }],
      disputedClaims: [],
      rejectedClaims: [],
      dashboardBrief: {
        title: 'Dashboard title',
        sections: ['Overview', 'Risks'],
        riskDisclosure: 'State material limitations and uncertainty.',
      },
      unresolvedRisks: [],
    };
  }
  return {
    schemaVersion: 1,
    agentRole: role,
    asOf,
    summary: 'Evidence-bound specialist summary.',
    claims: [{
      id: `${role}-claim-1`,
      statement: 'A supported point-in-time statement.',
      evidenceIds: ['evidence:copy-an-exact-supplied-id'],
      confidence: 0.8,
    }],
    evidence: [{
      id: 'evidence:copy-an-exact-supplied-id',
      source: 'copy-the-exact-supplied-source-path',
    }],
    uncertainties: [],
  };
}

export function specialistResultInstruction(role: PiAgentSpecialistRole): string {
  const instructions = [
    'Return exactly this object shape with every listed key present; replace example values with supported values:',
    JSON.stringify(contractExample(role), null, 2),
    'asOf must be an RFC 3339 timestamp with timezone, for example 2026-10-29T00:00:00+08:00.',
    'Do not rename keys, add keys, wrap the object, or return markdown.',
    'Use [] when an optional collection has no supported entries.',
  ];
  if (role === 'risk_precheck' || role === 'risk_crosscheck') {
    instructions.push(`Every finding.category must be exactly one of: ${riskCategories.join(', ')}.`);
    instructions.push(
      'Use severity=blocking and blocking=true only for a proven material integrity violation; data gaps, staleness, missing context, and model uncertainty are info or warning findings.',
    );
  }
  if (role === 'synthesis') {
    instructions.push(
      'Each disputedClaims entry must contain exactly statement and positions; positions must be an array of at least two plain strings, never objects. Use disputedClaims=[] when there is no actual dispute.',
    );
  }
  return instructions.join('\n');
}

export function parsePiAgentSpecialistResult(role: PiAgentSpecialistRole, value: unknown): unknown {
  const schema = role === 'risk_precheck' || role === 'risk_crosscheck'
    ? riskResult
    : role === 'synthesis'
      ? synthesisResult
      : baseSpecialistResult;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PiAgentSpecialistContractError(
      role,
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : 'result',
        message: issue.message,
      })),
    );
  }
  const parsed = result.data;
  if (role === 'risk_precheck' || role === 'risk_crosscheck' || role === 'synthesis') {
    return parsed;
  }
  if (parsed.agentRole !== role) {
    throw new Error(`Specialist result role mismatch: expected ${role}.`);
  }
  return parsed;
}

export function specialistSchemaId(role: PiAgentSpecialistRole): string {
  return `quantpilot.finance.${role.replaceAll('_', '-')}-result`;
}
