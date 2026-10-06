import type { IssueSeverity, ReviewIssue } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { notFound } from './errors.ts';
import type { Rec } from './util.ts';

export function mapIssue(r: Rec): ReviewIssue {
  return {
    id: r.id, projectId: r.project_id, nodeId: r.node_id ?? null, questionId: r.question_id ?? null, revId: r.rev_id ?? null, source: r.source,
    severity: r.severity, category: r.category, quote: r.quote, message: r.message, suggestion: r.suggestion, status: r.status,
    resolution: r.resolution, createdAt: r.created_at,
  };
}

export function listIssues(ctx: AppContext, projectId: string, filter: { status?: ReviewIssue['status']; nodeId?: string } = {}): ReviewIssue[] {
  const where = ['project_id = ?'];
  const params: string[] = [projectId];
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.nodeId) { where.push('node_id = ?'); params.push(filter.nodeId); }
  return ctx.db.all<Rec>(`SELECT * FROM review_issues WHERE ${where.join(' AND ')} ORDER BY rowid`, ...params).map(mapIssue);
}

/** Open and proposed issues grouped by node, for the manuscript view. */
export function activeIssuesByNode(ctx: AppContext, projectId: string): Map<string, ReviewIssue[]> {
  const out = new Map<string, ReviewIssue[]>();
  for (const r of ctx.db.all<Rec>(`SELECT * FROM review_issues WHERE project_id = ? AND node_id IS NOT NULL AND status IN ('open', 'proposed') ORDER BY rowid`, projectId)) {
    const list = out.get(r.node_id) ?? [];
    list.push(mapIssue(r));
    out.set(r.node_id, list);
  }
  return out;
}

export function getIssue(ctx: AppContext, id: string): ReviewIssue {
  const r = ctx.db.get<Rec>('SELECT * FROM review_issues WHERE id = ?', id);
  if (!r) throw notFound('This issue');
  return mapIssue(r);
}

export type NewIssue = Omit<ReviewIssue, 'id' | 'createdAt' | 'status' | 'resolution' | 'quote' | 'suggestion' | 'nodeId' | 'questionId' | 'revId'>
  & Partial<Pick<ReviewIssue, 'status' | 'resolution' | 'quote' | 'suggestion' | 'nodeId' | 'questionId' | 'revId'>>;

export function insertIssue(ctx: AppContext, i: NewIssue): ReviewIssue {
  const id = newId();
  ctx.db.insert('review_issues', {
    id, project_id: i.projectId, node_id: i.nodeId ?? null, question_id: i.questionId ?? null, rev_id: i.revId ?? null, source: i.source,
    severity: i.severity, category: i.category, quote: i.quote ?? '', message: i.message, suggestion: i.suggestion ?? '', status: i.status ?? 'open',
    resolution: i.resolution ?? '', created_at: now(),
  });
  return getIssue(ctx, id);
}

export function updateIssue(ctx: AppContext, id: string, patch: { status: ReviewIssue['status']; resolution?: string }): ReviewIssue {
  getIssue(ctx, id);
  ctx.db.update('review_issues', id, { status: patch.status, ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}) });
  return getIssue(ctx, id);
}

/** Replaces the open lint issues of a node with fresh findings. Resolved and dismissed history stays. */
export function replaceLintIssues(
  ctx: AppContext, projectId: string, nodeId: string, revId: string | null,
  findings: { rule: string; severity: IssueSeverity; message: string; quote?: string }[],
): ReviewIssue[] {
  return ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND node_id = ? AND source = 'lint' AND status = 'open'`, projectId, nodeId);
    return findings.map((f) => insertIssue(ctx, { projectId, nodeId, revId, source: 'lint', severity: f.severity, category: f.rule, message: f.message, quote: f.quote ?? '' }));
  });
}

/** Issues that block an approved export: blockers still open or waiting on a proposed fix. */
export function countUnresolvedBlockers(ctx: AppContext, projectId: string): number {
  return Number(ctx.db.get<Rec>(`SELECT COUNT(*) AS n FROM review_issues WHERE project_id = ? AND severity = 'blocker' AND status IN ('open', 'proposed')`, projectId)?.n ?? 0);
}
