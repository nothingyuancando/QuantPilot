import type {
  PiAgentArtifactMutability,
  PiAgentArtifactRequirement,
  PiAgentArtifactRole,
  PiAgentMissionDefinition,
  PiAgentMissionNodeBudget,
  PiAgentMissionNodeSpec,
} from '@/lib/agent/mission';

export const FINANCE_REQUIRED_VALIDATION_CHECK_IDS = [
  'artifact_policy',
  'next_build',
  'preview_http_200',
  'visual_presentation',
  'final_data_file',
  'evidence_files',
  'artifact_contracts',
  'dashboard_data_binding',
  'chart_presence',
  'market_proxy',
] as const;

export const FINANCE_ALLOWED_VALIDATION_WARNINGS = ['evidence_files'] as const;

export const FINANCE_MULTI_AGENT_ARTIFACTS = {
  fundamental: '.data-agent/multi-agent/fundamental-research.json',
  technical: '.data-agent/multi-agent/technical-analysis.json',
  riskPrecheck: '.data-agent/multi-agent/risk-precheck.json',
  riskCrosscheck: '.data-agent/multi-agent/risk-crosscheck.json',
  synthesis: '.data-agent/multi-agent/synthesis.json',
} as const;

const SUBJECT_ARTIFACTS = [
  '.data-agent/workspace.json',
  '.data-agent/profile.json',
  '.data-agent/task.json',
  '.data-agent/plan.json',
  '.data-agent/finance-query-rewrite.json',
  '.data-agent/finance-run-plan.json',
  'app/page.tsx',
  'app/globals.css',
  'app/layout.tsx',
  'app/api/market/[...path]/route.ts',
  'package.json',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
] as const;

const OPTIONAL_SUBJECT_ARTIFACTS = [
  'components/**',
  'lib/**',
  'src/**',
  'scripts/**',
  'public/**',
  'data_file/final/**',
  'next.config.*',
  'postcss.config.*',
  'tailwind.config.*',
  'tsconfig.json',
  'tsconfig.*.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'components.json',
] as const;

const EVIDENCE_ARTIFACTS = [
  '.data-agent/validation.json',
  '.data-agent/visual-validation.json',
  '.data-agent/artifact-contracts.json',
] as const;

const CONTROL_ARTIFACTS = [
  '.data-agent/generation-state.json',
  '.data-agent/generation-queue.json',
  '.data-agent/events.jsonl',
] as const;

function classification(path: string): {
  role: PiAgentArtifactRole;
  mutability: PiAgentArtifactMutability;
} {
  if ((CONTROL_ARTIFACTS as readonly string[]).includes(path)) {
    return { role: 'control', mutability: 'mutable' };
  }
  if (
    (EVIDENCE_ARTIFACTS as readonly string[]).includes(path) ||
    path.startsWith('.data-agent/screenshots/')
  ) {
    return { role: 'evidence', mutability: 'derived' };
  }
  return { role: 'subject', mutability: 'frozen' };
}

function artifacts(expectedArtifacts: readonly string[]): PiAgentArtifactRequirement[] {
  const result = new Map<string, PiAgentArtifactRequirement>();
  const add = (
    path: string,
    required: boolean,
    kind = classification(path),
  ) => {
    const existing = result.get(path);
    if (existing?.required && !required) return;
    result.set(path, { path, ...kind, required });
  };
  for (const path of SUBJECT_ARTIFACTS) add(path, true);
  for (const path of expectedArtifacts) add(path, true);
  for (const path of EVIDENCE_ARTIFACTS) add(path, true);
  for (const path of CONTROL_ARTIFACTS) add(path, true);
  for (const path of OPTIONAL_SUBJECT_ARTIFACTS) add(path, false);
  add('evidence/**', false, { role: 'evidence', mutability: 'derived' });
  return [...result.values()];
}

function budget(overrides: Partial<PiAgentMissionNodeBudget>): PiAgentMissionNodeBudget {
  return {
    maxAttempts: 1,
    maxToolCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    timeoutMs: 120_000,
    ...overrides,
  };
}

