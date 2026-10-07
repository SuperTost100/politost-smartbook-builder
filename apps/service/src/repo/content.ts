import { splitBlocks } from '@smartbuilder/content/blocks';
import type { ContentNodeKind, ContentOrigin, ContentRevision, EvidenceNote, EvidencePacket } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { conflict, notFound } from './errors.ts';
import { resolveProposalIssues } from './issues.ts';
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

/** Past this many cells the middle part is not diffed: only the common beginning and end keep their citations by identity. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Pairs of equal blocks (old index, new index) in increasing order on both sides. The common beginning and end are paired
 * first; the middle is an ordered alignment (longest common subsequence) that, among equally long ones, keeps blocks
 * close to their old position, so a duplicated text cannot steal the evidence of the unchanged block next to it.
 */
function alignEqualBlocks(a: string[], b: string[]): [number, number][] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const pairs: [number, number][] = [];
  for (let i = 0; i < lo; i++) pairs.push([i, i]);
  const n = ea - lo;
  const m = eb - lo;
  if (n > 0 && m > 0 && n * m <= MAX_DIFF_CELLS) {
    // best[i][j]: best score aligning a[lo+i..] with b[lo+j..]. A match is worth BIG minus its displacement; BIG outweighs any total displacement.
    const BIG = (n + m + 1) * (n + m + 1);
    const w = m + 1;
    const best = new Float64Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        let v = Math.max(best[(i + 1) * w + j], best[i * w + j + 1]);
        if (a[lo + i] === b[lo + j]) v = Math.max(v, BIG - Math.abs(i - j) + best[(i + 1) * w + j + 1]);
        best[i * w + j] = v;
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j] && best[i * w + j] === BIG - Math.abs(i - j) + best[(i + 1) * w + j + 1]) { pairs.push([lo + i, lo + j]); i++; j++; }
      else if (best[(i + 1) * w + j] >= best[i * w + j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; ea + k < a.length; k++) pairs.push([ea + k, eb + k]);
  return pairs;
}

/**
 * Moves block citations from an old text to an edited one. Unchanged blocks keep theirs (matched by an ordered alignment of
 * the block texts, not by "first equal text anywhere"); the edited blocks between two matched ones are paired in order, so
 * editing, inserting or deleting a block does not shift the evidence of the others.
 */
export function carryCitations(oldMd: string, newMd: string, old: Record<string, string[]>): Record<string, string[]> {
  const a = splitBlocks(oldMd).map((b) => b.text.trim());
  const b = splitBlocks(newMd).map((x) => x.text.trim());
  const out: Record<string, string[]> = {};
  const take = (i: number, j: number) => {
    if (old[String(i)]?.length) out[String(j)] = old[String(i)];
  };
  const pairs = alignEqualBlocks(a, b);
  for (const [i, j] of pairs) take(i, j);
  // Edited blocks: inside each gap between matched blocks, the k-th old block becomes the k-th new one.
  const anchors: [number, number][] = [[-1, -1], ...pairs, [a.length, b.length]];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [i0, j0] = anchors[k];
    const [i1, j1] = anchors[k + 1];
    for (let d = 1; i0 + d < i1 && j0 + d < j1; d++) take(i0 + d, j0 + d);
  }
  return out;
}

/**
 * Stores model output. It becomes the current text only when baseRevId (the head the model started from) is still
 * the head and `forceProposal` is not set; otherwise it waits as a proposal for the author and older pending proposals
 * of the node become 'superseded' (their issues reopen). Applied text leaves pending proposals alone. A proposal's parent is the revision the model started from (baseRevId), not the
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
    // Applied text leaves pending proposals alone: the UI warns when a proposal's base is no longer the head.
    if (!opts.forceProposal && (head?.id ?? null) === baseRevId) return { revision: makeCurrent(ctx, projectId, nodeId, head, fresh), applied: true };
    // Issues waiting on a proposal that is replaced go back to open, so none is stranded on a proposal nobody can accept.
    for (const old of ctx.db.all<Rec>(`SELECT id FROM content_revisions WHERE project_id = ? AND node_id = ? AND status = 'proposal'`, projectId, nodeId)) {
      resolveProposalIssues(ctx, projectId, old.id, { status: 'open', resolution: '' });
    }
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE project_id = ? AND node_id = ? AND status = 'proposal'`, projectId, nodeId);
    return { revision: insertRevision(ctx, { ...fresh, status: 'proposal' }), applied: false };
  });
}

function requireProposal(ctx: AppContext, projectId: string, nodeId: string, revId: string): ContentRevision {
  const rev = getRevision(ctx, projectId, revId);
  if (rev.nodeId !== nodeId) throw notFound('This proposal');
  if (rev.status !== 'proposal') throw conflict('This proposal was already handled.', 'Reload to see the current text.', nodeId);
  return rev;
}

const PROPOSAL_STALE = 'The section changed after you opened this proposal.';

/**
 * Makes the proposal the current text. The previous head becomes 'superseded'. With `expectedHeadRevId` (the head the author
 * compared the proposal with; null when the section had no text) acceptance is refused with 409 when the head is another one,
 * so newer work is never replaced without being seen. `undefined` skips the check (internal callers).
 */
export function acceptProposal(ctx: AppContext, projectId: string, nodeId: string, revId: string, expectedHeadRevId?: string | null): ContentRevision {
  return ctx.db.tx(() => {
    const rev = requireProposal(ctx, projectId, nodeId, revId);
    const head = currentHead(ctx, projectId, nodeId);
    if (expectedHeadRevId !== undefined && (head?.id ?? null) !== expectedHeadRevId) throw conflict(PROPOSAL_STALE, 'Reload to compare the proposal with the latest text.', nodeId);
    if (head) ctx.db.update('content_revisions', head.id, { status: 'superseded' });
    // The parent stays the revision the model started from.
    ctx.db.update('content_revisions', rev.id, { status: 'current' });
    // Issues this proposal answered are now fixed.
    resolveProposalIssues(ctx, projectId, rev.id, { status: 'fixed', resolution: `Fixed by accepting proposal ${rev.id}` });
    return getRevision(ctx, projectId, rev.id);
  });
}

export function rejectProposal(ctx: AppContext, projectId: string, nodeId: string, revId: string): ContentRevision {
  return ctx.db.tx(() => {
    const rev = requireProposal(ctx, projectId, nodeId, revId);
    ctx.db.update('content_revisions', rev.id, { status: 'rejected' });
    resolveProposalIssues(ctx, projectId, rev.id, { status: 'open', resolution: '' });
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

