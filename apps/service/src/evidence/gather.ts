// Evidence packets: NotebookLM when it is signed in, otherwise FTS candidates read by the evidence model.
import type { EvidenceNote, EvidencePacket } from '@smartbuilder/domain';
import { z } from 'zod';
import { TaskError } from '../queue/queue.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { claimsByCitation, shiftCitations } from './citations.ts';
import { deps } from './deps.ts';
import { notebookStatus, queryNotebook } from './nlm.ts';
import { syncNotebook } from './sync.ts';
import { clipQuote, quoteInText } from './verify.ts';
import type { EvidenceRequest } from './index.ts';

const MAX_PAGES = 14;
const MAX_CHARS = 60_000;
const PER_PAGE_CHARS = 8_000;
const SEARCH_LIMIT = 10;

export async function gatherEvidence(ctx: AppContext, req: EvidenceRequest, opts: { force?: boolean } = {}): Promise<EvidencePacket> {
  if (!opts.force) {
    const row = ctx.db.get<PacketRow>('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', req.projectId, req.nodeId);
    if (row) return toPacket(row);
  }
  const resourceIds = resolveResources(ctx, req);
  let built: Built | null = null;
  if (ctx.settings().evidenceMode === 'notebooklm') {
    const status = await notebookStatus();
    if (status.signedIn) {
      try {
        built = await viaNotebook(ctx, req, resourceIds);
      } catch (err) {
        // NotebookLM has its own limits and sign-in. The local reader keeps the run going.
        if (!(err instanceof TaskError) || (err.kind !== 'auth' && err.kind !== 'quota' && err.kind !== 'fatal')) throw err;
        ctx.events.emit('log', { message: `NotebookLM unavailable (${err.message}); using the local evidence reader.` }, { projectId: req.projectId, runId: req.runId, taskId: req.taskId });
      }
    }
  }
  built ??= await viaLocal(ctx, req, resourceIds);

  const packet: EvidencePacket = { id: newId(), projectId: req.projectId, nodeId: req.nodeId, provider: built.provider, query: req.query, answer: built.answer, notes: built.notes, createdAt: now() };
  ctx.db.insert('evidence_packets', { id: packet.id, project_id: packet.projectId, node_id: packet.nodeId, provider: packet.provider, query: packet.query, answer: packet.answer, notes: packet.notes, created_at: packet.createdAt });
  return packet;
}

interface Built { provider: EvidencePacket['provider']; answer: string; notes: EvidenceNote[] }
interface PacketRow { id: string; project_id: string; node_id: string; provider: string; query: string; answer: string; notes: string; created_at: string }

function toPacket(r: PacketRow): EvidencePacket {
  return { id: r.id, projectId: r.project_id, nodeId: r.node_id, provider: r.provider as EvidencePacket['provider'], query: r.query, answer: r.answer, notes: json<EvidenceNote[]>(r.notes, []), createdAt: r.created_at };
}

/** Requested resources, or every included theory (and mixed) resource of the project. */
function resolveResources(ctx: AppContext, req: EvidenceRequest): string[] {
  const rows = ctx.db.all<{ id: string; role: string }>(`SELECT id, role FROM resources WHERE project_id = ? AND included = 1 AND status = 'ready' ORDER BY created_at, id`, req.projectId);
  if (req.resourceIds.length) {
    const ok = new Set(rows.map((r) => r.id));
    const wanted = req.resourceIds.filter((id) => ok.has(id));
    if (wanted.length) return wanted;
  }
  const theory = rows.filter((r) => r.role === 'theory' || r.role === 'mixed');
  return (theory.length ? theory : rows).map((r) => r.id);
}

// ---------- NotebookLM ----------

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

