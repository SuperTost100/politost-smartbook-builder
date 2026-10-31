// Course program: the pasted text and/or the course guide page, read into editable items and the exam format.
import { examFormatSchema, programItemSchema, type CourseProgram, type ProgramItem } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { ExtractError } from '../extract/errors.ts';
import { htmlToMarkdown } from '../extract/html.ts';
import { safeFetch } from '../extract/safe-fetch.ts';
import { runRole } from '../llm/index.ts';
import { getProgram, saveProgramItems, setProgramStatus } from '../repo/program.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { programPrompt, programSchema } from './prompts.ts';
import { loadProject, slugify, truncate } from './util.ts';

/** The most the parser reads: a course guide is a few thousand words. */
const MAX_SOURCE_CHARS = 60_000;

/** The guide page as text. Tests replace it. */
export const programDeps = {
  fetchGuide: async (url: string, signal?: AbortSignal): Promise<string> => {
    const page = await safeFetch(url, { signal });
    const body = page.body.toString('utf8');
    return /html/i.test(page.contentType) ? htmlToMarkdown(body).markdown : body.trim();
  },
};

const norm = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Keys and limits for freshly parsed items. An item whose title did not change keeps the key it had, so outline references
 * survive a second reading; every other key comes from the parser, made unique against all keys in use.
 */
export function assignKeys(parsed: { key: string; title: string; details: string; proofs: string[] }[], previous: ProgramItem[]): ProgramItem[] {
  const free = new Map<string, string[]>();
  for (const p of previous) free.set(norm(p.title), [...(free.get(norm(p.title)) ?? []), p.key]);
  const keys: (string | null)[] = parsed.map((it) => free.get(norm(it.title))?.shift() ?? null);
  // A key of an item that changed or went away is not given to another item: references to it must not point at a different topic.
  const taken = new Set(previous.map((p) => p.key));
  return parsed.map((it, i) => {
    let key = keys[i];
    if (!key) {
      const base = slugify(it.key || it.title).slice(0, 70);
      key = base;
      for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
      taken.add(key);
    }
    return programItemSchema.parse({
      key, title: it.title.trim().slice(0, 300), details: it.details.trim().slice(0, 2000),
      proofs: it.proofs.map((x) => x.trim().slice(0, 300)).filter(Boolean),
    });
  });
}

async function readSource(row: CourseProgram, signal: AbortSignal): Promise<string> {
  const parts = [row.text.trim()];
  if (row.url) {
    try {
      parts.push((await programDeps.fetchGuide(row.url, signal)).trim());
    } catch (err) {
      if (!(err instanceof ExtractError)) throw err;
      const slow = err.code === 'url_timeout' || err.code === 'url_unreachable';
      throw new TaskError(err.message, slow ? 'temporary' : 'input', err.action ?? 'Check the address, or paste the program text instead.');
    }
  }
  return truncate(parts.filter(Boolean).join('\n\n'), MAX_SOURCE_CHARS);
}

/** `program.parse`: one planner call that turns the guide text into items and the exam format. */
export async function programParse(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const row = getProgram(ctx, projectId);
  if (!row) return { skipped: 'no program saved' };
  const project = loadProject(ctx, projectId);
  setProgramStatus(ctx, projectId, 'parsing');
  try {
    t.progress(row.url ? 'Reading the course guide' : 'Reading the program');
    const sourceText = await readSource(row, t.signal);
    if (!sourceText.trim()) throw new TaskError('The program is empty.', 'input', 'Paste the program text or give the address of the course guide.');
    t.progress('Listing the program items');
    const { data, route } = await runRole(ctx, {
      role: 'planner', ...programPrompt({ language: project.language, text: sourceText }), schema: programSchema,
      projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    const items = assignKeys(data.items.filter((i) => i.title.trim()), row.items);
    if (!items.length) throw new TaskError('No program items were found in that text.', 'input', 'Check that the text holds the course program ("Programma"), then try again.');
    const examFormat = examFormatSchema.parse({ ...data.examFormat, summary: data.examFormat.summary.slice(0, 3000) });
    // The author can remove the program while the planner reads it; saving would bring it back.
    if (!getProgram(ctx, projectId)) return { skipped: 'program removed while it was read' };
    saveProgramItems(ctx, projectId, { items, examFormat, sourceText, parsed: true });
    return { items: items.length, model: route.model, kept: items.filter((i) => row.items.some((o) => o.key === i.key)).length };
  } catch (err) {
    // The queue retries or gives up; the Setup screen reads the status, so it must not stay on "parsing".
    setProgramStatus(ctx, projectId, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
}
