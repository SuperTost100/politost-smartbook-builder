// Vision transcription of a page, cached in pages.transcript and mirrored into the FTS table.
import type { Page, PageQuality } from '@smartbuilder/domain';
import { TaskError } from '../queue/queue.ts';
import type { AppContext } from '../context.ts';
import { now } from '../db/db.ts';
import { deps } from './deps.ts';

interface PageRow { id: string; rowid: number; resource_id: string; idx: number; label: string; text: string; quality: string; transcript: string | null; transcript_model: string | null; project_id: string; language: string }

const toPage = (r: PageRow): Page => ({
  id: r.id, resourceId: r.resource_id, idx: r.idx, label: r.label, text: r.text, quality: r.quality as PageQuality, transcript: r.transcript, transcriptModel: r.transcript_model,
});

const SYSTEM = [
  'You transcribe a scanned or typeset page into Markdown with LaTeX, as faithfully as possible.',
  'Write inline math as $...$ and display math as $$...$$.',
  'Keep the language of the page. Do not translate, summarize, correct or explain anything.',
  'Keep headings, lists and tables as Markdown. Describe a figure in one bracketed line only if it carries information, for example [figure: ...].',
  'Mark any part you cannot read with an "illegible" marker written in the page language, for example [illeggibile] for Italian or [illegible] for English.',
  'Output only the transcription: no preamble, no commentary, no code fence around the whole page.',
].join(' ');

export async function transcribePage(ctx: AppContext, resourceId: string, idx: number, opts: { signal?: AbortSignal; force?: boolean; runId?: string; taskId?: string } = {}): Promise<Page> {
  const load = () => ctx.db.get<PageRow>(
    `SELECT p.id, p.rowid AS rowid, p.resource_id, p.idx, p.label, p.text, p.quality, p.transcript, p.transcript_model, r.project_id, pr.language
     FROM pages p JOIN resources r ON r.id = p.resource_id JOIN projects pr ON pr.id = r.project_id WHERE p.resource_id = ? AND p.idx = ?`,
    resourceId, idx,
  );
  const row = load();
  if (!row) throw new TaskError(`Page ${idx + 1} of resource ${resourceId} does not exist.`, 'input');
  if (!opts.force && row.transcript && row.transcript.trim()) return toPage(row);

  const png = await deps.renderPageImage(ctx, resourceId, idx, { scale: 2 });
  const out = await deps.runRole(ctx, {
    role: 'vision',
    system: SYSTEM,
    prompt: `Transcribe this page (page label ${row.label}). The book language is "${row.language}" but follow the language actually printed on the page.`,
    images: [png],
    projectId: row.project_id,
    runId: opts.runId,
    taskId: opts.taskId,
    signal: opts.signal,
  });
  const transcript = stripFence(out.text);
  if (!transcript) throw new TaskError('The vision model returned an empty transcription.', 'temporary');
  const model = `${out.route.provider}/${out.route.model}`;

  ctx.db.tx(() => {
    ctx.db.run('UPDATE pages SET transcript = ?, transcript_model = ?, transcript_at = ? WHERE id = ?', transcript, model, now(), row.id);
    const res = ctx.db.run('UPDATE pages_fts SET transcript = ? WHERE rowid = ?', transcript, row.rowid);
    if (Number(res.changes) === 0) ctx.db.run('INSERT INTO pages_fts (rowid, text, transcript) VALUES (?, ?, ?)', row.rowid, row.text, transcript);
  });
  return toPage(load()!);
}

/** Some models wrap the whole answer in a ```markdown fence. Remove it. */
function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  return (m ? m[1] : t).trim();
}
