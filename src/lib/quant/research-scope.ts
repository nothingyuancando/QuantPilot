import { createHash } from 'node:crypto';

/** Server-owned context: construct only after capability AND project authorization. */
export interface ResearchScope {
  projectId: string;
  actorUserId: string;
}

export function assertResearchScope(scope: ResearchScope): void {
  if (!scope?.projectId?.trim() || !scope?.actorUserId?.trim()) {
    throw new Error('Research operations require an authorized project and actor.');
  }
}

export function scopedResearchId(scope: ResearchScope, kind: string): string {
  assertResearchScope(scope);
  return `${kind}:${createHash('sha256').update(scope.projectId).digest('hex')}`;
}

export function assertSameResearchProject(scope: ResearchScope, rows: readonly { projectId: string | null }[]): void {
  assertResearchScope(scope);
  if (rows.some((row) => row.projectId !== scope.projectId)) throw new Error('Research resource not found in this project.');
}
