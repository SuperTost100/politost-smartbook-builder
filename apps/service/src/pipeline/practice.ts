// Practice: authentic exam questions cleaned from page transcriptions, generated exercises to topic targets,
// and an independent check of every solution.
import type { Question } from '@smartbuilder/domain';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { transcribePage } from '../evidence/index.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext, type TaskSpec } from '../queue/queue.ts';
import { authenticExtractPrompt, authenticExtractSchema, exercisesPrompt, formatRules, generatedQuestionsSchema, verifyPrompt, verifySchema } from './prompts.ts';
import { bookFormulaKeys } from './draft.ts';
import { loadOutline, loadProject, loadTopics, truncate } from './util.ts';

/** Authentic exam questions included per chapter, most recent sessions first. */
const AUTHENTIC_PER_CHAPTER = 8;
const MAX_PAGES_PER_QUESTION = 4;

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

  // Authentic exam questions whose main topic belongs to this chapter.
  let authentic = all.filter((q) => q.kind === 'exam' && q.origin === 'authentic' && q.chapterId === chapterId);
  if (!authentic.length) {
    const candidates = all
      .filter((q) => q.kind === 'exam' && q.origin === 'authentic' && !q.chapterId && q.topicIds[0] && topicIds.has(q.topicIds[0]))
      .sort((a, b) => (b.examDate ?? '').localeCompare(a.examDate ?? ''));
    authentic = candidates.slice(0, AUTHENTIC_PER_CHAPTER);
    ctx.db.tx(() => { for (const q of authentic) ctx.db.run('UPDATE questions SET chapter_id = ?, updated_at = ? WHERE id = ?', chapterId, now(), q.id); });
  }

  const specs: TaskSpec[] = [];
  for (const q of authentic) {
    specs.push({ kind: 'question.import', key: `import:${q.id}`, label: `Read exam question ${q.examGroup ?? ''} n. ${q.number ?? ''}`.trim(), input: { questionId: q.id }, pool: 'vision' });
    specs.push({ kind: 'question.verify', key: `verify:${q.id}`, label: `Check solution of ${q.examGroup ?? 'exam question'} n. ${q.number ?? ''}`.trim(), input: { questionId: q.id }, deps: [`import:${q.id}`], pool: 'reviewer' });
  }
  const imports = authentic.map((q) => `import:${q.id}`);
  specs.push({ kind: 'practice.generate', key: `generate:${chapterId}:exercise`, label: `Write exercises for "${chapter.title}"`, input: { chapterId, kind: 'exercise' }, pool: 'writer', deps: imports });
  // Without observed exams for this chapter, add labeled exam-style practice.
  if (authentic.length === 0) specs.push({ kind: 'practice.generate', key: `generate:${chapterId}:exam`, label: `Write exam-style practice for "${chapter.title}"`, input: { chapterId, kind: 'exam' }, pool: 'writer', deps: imports });
  t.enqueue(specs);
  t.progress(`${authentic.length} exam questions from past sessions; exercises to write next`);
  return { authentic: authentic.length, language: project.language };
}

