export interface MultiAgentArtifactProgress {
  id: string;
  schemaId: string;
  storagePath: string;
  contentSha256: string;
  byteLength: number;
}

export interface MultiAgentNodeProgress {
  key: string;
  type: string;
  profileId: string | null;
  dependencies: string[];
  status: string;
  attemptCount: number;
  model: string | null;
  provider: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  artifact: MultiAgentArtifactProgress | null;
  error: { code: string | null; message: string | null } | null;
}

export interface MultiAgentProgress {
  enabled: boolean;
  missionId: string | null;
  nodes: MultiAgentNodeProgress[];
}

export const EMPTY_MULTI_AGENT_PROGRESS: MultiAgentProgress = {
  enabled: false,
  missionId: null,
  nodes: [],
};

function issueSummary(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const issue = value as { path?: unknown; message?: unknown };
  if (!Array.isArray(issue.path) || typeof issue.message !== 'string') return null;
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'result';
  return `${path}: ${issue.message}`;
}

/** Keeps persisted validator diagnostics readable and bounded at API/UI boundaries. */
export function summarizeMultiAgentError(message: string | null): string | null {
  if (!message) return null;
  const normalized = message.trim();
  let issues: string[] = [];
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed)) issues = parsed.map(issueSummary).filter((item): item is string => Boolean(item));
  } catch {
    const pattern = /"path"\s*:\s*\[([^\]]*)\]\s*,\s*"message"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
    for (const match of normalized.matchAll(pattern)) {
      try {
        const path = JSON.parse(`[${match[1]}]`) as unknown[];
        const detail = JSON.parse(`"${match[2]}"`) as string;
        issues.push(`${path.length > 0 ? path.map(String).join('.') : 'result'}: ${detail}`);
      } catch {
        // A persisted diagnostic may have been truncated mid-issue.
      }
    }
  }
  const summary = issues.slice(0, 4).join('; ');
  if (summary) return `Specialist output schema mismatch: ${summary}${issues.length > 4 ? '; …' : ''}`;
  return normalized.length > 360 ? `${normalized.slice(0, 357)}…` : normalized;
}
