import { describe, expect, it } from 'vitest';

import { validateFinanceCollaboration } from './collaboration-policy';

describe('synthesis risk completeness feedback', () => {
  it('reports every missing risk together and preserves exact explanations', () => {
    const explanations = ['Historical coverage is partial.', 'Missing cash flow data.'];
    const artifacts = [{
      artifactId: 'risk', expectedSha256: 'sha256:abc',
      content: JSON.stringify({ findings: explanations.map((explanation) => ({ explanation })) }),
    }];
    const result = {
      sourceArtifacts: [{ artifactId: 'risk', sha256: 'sha256:abc' }],
      consensusClaims: [], rejectedClaims: [], disputedClaims: [], unresolvedRisks: [],
    };
    expect(() => validateFinanceCollaboration({ role: 'synthesis', artifacts, result }))
      .toThrow(JSON.stringify(explanations));
    expect(() => validateFinanceCollaboration({ role: 'synthesis', artifacts,
      result: { ...result, unresolvedRisks: explanations },
    })).not.toThrow();
  });
});
