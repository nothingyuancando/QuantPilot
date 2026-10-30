import type { QuantEvalMultiAgentComparison, QuantEvalRun } from './types';

function caseSelectionKey(run: QuantEvalRun): string {
  const selected = run.metadata.selection.selectedCases.length > 0
    ? [...run.metadata.selection.selectedCases].sort()
    : run.results.map((result) => result.id).sort();
  return JSON.stringify({
    cases: selected,
    evaluator: run.metadata.evaluator.id,
    model: run.metadata.runtime.configuredModel ?? run.metadata.runtime.model,
    suite: run.metadata.suite?.mode ?? 'contract',
  });
}

function totalTokens(run: QuantEvalRun): number {
  return run.results.reduce(
    (total, result) => total + (result.agentExecution?.usage.totalTokens ?? 0),
    0,
  );
}

export function buildMultiAgentComparison(
  runs: readonly QuantEvalRun[],
): QuantEvalMultiAgentComparison {
  const groups = new Map<string, { single?: QuantEvalRun; multi?: QuantEvalRun }>();
  for (const run of runs) {
    if (run.metadata.suite?.mode !== 'e2e') continue;
    const key = caseSelectionKey(run);
    const group = groups.get(key) ?? {};
    if (run.metadata.runtime.orchestrationMode === 'multi_agent') group.multi ??= run;
    else group.single ??= run;
    groups.set(key, group);
  }
  for (const [comparisonKey, group] of groups) {
    if (!group.single || !group.multi) continue;
    return {
      available: true,
      comparisonKey,
      singleAgentRunId: group.single.id,
      multiAgentRunId: group.multi.id,
      passRateDelta: group.multi.passRate - group.single.passRate,
      averageScoreDelta: group.multi.averageScore - group.single.averageScore,
      durationDeltaMs: group.multi.durationMs - group.single.durationMs,
      totalTokenDelta: totalTokens(group.multi) - totalTokens(group.single),
    };
  }
  const latestSingle = runs.find((run) => run.metadata.runtime.orchestrationMode !== 'multi_agent');
  const latestMulti = runs.find((run) => run.metadata.runtime.orchestrationMode === 'multi_agent');
  return {
    available: false,
    comparisonKey: null,
    singleAgentRunId: latestSingle?.id ?? null,
    multiAgentRunId: latestMulti?.id ?? null,
    passRateDelta: null,
    averageScoreDelta: null,
    durationDeltaMs: null,
    totalTokenDelta: null,
  };
}
