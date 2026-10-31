import { describe, expect, it } from 'vitest';
import {
  parsePiAgentSpecialistResult,
  specialistResultInstruction,
} from './specialist-contracts';

describe('multi-Agent specialist contracts', () => {
  it('rejects a role-confused specialist handoff', () => {
    expect(() => parsePiAgentSpecialistResult('fundamental_research', {
      schemaVersion: 1,
      agentRole: 'technical_analysis',
      asOf: '2026-10-28T00:00:00+08:00',
      summary: 'result',
      claims: [],
      evidence: [],
      uncertainties: [],
    })).toThrow(/role mismatch/i);
  });

  it('requires synthesis to bind immutable source artifacts', () => {
    expect(() => parsePiAgentSpecialistResult('synthesis', {
      schemaVersion: 1,
      agentRole: 'synthesis',
      asOf: '2026-10-28T00:00:00+08:00',
      summary: 'result',
      sourceArtifacts: [],
      consensusClaims: [],
      disputedClaims: [],
      rejectedClaims: [],
      dashboardBrief: { title: 'Dashboard', sections: ['Overview'], riskDisclosure: 'Risk' },
      unresolvedRisks: [],
    })).toThrow();
  });

  it('gives every role an exact bounded output template', () => {
    const instruction = specialistResultInstruction('fundamental_research');

    expect(instruction).toContain('"id": "fundamental_research-claim-1"');
    expect(instruction).toContain('"evidenceIds"');
    expect(instruction).toContain('"summary"');
    expect(instruction).toContain('RFC 3339');
    expect(instruction).not.toContain('claimId');
  });

  it('lists the closed risk taxonomy in risk specialist instructions', () => {
    const instruction = specialistResultInstruction('risk_precheck');

    expect(instruction).toContain(
      'lookahead_bias, survivorship_bias, data_gap, unsupported_claim, concentration, model_uncertainty',
    );
    expect(instruction).not.toContain('"targetClaimId"');
    expect(specialistResultInstruction('risk_crosscheck')).toContain('referenceCatalog');
  });

  it('normalizes noncanonical risk labels without weakening the remaining contract', () => {
    const result = parsePiAgentSpecialistResult('risk_precheck', {
      schemaVersion: 1,
      agentRole: 'risk_precheck',
      asOf: '2026-10-28T00:00:00+08:00',
      summary: 'Risk review',
      reviewedArtifactHashes: [],
      findings: [
        {
          category: 'data-quality',
          severity: 'warning',
          explanation: 'Inputs are incomplete.',
          evidenceIds: [],
        },
        {
          category: 'liquidity_risk',
          severity: 'info',
          explanation: 'The model emitted a label outside the closed taxonomy.',
          evidenceIds: [],
        },
      ],
      blocking: false,
    }) as { findings: Array<{ category: string }> };

    expect(result.findings.map((finding) => finding.category)).toEqual([
      'data_gap',
      'model_uncertainty',
    ]);
  });

  it('normalizes structured synthesis positions into the canonical string representation', () => {
    const result = parsePiAgentSpecialistResult('synthesis', {
      schemaVersion: 1,
      agentRole: 'synthesis',
      asOf: '2026-10-28T00:00:00+08:00',
      summary: 'Synthesis',
      sourceArtifacts: [{
        artifactId: '11111111-1111-4111-8111-111111111111',
        sha256: `sha256:${'a'.repeat(64)}`,
      }],
      consensusClaims: [],
      disputedClaims: [{
        id: 'dispute-1',
        statement: 'The evidence supports different interpretations.',
        positions: [
          { agentRole: 'fundamental_research', statement: 'Fundamental position.' },
          { source: 'technical_analysis', position: 'Technical position.' },
        ],
        evidenceIds: ['evidence-1'],
        confidence: 0.5,
      }],
      rejectedClaims: [],
      dashboardBrief: {
        title: 'Dashboard',
        sections: ['Overview'],
        riskDisclosure: 'Risk remains.',
      },
      unresolvedRisks: [],
    }) as { disputedClaims: Array<{ statement: string; positions: string[] }> };

    expect(result.disputedClaims).toEqual([{
      statement: 'The evidence supports different interpretations.',
      positions: [
        'fundamental_research: Fundamental position.',
        'technical_analysis: Technical position.',
      ],
    }]);
  });

  it('summarizes schema failures without dumping escaped validator internals', () => {
    expect(() => parsePiAgentSpecialistResult('fundamental_research', {
      schemaVersion: 1,
      agentRole: 'fundamental_research',
      asOf: 'not-a-date',
      claims: [{ claimId: 'wrong-key' }],
      evidence: [],
      uncertainties: [],
    })).toThrowError(
      /asOf: Invalid ISO datetime; summary: Invalid input.*claims\.0\.id.*claims\.0\.evidenceIds/s,
    );

    try {
      parsePiAgentSpecialistResult('fundamental_research', {
        schemaVersion: 1,
        agentRole: 'fundamental_research',
      });
    } catch (error) {
      expect(String(error)).not.toContain('\\\\d');
      expect(String(error).length).toBeLessThan(1_200);
    }
  });
});
