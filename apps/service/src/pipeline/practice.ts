// Practice: authentic exam questions cleaned from page transcriptions, generated exercises to topic targets,
// and an independent check of every solution.
import { changedWords, formatModelText, formatterHandles, lintQuestionText, stripDifficultyDecoration } from '@smartbuilder/content';
import { subjectProfileOf, type Question } from '@smartbuilder/domain';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { transcribePage } from '../evidence/index.ts';
import { searchPages } from '../extract/index.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext, type TaskSpec } from '../queue/queue.ts';
import { authenticExtractPrompt, examReadParser, exercisesPrompt, formatRules, generatedQuestionsSchema, parseQuestionText, questionTextAnswerRule, sessionExtractPrompt, verifyPrompt, verifySchema } from './prompts.ts';
import { bookFormulaKeys } from './draft.ts';
import { isFormatIssue, settleQuestionFormatting } from './formatting.ts';
import { combineRecomputes, mismatchMessage, readMismatches, recomputeFinalValues, runConsistency, type Comparison, type ConsistencyCheck, type NumericCheck } from './numeric.ts';
import { issuesChanged } from '../repo/issues.ts';
import { effectiveOutline } from '../repo/outline.ts';
import { getQuestion, questionsChanged, recordQuestionRevision, type QuestionText } from '../repo/questions.ts';
import { COUNTED_QUESTION_SQL, loadOutline, loadProject, loadTopics, truncate } from './util.ts';

/** Authentic exam questions included per chapter, most recent sessions first. */
const AUTHENTIC_PER_CHAPTER = 8;
/** Items from uploaded exercise collections shown to the writer of a chapter's exercises. They are never put in the book. */
const COLLECTION_EXAMPLES = 6;
const MAX_PAGES_PER_QUESTION = 4;
/**
 * One extraction call reads a whole exam session when the pages of its exercises (each question's own window of
 * MAX_PAGES_PER_QUESTION) add up to at most this many pages and this many characters of transcript. A longer session is read
 * exercise by exercise, as before. The longest session in the Analisi, Fisica and Chimica books spans 6 pages by this count.
 */
const MAX_SESSION_PAGES = 12;
const MAX_SESSION_CHARS = 60_000;
/** Pages of the exercise collections the full-text search returns when looking for examples for one chapter. */
const COLLECTION_SEARCH_PAGES = 100;

const ruleOf = (category: string) => category.replace(/^compile:/, '');

/** The text of a question as it is stored: model-written, so formatted. */
const layout = (text: string) => formatModelText(text, { kind: 'question' });

/** Why a formatting repair of question text must not replace the original: it changed a word or a number, in the first part that did. Null when it may. */
function wordsChanged(before: QuestionText, after: QuestionText): string | null {
  for (const part of ['statement', 'hint', 'solution'] as const) {
    const why = changedWords(before[part], after[part]);
    if (why) return `${part}: ${why}`;
  }
  return null;
}
/** Lint rules whose fix is about words (a leaked comment, a placeholder, a figure in an exercise, difficulty marks, drifted language, a reference to a formula the book lacks, a stray digit or letter, a list that lost an item). Every other rule is formatting. */
const WORD_RULES = new Set(['meta-leak', 'placeholder', 'exercise-fence', 'difficulty-decoration', 'language-drift', 'formula-ref-unknown', 'stray-digit-wrap', 'foreign-script', 'list-start', 'decimal-comma']);

/**
 * One formatting repair for question text that would not render or reads broken (unbalanced $, LaTeX KaTeX rejects,
 * a colon leading nowhere): the editor fixes only the listed problems, and its text is kept when it has fewer of them.
 */