function nodes(maxRepairAttempts: number): PiAgentMissionNodeSpec[] {
  return [
    {
      key: 'planning',
      type: 'planner',
      effect: 'platform_write',
      dependencies: [],
      allowedTools: [],
      requiredSkillSections: ['query-rewrite', 'run-planner'],
      inputArtifacts: ['.data-agent/finance-query-rewrite.json'],
      outputArtifacts: [
        '.data-agent/task.json',
        '.data-agent/plan.json',
        '.data-agent/finance-run-plan.json',
      ],
      budget: budget({ timeoutMs: 120_000 }),
      acceptancePredicates: ['run_plan_created'],
    },
    {
      key: 'data_prefetch',
      type: 'data',
      effect: 'platform_write',
      dependencies: ['planning'],
      allowedTools: [],
      requiredSkillSections: ['query-rewrite', 'quant-market-data', 'data-quality'],
      inputArtifacts: [
        '.data-agent/task.json',
        '.data-agent/plan.json',
        '.data-agent/finance-query-rewrite.json',
        '.data-agent/finance-run-plan.json',
      ],
      outputArtifacts: [
        'data_file/final/dashboard-data.json',
        'evidence/sources.json',
        'evidence/data_quality.json',
      ],
      budget: budget({ timeoutMs: 180_000 }),
      acceptancePredicates: ['prefetched_artifacts_present'],
    },
    {
      key: 'workspace_generation',
      type: 'writer',
      effect: 'workspace_write',
      dependencies: ['data_prefetch'],
      allowedTools: [
        'inspect_dashboard_contract',
        'query_json',
        'query_text_file',
        'apply_dashboard_spec',
        'semantic_edit',
        'write_file',
        'edit_file',
        'apply_patch',
        'submit_result',
      ],
      requiredSkillSections: ['dashboard-visualization'],
      inputArtifacts: [
        '.data-agent/finance-query-rewrite.json',
        '.data-agent/finance-run-plan.json',
        'data_file/final/dashboard-data.json',
        'evidence/sources.json',
        'evidence/data_quality.json',
      ],
      outputArtifacts: ['app/page.tsx', 'app/globals.css'],
      budget: budget({
        maxAttempts: 1 + maxRepairAttempts,
        maxToolCalls: 20,
        maxInputTokens: 160_000,
        maxOutputTokens: 24_000,
        timeoutMs: 1_200_000,
      }),
      acceptancePredicates: ['candidate_submission'],
    },
    {
      key: 'validation',
      type: 'validator',
      effect: 'verification',
      dependencies: ['workspace_generation'],
      allowedTools: [],
      requiredSkillSections: [],
      inputArtifacts: ['app/page.tsx', 'app/globals.css'],
      outputArtifacts: [
        '.data-agent/validation.json',
        '.data-agent/visual-validation.json',
        '.data-agent/artifact-contracts.json',
      ],
      budget: budget({ maxAttempts: 1 + maxRepairAttempts, timeoutMs: 600_000 }),
      acceptancePredicates: ['required_validation_checks'],
    },
    {
      key: 'preview_readiness',
      type: 'preview',
      effect: 'verification',
      dependencies: ['validation'],
      allowedTools: [],
      requiredSkillSections: [],
      inputArtifacts: ['app/page.tsx'],
      outputArtifacts: [],
      budget: budget({ maxAttempts: 2, timeoutMs: 120_000 }),
      acceptancePredicates: ['preview_http_ready'],
    },
    {
      key: 'evidence_verification',
      type: 'verifier',
      effect: 'verification',
      dependencies: ['validation', 'preview_readiness'],
      allowedTools: [],
      requiredSkillSections: [],
      inputArtifacts: [
        '.data-agent/validation.json',
        '.data-agent/visual-validation.json',
        '.data-agent/artifact-contracts.json',
      ],
      outputArtifacts: [],
      budget: budget({ maxAttempts: 1 + maxRepairAttempts, timeoutMs: 60_000 }),
      acceptancePredicates: [
        'subject_manifest_stable',
        'derived_evidence_present',
        'preview_http_ready',
      ],
    },
  ];
}

export function createFinanceMissionDefinition(input: {
  maxRepairAttempts: number;
  expectedArtifacts?: readonly string[];
}): PiAgentMissionDefinition {
  return {
    id: 'finance.quant-workspace',
    version: '1.0.0',
    validationReportPath: '.data-agent/validation.json',
    artifacts: artifacts(input.expectedArtifacts ?? []),
    requiredValidationCheckIds: [...FINANCE_REQUIRED_VALIDATION_CHECK_IDS],
    allowedValidationWarnings: [...FINANCE_ALLOWED_VALIDATION_WARNINGS],
    nodes: nodes(input.maxRepairAttempts),
    acceptancePredicates: [
      { id: 'candidate_submission', kind: 'candidate_submission', required: true },
      {
        id: 'required_validation_checks',
        kind: 'required_validation_checks',
        required: true,
        parameters: { checkIds: [...FINANCE_REQUIRED_VALIDATION_CHECK_IDS] },
      },
      { id: 'subject_manifest_stable', kind: 'subject_manifest_stable', required: true },
      { id: 'derived_evidence_present', kind: 'derived_evidence_present', required: true },
      { id: 'preview_http_ready', kind: 'preview_http_ready', required: true },
    ],
  };
}

/**
 * Fixed, trusted v1 multi-Agent topology. It is intentionally separate from
 * the current production definition until the durable node Worker is enabled;
 * callers cannot inject nodes or profiles through request data.
 */
