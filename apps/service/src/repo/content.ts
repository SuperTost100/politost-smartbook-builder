import { splitBlocks } from '@smartbuilder/content/blocks';
import type { ContentNodeKind, ContentOrigin, ContentRevision, EvidenceNote, EvidencePacket } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { conflict, notFound } from './errors.ts';
import type { Rec } from './util.ts';

export function mapRevision(r: Rec): ContentRevision {
  return {
    id: r.id, projectId: r.project_id, nodeId: r.node_id, kind: r.kind, markdown: r.markdown, origin: r.origin, model: r.model ?? null,
    parentRevId: r.parent_rev_id ?? null, status: r.status, citations: json(r.citations, {}), createdAt: r.created_at,
  };
}

const STALE = 'This text changed since you opened it.';

/** The current text of a node: the newest revision with status 'current'. */
export function currentHead(ctx: AppContext, projectId: string, nodeId: string): ContentRevision | null {
  const r = ctx.db.get<Rec>(`SELECT * FROM content_revisions WHERE project_id = ? AND node_id = ? AND status = 'current' ORDER BY rowid DESC LIMIT 1`, projectId, nodeId);
  return r ? mapRevision(r) : null;
}

/** The newest proposal waiting for a decision. */
export function pendingProposal(ctx: AppContext, projectId: string, nodeId: string): ContentRevision | null {
  const r = ctx.db.get<Rec>(`SELECT * FROM content_revisions WHERE project_id = ? AND node_id = ? AND status = 'proposal' ORDER BY rowid DESC LIMIT 1`, projectId, nodeId);
  return r ? mapRevision(r) : null;
}

export function getRevision(ctx: AppContext, projectId: string, revId: string): ContentRevision {
  const r = ctx.db.get<Rec>('SELECT * FROM content_revisions WHERE id = ? AND project_id = ?', revId, projectId);
  if (!r) throw notFound('This version');
  return mapRevision(r);
}

export function listRevisions(ctx: AppContext, projectId: string, nodeId: string): ContentRevision[] {
  return ctx.db.all<Rec>('SELECT * FROM content_revisions WHERE project_id = ? AND node_id = ? ORDER BY rowid DESC', projectId, nodeId).map(mapRevision);
}

/** Current heads for every node of a project (one query for the manuscript view). */
export function currentHeads(ctx: AppContext, projectId: string): Map<string, ContentRevision> {
  const out = new Map<string, ContentRevision>();
  for (const r of ctx.db.all<Rec>(`SELECT * FROM content_revisions WHERE project_id = ? AND status = 'current' ORDER BY rowid`, projectId)) out.set(r.node_id, mapRevision(r));
  return out;
}

export function pendingProposals(ctx: AppContext, projectId: string): Map<string, ContentRevision> {
  const out = new Map<string, ContentRevision>();
  for (const r of ctx.db.all<Rec>(`SELECT * FROM content_revisions WHERE project_id = ? AND status = 'proposal' ORDER BY rowid`, projectId)) out.set(r.node_id, mapRevision(r));
  return out;
}

function insertRevision(ctx: AppContext, v: {
  projectId: string; nodeId: string; kind: ContentNodeKind; markdown: string; origin: ContentOrigin; model: string | null;
  parentRevId: string | null; status: ContentRevision['status']; citations: Record<string, string[]>; taskId?: string | null;
}): ContentRevision {
  const id = newId();
  ctx.db.insert('content_revisions', {
    id, project_id: v.projectId, node_id: v.nodeId, kind: v.kind, markdown: v.markdown, origin: v.origin, model: v.model,
    parent_rev_id: v.parentRevId, status: v.status, citations: v.citations, task_id: v.taskId ?? null, created_at: now(),
  });
  return getRevision(ctx, v.projectId, id);
}