async function viaNotebook(ctx: AppContext, req: EvidenceRequest, resourceIds: string[]): Promise<Built> {
  if (!resourceIds.length) throw new TaskError('The project has no ready sources.', 'input');
  await syncNotebook(ctx, req.projectId, req.signal);
  const marks = resourceIds.map(() => '?').join(',');
  const rows = ctx.db.all<{ resource_id: string; remote_source_id: string; nb_remote: string }>(
    `SELECT s.resource_id, s.remote_source_id, n.remote_id AS nb_remote FROM notebook_sources s JOIN notebooks n ON n.id = s.notebook_id
     WHERE s.resource_id IN (${marks}) AND s.status = 'ready' AND s.remote_source_id IS NOT NULL`,
    ...resourceIds,
  );
  if (!rows.length) throw new TaskError('No source reached NotebookLM.', 'fatal');
  const resourceBySource = new Map(rows.map((r) => [r.remote_source_id, r.resource_id]));
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.nb_remote, [...(groups.get(r.nb_remote) ?? []), r.remote_source_id]);

  const lang = ctx.db.get<{ language: string }>('SELECT language FROM projects WHERE id = ?', req.projectId)?.language ?? 'it';
  const question = [
    req.query,
    '',
    `Answer in ${languageName(lang)}. Use only the selected sources. For every statement, quote the supporting passage verbatim from the sources (keep wording and formulas exactly as written) and put its citation marker right after the quote. Do not paraphrase when a quote is possible.`,
  ].join('\n');

  const answers: string[] = [];
  const notes: EvidenceNote[] = [];
  let offset = 0;
  for (const [remote, sourceIds] of groups) {
    const res = await queryNotebook(remote, question, sourceIds, req.signal);
    answers.push(shiftCitations(res.answer, offset));
    const valid = new Set(res.references.map((r) => r.citation_number));
    const claims = claimsByCitation(res.answer, valid);
    for (const ref of res.references) {
      const mapped = resourceBySource.get(ref.source_id) ?? null;
      const hit = (mapped ? deps.findPassage(ctx, [mapped], ref.cited_text) : null) ?? deps.findPassage(ctx, resourceIds, ref.cited_text);
      const n = ref.citation_number + offset;
      notes.push({
        id: uniqueId(`n${n}`, notes),
        quote: ref.cited_text,
        resourceId: hit?.resourceId ?? mapped,
        page: hit ? hit.idx : null,
        verified: hit !== null,
        claim: claims.get(ref.citation_number) ?? '',
      });
    }
    offset += Math.max(0, ...res.references.map((r) => r.citation_number));
  }
  return { provider: 'notebooklm', answer: answers.join('\n\n'), notes };
}

