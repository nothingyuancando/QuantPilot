import assert from 'node:assert/strict';
import { assessResearch, candidateWithinWatchlist, canonicalResearchSymbol, decideFinanceRisk } from '../../src/lib/domains/finance/research-policy';
import { resolveResearchTime } from '../../src/lib/domains/finance/research-time';
import { assertResearchScope, assertSameResearchProject, scopedResearchId } from '../../src/lib/quant/research-scope';
import { retrieveFinanceEvidence } from '../../src/lib/domains/finance/orchestration/finance-evidence-retrieval';
import { validateFinanceCollaboration } from '../../src/lib/domains/finance/orchestration/collaboration-policy';
import { buildMultiAgentComparison } from '../../src/lib/eval/multi-agent-comparison';
import type { QuantEvalRun } from '../../src/lib/eval/types';

export interface BusinessCase { id: string; category: string; check(): void }
const scope = { projectId: 'research-a', actorUserId: 'owner-a' };
const assessment = (changes: Partial<Parameters<typeof assessResearch>[0]> = {}) => assessResearch({ coverageRatio: 1, sourceStatuses: ['available'], candidates: [{ score: 80 }], ...changes });
const watchlist = { symbols: ['600519.SH'], markets: ['A股'], endDate: '2025-12-31' };
const candidate = { symbol: '600519.SH', trade_date: '2025-12-31' };
const cutoffNow = new Date('2026-01-02T00:00:00Z');
const time = (changes: Record<string, string> = {}) => resolveResearchTime({ unit: 'date_range', endDate: '2025-12-31', asOf: '2025-12-31T23:59:59.999+08:00', ...changes }, cutoffNow);
const claim = { id: 'valuation', statement: '估值存在不确定性', evidenceIds: ['e1'], confidence: 0.6 };
const artifact = { artifactId: 'a1', expectedSha256: 'sha256:abc', content: JSON.stringify({ claims: [claim] }) };
const synthesis = () => ({ asOf: '2025-12-31T15:59:59.999Z', sourceArtifacts: [{ artifactId: 'a1', sha256: 'sha256:abc' }], consensusClaims: [{ ...claim }], rejectedClaims: [], disputedClaims: [], unresolvedRisks: [] });
const validate = (result: Record<string, unknown>, artifacts = [artifact]) => validateFinanceCollaboration({ role: 'synthesis', result, artifacts });
const finding = { category: 'lookahead_bias', severity: 'blocking', evidenceIds: ['e1'], explanation: '存在未来数据', targetClaimId: 'valuation' };

export function pairedRun(mode: 'single_agent' | 'multi_agent'): QuantEvalRun {
  return {
    id: mode, passRate: 80, averageScore: 75, durationMs: 100,
    metadata: {
      evaluator: { id: 'independent-review', version: '1', rubricVersion: '1' },
      runtime: { model: 'fixture-model', orchestrationMode: mode, reasoningEffort: '', frameworkVersion: '1', buildRevision: 'same' },
      suite: { mode: 'e2e' },
      provenance: { experimentId: 'controlled-1', casesSha256: 'cases', promptsSha256: 'prompts', snapshotManifestSha256: 'manifest', frozenInputsSha256: 'full-responses', toolConfigSha256: 'tools' },
      dataSnapshots: { selected: [{ caseId: 'c1', id: 's1', asOf: '2025-12-31', payloadSha256: 'payload' }] },
      selection: { selectedCases: ['c1'], repeat: 1 }, skillLockSnapshot: { schemaVersion: 1, skills: {} },
    },
    results: [{ id: 'c1', agentExecution: { usage: { totalTokens: 100 } } }],
  } as QuantEvalRun;
}

