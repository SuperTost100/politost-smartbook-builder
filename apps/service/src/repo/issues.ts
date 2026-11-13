import type { IssueSeverity, ReviewIssue, ReviewState } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
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

/** Tells clients that issues changed status (the Review list, the manuscript badges and the export gate depend on it). */
export function issuesChanged(ctx: AppContext, projectId: string, issueIds: string[]): void {
  if (issueIds.length) ctx.events.emit('issue.updated', { issueIds }, { projectId });
}

export function updateIssue(ctx: AppContext, id: string, patch: { status: ReviewIssue['status']; resolution?: string }): ReviewIssue {
  const cur = getIssue(ctx, id);
  ctx.db.update('review_issues', id, { status: patch.status, ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}) });
  if (patch.status !== cur.status) issuesChanged(ctx, cur.projectId, [id]);
  return getIssue(ctx, id);
}

/** Sets the status and resolution of several issues at once and announces them. */
export function setIssuesStatus(ctx: AppContext, projectId: string, issueIds: string[], status: ReviewIssue['status'], resolution: string): void {
  if (!issueIds.length) return;
  ctx.db.tx(() => { for (const id of issueIds) ctx.db.run('UPDATE review_issues SET status = ?, resolution = ? WHERE id = ? AND project_id = ?', status, resolution, id, projectId); });
  issuesChanged(ctx, projectId, issueIds);
}

/**
 * Moves the issues that point at a proposal ('proposed' with resolution "Proposal <revId>") to a new status.
 * Returns the ids it changed and announces them.
 */
export function resolveProposalIssues(ctx: AppContext, projectId: string, revId: string, to: { status: ReviewIssue['status']; resolution: string }): string[] {
  const ids = ctx.db.all<Rec>(`SELECT id FROM review_issues WHERE project_id = ? AND status = 'proposed' AND resolution = ?`, projectId, `Proposal ${revId}`).map((r) => r.id as string);
  if (ids.length) {
    ctx.db.run(`UPDATE review_issues SET status = ?, resolution = ? WHERE project_id = ? AND status = 'proposed' AND resolution = ?`, to.status, to.resolution, projectId, `Proposal ${revId}`);
    issuesChanged(ctx, projectId, ids);
  }
  return ids;
}

/**
 * Replaces the open lint issues of a node with fresh findings. Resolved and dismissed history stays. An open issue listed in
 * `keepIds` that a fresh finding still matches (same rule, message and quote; or the quote as the formatter rewrote it; or the
 * only one of its rule and message when the quote changed some other way) keeps its row and id, because a running fix refers to it; its revision and quote move to the fresh finding's.
 */
