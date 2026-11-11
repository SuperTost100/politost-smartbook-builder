// Splitting exam files into sessions and exercises: what the split found, the shared store, and the AI split the author asks for.
import { z } from 'zod';
import type { SplitWarning } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { findDate, isSolutionMarker, joinLines, sessionName, type QuestionRow } from '../extract/segment.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { questionsChanged } from '../repo/questions.ts';

// ---------- what a split found ----------

export interface SplitSummary { sessions: number; questions: number; warning: SplitWarning | null }

/** Sessions and questions of a split, and why it looks wrong, if it does. `noHeading`: the splitter recognised no session heading in the file. */
export function summarizeSplit(rows: QuestionRow[], noHeading: boolean): SplitSummary {
  const perSession = new Map<string | null, number>();
  for (const r of rows) perSession.set(r.examGroup, (perSession.get(r.examGroup) ?? 0) + 1);
  const warning: SplitWarning | null = !rows.length ? 'no_questions'
    : noHeading ? 'no_heading'
      : [...perSession.values()].every((n) => n <= 1) ? 'thin_sessions' : null;
  return { sessions: perSession.size, questions: rows.length, warning };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const REASON: Record<SplitWarning, string> = {
  no_questions: 'No exercise heading was recognised.',
  no_heading: 'No session heading was recognised, so the whole file is one session.',
  thin_sessions: 'Every session has at most one question.',
};

/** The warning line shown with a run and next to the file: "1 session and 0 questions found in esami-2024.pdf. …". */
export function splitMessage(filename: string, s: SplitSummary): string {
  return `${plural(s.sessions, 'session', 'sessions')} and ${plural(s.questions, 'question', 'questions')} found in ${filename}.${s.warning ? ` ${REASON[s.warning]}` : ''}`;
}

/** Keeps what the split found in the resource's meta, where the sources API reads it. Only exam files are recorded. */
export function recordSplit(ctx: AppContext, resourceId: string, role: string, s: SplitSummary, method: 'rules' | 'ai') {
  if (role !== 'exams') return;
  const row = ctx.db.get<{ meta: string }>('SELECT meta FROM resources WHERE id = ?', resourceId);
  if (!row) return;
  const meta = json<Record<string, unknown>>(row.meta, {});
  meta.split = { role, sessions: s.sessions, questions: s.questions, warning: s.warning, method, at: now() };
  ctx.db.update('resources', resourceId, { meta });
}

/** The recorded split as fields of a task result: the counts, and `warning` (read by the run summary) when it looks wrong. */
export function splitResult(ctx: AppContext, resourceId: string): Record<string, unknown> {
  const row = ctx.db.get<{ meta: string; filename: string; role: string }>('SELECT meta, filename, role FROM resources WHERE id = ?', resourceId);
  const split = json<{ split?: { role: string } & SplitSummary }>(row?.meta, {}).split;
  if (!row || !split || split.role !== row.role) return {};
  return { sessions: split.sessions, ...(split.warning ? { splitWarning: split.warning, warning: splitMessage(row.filename, split) } : {}) };
}

// ---------- storing ----------

/**
 * Replaces the authentic questions of a file with `rows`. A session already stored from another file is not stored twice
 * (the same session can appear in two yearly files). The regex splitter and the AI split both store through here.
 * With `keepWorkedOn` nothing is replaced when a question of the file was edited or checked, which is tested inside the
 * same transaction as the replacement so an edit made while a model call was pending is not lost.
 */
export function storeAuthenticQuestions(ctx: AppContext, projectId: string, resourceId: string, rows: QuestionRow[], opts: { keepWorkedOn?: boolean } = {}) {
  let inserted = 0;
  let duplicates = 0;
  let refused = false;
  const insertedIds: string[] = [];
  ctx.db.tx(() => {
    if (opts.keepWorkedOn && workedOnQuestions(ctx, resourceId)) { refused = true; return; }
    ctx.db.run(`DELETE FROM questions WHERE resource_id = ? AND origin = 'authentic'`, resourceId);
    for (const q of rows) {
      const dup = q.kind === 'exam' && q.examDate && q.number
        ? ctx.db.get(`SELECT id FROM questions WHERE project_id = ? AND kind = 'exam' AND exam_group = ? AND number = ? AND resource_id != ?`, projectId, q.examGroup, q.number, resourceId)
        : undefined;
      if (dup) { duplicates++; continue; }
      const id = newId();
      insertedIds.push(id);
      ctx.db.insert('questions', {
        id, project_id: projectId, kind: q.kind, origin: 'authentic', resource_id: resourceId,
        page_from: q.pageFrom, page_to: q.pageTo, exam_group: q.examGroup, exam_date: q.examDate, number: q.number,
        statement: q.statement, hint: q.hint ?? '', solution: q.solution ?? '', difficulty: q.difficulty ?? 'medio',
        topic_ids: [], chapter_id: null, status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(),
      });
      inserted++;
    }
  });
  questionsChanged(ctx, projectId, insertedIds);
  return { inserted, duplicates, refused };
}

/** Questions of a file that the author or a later step already worked on: replacing them would lose that work. */
export function workedOnQuestions(ctx: AppContext, resourceId: string): number {
  return ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM questions WHERE resource_id = ? AND origin = 'authentic' AND (edited_at IS NOT NULL OR imported_at IS NOT NULL OR status != 'draft')`, resourceId)?.n ?? 0;
}

// ---------- split with AI ----------

const WORKED_ON = 'Some of its questions were edited or checked already, and the new split would replace them.';

/** One call reads the whole file, so a longer one has to be cut into smaller files first. */
export const AI_SPLIT_MAX_PAGES = 300;

export const examSplitSchema = z.object({
  sessions: z.array(z.object({
    title: z.string().describe('the heading as printed, for example "Esame del 12 febbraio 2024"'),
    date: z.string().nullable().describe('YYYY-MM-DD when the paper prints a date, else null'),
    page: z.number().int().min(1).describe('1-based page where the session starts'),
    start: z.string().describe('the line where the session starts, copied exactly from the text'),
    exercises: z.array(z.object({
      number: z.string().describe('the number or letter as printed, for example "1" or "A"'),
      page: z.number().int().min(1).describe('1-based page where the exercise starts'),
      start: z.string().describe('the first line of the exercise, copied exactly from the text'),
      solution: z.object({
        page: z.number().int().min(1).describe('1-based page where the official solution of this exercise starts'),
        start: z.string().describe('the first line of that solution, copied exactly from the text'),
      }).nullable().optional().describe('where the official solution of this exercise is printed, null when the paper has none'),
    })),
  })),
});
export type ExamSplitAnswer = z.infer<typeof examSplitSchema>;

export function examSplitPrompt(p: { filename: string; heads: string }) {
  return {
    system: 'You find where each exam paper and each exercise starts in a document made of past exam papers. Copy the starting lines exactly as they appear in the text you are given.',
    prompt: `Document: ${p.filename}
A selection of the lines of each page ("page N:" is 1-based): the first ${PAGE_HEAD_FIRST} lines, then the lines that start with a word and a number or a letter ("Es. 2", "Problema 3", "Parte B"), start with a number, or contain a date, at most ${PAGE_HEAD_MAX} lines per page.
${p.heads}

A session is one exam paper, the exam of one day. A paper with versions A and B of the same day is one session. List the sessions in page order. For each session give its title, its date as YYYY-MM-DD when the paper prints one, the page where it starts, the line where it starts, and its exercises in order.
An exercise is an exercise, problem or question ("Esercizio", "Problema", "Quesito", "Domanda", "Parte"). Give its number or letter as printed, the page where it starts and its first line.
Sub-questions a), b), c) belong to their exercise: do not list them. Solutions that follow a paper are not exercises: do not list them as exercises. When the paper prints official solutions (a section headed "Soluzione", "Soluzioni", "Svolgimento"), give for each exercise the page and the first line of its solution, and null when it has none. Quote only lines that appear in the text above.`,
  };
}

interface Line { page: number; text: string }

/** Lines of a page shown to the model: the first ones, then heading-like lines, at most `PAGE_HEAD_MAX` in all. */
const PAGE_HEAD_FIRST = 3;
const PAGE_HEAD_MAX = 25;

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The lines of a page the model is shown: the first ones, and the lines that look like a heading in any course's style:
 * a word, with or without a full stop, then a number, roman numeral or letter ("Es. 2", "Problema 3", "Parte B"); a line that
 * starts with a number; or a line with a date. Sub-questions "a)" do not match, so they do not use up the cap.
 * shortcut: a heading that starts with none of these shapes is not shown, upgrade when a real paper needs another shape.
 */
function pageHeads(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = (l: string) => /^(?:\p{L}[\p{L}'’.]*\s+){1,3}(?:\d{1,2}|[IVX]{1,4}|\p{L})(?![\p{L}\p{N}])/u.test(l) || /^\d{1,2}(?:\s*[.):–-]|\s+\p{L})/u.test(l) || (l.length <= 100 && !!findDate(l));
  return [...lines.slice(0, PAGE_HEAD_FIRST), ...lines.slice(PAGE_HEAD_FIRST).filter(heading)].slice(0, PAGE_HEAD_MAX).map((l) => l.slice(0, 120));
}

/**
 * Turns the model's answer into question rows, or says why it cannot be used. Every boundary must be a line quoted from
 * the page the model names, in page order, and every exercise must start inside its session. The text of an exercise runs
 * from its first line to the next exercise, solution or session, so two exercises on one page do not share text. The
 * solution the model locates for an exercise is stored as the question's solution, as the text rules do.
 */
export function buildAiSplit(resourceId: string, pages: { idx: number; text: string }[], answer: ExamSplitAnswer, label: string): { rows: QuestionRow[] } | { reason: string } {
  const lines: Line[] = pages.flatMap((p) => p.text.split('\n').map((t) => t.trim()).filter(Boolean).map((text) => ({ page: p.idx, text })));
  const locate = (page: number, quote: string, from: number) => {
    const q = squash(quote);
    if (q.length < 3) return -1;
    for (let i = from; i < lines.length; i++) {
      if (lines[i].page !== page - 1) continue;
      const l = squash(lines[i].text);
      if (l.length >= 3 && (l.startsWith(q) || q.startsWith(l))) return i;
    }
    return -1;
  };
  const sessions: { title: string; date: string | null; start: number; exercises: { number: string; start: number; solution: number | null }[] }[] = [];
  let at = 0;
  for (const s of answer.sessions) {
    if (s.page > pages.length) return { reason: `A session starts on page ${s.page}, but the file has ${pages.length} pages.` };
    const start = locate(s.page, s.start, at);
    if (start < 0) return { reason: `The session "${s.title}" does not start with the line the model quoted on page ${s.page}, or it is out of page order.` };
    const exercises: { number: string; start: number; solution: number | null }[] = [];
    at = start;
    for (const e of s.exercises) {
      if (e.page > pages.length) return { reason: `An exercise starts on page ${e.page}, but the file has ${pages.length} pages.` };
      const first = locate(e.page, e.start, exercises.length ? at + 1 : at);
      if (first < 0) return { reason: `Exercise ${e.number} of "${s.title}" does not start with the line the model quoted on page ${e.page}, or it is out of order or outside its session.` };
      // The solution is printed after the exercise, on its own page when the solutions follow the paper.
      const solution = e.solution ? locate(e.solution.page, e.solution.start, first + 1) : null;
      if (e.solution && solution! < 0) return { reason: `The solution of exercise ${e.number} of "${s.title}" does not start with the line the model quoted on page ${e.solution.page}, or it comes before the exercise.` };
      exercises.push({ number: e.number.trim() || String(exercises.length + 1), start: first, solution });
      at = first;
    }
    sessions.push({ title: s.title.trim(), date: s.date, start, exercises });
    at += 1;
  }
  const rows: QuestionRow[] = [];
  const seen = new Map<string, number>();
  const keys = sessions.map((s, i) => {
    const d = s.date ? findDate(s.date) : null;
    return d ? sessionName(s.title, d) : s.title.slice(0, 80) || `${label} - sessione ${i + 1}`;
  });
  for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  const counter = new Map<string, number>();
  // Every place where a session, an exercise or a solution starts. A text runs to the next one.
  const starts = [...new Set(sessions.flatMap((s) => [s.start, ...s.exercises.flatMap((e) => (e.solution === null ? [e.start] : [e.start, e.solution]))]))].sort((a, b) => a - b);
  const nextStart = (from: number) => starts.find((x) => x > from) ?? lines.length;
  sessions.forEach((s, i) => {
    const d = s.date ? findDate(s.date) : null;
    let examGroup = keys[i];
    if ((seen.get(examGroup) ?? 0) > 1) {
      const n = (counter.get(examGroup) ?? 0) + 1;
      counter.set(examGroup, n);
      examGroup = `${examGroup} - versione ${n}`;
    }
    s.exercises.forEach((e) => {
      const own = lines.slice(e.start, nextStart(e.start));
      // The line that opens a section of solutions ("Soluzioni") sits after the last exercise but is not part of it.
      while (own.length > 1 && isSolutionMarker(own[own.length - 1].text)) own.pop();
      const sol = e.solution === null ? [] : lines.slice(e.solution, nextStart(e.solution));
      rows.push({
        kind: 'exam', origin: 'authentic', resourceId, pageFrom: own[0].page,
        // As in the text rules, the range covers statement and solution, so both can be re-read from the page images.
        pageTo: Math.max(own[own.length - 1].page, sol.length ? sol[sol.length - 1].page : 0),
        examGroup, examDate: d ? `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null,
        number: e.number, statement: joinLines(own.map((l) => l.text)), hint: '', solution: joinLines(sol.map((l) => l.text)), difficulty: 'medio', topicIds: [], chapterId: null, status: 'draft', checks: [],
      });
    });
  });
  if (!rows.length) return { reason: 'The model found no exercise.' };
  return { rows };
}