function makeCurrent(ctx: AppContext, projectId: string, nodeId: string, head: ContentRevision | null, fresh: Parameters<typeof insertRevision>[1]) {
  if (head) ctx.db.update('content_revisions', head.id, { status: 'superseded' });
  return insertRevision(ctx, { ...fresh, projectId, nodeId, parentRevId: head?.id ?? null, status: 'current' });
}

/** Saves a human edit. 409 when baseRevId is not the current head. The previous head becomes 'superseded'. */
export function saveHuman(ctx: AppContext, projectId: string, nodeId: string, markdown: string, baseRevId: string | null, kind: ContentNodeKind = 'section'): ContentRevision {
  return ctx.db.tx(() => {
    const head = currentHead(ctx, projectId, nodeId);
    if ((head?.id ?? null) !== baseRevId) throw conflict(STALE, undefined, nodeId);
    const citations = head ? carryCitations(head.markdown, markdown, head.citations) : {};
    return makeCurrent(ctx, projectId, nodeId, head, { projectId, nodeId, kind, markdown, origin: 'human', model: null, parentRevId: head?.id ?? null, status: 'current', citations });
  });
}

/**
 * Moves block citations from an old text to an edited one. Blocks with identical text keep theirs; the remaining
 * blocks are aligned from the start and from the end, so editing, inserting or deleting one block does not shift
 * the evidence of the others.
 */
export function carryCitations(oldMd: string, newMd: string, old: Record<string, string[]>): Record<string, string[]> {
  const a = splitBlocks(oldMd).map((b) => b.text.trim());
  const b = splitBlocks(newMd).map((x) => x.text.trim());
  const out: Record<string, string[]> = {};
  const used = new Set<number>();
  const take = (i: number, j: number) => {
    used.add(i);
    if (old[String(i)]?.length) out[String(j)] = old[String(i)];
  };
  const matched = new Set<number>();
  b.forEach((text, j) => {
    const i = a.findIndex((t, k) => !used.has(k) && t === text);
    if (i >= 0) { take(i, j); matched.add(j); }
  });
  // Edited blocks: align the unmatched ones from both ends.
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++, i++) {
    if (matched.has(j)) continue;
    if (a[i] === undefined || used.has(i)) break;
    take(i, j);
    matched.add(j);
  }
  let k = a.length - 1;
  for (let j = b.length - 1; j >= 0 && k >= 0; j--, k--) {
    if (matched.has(j)) continue;
    if (used.has(k)) break;
    take(k, j);
    matched.add(j);
  }
  return out;
}

/**
 * Stores model output. It becomes the current text only when baseRevId (the head the model started from) is still
 * the head and `forceProposal` is not set; otherwise it waits as a proposal for the author. Older pending proposals
 * of the node become 'superseded'. A proposal's parent is the revision the model started from (baseRevId), not the
 * head it arrived after. `taskId` records the producing task so a retried task finds its own result.
 */
