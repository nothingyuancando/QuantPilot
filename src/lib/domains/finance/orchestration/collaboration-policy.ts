export interface CollaborationArtifact {
  artifactId?: string;
  expectedSha256?: string;
  content: string;
}

type Claim = { id: string; statement: string; evidenceIds: string[]; confidence: number };

/** Checks lineage, not the semantic truth of a model's interpretation. */
export function validateFinanceCollaboration(input: {
  role: string;
  result: Record<string, unknown>;
  artifacts: readonly CollaborationArtifact[];
  asOf?: string;
}): void {
  if (input.asOf && input.result.asOf !== input.asOf) throw new Error('Specialist changed the frozen research cutoff.');
  if (input.role === 'risk_crosscheck') {
    const reviewed = input.result.reviewedArtifactHashes as string[];
    const expected = input.artifacts.map((artifact) => artifact.expectedSha256).filter(Boolean);
    if (expected.length !== reviewed.length || expected.some((hash) => !reviewed.includes(hash!))) throw new Error('Risk crosscheck omitted or changed reviewed artifact hashes.');
    const upstream = input.artifacts.map((artifact) => JSON.parse(artifact.content));
    const claims = upstream.flatMap((item) => Array.isArray(item.claims) ? item.claims as Claim[] : []);
    const evidence = new Set(upstream.flatMap((item) => [
      ...(Array.isArray(item.evidence) ? item.evidence.map((ref: { id: string }) => ref.id) : []),
      ...(Array.isArray(item.findings) ? item.findings.flatMap((finding: { evidenceIds: string[] }) => finding.evidenceIds) : []),
    ]));
    for (const finding of input.result.findings as Array<{ targetClaimId?: string; evidenceIds: string[] }>) {
      if ((finding.targetClaimId && !claims.some((claim) => claim.id === finding.targetClaimId)) || finding.evidenceIds.some((id) => !evidence.has(id))) throw new Error('Risk crosscheck cited an unknown upstream claim or evidence.');
    }
  }
  if (input.role !== 'synthesis') return;
  const upstream = input.artifacts.map((artifact) => JSON.parse(artifact.content) as Record<string, unknown>);
  const claims = upstream.flatMap((item) => Array.isArray(item.claims) ? item.claims as Claim[] : []);
  const byId = new Map<string, Claim[]>();
  for (const claim of claims) byId.set(claim.id, [...byId.get(claim.id) ?? [], claim]);
  const sourceArtifacts = input.result.sourceArtifacts as Array<{ artifactId: string; sha256: string }>;
  const expected = input.artifacts.filter((item) => item.artifactId && item.expectedSha256);
  if (sourceArtifacts.length !== expected.length || new Set(sourceArtifacts.map((item) => item.artifactId)).size !== expected.length
    || expected.some((artifact) => !sourceArtifacts.some((source) => source.artifactId === artifact.artifactId && source.sha256 === artifact.expectedSha256))) {
    throw new Error('Synthesis must retain every verified upstream artifact hash.');
  }
  const rejected = input.result.rejectedClaims as Array<{ claimId: string }>;
  const consensus = input.result.consensusClaims as Claim[];
  for (const claim of consensus) {
    const sources = byId.get(claim.id) ?? [];
    // Exact preservation deliberately disallows an unreviewed new decision claim.
    if (!sources.length || sources.some((source) => source.statement !== claim.statement)
      || rejected.some((item) => item.claimId === claim.id)
      || !claim.evidenceIds.length
      || !sources.some((source) => claim.evidenceIds.every((id) => source.evidenceIds.includes(id)) && claim.confidence <= source.confidence)) {
      throw new Error(`Synthesis contains an unsupported or disputed consensus claim: ${claim.id}`);
    }
  }
  if (rejected.some((item) => !byId.has(item.claimId))) throw new Error('Synthesis rejected an unknown claim.');
  const disputes = input.result.disputedClaims as Array<{ positions: string[] }>;
  for (const [id, sources] of byId) {
    if (new Set(sources.map((source) => source.statement)).size > 1
      && !sources.every((source) => disputes.some((dispute) => dispute.positions.some((position) => position.includes(source.statement))))) {
      throw new Error(`Synthesis omitted an upstream disagreement: ${id}`);
    }
  }
  const findings = upstream.flatMap((item) => Array.isArray(item.findings) ? item.findings as Array<{ explanation: string; targetClaimId?: string }> : []);
  const unresolved = input.result.unresolvedRisks as string[];
  const missingRisks = [...new Set(findings.filter((finding) =>
    !(finding.targetClaimId && rejected.some((item) => item.claimId === finding.targetClaimId))
      && !unresolved.some((risk) => risk.includes(finding.explanation)))
    .map((finding) => finding.explanation))];
  if (missingRisks.length) {
    throw new Error(`Synthesis omitted unresolved upstream risks. Copy every exact explanation in this JSON array into top-level unresolvedRisks: ${JSON.stringify(missingRisks)}`);
  }
}