export function createFinanceMultiAgentMissionDefinition(input: {
  maxRepairAttempts: number;
  expectedArtifacts?: readonly string[];
}): PiAgentMissionDefinition {
  const base = createFinanceMissionDefinition(input);
  const dataPrefetch = base.nodes.find((node) => node.key === 'data_prefetch');
  const writer = base.nodes.find((node) => node.key === 'workspace_generation');
  if (!dataPrefetch || !writer) throw new Error('Finance Mission base topology is incomplete.');

  const specialistBudget = budget({
    maxAttempts: 2,
    maxToolCalls: 3,
    maxInputTokens: 48_000,
    // Initial extraction and a complete corrective JSON response share this
    // budget. Real portfolio runs exhausted 8k during the correction.
    maxOutputTokens: 16_000,
    timeoutMs: 300_000,
  });
  const specialist = (
    key: string,
    profile: string,
    output: string,
  ): PiAgentMissionNodeSpec => ({
    key,
    type: 'analyst',
    executor: 'model_agent',
    agentProfileId: profile,
    agentProfileVersion: '1.0.0',
    effect: 'artifact_write',
    workspacePolicy: 'artifact_only',
    dependencies: ['data_prefetch'],
    joinPolicy: { type: 'all', allowDegradedInputs: false },
    failurePolicy: { mode: 'retry', maxAttempts: 2, retryBackoffMs: 1_000 },
    concurrency: { group: 'finance-research', maxParallel: 3, priority: 50 },
    allowedTools: ['retrieve_finance_evidence'],
    requiredSkillSections: ['quant-market-data', 'data-quality'],
    inputArtifacts: [...dataPrefetch.outputArtifacts, '.data-agent/finance-run-plan.json'],
    outputArtifacts: [output],
    budget: specialistBudget,
    acceptancePredicates: ['derived_evidence_present'],
  });

  const fundamental = specialist(
    'fundamental_research',
    'quantpilot.finance.fundamental',
    FINANCE_MULTI_AGENT_ARTIFACTS.fundamental,
  );
  const technical = specialist(
    'technical_analysis',
    'quantpilot.finance.technical',
    FINANCE_MULTI_AGENT_ARTIFACTS.technical,
  );
  const riskPrecheck = specialist(
    'risk_precheck',
    'quantpilot.finance.risk-precheck',
    FINANCE_MULTI_AGENT_ARTIFACTS.riskPrecheck,
  );
  const riskCrosscheck: PiAgentMissionNodeSpec = {
    ...specialist(
      'risk_crosscheck',
      'quantpilot.finance.risk-crosscheck',
      FINANCE_MULTI_AGENT_ARTIFACTS.riskCrosscheck,
    ),
    dependencies: ['fundamental_research', 'technical_analysis', 'risk_precheck'],
    inputArtifacts: [
      '.data-agent/finance-run-plan.json',
      FINANCE_MULTI_AGENT_ARTIFACTS.fundamental,
      FINANCE_MULTI_AGENT_ARTIFACTS.technical,
      FINANCE_MULTI_AGENT_ARTIFACTS.riskPrecheck,
    ],
    concurrency: { group: 'finance-review', maxParallel: 1, priority: 70 },
  };
  const synthesis: PiAgentMissionNodeSpec = {
    key: 'synthesis',
    type: 'synthesizer',
    executor: 'model_agent',
    agentProfileId: 'quantpilot.finance.synthesis',
    agentProfileVersion: '1.0.0',
    effect: 'artifact_write',
    workspacePolicy: 'artifact_only',
    dependencies: ['fundamental_research', 'technical_analysis', 'risk_precheck', 'risk_crosscheck'],
    joinPolicy: { type: 'all', allowDegradedInputs: false },
    failurePolicy: { mode: 'retry', maxAttempts: 2, retryBackoffMs: 1_000 },
    concurrency: { group: 'finance-synthesis', maxParallel: 1, priority: 80 },
    allowedTools: ['retrieve_finance_evidence'],
    requiredSkillSections: ['dashboard-visualization'],
    inputArtifacts: [
      '.data-agent/finance-run-plan.json',
      FINANCE_MULTI_AGENT_ARTIFACTS.fundamental,
      FINANCE_MULTI_AGENT_ARTIFACTS.technical,
      FINANCE_MULTI_AGENT_ARTIFACTS.riskCrosscheck,
      FINANCE_MULTI_AGENT_ARTIFACTS.riskPrecheck,
    ],
    outputArtifacts: [FINANCE_MULTI_AGENT_ARTIFACTS.synthesis],
    budget: budget({
      maxAttempts: 2,
      maxToolCalls: 3,
      maxInputTokens: 48_000,
      // A complete synthesis and one schema/lineage correction share this
      // budget; both must retain every unresolved upstream risk.
      maxOutputTokens: 16_000,
      timeoutMs: 300_000,
    }),
    acceptancePredicates: ['derived_evidence_present'],
  };

  const nodes = base.nodes.flatMap((node) => {
    if (node.key === 'workspace_generation') {
      return [{
        ...node,
        dependencies: ['synthesis'],
        inputArtifacts: [...node.inputArtifacts, FINANCE_MULTI_AGENT_ARTIFACTS.synthesis],
      }];
    }
    if (node.key === 'data_prefetch') {
      return [node, fundamental, technical, riskPrecheck, riskCrosscheck, synthesis];
    }
    return [node];
  });
  return {
    ...base,
    id: `${base.id}.multi-agent`,
    version: '2.0.0',
    artifacts: [
      ...base.artifacts,
      ...Object.values(FINANCE_MULTI_AGENT_ARTIFACTS).map((path) => ({
        path,
        role: 'evidence' as const,
        mutability: 'derived' as const,
        required: true,
      })),
    ],
    nodes,
  };
}