export const researchBusinessCases: BusinessCase[] = [
  { id: 'watchlist-malformed-date', category: 'scope', check: () => assert.equal(candidateWithinWatchlist({ ...candidate, trade_date: '2025-02-30' }, watchlist), false) },
  { id: 'watchlist-unparseable-date', category: 'scope', check: () => assert.equal(candidateWithinWatchlist({ ...candidate, trade_date: 'invalid' }, watchlist), false) },
  { id: 'retrieval-retains-row-context', category: 'retrieval', check: () => { const result = retrieveFinanceEvidence({ role: 'technical_analysis', question: 'close', documents: [{ path: 'bars', content: JSON.stringify([{ symbol: '600519.SH', date: '2025-12-31', close: 1500 }]) }] }); const close = result.find((item) => item.jsonPath.endsWith('.close')); assert.ok(close); assert.match(close.text, /600519.SH/); assert.match(close.text, /2025-12-31/); } },
  { id: 'crosscheck-unknown-target', category: 'collaboration', check: () => assert.throws(() => validateFinanceCollaboration({ role: 'risk_crosscheck', artifacts: [artifact], result: { reviewedArtifactHashes: ['sha256:abc'], findings: [{ ...finding, targetClaimId: 'invented' }] } })) },
  { id: 'crosscheck-missing-reviewed-hash', category: 'collaboration', check: () => assert.throws(() => validateFinanceCollaboration({ role: 'risk_crosscheck', artifacts: [artifact], result: { reviewedArtifactHashes: [], findings: [] } })) },
  { id: 'quality-zero-coverage', category: 'assessment', check: () => assert.equal(assessment({ coverageRatio: 0 }).dataConfidence, 0) },
  { id: 'quality-partial-source', category: 'assessment', check: () => assert.equal(assessment({ sourceStatuses: ['partial'] }).dataConfidence, 50) },
  { id: 'quality-missing-source', category: 'assessment', check: () => assert.equal(assessment({ sourceStatuses: [] }).dataConfidence, 0) },
  { id: 'quality-invalid-coverage', category: 'assessment', check: () => assert.equal(assessment({ coverageRatio: NaN }).dataConfidence, 0) },
  { id: 'risk-not-inferred-from-coverage', category: 'assessment', check: () => assert.equal(assessment().investmentRisk, 'unknown') },
  { id: 'risk-explicit-high', category: 'assessment', check: () => assert.equal(assessment({ candidates: [{ riskLevel: 'low' }, { riskLevel: 'high' }] }).investmentRisk, 'high') },
  { id: 'risk-incomplete-is-unknown', category: 'assessment', check: () => assert.equal(assessment({ candidates: [{ riskLevel: 'low' }, {}] }).investmentRisk, 'unknown') },
  { id: 'signal-not-inferred-from-service', category: 'assessment', check: () => assert.equal(assessment({ sourceStatuses: ['unavailable'] }).signalStrength, 80) },
  { id: 'signal-empty-is-unknown', category: 'assessment', check: () => assert.equal(assessment({ candidates: [] }).signalStrength, null) },
  { id: 'signal-invalid-score-rejected', category: 'assessment', check: () => assert.equal(assessment({ candidates: [{ score: 1000 }] }).signalStrength, null) },
  { id: 'watchlist-exact-member', category: 'scope', check: () => assert.equal(candidateWithinWatchlist(candidate, watchlist), true) },
  { id: 'watchlist-other-member', category: 'scope', check: () => assert.equal(candidateWithinWatchlist({ ...candidate, symbol: '000001.SZ' }, watchlist), false) },
  { id: 'watchlist-bare-code', category: 'scope', check: () => assert.equal(candidateWithinWatchlist({ ...candidate, symbol: '600519' }, watchlist), false) },
  { id: 'watchlist-future-bar', category: 'scope', check: () => assert.equal(candidateWithinWatchlist({ ...candidate, trade_date: '2026-01-01' }, watchlist), false) },
  { id: 'watchlist-missing-date', category: 'scope', check: () => assert.equal(candidateWithinWatchlist({ symbol: candidate.symbol }, watchlist), false) },
  { id: 'watchlist-etf-excludes-stock', category: 'scope', check: () => assert.equal(candidateWithinWatchlist(candidate, { ...watchlist, markets: ['ETF'] }), false) },
  { id: 'watchlist-etf-explicit', category: 'scope', check: () => assert.equal(candidateWithinWatchlist({ ...candidate, asset_type: 'etf' }, { ...watchlist, markets: ['ETF'] }), true) },
  { id: 'symbol-exchange-normalization', category: 'scope', check: () => assert.equal(canonicalResearchSymbol(' 600519.sh '), '600519.SH') },
  { id: 'project-empty-rejected', category: 'isolation', check: () => assert.throws(() => assertResearchScope({ ...scope, projectId: '' })) },
  { id: 'actor-empty-rejected', category: 'isolation', check: () => assert.throws(() => assertResearchScope({ ...scope, actorUserId: '' })) },
  { id: 'project-cross-resource', category: 'isolation', check: () => assert.throws(() => assertSameResearchProject(scope, [{ projectId: 'research-b' }])) },
  { id: 'project-legacy-quarantine', category: 'isolation', check: () => assert.throws(() => assertSameResearchProject(scope, [{ projectId: null }])) },
  { id: 'project-distinct-defaults', category: 'isolation', check: () => assert.notEqual(scopedResearchId(scope, 'watchlist'), scopedResearchId({ ...scope, projectId: 'research-b' }, 'watchlist')) },
  { id: 'time-complete-day', category: 'time', check: () => assert.equal(time()?.endDate, '2025-12-31') },
  { id: 'time-intraday-exclusion', category: 'time', check: () => assert.equal(time({ asOf: '2025-12-31T14:00:00+08:00' })?.endDate, '2025-12-30') },
  { id: 'time-future-rejected', category: 'time', check: () => assert.throws(() => time({ endDate: '2027-01-01', asOf: '2027-01-01T23:59:59.999+08:00' })) },
  { id: 'time-invalid-calendar', category: 'time', check: () => assert.throws(() => time({ endDate: '2025-02-30' })) },
  { id: 'time-reversed-window', category: 'time', check: () => assert.throws(() => time({ startDate: '2026-01-01' })) },
  { id: 'risk-model-veto-insufficient', category: 'collaboration', check: () => assert.equal(decideFinanceRisk([finding], new Set(['e1'])).action, 'restrict') },
  { id: 'risk-verified-claim-rejected', category: 'collaboration', check: () => assert.deepEqual(decideFinanceRisk([finding], new Set(['e1']), new Set([0])).rejectedClaimIds, ['valuation']) },
  { id: 'risk-unknown-evidence-no-veto', category: 'collaboration', check: () => assert.equal(decideFinanceRisk([finding], new Set(), new Set([0])).action, 'restrict') },
  { id: 'synthesis-supported-consensus', category: 'collaboration', check: () => validate(synthesis()) },
  { id: 'synthesis-invented-claim', category: 'collaboration', check: () => assert.throws(() => validate({ ...synthesis(), consensusClaims: [{ ...claim, id: 'invented' }] })) },
  { id: 'synthesis-increased-confidence', category: 'collaboration', check: () => assert.throws(() => validate({ ...synthesis(), consensusClaims: [{ ...claim, confidence: 1 }] })) },
  { id: 'synthesis-rewritten-decision', category: 'collaboration', check: () => assert.throws(() => validate({ ...synthesis(), consensusClaims: [{ ...claim, statement: '保证上涨' }] })) },
  { id: 'synthesis-changed-hash', category: 'collaboration', check: () => assert.throws(() => validate({ ...synthesis(), sourceArtifacts: [{ artifactId: 'a1', sha256: 'changed' }] })) },
  { id: 'synthesis-omitted-risk', category: 'collaboration', check: () => assert.throws(() => validate(synthesis(), [{ ...artifact, content: JSON.stringify({ claims: [claim], findings: [finding] }) }])) },
  { id: 'synthesis-preserved-risk', category: 'collaboration', check: () => validate({ ...synthesis(), unresolvedRisks: [finding.explanation] }, [{ ...artifact, content: JSON.stringify({ claims: [claim], findings: [finding] }) }]) },
  { id: 'retrieval-question-aware', category: 'retrieval', check: () => { const result = retrieveFinanceEvidence({ role: 'fundamental_research', question: '新能源补贴', documents: [{ path: 'facts', content: JSON.stringify({ '新能源补贴': '增长', unrelated: 'noise' }) }], limit: 1 }); assert.match(result[0].jsonPath, /新能源补贴/); } },
  { id: 'retrieval-bounded', category: 'retrieval', check: () => assert.equal(retrieveFinanceEvidence({ role: 'technical_analysis', documents: [{ path: 'facts', content: JSON.stringify(Array.from({ length: 200 }, (_, i) => i)) }], limit: 10000 }).length, 100) },
  { id: 'comparison-controlled-pair', category: 'evaluation', check: () => assert.equal(buildMultiAgentComparison([pairedRun('single_agent'), pairedRun('multi_agent')]).available, true) },
  { id: 'comparison-missing-provenance', category: 'evaluation', check: () => { const multi = pairedRun('multi_agent'); delete multi.metadata.provenance; assert.equal(buildMultiAgentComparison([pairedRun('single_agent'), multi]).available, false); } },
  { id: 'comparison-input-drift', category: 'evaluation', check: () => { const multi = pairedRun('multi_agent'); multi.metadata.provenance!.frozenInputsSha256 = 'changed'; assert.equal(buildMultiAgentComparison([pairedRun('single_agent'), multi]).available, false); } },
  { id: 'comparison-judge-drift', category: 'evaluation', check: () => { const multi = pairedRun('multi_agent'); multi.metadata.evaluator.rubricVersion = 'changed'; assert.equal(buildMultiAgentComparison([pairedRun('single_agent'), multi]).available, false); } },
  { id: 'comparison-tool-drift', category: 'evaluation', check: () => { const multi = pairedRun('multi_agent'); multi.metadata.provenance!.toolConfigSha256 = 'changed'; assert.equal(buildMultiAgentComparison([pairedRun('single_agent'), multi]).available, false); } },
];
