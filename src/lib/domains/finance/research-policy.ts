/** Business decisions are separate from data readiness and infrastructure health. */
export interface ResearchAssessment {
  dataConfidence: number;
  signalStrength: number | null;
  investmentRisk: 'low' | 'medium' | 'high' | 'unknown';
  recommendation: string;
}

export function assessResearch(input: {
  coverageRatio: number;
  sourceStatuses: readonly string[];
  candidates: readonly { score?: unknown; riskLevel?: unknown; risk_level?: unknown }[];
}): ResearchAssessment {
  const coverage = Number.isFinite(input.coverageRatio) ? Math.max(0, Math.min(1, input.coverageRatio)) : 0;
  const available = input.sourceStatuses.filter((status) => status === 'available').length;
  const partial = input.sourceStatuses.filter((status) => status === 'partial').length;
  const readiness = input.sourceStatuses.length ? (available + partial * 0.5) / input.sourceStatuses.length : 0;
  const scores = input.candidates.map((item) => item.score)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100);
  const risks = input.candidates.map((item) => item.riskLevel ?? item.risk_level);
  const investmentRisk = risks.length > 0 && risks.every((risk) => ['low', 'medium', 'high'].includes(String(risk)))
    ? risks.includes('high') ? 'high' : risks.includes('medium') ? 'medium' : 'low'
    : 'unknown';
  return {
    dataConfidence: Math.round(100 * coverage * readiness),
    signalStrength: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
    investmentRisk,
    recommendation: investmentRisk === 'high'
      ? '已识别高风险，先复核风险暴露；候选信号不构成交易建议'
      : '仅供观察，结合投资周期、持仓约束和风险证据人工复核；不据数据覆盖或服务状态作出买卖建议',
  };
}

export function canonicalResearchSymbol(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) return normalized;
  // Bare codes are ambiguous; the caller must resolve their exchange first.
  throw new Error(`Research symbol requires a canonical exchange: ${value}`);
}

export function candidateWithinWatchlist(
  candidate: { symbol?: unknown; asset_type?: unknown; trade_date?: unknown },
  scope: { symbols: readonly string[]; markets: readonly string[]; endDate?: string },
): boolean {
  if (typeof candidate.symbol !== 'string') return false;
  let symbol: string;
  try { symbol = canonicalResearchSymbol(candidate.symbol); } catch { return false; }
  if (scope.symbols.length && !scope.symbols.map(canonicalResearchSymbol).includes(symbol)) return false;
  if (scope.markets.length) {
    const asset = candidate.asset_type ?? 'stock'; // This endpoint only screens A-share stocks.
    if (!scope.markets.some((market) => (market === 'A股' && asset === 'stock') || (market === 'ETF' && asset === 'etf'))) return false;
  }
  if (scope.endDate) {
    if (typeof candidate.trade_date !== 'string') return false;
    const day = candidate.trade_date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const timestamp = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day || day > scope.endDate) return false;
  }
  return true;
}

export interface FinanceRiskFinding {
  category: string;
  severity: string;
  targetClaimId?: string;
  evidenceIds: readonly string[];
  explanation: string;
}

export interface FinanceRiskDecision {
  action: 'allow' | 'restrict' | 'reject_claims' | 'block';
  rejectedClaimIds: string[];
  restrictions: string[];
}

/** A model's blocking boolean never grants abort authority. Verified findings do. */
export function decideFinanceRisk(findings: readonly FinanceRiskFinding[], knownEvidenceIds: ReadonlySet<string>, verifiedFindingIndexes: ReadonlySet<number> = new Set()): FinanceRiskDecision {
  const rejectedClaimIds = new Set<string>();
  const restrictions = new Set<string>();
  let block = false;
  for (const [index, finding] of findings.entries()) {
    const supported = finding.evidenceIds.length > 0 && finding.evidenceIds.every((id) => knownEvidenceIds.has(id));
    const material = finding.severity === 'blocking' && ['lookahead_bias', 'unsupported_claim'].includes(finding.category);
    if (material && supported && verifiedFindingIndexes.has(index)) {
      if (finding.targetClaimId) rejectedClaimIds.add(finding.targetClaimId);
      else block = true; // No safe way to identify the affected decision.
    } else {
      restrictions.add(`${finding.category}: ${finding.explanation}`);
    }
  }
  return {
    action: block ? 'block' : rejectedClaimIds.size ? 'reject_claims' : restrictions.size ? 'restrict' : 'allow',
    rejectedClaimIds: [...rejectedClaimIds].sort(),
    restrictions: [...restrictions].sort(),
  };
}