/** Clean statement and official solution from vision transcripts of the question's pages. */
export async function questionImport(ctx: AppContext, t: TaskContext) {
  const q = ctx.db.get('SELECT * FROM questions WHERE id = ?', t.task.input.questionId as string);
  if (!q) return { skipped: true };
  const question = rowToQuestion(q);
  if (question.checks.some((c) => c.method === 'lint' && c.detail === 'imported')) return { reused: true };
  if (question.resourceId === null || question.pageFrom === null) return { skipped: 'no page range' };
  // Every update below applies only if the author has not edited the question since this read.
  const rev = question.rev;
  const project = loadProject(ctx, question.projectId);
  const last = Math.min(question.pageTo ?? question.pageFrom, question.pageFrom + MAX_PAGES_PER_QUESTION - 1);
  const pages: string[] = [];
  for (let idx = question.pageFrom; idx <= last; idx++) {
    const p = await transcribePage(ctx, question.resourceId, idx, { signal: t.signal, runId: t.task.runId, taskId: t.task.id });
    pages.push(`--- page ${p.label} ---\n${p.transcript ?? p.text}`);
  }
  const solutionPages = question.solution ? `(text layer, math may be garbled)\n${truncate(question.solution, 6000)}` : '(same pages)';
  const { data } = await runRole(ctx, {
    role: 'bulk', ...authenticExtractPrompt({ language: project.language, examGroup: question.examGroup ?? '', number: question.number ?? '', statementPages: pages.join('\n\n'), solutionPages }),
    schema: authenticExtractSchema, projectId: question.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  if (!data.readable) {
    const changed = ctx.db.run(`UPDATE questions SET status = 'issue', rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`, now(), question.id, rev).changes;
    if (!changed) return { stale: true };
    addIssue(ctx, question, 'major', 'unreadable', 'This exam question could not be read from its pages.', 'Open the source pages and type the statement, or remove the question.');
    return { readable: false };
  }
  const checks = [...question.checks, { method: 'lint' as const, ok: true, detail: 'imported' }];
  const changed = ctx.db.run('UPDATE questions SET statement = ?, solution = ?, checks = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?', data.statement, data.solution, JSON.stringify(checks), now(), question.id, rev).changes;
  if (!changed) {
    keepStaleOutput(ctx, question, data.statement, data.solution);
    return { stale: true };
  }
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
    const list = kind === 'exercise'
      ? topics.map((tp) => ({ key: keyOf(tp.id), name: tp.name, n: target(tp.priority) }))
      : topics.filter((tp) => tp.priority !== 'low').slice(0, 2).map((tp) => ({ key: keyOf(tp.id), name: tp.name, n: 1 }));
    const count = list.reduce((a, b) => a + b.n, 0);
    if (count) {
      const { data } = await runRole(ctx, {
        role: 'writer',
        ...exercisesPrompt({ language: project.language, kind, chapterTitle: chapter.title, topics: list.map((x) => `${x.key}: ${x.name} — ${x.n}`).join('\n'), count, examples, knownFormulas: known }),
        schema: generatedQuestionsSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
      });
      const valid = new Map(topics.map((tp) => [keyOf(tp.id), tp.id]));
      ids = ctx.db.tx(() => data.questions.map((g) => {
        const id = newId();
        ctx.db.insert('questions', {
          id, project_id: projectId, kind, origin: 'generated', resource_id: null, page_from: null, page_to: null, exam_group: null, exam_date: null,
          number: null, statement: g.statement, hint: g.hint, solution: g.solution, difficulty: g.difficulty,
          topic_ids: g.topics.map((k) => valid.get(k)).filter(Boolean), chapter_id: chapterId, status: 'draft',
          checks: [{ method: 'lint', ok: true, detail: `final answer: ${g.finalAnswer}` }], rev: 1, created_at: now(), updated_at: now(),
        });
        return id;
      }));
    }
  }
  // Always: enqueue is idempotent by key, so questions that lost their verification task get it back.
  t.enqueue(ids.map((id) => ({ kind: 'question.verify', key: `verify:${id}`, label: `Check generated ${kind === 'exam' ? 'exam question' : 'exercise'} (chapter ${chapterNumber})`, input: { questionId: id }, pool: 'reviewer' })));
  return { generated: ids.length - reused, reused };
}

/**
 * Barrier for the first-chapter gate: succeeds when every task of the chapter's practice in this run (imports, generation,
 * verification) has finished. Until then it asks the queue to try again shortly.
 */
export async function practiceDone(ctx: AppContext, t: TaskContext) {
  const chapterId = t.task.input.chapterId as string;
  const rows = ctx.db.all<{ state: string }>(
    `SELECT t.state FROM tasks t WHERE t.run_id = ? AND (
       (t.kind = 'practice.generate' AND json_extract(t.input, '$.chapterId') = ?)
       OR (t.kind IN ('question.import', 'question.verify') AND json_extract(t.input, '$.questionId') IN (SELECT id FROM questions WHERE project_id = ? AND chapter_id = ?)))`,
    t.task.runId, chapterId, t.task.projectId, chapterId);
  const open = rows.filter((r) => !['succeeded', 'failed', 'cancelled', 'skipped'].includes(r.state)).length;
  if (open) {
    t.progress(`${open} practice task${open > 1 ? 's' : ''} still running`);
    throw new TaskError(`${open} practice tasks are still running.`, 'later');
  }
  return { tasks: rows.length, failed: rows.filter((r) => r.state === 'failed').length };
}

export async function questionVerify(ctx: AppContext, t: TaskContext) {
  const r = ctx.db.get('SELECT * FROM questions WHERE id = ?', t.task.input.questionId as string);
  if (!r) return { skipped: true };
  const q = rowToQuestion(r);
  if (!q.statement.trim() || !q.solution.trim()) return { skipped: 'missing statement or solution' };
  const project = loadProject(ctx, q.projectId);
  const { data, route } = await runRole(ctx, {
    role: 'reviewer', ...verifyPrompt({ language: project.language, statement: q.statement, solution: q.solution }), schema: verifySchema,
    projectId: q.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const ok = data.agrees && !data.problems.some((p) => p.severity !== 'minor');
  const checks = [...q.checks.filter((c) => c.method !== 'independent-solve'), { method: 'independent-solve' as const, ok, detail: `Independent result: ${truncate(data.independentAnswer, 400)}`, model: route.model }];
  return ctx.db.tx(() => {
    // The check was made on the text as of q.rev; if the author edited since, it says nothing about the new text.
    const changed = ctx.db.run('UPDATE questions SET status = ?, checks = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?', ok ? 'verified' : 'issue', JSON.stringify(checks), now(), q.id, q.rev).changes;
    if (!changed) return { stale: true };
    ctx.db.run(`DELETE FROM review_issues WHERE question_id = ? AND source = 'verification' AND status = 'open'`, q.id);
    for (const p of data.problems) addIssue(ctx, q, p.severity, 'solution', p.message, p.suggestion);
    // A known disagreement with the independent answer blocks export, unless a listed problem is already a blocker.
    if (!data.agrees && !data.problems.some((p) => p.severity === 'blocker')) addIssue(ctx, q, 'blocker', 'solution', `The independent solution disagrees: ${data.independentAnswer}`, 'Compare both results and correct the solution, or accept the issue if the independent answer is wrong.');
    return { ok, problems: data.problems.length };
  });
}

function addIssue(ctx: AppContext, q: Question, severity: string, category: string, message: string, suggestion: string) {
  ctx.db.insert('review_issues', {
    id: newId(), project_id: q.projectId, node_id: q.chapterId, question_id: q.id, rev_id: null, source: 'verification', severity, category,
    quote: truncate(q.statement, 200), message, suggestion, status: 'open', resolution: '', created_at: now(),
  });
  ctx.events.emit('issue.created', { questionId: q.id, severity }, { projectId: q.projectId });
}

export const questionReviseSchema = z.object({ statement: z.string(), hint: z.string(), solution: z.string() });

/** Rewrites an exercise for its open issues. Authentic questions keep their statement unless an issue says it is wrong. */
export async function questionRevise(ctx: AppContext, t: TaskContext) {
  const r = ctx.db.get('SELECT * FROM questions WHERE id = ?', t.task.input.questionId as string);
  if (!r) return { skipped: true };
  const q = rowToQuestion(r);
  const ids = (t.task.input.issueIds as string[]) ?? [];
  const issues = ids.length ? ctx.db.all<{ id: string; message: string; suggestion: string }>(`SELECT id, message, suggestion FROM review_issues WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  const project = loadProject(ctx, q.projectId);
  const { data, route } = await runRole(ctx, {
    role: 'writer',
    system: `You correct a textbook exercise in ${project.language === 'it' ? 'Italian' : project.language}. Fix exactly the reported problems; keep everything else.\n\n${formatRules(project.language)}`,
    prompt: `PROBLEMS:\n${issues.map((i, n) => `${n + 1}. ${i.message} Suggested fix: ${i.suggestion}`).join('\n')}\n\nSTATEMENT:\n${q.statement}\n\nHINT:\n${q.hint}\n\nSOLUTION:\n${q.solution}\n\nReturn JSON with the corrected statement, hint and solution.`,
    schema: questionReviseSchema, projectId: q.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  return ctx.db.tx(() => {
    const changed = ctx.db.run('UPDATE questions SET statement = ?, hint = ?, solution = ?, origin = ?, status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?',
      data.statement, data.hint, data.solution, q.origin === 'authentic' ? 'adapted' : q.origin, 'draft', now(), q.id, q.rev).changes;
    if (!changed) {
      keepStaleOutput(ctx, q, data.statement, data.solution, data.hint);
      return { stale: true };
    }
    if (issues.length) ctx.db.run(`UPDATE review_issues SET status = 'fixed', resolution = ? WHERE id IN (${issues.map(() => '?').join(',')})`, `Rewritten by ${route.model}`, ...issues.map((i) => i.id));
    return { revised: true };
  });
}