/**
 * Split with AI: asks the bulk model for the sessions and exercises of one exam file, from the first lines of each page.
 * It runs only when the author asks. An answer that does not hold up leaves the file as it was.
 */
export async function resourceSplit(ctx: AppContext, t: TaskContext) {
  const resourceId = t.task.input.resourceId as string;
  const res = ctx.db.get<{ role: string; filename: string; project_id: string }>('SELECT role, filename, project_id FROM resources WHERE id = ?', resourceId);
  if (!res) return { skipped: 'resource deleted' };
  if (res.role !== 'exams') return { skipped: 'not an exam source' };
  const notApplied = (reason: string) => ({ applied: false, reason, ...splitResult(ctx, resourceId), warning: `The AI split of ${res.filename} was not applied. ${reason}` });
  const pages = ctx.db.all<{ idx: number; text: string; transcript: string | null }>('SELECT idx, text, transcript FROM pages WHERE resource_id = ? ORDER BY idx', resourceId)
    .map((p) => ({ idx: p.idx, text: p.transcript || p.text }));
  if (!pages.length) throw new TaskError('This source has no readable pages yet.', 'input', 'Run Prepare so the file is read, then split it again.');
  if (pages.length > AI_SPLIT_MAX_PAGES) return notApplied(`The file has ${pages.length} pages and one call reads at most ${AI_SPLIT_MAX_PAGES}. Split the file into smaller ones.`);
  if (workedOnQuestions(ctx, resourceId)) return notApplied(WORKED_ON);
  const heads = pages.map((p) => `page ${p.idx + 1}:\n${pageHeads(p.text).map((l) => `  ${l}`).join('\n')}`).join('\n');
  const { data } = await runRole(ctx, {
    role: 'bulk', ...examSplitPrompt({ filename: res.filename, heads }), schema: examSplitSchema,
    projectId: t.task.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const built = buildAiSplit(resourceId, pages, data, res.filename.replace(/\.[^.]+$/, '').trim());
  if ('reason' in built) return notApplied(built.reason);
  const stored = storeAuthenticQuestions(ctx, res.project_id, resourceId, built.rows, { keepWorkedOn: true });
  if (stored.refused) return notApplied(WORKED_ON);
  recordSplit(ctx, resourceId, res.role, summarizeSplit(built.rows, false), 'ai');
  return { applied: true, questions: stored.inserted, duplicates: stored.duplicates, ...splitResult(ctx, resourceId) };
}