function uniqueId(base: string, existing: EvidenceNote[]): string {
  if (!existing.some((n) => n.id === base)) return base;
  let i = 2;
  while (existing.some((n) => n.id === `${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---------- Local reader ----------

interface Candidate { label: string; resourceId: string; idx: number; pageLabel: string; filename: string; text: string }

const localSchema = z.object({
  notes: z.array(z.object({ page: z.string(), quote: z.string(), claim: z.string() })),
  answer: z.string(),
});

export function collectCandidates(ctx: AppContext, req: EvidenceRequest, resourceIds: string[]): Candidate[] {
  const picked: { resourceId: string; idx: number }[] = [];
  const seen = new Set<string>();
  const add = (resourceId: string, idx: number) => {
    const key = `${resourceId}:${idx}`;
    if (seen.has(key) || picked.length >= MAX_PAGES) return;
    seen.add(key);
    picked.push({ resourceId, idx });
  };
  let hits: { resourceId: string; idx: number }[] = [];
  try {
    hits = deps.searchPages(ctx, req.projectId, req.query, { limit: SEARCH_LIMIT, resourceIds }).slice(0, SEARCH_LIMIT);
  } catch (err) {
    ctx.events.emit('log', { message: `Page search failed: ${err instanceof Error ? err.message : String(err)}` }, { projectId: req.projectId, runId: req.runId, taskId: req.taskId });
  }
  for (const h of hits) add(h.resourceId, h.idx);
  for (const h of req.pageHints ?? []) {
    if (resourceIds.length && !resourceIds.includes(h.resourceId)) continue;
    for (let i = h.pageFrom; i <= h.pageTo && i - h.pageFrom < MAX_PAGES; i++) add(h.resourceId, i);
  }
  const out: Candidate[] = [];
  let chars = 0;
  for (const p of picked) {
    const row = ctx.db.get<{ label: string; text: string; transcript: string | null; filename: string }>(
      `SELECT p.label, p.text, p.transcript, r.filename FROM pages p JOIN resources r ON r.id = p.resource_id WHERE p.resource_id = ? AND p.idx = ?`,
      p.resourceId, p.idx,
    );
    if (!row) continue;
    const text = row.transcript?.trim() ? row.transcript : row.text;
    if (!text.trim()) continue;
    if (out.length && chars + Math.min(text.length, PER_PAGE_CHARS) > MAX_CHARS) break;
    chars += Math.min(text.length, PER_PAGE_CHARS);
    out.push({ label: `P${out.length + 1}`, resourceId: p.resourceId, idx: p.idx, pageLabel: row.label, filename: row.filename, text });
  }
  return out;
}

async function viaLocal(ctx: AppContext, req: EvidenceRequest, resourceIds: string[]): Promise<Built> {
  const pages = collectCandidates(ctx, req, resourceIds);
  if (!pages.length) return { provider: 'local', answer: `<!-- local-evidence: kept=0 dropped=0 pages=0 -->`, notes: [] };
  const lang = ctx.db.get<{ language: string }>('SELECT language FROM projects WHERE id = ?', req.projectId)?.language ?? 'it';
  const body = pages.map((p) => `[${p.label}] ${p.filename}, page ${p.pageLabel}\n${p.text.length > PER_PAGE_CHARS ? p.text.slice(0, PER_PAGE_CHARS) : p.text}`).join('\n\n=====\n\n');
  const out = await deps.runRole(ctx, {
    role: 'evidence',
    system: [
      'You are an evidence reader for a university textbook project.',
      'You receive numbered source pages. Return only passages that appear on those pages, copied character for character.',
      'Never invent, translate, reword or fix a quote. If the pages do not answer the question, return fewer notes or none.',
      'Reply with JSON only.',
    ].join(' '),
    prompt: [
      `Question: ${req.query}`,
      '',
      `Return JSON {"notes": [{"page": "P3", "quote": "...", "claim": "..."}], "answer": "..."}.`,
      `- "quote": verbatim text from that page, at most 400 characters. Use "..." to skip the middle of a long passage.`,
      `- "claim": one short sentence in ${languageName(lang)} saying what the quote supports.`,
      `- "answer": a brief answer in ${languageName(lang)} built only from the quotes, citing them as [P3].`,
      '',
      'Source pages:',
      '',
      body,
    ].join('\n'),
    schema: localSchema,
    projectId: req.projectId,
    runId: req.runId,
    taskId: req.taskId,
    signal: req.signal,
  });

  const notes: EvidenceNote[] = [];
  let dropped = 0;
  for (const raw of out.data.notes) {
    const quote = clipQuote(raw.quote);
    const labelled = /P(\d+)/i.exec(raw.page);
    const named = labelled ? pages.find((p) => p.label === `P${labelled[1]}`) : undefined;
    // The model may mislabel the page; accept the quote if it is verbatim on any candidate page.
    const hit = (named && quoteInText(named.text, quote) ? named : undefined) ?? pages.find((p) => quoteInText(p.text, quote));
    if (!hit) {
      dropped++;
      continue;
    }
    notes.push({ id: `n${notes.length + 1}`, quote, resourceId: hit.resourceId, page: hit.idx, verified: true, claim: raw.claim.trim() });
  }
  const answer = `${out.data.answer.trim()}\n\n<!-- local-evidence: kept=${notes.length} dropped=${dropped} pages=${pages.length} -->`;
  return { provider: 'local', answer, notes };
}

/** Reads the kept/dropped counts recorded in a local packet's answer. */
export function localEvidenceMeta(answer: string): { kept: number; dropped: number; pages: number } | null {
  const m = /<!-- local-evidence: kept=(\d+) dropped=(\d+) pages=(\d+) -->/.exec(answer);
  return m ? { kept: Number(m[1]), dropped: Number(m[2]), pages: Number(m[3]) } : null;
}