async function repairQuestionFormat(ctx: AppContext, t: TaskContext, projectId: string, language: string, text: QuestionText): Promise<QuestionText> {
  const problems = (x: QuestionText) => (['statement', 'hint', 'solution'] as const).flatMap((part) =>
    lintQuestionText(layout(x[part]), { file: part, language, skipRules: ['formula-ref-unknown'] })
      .filter((f) => f.severity !== 'minor' && !formatterHandles(f.rule, f.severity, 'question'))
      .map((f) => `[${part}] ${f.rule}: ${f.message}${f.quote ? ` — "${truncate(f.quote, 160)}"` : ''}`));
  const found = problems(text);
  if (!found.length) return text;
  t.progress(`Fixing ${found.length} formatting problem${found.length > 1 ? 's' : ''} in a question`);
  try {
    const { data } = await runRole(ctx, {
      role: 'editor',
      system: `You fix formatting problems in a university exercise written in ${language === 'it' ? 'Italian' : language} without changing its wording, numbers or results.\n\n${formatRules(language)}`,
      prompt: `PROBLEMS:\n${found.join('\n')}\n\nSTATEMENT:\n${text.statement}\n\nHINT:\n${text.hint}\n\nSOLUTION:\n${text.solution}\n\nChange only what the problems require and keep an empty hint empty.\n\n${questionTextAnswerRule}`,
      parse: parseQuestionText, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    const next = { ...data, hint: text.hint ? data.hint : '' };
    const why = wordsChanged(text, next);
    if (why) t.progress(`A formatting repair was not applied: ${why}`);
    else if (problems(data).length < found.length) return next;
  } catch (err) {
    if (err instanceof TaskError && err.kind !== 'input') throw err;
  }
  return text;
}

export function rowToQuestion(r: Record<string, unknown>): Question {
  return {
    id: r.id as string, projectId: r.project_id as string, kind: r.kind as Question['kind'], origin: r.origin as Question['origin'],
    resourceId: (r.resource_id as string) ?? null, pageFrom: (r.page_from as number) ?? null, pageTo: (r.page_to as number) ?? null,
    examGroup: (r.exam_group as string) ?? null, examDate: (r.exam_date as string) ?? null, number: (r.number as string) ?? null,
    statement: r.statement as string, hint: r.hint as string, solution: r.solution as string, difficulty: r.difficulty as Question['difficulty'],
    topicIds: json(r.topic_ids, []), chapterId: (r.chapter_id as string) ?? null, status: r.status as Question['status'], checks: json(r.checks, []),
    rev: Number(r.rev), createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

/** Plans the chapter's practice: assigns authentic exam questions and enqueues import, generation and verification tasks. */
export async function chapterPractice(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true };
  const project = loadProject(ctx, projectId);
  const topicIds = new Set(chapter.sections.flatMap((s) => s.topicIds));
  const all = ctx.db.all(`SELECT * FROM questions WHERE project_id = ?`, projectId).map(rowToQuestion);
  // Candidates come only from sources that are still included and can hold questions.
  const counted = new Set(ctx.db.all<{ id: string }>(`SELECT id FROM questions WHERE project_id = ? AND ${COUNTED_QUESTION_SQL}`, projectId).map((r) => r.id));

  // Authentic exam questions whose main topic belongs to this chapter.
  let authentic = all.filter((q) => q.kind === 'exam' && q.origin === 'authentic' && q.chapterId === chapterId);
  if (!authentic.length) {
    const candidates = all
      .filter((q) => counted.has(q.id))
      .filter((q) => q.kind === 'exam' && q.origin === 'authentic' && !q.chapterId && q.topicIds[0] && topicIds.has(q.topicIds[0]))
      .sort((a, b) => (b.examDate ?? '').localeCompare(a.examDate ?? ''));
    authentic = candidates.slice(0, AUTHENTIC_PER_CHAPTER);
    ctx.db.tx(() => { for (const q of authentic) ctx.db.run('UPDATE questions SET chapter_id = ?, updated_at = ? WHERE id = ?', chapterId, now(), q.id); });
    questionsChanged(ctx, projectId, authentic.map((q) => q.id));
  }

  const specs: TaskSpec[] = [];
  // Text the author typed or corrected is verified as it is: it is never read from the source pages again.
  const editedIds = new Set(ctx.db.all<{ id: string }>(`SELECT id FROM questions WHERE project_id = ? AND edited_at IS NOT NULL`, projectId).map((r) => r.id));
  const imported = authentic.filter((q) => !editedIds.has(q.id));
  // A session with two or more questions still to read is read in one call, by a task of its own that the imports wait for.
  const sessionTasks = new Map<string, boolean>();
  const sessionKeyOf = new Map<string, string>();
  for (const q of imported) {
    if (q.resourceId === null || q.pageFrom === null) continue;
    const key = sessionImportKey(q.resourceId, q.examGroup);
    if (!sessionTasks.has(key)) {
      // A session task another chapter already made in this run holds the reading of every question it listed, so wait for it too.
      const several = questionsToRead(ctx, q.resourceId, q.examGroup).length >= 2 || !!ctx.db.get('SELECT 1 FROM tasks WHERE run_id = ? AND key = ?', t.task.runId, key);
      sessionTasks.set(key, several);
      if (several) specs.push({ kind: 'question.session', key, label: `Read exam session ${q.examGroup ?? ''}`.trim(), input: { resourceId: q.resourceId, examGroup: q.examGroup }, pool: 'vision' });
    }
    if (sessionTasks.get(key)) sessionKeyOf.set(q.id, key);
  }
  for (const q of authentic) {
    const label = `${q.examGroup ?? 'exam question'} n. ${q.number ?? ''}`.trim();
    if (!editedIds.has(q.id)) specs.push({ kind: 'question.import', key: `import:${q.id}`, label: `Read exam question ${q.examGroup ?? ''} n. ${q.number ?? ''}`.trim(), input: { questionId: q.id }, pool: 'vision', deps: sessionKeyOf.has(q.id) ? [sessionKeyOf.get(q.id)!] : [] });
    specs.push({ kind: 'question.verify', key: `verify:${q.id}`, label: `Check solution of ${label}`, input: { questionId: q.id }, deps: editedIds.has(q.id) ? [] : [`import:${q.id}`], pool: 'checker' });
  }
  const imports = imported.map((q) => `import:${q.id}`);
  specs.push({ kind: 'practice.generate', key: `generate:${chapterId}:exercise`, label: `Write exercises for "${chapter.title}"`, input: { chapterId, kind: 'exercise' }, pool: 'exercises', deps: imports });
  // Without observed exams for this chapter, add labeled exam-style practice.
  if (authentic.length === 0) specs.push({ kind: 'practice.generate', key: `generate:${chapterId}:exam`, label: `Write exam-style practice for "${chapter.title}"`, input: { chapterId, kind: 'exam' }, pool: 'exercises', deps: imports });
  t.enqueue(specs);
  t.progress(`${authentic.length} exam questions from past sessions; exercises to write next`);
  return { authentic: authentic.length, language: project.language };
}

/** What one import reads for a question: its cleaned statement and official solution, or that it is not readable. */
type ImportRead = { statement: string; solution: string; readable: boolean };

/** The key of the task that reads a whole session. Questions of one source file with the same session name share it. */
export const sessionImportKey = (resourceId: string, examGroup: string | null) => `import-session:${resourceId}:${examGroup ?? ''}`;

/** The pages a question's import reads: its own range, at most MAX_PAGES_PER_QUESTION from its first page. */
function importPages(q: { pageFrom: number | null; pageTo: number | null }): number[] {
  if (q.pageFrom === null) return [];
  const last = Math.min(q.pageTo ?? q.pageFrom, q.pageFrom + MAX_PAGES_PER_QUESTION - 1);
  return Array.from({ length: last - q.pageFrom + 1 }, (_, i) => q.pageFrom! + i);
}

/** The questions of a session that an import would still read: not edited by the author, not read from the pages yet, with a page range. */
function questionsToRead(ctx: AppContext, resourceId: string, examGroup: string | null): Question[] {
  return ctx.db.all(`SELECT * FROM questions WHERE resource_id = ? AND exam_group IS ? AND kind = 'exam' AND edited_at IS NULL AND page_from IS NOT NULL ORDER BY rowid`, resourceId, examGroup)
    .filter((r) => !(r.imported_at && String(r.solution).trim())).map(rowToQuestion);
}

const pageText = (p: { label: string; transcript: string | null; text: string }) => `--- page ${p.label} ---\n${p.transcript ?? p.text}`;

/**
 * Reads every question of a session that still needs reading in one call, so the pages are sent once and the fixed cost of a
 * call is paid once. The answer is used only when it lists exactly the questions' numbers: none missing, none invented, none
 * twice. In every other case (a session too long for one call, an answer that does not match, a model that cannot give a valid
 * one) the result says `fallback` and each question's import reads its own pages, as it did before. Errors that a retry can
 * cure (a limit, a login, a timeout) are thrown, so the queue retries this task like any other, except a temporary error on its last attempt, which also falls back.
 */
/**
 * Whether a failed session read hands over to the single reads: on its last attempt, for a temporary TaskError and for an error
 * that is not a TaskError (a page that would not render), which the queue retries the same way. A cancelled task does not, and
 * neither does an error that waits for the author or for a quota reset.
 */
export const sessionGivesWay = (err: unknown, o: { aborted: boolean; lastAttempt: boolean }): boolean =>
  o.lastAttempt && !o.aborted && (!(err instanceof TaskError) || err.kind === 'temporary');

export async function sessionImport(ctx: AppContext, t: TaskContext) {
  const resourceId = t.task.input.resourceId as string;
  const examGroup = (t.task.input.examGroup as string | null) ?? null;
  const questions = questionsToRead(ctx, resourceId, examGroup);
  if (questions.length < 2) return { fallback: 'fewer than two questions to read' };
  const numbers = questions.map((q) => (q.number ?? '').trim());
  if (numbers.some((n) => !n) || new Set(numbers.map((n) => n.toLowerCase())).size !== numbers.length) return { fallback: 'the questions of the session have no distinct numbers' };
  const pageIdx = [...new Set(questions.flatMap(importPages))].sort((a, b) => a - b);
  if (pageIdx.length > MAX_SESSION_PAGES) return { fallback: `the session spans ${pageIdx.length} pages, more than ${MAX_SESSION_PAGES}` };
  try {
    const pages: string[] = [];
    for (const idx of pageIdx) pages.push(pageText(await transcribePage(ctx, resourceId, idx, { signal: t.signal, runId: t.task.runId, taskId: t.task.id })));
    const text = pages.join('\n\n');
    if (text.length > MAX_SESSION_CHARS) return { fallback: `the pages hold ${text.length} characters, more than ${MAX_SESSION_CHARS}` };
    t.progress(`Reading ${questions.length} exercises of ${examGroup ?? 'the session'} together`);
    const project = loadProject(ctx, t.task.projectId);
    // The parser accepts only an answer that has every listed number once and no other, in the listed order.
    const { data, route } = await runRole(ctx, {
      role: 'bulk', ...sessionExtractPrompt({ language: project.language, examGroup: examGroup ?? '', exercises: questions.map((q, i) => ({ number: numbers[i]!, solutionText: truncate(q.solution, 4000) })), pages: text }),
      parse: examReadParser(numbers), projectId: t.task.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    return { exercises: questions.length, model: route.model, extracted: Object.fromEntries(questions.map((q, i) => { const e = data.exercises[i]!; return [q.id, { statement: e.statement, solution: e.solution, readable: e.readable }]; })) };
  } catch (err) {
    if (err instanceof TaskError && err.kind === 'input') return { fallback: err.message };
    // The imports wait for this task, so a task that failed for good would fail the chapter. On the last attempt an error a retry could have cured gives way to their own reads.
    const lastAttempt = t.task.attempts >= (ctx.db.get<{ max_attempts: number }>('SELECT max_attempts FROM tasks WHERE id = ?', t.task.id)?.max_attempts ?? 1);
    if (sessionGivesWay(err, { aborted: t.signal.aborted, lastAttempt })) return { fallback: err instanceof Error ? err.message : String(err) };
    throw err;
  }
}

/** The session task's reading of this question and the model that read it, when the question waited for one and it gave a usable answer. */
function sessionRead(t: TaskContext, q: Question): { read: ImportRead; model: string | null } | null {
  if (q.resourceId === null) return null;
  const result = t.deps[sessionImportKey(q.resourceId, q.examGroup)] as { extracted?: Record<string, ImportRead>; model?: string } | null | undefined;
  const read = result?.extracted?.[q.id];
  return read ? { read, model: result?.model ?? null } : null;
}

/** Clean statement and official solution from vision transcripts of the question's pages: from its session's single reading, or else one call of its own. */
export async function questionImport(ctx: AppContext, t: TaskContext) {
  const q = ctx.db.get('SELECT * FROM questions WHERE id = ?', t.task.input.questionId as string);
  if (!q) return { skipped: true };
  const question = rowToQuestion(q);
  // The author's own text is never replaced by a re-read of the source pages.
  if (q.edited_at) return { skipped: 'edited by the author' };
  // Already read from the pages (the marker survives later edits and check changes).
  if (q.imported_at && question.solution.trim()) return { reused: true };
  if (question.resourceId === null || question.pageFrom === null) return { skipped: 'no page range' };
  // Every update below applies only if the author has not edited the question since this read.
  const rev = question.rev;
  const project = loadProject(ctx, question.projectId);
  const session = sessionRead(t, question);
  let data = session?.read ?? null;
  const models: string[] = session?.model ? [session.model] : [];
  if (!data) {
    const pages: string[] = [];
    for (const idx of importPages(question)) pages.push(pageText(await transcribePage(ctx, question.resourceId, idx, { signal: t.signal, runId: t.task.runId, taskId: t.task.id })));
    const solutionPages = question.solution ? `(text layer, math may be garbled)\n${truncate(question.solution, 6000)}` : '(same pages)';
    const read = await runRole(ctx, {
      role: 'bulk', ...authenticExtractPrompt({ language: project.language, examGroup: question.examGroup ?? '', number: question.number ?? '', statementPages: pages.join('\n\n'), solutionPages }),
      parse: examReadParser([question.number ?? '']), projectId: question.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    data = read.data.exercises[0]!;
    models.push(read.route.model);
  }
  if (!data.readable) {
    // Out of the book until the author types it in: its raw text-layer statement is garbled.
    const changed = ctx.db.run(`UPDATE questions SET status = 'issue', chapter_id = NULL, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`, now(), question.id, rev).changes;
    if (!changed) return { stale: true };
    questionsChanged(ctx, question.projectId, [question.id]);
    addIssue(ctx, question, 'major', 'unreadable', 'This exam question could not be read from its pages, so it was left out of the book.', 'Open the source pages, type the statement and solution in Practice, and assign it to a chapter.');
    return { readable: false };
  }
  const checks = [...question.checks, { method: 'lint' as const, ok: true, detail: 'imported' }];
  let solution = data.solution;
  if (!solution.trim()) {
    // Some sessions are published without solutions; the book needs a worked one, which verification then checks.
    t.progress('Writing the missing solution');
    const solved = await runRole(ctx, {
      role: 'exercises',
      system: `You solve a university exam exercise for a textbook in ${project.language === 'it' ? 'Italian' : project.language}, with every step and the final results clearly stated.\n\n${formatRules(project.language)}`,
      prompt: `EXERCISE:\n${data.statement}\n\nReturn JSON {"markdown": "<the worked solution>"}.`,
      schema: z.object({ markdown: z.string() }), projectId: question.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    solution = solved.data.markdown;
    models.push(solved.route.model);
    checks.push({ method: 'lint', ok: true, detail: `No official solution; written by ${solved.route.model}` });
  }
  const fixed = await repairQuestionFormat(ctx, t, question.projectId, project.language, { statement: data.statement, hint: '', solution });
  const at = now();
  const after = { statement: layout(fixed.statement), hint: question.hint, solution: layout(fixed.solution) };
  const changed = ctx.db.tx(() => {
    const n = ctx.db.run('UPDATE questions SET statement = ?, solution = ?, checks = ?, imported_at = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?', after.statement, after.solution, JSON.stringify(checks), at, at, question.id, rev).changes;
    if (n) recordQuestionRevision(ctx, question.id, question, after, { origin: 'imported', model: models.join(', ') || null, taskId: t.task.id });
    return n;
  });
  if (!changed) {
    keepStaleOutput(ctx, question, data.statement, data.solution);
    return { stale: true };
  }
  questionsChanged(ctx, question.projectId, [question.id]);
  return { readable: true };
}

/** The question was edited while the model worked: keep the model's text in an issue instead of overwriting the author. */
function keepStaleOutput(ctx: AppContext, q: Question, statement: string, solution: string, hint?: string) {
  addIssue(ctx, q, 'minor', 'stale-ai-output', 'This question was edited while the AI was working, so the AI result was not applied. It is kept here.',
    `STATEMENT:\n${statement}\n${hint !== undefined ? `\nHINT:\n${hint}\n` : ''}\nSOLUTION:\n${solution}`);
}

/**
 * One stage of chapter practice: `kind` is 'exercise' or 'exam' (inputs from before the split have no kind and do both when
 * `examStyle` is set). A stage reuses the generated questions of its (chapter, kind) instead of calling the model again, and
 * always enqueues their verification (idempotent by key), so a retry rebuilds whatever downstream work is missing.
 */
export async function practiceGenerate(ctx: AppContext, t: TaskContext) {
  const kinds: ('exercise' | 'exam')[] = t.task.input.kind === 'exam' ? ['exam'] : t.task.input.kind === 'exercise' ? ['exercise'] : t.task.input.examStyle ? ['exercise', 'exam'] : ['exercise'];
  let generated = 0;
  let reused = 0;
  for (const kind of kinds) {
    const r = await generateStage(ctx, t, kind);
    if ('skipped' in r) return r;
    generated += r.generated;
    reused += r.reused;
  }
  return { generated, reused };
}

/**
 * Up to COLLECTION_EXAMPLES items of the included exercise collections on these topics, those with a known answer first.
 * Items already classified on the topics come first. For the rest, Prepare does not classify collection items: the pages of
 * the collections that best match the chapter's topic and section names (the full-text index of the pages) narrow the search,
 * and the items on those pages are ranked by how many of those words their own text contains. This costs no model call. A
 * classification would only add a topic and a difficulty, and the writer uses the items for level and style.
 */
function collectionExamples(ctx: AppContext, projectId: string, topicIds: Set<string>, query: string): string {
  const rows = ctx.db.all(`SELECT * FROM questions WHERE project_id = ? AND kind = 'exercise' AND origin = 'authentic' AND resource_id IS NOT NULL AND ${COUNTED_QUESTION_SQL} ORDER BY rowid`, projectId).map(rowToQuestion);
  const known = (q: Question) => (q.solution.trim() ? 0 : 1);
  const classified = rows.filter((q) => q.topicIds.some((id) => topicIds.has(id))).sort((a, b) => known(a) - known(b)).slice(0, COLLECTION_EXAMPLES);
  const picked = [...classified];
  if (picked.length < COLLECTION_EXAMPLES) {
    const unclassified = rows.filter((q) => !q.topicIds.length && q.pageFrom !== null);
    const resourceIds = [...new Set(unclassified.map((q) => q.resourceId!))];
    const pageRank = new Map(searchPages(ctx, projectId, query, { limit: COLLECTION_SEARCH_PAGES, resourceIds }).map((h, i) => [`${h.resourceId}:${h.idx}`, i]));
    const words = searchWords(query);
    const found = unclassified.flatMap((q) => {
      let rank = Infinity;
      for (let page = q.pageFrom!; page <= (q.pageTo ?? q.pageFrom!); page++) rank = Math.min(rank, pageRank.get(`${q.resourceId}:${page}`) ?? Infinity);
      const text = q.statement.normalize('NFKC').toLowerCase();
      const hits = words.filter((w) => text.includes(w)).length;
      return Number.isFinite(rank) && hits ? [{ q, rank, hits }] : [];
    }).sort((a, b) => known(a.q) - known(b.q) || b.hits - a.hits || a.rank - b.rank);
    picked.push(...found.slice(0, COLLECTION_EXAMPLES - picked.length).map((f) => f.q));
  }
  return picked.map((q) => `${truncate(q.statement, 800)}${q.solution.trim() ? `\n${truncate(q.solution, 300)}` : ''}`).join('\n\n');
}

/** The words of a search text that an item must contain to count as on the topic: at least 4 letters, cut by 2 when long, as the page search does. */
function searchWords(query: string): string[] {
  const words = query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 4).map((w) => (w.length >= 7 ? w.slice(0, -2) : w)))];
}

async function generateStage(ctx: AppContext, t: TaskContext, kind: 'exercise' | 'exam') {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true as const };
  const chapterNumber = outline!.outline.chapters.indexOf(chapter) + 1;

  let ids = t.task.input.force ? [] : ctx.db.all<{ id: string }>(`SELECT id FROM questions WHERE project_id = ? AND chapter_id = ? AND origin = 'generated' AND kind = ? ORDER BY rowid`, projectId, chapterId, kind).map((r) => r.id);
  const reused = ids.length;
  if (!ids.length) {
    const project = loadProject(ctx, projectId);
    const topics = loadTopics(ctx, projectId).filter((tp) => chapter.sections.some((s) => s.topicIds.includes(tp.id)));
    const keyOf = (id: string) => id.slice(9);
    const target = (p: string) => (p === 'high' ? project.options.exercisesPerHotTopic : project.options.exercisesPerTopic);
    const known = bookFormulaKeys(ctx, projectId).map((k) => `${k.key}: ${k.label}`).join('\n');
    const examples = ctx.db.all(`SELECT * FROM questions WHERE project_id = ? AND chapter_id = ? AND kind = 'exam' AND origin = 'authentic'`, projectId, chapterId)
      .map(rowToQuestion).slice(0, 3).map((q) => `${q.examGroup}, Esercizio ${q.number}:\n${truncate(q.statement, 1500)}`).join('\n\n');
    const searchText = [...topics.map((tp) => tp.name), ...chapter.sections.map((s) => s.title)].join(' ');
    const collection = kind === 'exercise' ? collectionExamples(ctx, projectId, new Set(topics.map((tp) => tp.id)), searchText) : '';
    const list = kind === 'exercise'
      ? topics.map((tp) => ({ key: keyOf(tp.id), name: tp.name, n: target(tp.priority) }))
      : topics.filter((tp) => tp.priority !== 'low').slice(0, 2).map((tp) => ({ key: keyOf(tp.id), name: tp.name, n: 1 }));
    const count = list.reduce((a, b) => a + b.n, 0);
    if (count) {
      const { data, route } = await runRole(ctx, {
        role: 'exercises',
        ...exercisesPrompt({ language: project.language, kind, chapterTitle: chapter.title, topics: list.map((x) => `${x.key}: ${x.name} — ${x.n}`).join('\n'), count, examples, collection, knownFormulas: known }),
        schema: generatedQuestionsSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
      });
      const valid = new Map(topics.map((tp) => [keyOf(tp.id), tp.id]));
      // A problem the writer itself says has no answer (E17.5 of Chimica: "the data imply 3.75 oxygen atoms") is not kept.
      const solvable = data.questions.filter((g) => g.solvable);
      if (solvable.length < data.questions.length) t.progress(`${data.questions.length - solvable.length} generated problem${data.questions.length - solvable.length > 1 ? 's' : ''} without an answer left out`);
      const written: typeof data.questions = [];
      for (const g of solvable) written.push({ ...g, ...await repairQuestionFormat(ctx, t, projectId, project.language, { statement: stripDifficultyDecoration(g.statement), hint: kind === 'exam' ? '' : g.hint, solution: g.solution }) });
      ids = ctx.db.tx(() => written.map((g) => {
        const id = newId();
        const text = { statement: layout(g.statement), hint: layout(g.hint), solution: layout(g.solution) };
        ctx.db.insert('questions', {
          id, project_id: projectId, kind, origin: 'generated', resource_id: null, page_from: null, page_to: null, exam_group: null, exam_date: null,
          number: null, ...text, difficulty: g.difficulty,
          topic_ids: g.topics.map((k) => valid.get(k)).filter(Boolean), chapter_id: chapterId, status: 'draft',
          checks: [{ method: 'lint', ok: true, detail: `final answer: ${g.finalAnswer}` }], rev: 1, created_at: now(), updated_at: now(),
        });
        recordQuestionRevision(ctx, id, null, text, { origin: 'generated', model: route.model, taskId: t.task.id });
        return id;
      }));
    }
  }
  questionsChanged(ctx, projectId, ids.slice(reused));
  // Always: enqueue is idempotent by key, so questions that lost their verification task get it back.
  t.enqueue(ids.map((id) => ({ kind: 'question.verify', key: `verify:${id}`, label: `Check generated ${kind === 'exam' ? 'exam question' : 'exercise'} (chapter ${chapterNumber})`, input: { questionId: id }, pool: 'checker' })));
  return { generated: ids.length - reused, reused };
}

/**
 * Barrier for the first-chapter gate: succeeds when every task of the chapter's practice in this run (imports, generation,
 * verification) has finished. Until then it asks the queue to try again shortly.
 */
export async function practiceDone(ctx: AppContext, t: TaskContext) {
  const chapterId = t.task.input.chapterId as string;
  // A task behind a failed or cancelled dependency, at any depth, never runs: it counts as finished, not as open.
  const rows = ctx.db.all<{ state: string; blocked: number }>(
    `WITH RECURSIVE blocked(id) AS (
       SELECT d.task_id FROM task_deps d JOIN tasks dt ON dt.id = d.dep_id WHERE dt.run_id = ? AND dt.state IN ('failed', 'cancelled')
       UNION
       SELECT d.task_id FROM task_deps d JOIN blocked b ON d.dep_id = b.id
     )
     SELECT t.state, t.id IN (SELECT id FROM blocked) AS blocked FROM tasks t WHERE t.run_id = ? AND (
       (t.kind = 'practice.generate' AND json_extract(t.input, '$.chapterId') = ?)
       OR (t.kind IN ('question.import', 'question.verify') AND json_extract(t.input, '$.questionId') IN (SELECT id FROM questions WHERE project_id = ? AND chapter_id = ?)))`,
    t.task.runId, t.task.runId, chapterId, t.task.projectId, chapterId);
  const open = rows.filter((r) => !r.blocked && !['succeeded', 'failed', 'cancelled', 'skipped'].includes(r.state)).length;
  if (open) {
    t.progress(`${open} practice task${open > 1 ? 's' : ''} still running`);
    throw new TaskError(`${open} practice tasks are still running.`, 'later');
  }
  return { tasks: rows.length, failed: rows.filter((r) => r.state === 'failed').length, blocked: rows.filter((r) => r.blocked).length };
}

/** The answer of one exercise check (`verifySchema`). */
export type VerifyAnswer = z.infer<typeof verifySchema>;

/**
 * Why the statement's data fail the check, in one message for one blocker, or null when they pass: the problem is well posed,
 * no data problem is listed, and the consistency program printed CONSISTENT. A program that crashed, timed out or printed no
 * verdict fails. No program at all passes only because the prompt allows that for a problem with no numeric data.
 */
export function dataFailure(d: Pick<VerifyAnswer, 'wellPosed' | 'wellPosedReason' | 'dataProblems'>, consistency: ConsistencyCheck | null): string | null {
  const parts: string[] = [];
  if (!d.wellPosed) parts.push(`The statement's data do not determine one answer${d.wellPosedReason.trim() ? `: ${d.wellPosedReason.trim().replace(/\.$/, '')}` : ''}.`);
  const problems = d.dataProblems.map((p) => p.trim().replace(/\.$/, '')).filter(Boolean);
  if (problems.length) parts.push(`Data problems: ${problems.join('; ')}.`);
  if (consistency?.verdict === 'inconsistent') parts.push(`The consistency check printed: ${consistency.detail}`);
  if (consistency?.verdict === 'failed') parts.push(consistency.detail);
  return parts.length ? parts.join(' ') : null;
}

/**
 * The verdict of the exercise check. A question is verified only when the two solutions agree, no problem above minor is
 * listed, the numeric recompute found no mismatch, and the statement's data pass (`dataFailure`). Two models that agree on a
 * problem with impossible data (Chimica E17.5: both said "no solution") do not pass.
 *
 * The Python recompute settles the numbers: a mismatch it finds is a different result whatever the model says, and when it
 * compared every stated value without a mismatch the results agree, though the model may still list problems with their own
 * severity. Fisica E5.3 (339 against 339,7 N) was blocked on the model's word while the recompute matched all four values.
 */
export function verifyVerdict(d: VerifyAnswer, numeric: NumericCheck | null, consistency: ConsistencyCheck | null) {
  const settled = !!numeric?.complete && !numeric.mismatches.length;
  const resultsAgree = numeric?.mismatches.length ? false : settled || d.resultsAgree;
  // The model's `agrees` includes its results: once the recompute settled those, the listed problems are what is left.
  const agrees = d.agrees || (settled && !d.resultsAgree);
  const data = dataFailure(d, consistency);
  const ok = agrees && resultsAgree && !d.problems.some((p) => p.severity !== 'minor') && !data;
  return { ok, resultsAgree, data };
}

export async function questionVerify(ctx: AppContext, t: TaskContext) {
  const r = ctx.db.get('SELECT * FROM questions WHERE id = ?', t.task.input.questionId as string);
  if (!r) return { skipped: true };
  const q = rowToQuestion(r);
  if (!q.statement.trim() || !q.solution.trim()) return { skipped: 'missing statement or solution' };
  // The check queued after a fix has nothing new to look at when the fix changed nothing.
  if (Object.entries(t.deps).some(([key, r]) => key.startsWith('qfix:') && !!r && typeof r === 'object' && 'skipped' in r)) return { skipped: 'the fix changed nothing' };
  const project = loadProject(ctx, q.projectId);
  const check = (role: 'checker' | 'reviewer') => runRole(ctx, {
    role, ...verifyPrompt({ language: project.language, statement: q.statement, solution: q.solution, profile: subjectProfileOf(project) }), schema: verifySchema,
    projectId: q.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  // A cheap first check; the reviewer is asked only when it finds something, and its verdict is the one recorded.
  // A numeric final answer is recomputed, and the statement's data are checked, in the sandbox from the programs the checker
  // returned, with no extra model call.
  let { data, route } = await check('checker');
  let recomputed = await recomputeFinalValues(data.computation, data.statedValues);
  let consistency = await runConsistency(data.consistency);
  const suspicious = (d: typeof data, r: NumericCheck | null, c: ConsistencyCheck | null) => {
    const v = verifyVerdict(d, r, c);
    return !v.resultsAgree || d.problems.some((p) => p.severity !== 'minor') || !!v.data;
  };
  if (suspicious(data, recomputed, consistency) && ctx.settings().routes.checker.primary.model !== ctx.settings().routes.reviewer.primary.model) {
    t.progress('Asking the reviewer for a second opinion');
    ({ data, route } = await check('reviewer'));
    // A reviewer that gave no usable program does not erase the checker's mismatch; with both programs, a mismatch needs both.
    recomputed = combineRecomputes(recomputed, await recomputeFinalValues(data.computation, data.statedValues));
    // Its consistency program is its verdict on the data; with no program, the checker's result stands.
    consistency = (await runConsistency(data.consistency)) ?? consistency;
  }
  const mismatches = recomputed?.mismatches ?? [];
  const { ok, resultsAgree, data: badData } = verifyVerdict(data, recomputed, consistency);
  // A verified question gets no issue: its minor notes stay in the check's detail.
  const notes = ok && data.problems.length ? ` Minor notes: ${truncate(data.problems.map((p) => p.message.trim()).join(' '), 1000)}` : '';
  const checks = [
    ...q.checks.filter((c) => c.method !== 'independent-solve' && c.method !== 'numeric' && c.method !== 'consistency'),
    { method: 'independent-solve' as const, ok, detail: `Independent result: ${truncate(data.independentAnswer, 400)}${notes}`, model: route.model },
    ...(recomputed ? [{ method: 'numeric' as const, ok: !mismatches.length, detail: `Recomputed in Python: ${recomputed.compared.map((c) => `${c.name} ${c.computed} (solution: ${c.stated})`).join('; ')}` }] : []),
    { method: 'consistency' as const, ok: !badData, detail: badData ?? consistency?.detail ?? 'No numeric data to check; the statement was judged well posed.' },
  ];
  if (!ok) {
    const undone = undoFix(ctx, t, q, failureSummary(data, mismatches, resultsAgree, badData));
    if (undone) return undone;
  }
  return ctx.db.tx(() => {
    // The check was made on the text as of q.rev; if the author edited since, it says nothing about the new text.
    const changed = ctx.db.run('UPDATE questions SET status = ?, checks = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?', ok ? 'verified' : 'issue', JSON.stringify(checks), now(), q.id, q.rev).changes;
    if (!changed) return { stale: true };
    questionsChanged(ctx, q.projectId, [q.id]);
    const stale = ctx.db.all<{ id: string }>(`SELECT id FROM review_issues WHERE question_id = ? AND source = 'verification' AND status = 'open'`, q.id).map((r) => r.id);
    ctx.db.run(`DELETE FROM review_issues WHERE question_id = ? AND source = 'verification' AND status = 'open'`, q.id);
    issuesChanged(ctx, q.projectId, stale);
    if (!ok) for (const p of data.problems) addIssue(ctx, q, p.severity, 'solution', p.message, p.suggestion);
    // A known disagreement with the independent answer blocks export, unless a listed problem is already a blocker.
    // Only a different result blocks approval; gaps in the reasoning keep the severity the reviewer gave them.
    if (!resultsAgree && !data.problems.some((p) => p.severity === 'blocker')) {
      const found = mismatches.length
        ? mismatchMessage(mismatches)
        : `The independent solution reaches a different result: ${data.independentAnswer}`;
      addIssue(ctx, q, 'blocker', 'solution', found, 'Compare both results and correct the solution, or accept the issue if the independent answer is wrong.');
    }
    // Data that are inconsistent, impossible or not shown consistent always block, whatever the solutions say.
    if (badData) {
      addIssue(ctx, q, 'blocker', 'data', badData, q.origin === 'generated'
        ? 'Correct the data of the statement so that they are consistent and determine one answer, and the solution with them. Accept the issue only if the check is wrong.'
        : 'The statement comes from a source or from the author, so the AI fix leaves it alone: check it against the source and correct it by hand, or accept the issue if the check is wrong.');
    }
    return { ok, problems: data.problems.length, ...(recomputed ? { recomputed: recomputed.compared.length, mismatches: mismatches.length } : {}), ...(badData ? { data: badData } : {}) };
  });
}

/** What made a check fail, in one line, for the issues an undone fix reopens. */
function failureSummary(d: VerifyAnswer, mismatches: Comparison[], resultsAgree: boolean, badData: string | null): string {
  const parts = d.problems.filter((p) => p.severity !== 'minor').map((p) => p.message.trim().replace(/\.$/, ''));
  if (mismatches.length) parts.push(mismatchMessage(mismatches).replace(/\.$/, ''));
  else if (!resultsAgree) parts.push(`the independent solution reaches a different result: ${d.independentAnswer.trim().replace(/\.$/, '')}`);
  if (badData) parts.push(badData.replace(/\.$/, ''));
  return truncate(parts.length ? parts.join('; ') : 'the independent check does not agree with the solution', 800);
}

/** What `questionRevise` returns when it saved a rewrite: the issues it closed and the question's origin and status before. */
interface FixResult { revised: true; fixed: string[]; origin: Question['origin']; status: Question['status'] }

/**
 * Undoes the AI fix this check was queued after, when the check fails: the text goes back to what it was before the fix
 * (from `question_revisions`), and the issues the fix closed open again with the reason. Only the fix's own rewrite is undone:
 * when the text changed after it (an author edit), or the check was not queued after a fix, this returns null and the failed
 * check files its issues as usual. The reopened issues wait for the author, so a failed fix is never retried on its own.
 */
function undoFix(ctx: AppContext, t: TaskContext, q: Question, reason: string) {
  const fix = Object.entries(t.deps).find(([key]) => key.startsWith('qfix:'))?.[1] as FixResult | null | undefined;
  if (!fix?.revised) return null;
  const rev = ctx.db.get<{ old_statement: string | null; old_hint: string | null; old_solution: string | null; statement: string; hint: string; solution: string }>(
    `SELECT r.* FROM question_revisions r JOIN task_deps d ON d.dep_id = r.task_id WHERE d.task_id = ? AND r.question_id = ? AND r.origin = 'revised' ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
    t.task.id, q.id);
  if (!rev || rev.old_statement === null || rev.statement !== q.statement || rev.hint !== q.hint || rev.solution !== q.solution) return null;
  const before = { statement: rev.old_statement, hint: rev.old_hint ?? '', solution: rev.old_solution ?? '' };
  return ctx.db.tx(() => {
    const changed = ctx.db.run('UPDATE questions SET statement = ?, hint = ?, solution = ?, origin = ?, status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?',
      before.statement, before.hint, before.solution, fix.origin, fix.status, now(), q.id, q.rev).changes;
    if (!changed) return { stale: true };
    recordQuestionRevision(ctx, q.id, q, before, { origin: 'restored', taskId: t.task.id });
    const reopened = fix.fixed.length ? ctx.db.all<{ id: string }>(`SELECT id FROM review_issues WHERE status = 'fixed' AND id IN (${fix.fixed.map(() => '?').join(',')})`, ...fix.fixed).map((r) => r.id) : [];
    if (reopened.length) ctx.db.run(`UPDATE review_issues SET status = 'open', resolution = ? WHERE id IN (${reopened.map(() => '?').join(',')})`, `The AI fix was undone because the check after it failed: ${reason}`, ...reopened);
    questionsChanged(ctx, q.projectId, [q.id]);
    issuesChanged(ctx, q.projectId, reopened);
    return { ok: false, restored: true, reopened: reopened.length };
  });
}

function addIssue(ctx: AppContext, q: Question, severity: string, category: string, message: string, suggestion: string) {
  ctx.db.insert('review_issues', {
    id: newId(), project_id: q.projectId, node_id: q.chapterId, question_id: q.id, rev_id: null, source: 'verification', severity, category,
    quote: truncate(q.statement, 200), message, suggestion, status: 'open', resolution: '', created_at: now(),
  });
  ctx.events.emit('issue.created', { questionId: q.id, severity }, { projectId: q.projectId });
}

/** The ids among these issues that are still open: the author has not dismissed, accepted or fixed them since the task was queued. */
function stillOpen(ctx: AppContext, ids: string[]): string[] {
  return ids.length ? ctx.db.all<{ id: string }>(`SELECT id FROM review_issues WHERE status = 'open' AND id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => r.id) : [];
}

export const questionReviseSchema = z.object({ statement: z.string(), hint: z.string(), solution: z.string() });

/** Rewrites an exercise for its open issues. Authentic questions keep their statement unless an issue says it is wrong. */
export async function questionRevise(ctx: AppContext, t: TaskContext) {
  const r = ctx.db.get('SELECT * FROM questions WHERE id = ?', t.task.input.questionId as string);
  if (!r) return { skipped: true };
  let q = rowToQuestion(r);
  const ids = (t.task.input.issueIds as string[]) ?? [];
  const selected = ids.length ? ctx.db.all<{ id: string; message: string; suggestion: string; source: string; category: string; severity: string; status: string }>(`SELECT id, message, suggestion, source, category, severity, status FROM review_issues WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  // The issues may be gone (a relint of the chapter deletes open lint rows): with nothing left to fix the editor must not run and save its answer as a draft.
  if (ids.length && !selected.length) return { skipped: 'the requested issues are gone' };
  const project = loadProject(ctx, q.projectId);
  // Formatting findings are settled by code and never listed in a prompt. A fix made of them alone makes no model call.
  const formatIssues = selected.filter((i) => isFormatIssue(i, 'question'));
  // A statement that was not generated comes from an exam paper, a collection or the author: a data issue on it stays with the author.
  const authorOnly = q.origin === 'generated' ? [] : selected.filter((i) => i.category === 'data' && !isFormatIssue(i, 'question'));
  const issues = selected.filter((i) => !isFormatIssue(i, 'question') && !authorOnly.includes(i));
  if (authorOnly.length) {
    ctx.db.tx(() => {
      const open = stillOpen(ctx, authorOnly.map((i) => i.id));
      if (open.length) ctx.db.run(`UPDATE review_issues SET resolution = ? WHERE id IN (${open.map(() => '?').join(',')})`, 'The AI fix does not change the data of a statement that was not generated: correct it by hand, or accept the issue.', ...open);
      issuesChanged(ctx, q.projectId, open);
    });
    if (!issues.length && !formatIssues.length) return { skipped: 'a data issue on this statement stays with the author' };
  }
  const settled = settleQuestionFormatting(ctx, { projectId: q.projectId, questionId: q.id, language: project.language, issues: formatIssues });
  if (formatIssues.length && !issues.length) return settled.changed ? { revised: true } : { skipped: 'the formatter changed nothing' };
  // The model works on the text the formatter left.
  if (settled.changed) q = getQuestion(ctx, q.id);
  // The editor cannot tell which formula keys exist, so a note about an unknown reference comes with the book's keys and labels.
  // Only sections of the outline count: a section taken out of it keeps its text, and the book does not define its formulas.
  const inBook = new Set(effectiveOutline(ctx, q.projectId)?.revision.outline.chapters.flatMap((c) => [c.id, ...c.sections.map((s) => s.id)]));
  const keyList = issues.some((i) => ruleOf(i.category) === 'formula-ref-unknown')
    ? `\n\nNUMBERED FORMULAS OF THE BOOK (key: label):\n${bookFormulaKeys(ctx, q.projectId, undefined, inBook).map((k) => `${k.key}: ${k.label}`).join('\n') || '(none)'}\nFor an unknown formula reference, point {{formula:@key}} at one of these keys only when that formula states the same result. Otherwise replace the reference with plain words.`
    : '';
  const { data, route } = await runRole(ctx, {
    role: 'editor',
    system: `You correct a textbook exercise in ${project.language === 'it' ? 'Italian' : project.language}. Fix exactly the reported problems; keep everything else.\n\n${formatRules(project.language)}`,
    prompt: `PROBLEMS:\n${issues.map((i, n) => `${n + 1}. ${i.message} Suggested fix: ${i.suggestion}`).join('\n')}${keyList}\n\nSTATEMENT:\n${q.statement}\n\nHINT:\n${q.hint}\n\nSOLUTION:\n${q.solution}\n\nReturn JSON with the corrected statement, hint and solution.`,
    schema: questionReviseSchema, projectId: q.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  // A fix of formatting findings may change line breaks, spacing and markup, never a word or a number.
  const formatting = issues.length > 0 && issues.every((i) => i.source === 'lint' && !WORD_RULES.has(ruleOf(i.category)));
  const why = formatting ? wordsChanged(q, data) : null;
  if (why) {
    // The reason goes only on issues that are still open: a decision the author made while the editor ran stays.
    ctx.db.tx(() => {
      const open = stillOpen(ctx, issues.map((i) => i.id));
      if (open.length) ctx.db.run(`UPDATE review_issues SET resolution = ? WHERE id IN (${open.map(() => '?').join(',')})`, `The AI fix was not applied: ${why}`, ...open);
      issuesChanged(ctx, q.projectId, open);
    });
    return { skipped: 'the repair changed words or numbers' };
  }
  // The author must be able to see that the paper's printed solution was changed, and how. The question turns "adapted" (below), which the Practice screen shows.
  const corrected = q.origin === 'authentic' && changedWords(q.solution, data.solution) !== null;
  const was = issues.flatMap((i) => readMismatches(i.message));
  const resolution = !corrected ? `Rewritten by ${route.model}`
    : was.length ? `The printed solution was corrected by ${route.model}: ${was.map((m) => `${m.name} was ${m.stated} and the numeric check gives ${m.computed}`).join(', ')}.`
      : `The printed solution was rewritten by ${route.model}.`;
  return ctx.db.tx(() => {
    // The author may have closed the issues while the editor ran. A rewrite made for issues that are all closed now is not applied over that decision.
    const open = stillOpen(ctx, issues.map((i) => i.id));
    if (issues.length && !open.length) return { stale: true };
    const after = { statement: layout(data.statement), hint: layout(data.hint), solution: layout(data.solution) };
    const changed = ctx.db.run('UPDATE questions SET statement = ?, hint = ?, solution = ?, origin = ?, status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?',
      after.statement, after.hint, after.solution, q.origin === 'authentic' ? 'adapted' : q.origin, 'draft', now(), q.id, q.rev).changes;
    if (!changed) {
      keepStaleOutput(ctx, q, data.statement, data.solution, data.hint);
      return { stale: true };
    }
    recordQuestionRevision(ctx, q.id, q, after, { origin: 'revised', model: route.model, taskId: t.task.id });
    if (open.length) ctx.db.run(`UPDATE review_issues SET status = 'fixed', resolution = ? WHERE id IN (${open.map(() => '?').join(',')})`, resolution, ...open);
    questionsChanged(ctx, q.projectId, [q.id]);
    issuesChanged(ctx, q.projectId, open);
    const result: FixResult = { revised: true, fixed: open, origin: q.origin, status: q.status };
    return result;
  });
}