export function replaceLintIssues(
  ctx: AppContext, projectId: string, nodeId: string, revId: string | null,
  findings: { rule: string; severity: IssueSeverity; message: string; quote?: string }[],
  keepIds: string[] = [],
  /** What a kept row's quote reads after the text was formatted, so the row is found again by its own line. */
  moved: (quote: string) => string = (quote) => quote,
): ReviewIssue[] {
  return ctx.db.tx(() => {
    const kept = ctx.db.all<Rec>(`SELECT id, category, message, quote FROM review_issues WHERE project_id = ? AND node_id = ? AND source = 'lint' AND status = 'open'`, projectId, nodeId).filter((r) => keepIds.includes(r.id as string));
    const used = new Set<string>();
    const rows = findings.map((f) => {
      const same = kept.find((r) => !used.has(r.id as string) && r.category === f.rule && r.message === f.message && r.quote === (f.quote ?? ''));
      if (same) used.add(same.id as string);
      return same;
    });
    // The formatter may have rewritten the line an issue quotes (a heading that changed level), so its fresh finding has
    // another quote. A kept row then goes with the finding that quotes its line as the formatter wrote it, and failing that
    // with the one unmatched finding of its rule and message, when there is exactly one of each.
    for (const r of kept) {
      if (used.has(r.id as string)) continue;
      const at = findings.findIndex((f, n) => !rows[n] && f.rule === r.category && f.message === r.message && (f.quote ?? '') === moved(r.quote as string));
      if (at < 0) continue;
      rows[at] = r;
      used.add(r.id as string);
    }
    for (const r of kept) {
      if (used.has(r.id as string)) continue;
      const alike = (x: { rule: string; message: string }) => x.rule === r.category && x.message === r.message;
      const open = findings.map((f, n) => (rows[n] || !alike(f) ? -1 : n)).filter((n) => n >= 0);
      const rivals = kept.filter((k) => !used.has(k.id as string) && k.category === r.category && k.message === r.message);
      if (open.length !== 1 || rivals.length !== 1) continue;
      rows[open[0]] = r;
      used.add(r.id as string);
    }
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND node_id = ? AND source = 'lint' AND status = 'open'${used.size ? ` AND id NOT IN (${[...used].map(() => '?').join(',')})` : ''}`, projectId, nodeId, ...used);
    return findings.map((f, n) => {
      const same = rows[n];
      if (!same) return insertIssue(ctx, { projectId, nodeId, revId, source: 'lint', severity: f.severity, category: f.rule, message: f.message, quote: f.quote ?? '' });
      ctx.db.run('UPDATE review_issues SET rev_id = ?, quote = ? WHERE id = ?', revId, f.quote ?? '', same.id as string);
      return getIssue(ctx, same.id as string);
    });
  });
}

/** Issues that block an approved export: blockers still open or waiting on a proposed fix. */
export function countUnresolvedBlockers(ctx: AppContext, projectId: string): number {
  return Number(ctx.db.get<Rec>(`SELECT COUNT(*) AS n FROM review_issues WHERE project_id = ? AND severity = 'blocker' AND status IN ('open', 'proposed')`, projectId)?.n ?? 0);
}

/** Blockers and majors still open or waiting as a proposal, in the given nodes or in the whole book. */
export function countOpenSerious(ctx: AppContext, projectId: string, nodeIds?: string[]): number {
  const scope = nodeIds ? ` AND node_id IN (${nodeIds.map(() => '?').join(',')})` : '';
  return Number(ctx.db.get<Rec>(`SELECT COUNT(*) AS n FROM review_issues WHERE project_id = ? AND severity IN ('blocker', 'major') AND status IN ('open', 'proposed')${scope}`, projectId, ...(nodeIds ?? []))?.n ?? 0);
}

/**
 * The state of the review loop for the book (see ReviewState). A chapter counts as reviewed when its latest review read
 * exactly the section revisions that are current now, so text changed after a review makes the book unreviewed again.
 * Null when no chapter was ever reviewed.
 */
export function reviewState(ctx: AppContext, projectId: string): ReviewState | null {
  const latest = new Map<string, { reviewed: string; finishedAt: string }>();
  for (const t of ctx.db.all<{ chapter: string; reviewed: string; finished_at: string }>(
    `SELECT json_extract(input, '$.chapterId') AS chapter, json_extract(result, '$.reviewed') AS reviewed, finished_at FROM tasks
     WHERE project_id = ? AND kind = 'chapter.review' AND state = 'succeeded' AND json_extract(result, '$.reviewed') IS NOT NULL ORDER BY finished_at DESC, rowid DESC`, projectId)) {
    if (!latest.has(t.chapter)) latest.set(t.chapter, { reviewed: t.reviewed, finishedAt: t.finished_at });
  }
  if (!latest.size) return null;
  const outlineRow = ctx.db.get<Rec>('SELECT o.outline FROM outline_revisions o JOIN projects p ON p.outline_rev_id = o.id WHERE p.id = ?', projectId);
  const chapters = json<{ chapters?: { id: string; sections?: { id: string }[] }[] }>(outlineRow?.outline, {}).chapters ?? [];
  const heads = new Map(ctx.db.all<Rec>(`SELECT node_id, id FROM content_revisions WHERE project_id = ? AND status = 'current' AND kind = 'section'`, projectId).map((r) => [r.node_id as string, r.id as string]));
  const reviewedNow = chapters.every((c) => {
    const current = (c.sections ?? []).map((s) => heads.get(s.id)).filter((id): id is string => !!id).sort().join(',');
    return !current || latest.get(c.id)?.reviewed === current;
  });
  const openSerious = countOpenSerious(ctx, projectId);
  const reviewedAt = [...latest.values()].map((l) => l.finishedAt).sort().at(-1)!;
  return { clean: reviewedNow && openSerious === 0, openSerious, reviewedAt };
}