export function insertProposal(
  ctx: AppContext, projectId: string, nodeId: string, markdown: string, baseRevId: string | null,
  origin: Exclude<ContentOrigin, 'human'>, model: string | null, citations: Record<string, string[]> = {},
  opts: { kind?: ContentNodeKind; forceProposal?: boolean; taskId?: string } = {},
): { revision: ContentRevision; applied: boolean } {
  return ctx.db.tx(() => {
    const head = currentHead(ctx, projectId, nodeId);
    const kind = opts.kind ?? 'section';
    const fresh = { projectId, nodeId, kind, markdown, origin, model, parentRevId: baseRevId, status: 'current' as const, citations, taskId: opts.taskId ?? null };
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE project_id = ? AND node_id = ? AND status = 'proposal'`, projectId, nodeId);
    if (!opts.forceProposal && (head?.id ?? null) === baseRevId) return { revision: makeCurrent(ctx, projectId, nodeId, head, fresh), applied: true };
    return { revision: insertRevision(ctx, { ...fresh, status: 'proposal' }), applied: false };
  });
}

function requireProposal(ctx: AppContext, projectId: string, nodeId: string, revId: string): ContentRevision {
  const rev = getRevision(ctx, projectId, revId);
  if (rev.nodeId !== nodeId) throw notFound('This proposal');
  if (rev.status !== 'proposal') throw conflict('This proposal was already handled.', 'Reload to see the current text.', nodeId);
  return rev;
}

/** Makes the proposal the current text. The previous head becomes 'superseded'. */
export function acceptProposal(ctx: AppContext, projectId: string, nodeId: string, revId: string): ContentRevision {
  return ctx.db.tx(() => {
    const rev = requireProposal(ctx, projectId, nodeId, revId);
    const head = currentHead(ctx, projectId, nodeId);
    if (head) ctx.db.update('content_revisions', head.id, { status: 'superseded' });
    // The parent stays the revision the model started from.
    ctx.db.update('content_revisions', rev.id, { status: 'current' });
    // Issues this proposal answered are now fixed.
    ctx.db.run(`UPDATE review_issues SET status = 'fixed', resolution = ? WHERE project_id = ? AND status = 'proposed' AND resolution = ?`,
      `Fixed by accepting proposal ${rev.id}`, projectId, `Proposal ${rev.id}`);
    return getRevision(ctx, projectId, rev.id);
  });
}

export function rejectProposal(ctx: AppContext, projectId: string, nodeId: string, revId: string): ContentRevision {
  return ctx.db.tx(() => {
    const rev = requireProposal(ctx, projectId, nodeId, revId);
    ctx.db.update('content_revisions', rev.id, { status: 'rejected' });
    ctx.db.run(`UPDATE review_issues SET status = 'open', resolution = '' WHERE project_id = ? AND status = 'proposed' AND resolution = ?`, projectId, `Proposal ${rev.id}`);
    return getRevision(ctx, projectId, rev.id);
  });
}

/** Creates a new human revision with the text of an older one. */
export function restoreRevision(ctx: AppContext, projectId: string, nodeId: string, revId: string): ContentRevision {
  return ctx.db.tx(() => {
    const old = getRevision(ctx, projectId, revId);
    if (old.nodeId !== nodeId) throw notFound('This version');
    const head = currentHead(ctx, projectId, nodeId);
    return makeCurrent(ctx, projectId, nodeId, head, { projectId, nodeId, kind: old.kind, markdown: old.markdown, origin: 'human', model: null, parentRevId: null, status: 'current', citations: old.citations });
  });
}

// ---------- evidence ----------

export function mapPacket(r: Rec): EvidencePacket {
  return {
    id: r.id, projectId: r.project_id, nodeId: r.node_id, provider: r.provider, query: r.query, answer: r.answer,
    notes: json<EvidenceNote[]>(r.notes, []), createdAt: r.created_at,
  };
}

export function latestEvidence(ctx: AppContext, projectId: string, nodeId: string): EvidencePacket | null {
  const r = ctx.db.get<Rec>('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY rowid DESC LIMIT 1', projectId, nodeId);
  return r ? mapPacket(r) : null;
}

export function latestEvidenceByNode(ctx: AppContext, projectId: string): Map<string, EvidencePacket> {
  const out = new Map<string, EvidencePacket>();
  for (const r of ctx.db.all<Rec>('SELECT * FROM evidence_packets WHERE project_id = ? ORDER BY rowid', projectId)) out.set(r.node_id, mapPacket(r));
  return out;
}

export function insertEvidence(ctx: AppContext, p: Omit<EvidencePacket, 'id' | 'createdAt'>): EvidencePacket {
  const id = newId();
  ctx.db.insert('evidence_packets', { id, project_id: p.projectId, node_id: p.nodeId, provider: p.provider, query: p.query, answer: p.answer, notes: p.notes, created_at: now() });
  return mapPacket(ctx.db.get<Rec>('SELECT * FROM evidence_packets WHERE id = ?', id)!);
}

