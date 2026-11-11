// Handler tests: scripted model answers (FakeFunnel), a real temp database, handlers called directly with a hand-made task.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { MAX_DELETED_BLOCKS } from '@smartbuilder/content';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { json, newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, patchAnswer, patchText, seedPage, seedProject, seedResource, usageOf, written, wroteCode } from '../llm/testkit.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { resolveDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { commitAiRevision, sectionDraft } from './draft.ts';
import { chapterEnrich, enrichGraph, enrichIde } from './enrich.ts';
import { chapterPractice, practiceDone, practiceGenerate, questionImport, questionRevise, questionVerify, sessionImport, sessionImportKey } from './practice.ts';
import { labelResources, resourceQuestions, topicsMap } from './prepare.ts';
import { chapterReview, sectionRevise } from './review.ts';
import { sectionFigures } from './figures.ts';
import { setStockDeps } from '../figures/stock.ts';
import { patchPrompt, reviewSchema } from './prompts.ts';
import { generateSpecs, startRun } from './runs.ts';
import { registerHandlers } from './index.ts';
import { computePriorities } from './prepare.ts';
import { acceptProposal, getProjectSummary, rejectProposal, insertProposal, listIssues, saveHuman, updateQuestion } from '../repo/index.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';
const answer = (obj: unknown) => () => ({ structured: obj as never, text: JSON.stringify(obj), usage: usageOf(10, 10) });
/** The figure check's answer: keep the first n figures. */
const keepFigures = (n: number) => ({ figures: Array.from({ length: n }, (_, i) => ({ index: i + 1, keep: true, reason: 'utile' })) });
/** The cheap check's answer: every listed block good, every issue (1..n) fixed. */
const checkGood = (blocks: number[], n = 1) => ({ changes: blocks.map((block) => ({ block, verdict: 'good', reason: '' })), issues: Array.from({ length: n }, (_, k) => ({ index: k + 1, fixed: true, reason: '' })) });

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  ctx = kit.ctx;
  ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(ctx, P);
  // Tests never search Wikimedia Commons; a photo needs a stock key and a fake fetch.
  setStockDeps({ commons: false });
});
afterEach(() => {
  setFunnel(null);
  kit.cleanup();
});

/** Approved outline: chapters of [chapterId, sectionIds]. */
function seedOutline(chapters: [string, string[]][], extra: { topicIds?: string[] } = {}) {
  const outline = {
    chapters: chapters.map(([id, sections], i) => ({
      id, slug: `cap-${i + 1}`, title: `Capitolo ${i + 1}`, objectives: [], prerequisites: [],
      sections: sections.map((sid, j) => ({ id: sid, title: `Sezione ${i + 1}.${j + 1}`, objectives: [], topicIds: extra.topicIds ?? [], depth: 'standard', subsections: [] })),
    })),
    exclusions: [], notation: '',
  };
  const id = newId();
  ctx.db.insert('outline_revisions', { id, project_id: P, outline, origin: 'human', note: '', created_at: now(), approved_at: now() });
  ctx.db.run('UPDATE projects SET outline_rev_id = ? WHERE id = ?', id, P);
  return outline;
}

function seedRevision(nodeId: string, markdown: string, o: { status?: string; origin?: string; citations?: Record<string, string[]>; parent?: string | null } = {}) {
  const id = newId();
  ctx.db.insert('content_revisions', { id, project_id: P, node_id: nodeId, kind: 'section', markdown, origin: o.origin ?? 'human', model: null, parent_rev_id: o.parent ?? null, status: o.status ?? 'current', citations: o.citations ?? {}, created_at: now() });
  return id;
}

/** A running task in a (shared) run, with a TaskContext whose enqueue writes to the real queue tables. */
function startTask(kind: string, input: Record<string, unknown>, o: { runId?: string; key?: string; id?: string } = {}): TaskContext {
  const runId = o.runId ?? newId();
  if (!ctx.db.get('SELECT 1 FROM runs WHERE id = ?', runId)) ctx.db.insert('runs', { id: runId, project_id: P, kind: 'generate', status: 'running', snapshot: {}, created_at: now() });
  const id = o.id ?? newId();
  const key = o.key ?? `${kind}:${id}`;
  ctx.db.insert('tasks', { id, run_id: runId, project_id: P, kind, label: kind, key, input, state: 'running', pool: 'local', attempts: 1, max_attempts: 3, created_at: now() });
  return {
    task: { id, runId, projectId: P, kind, key, label: kind, input, attempts: 1 }, signal: new AbortController().signal, deps: {},
    enqueue: (specs) => ctx.queue.addTasks(runId, P, specs), progress: () => undefined, setProvider: () => undefined,
  };
}

const q = (o: Record<string, unknown> = {}) => {
  const id = newId();
  ctx.db.insert('questions', { id, project_id: P, kind: 'exercise', origin: 'generated', statement: 'Calcola il limite.', hint: '', solution: 'Vale 1.', difficulty: 'medio', topic_ids: [], status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(), ...o });
  return id;
};
const row = (id: string) => ctx.db.get<Record<string, any>>('SELECT * FROM questions WHERE id = ?', id)!;
const issues = (where = '1=1') => ctx.db.all<Record<string, any>>(`SELECT * FROM review_issues WHERE ${where} ORDER BY created_at, rowid`);
const taskKeys = (runId: string) => ctx.db.all<{ key: string }>('SELECT key FROM tasks WHERE run_id = ? ORDER BY rowid', runId).map((r) => r.key);

describe('1. question updates do not overwrite author edits', () => {
  const edit = (id: string) => () => { ctx.db.run(`UPDATE questions SET statement = 'Testo dell''autrice', rev = rev + 1 WHERE id = ?`, id); };

  test('verify: an edit during the check leaves the status alone and reports stale', async () => {
    const id = q();
    fake.next(() => { edit(id)(); return { structured: { independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] } as never, text: '{}', usage: usageOf(1, 1) }; });
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { stale: true });
    assert.equal(row(id).status, 'draft');
    assert.equal(row(id).statement, "Testo dell'autrice");
    assert.equal(issues().length, 0);
  });

  test('verify: without an edit the question is verified and rev moves on', async () => {
    const id = q();
    fake.next(answer({ independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal(row(id).status, 'verified');
    assert.equal(row(id).rev, 2);
  });

  test('revise: the AI text is kept in a stale-ai-output issue, the author text stays', async () => {
    const id = q();
    fake.next(() => { edit(id)(); return { structured: { statement: 'Testo AI', hint: 'Suggerimento AI', solution: 'Soluzione AI' } as never, text: '{}', usage: usageOf(1, 1) }; });
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [] }));
    assert.deepEqual(r, { stale: true });
    assert.equal(row(id).statement, "Testo dell'autrice");
    const [issue] = issues();
    assert.equal(issue.category, 'stale-ai-output');
    assert.equal(issue.severity, 'minor');
    assert.equal(issue.source, 'verification');
    assert.equal(issue.status, 'open');
    assert.match(issue.suggestion, /Testo AI/);
    assert.match(issue.suggestion, /Soluzione AI/);
  });

  test('import: same protection', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(() => { edit(id)(); return { structured: { statement: 'Calcola.', solution: 'Fatto.', readable: true } as never, text: '{}', usage: usageOf(1, 1) }; });
    const r = await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.deepEqual(r, { stale: true });
    assert.equal(row(id).statement, "Testo dell'autrice");
    assert.match(issues()[0].suggestion, /Fatto\./);
  });

  test('import: applied when nobody edited', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(answer({ statement: 'Calcola.', solution: 'Fatto.', readable: true }));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(row(id).statement, 'Calcola.');
    assert.equal(row(id).rev, 2);
  });

  test('import: text that would not render gets one formatting repair', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(answer({ statement: 'Calcola $\\lim_{x\\to 0} f(x).', solution: 'Vale $1$.', readable: true }), answer({ statement: 'Calcola $\\lim_{x\\to 0} f(x)$.', hint: 'inventato', solution: 'Vale $1$.' }));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(row(id).statement, 'Calcola $\\lim_{x\\to 0} f(x)$.');
    assert.equal(row(id).hint, '');
    assert.equal(fake.calls.length, 2);
  });
});

describe('15. disagreement is a blocker', () => {
  test('agrees=false with no problems, or only minor/major ones, adds a blocker; an existing blocker is not duplicated', async () => {
    const a = q();
    fake.next(answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [] }), answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: a }));
    assert.deepEqual(issues(`question_id = '${a}'`).map((i) => i.severity), ['blocker']);

    const b = q();
    fake.next(answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [{ severity: 'major', message: 'm', suggestion: 's' }] }), answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [{ severity: 'major', message: 'm', suggestion: 's' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: b }));
    assert.deepEqual(issues(`question_id = '${b}'`).map((i) => i.severity).sort(), ['blocker', 'major']);

    const c = q();
    fake.next(answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [{ severity: 'blocker', message: 'wrong', suggestion: 's' }] }), answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [{ severity: 'blocker', message: 'wrong', suggestion: 's' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: c }));
    assert.deepEqual(issues(`question_id = '${c}'`).map((i) => i.severity), ['blocker']);
    assert.equal(row(c).status, 'issue');

    // Same result, gap in the argument: the reviewer's severity stands, no extra blocker.
    const d = q();
    fake.next(answer({ independentAnswer: '1', resultsAgree: true, agrees: false, problems: [{ severity: 'major', message: 'gap', suggestion: 's' }] }), answer({ independentAnswer: '1', resultsAgree: true, agrees: false, problems: [{ severity: 'major', message: 'gap', suggestion: 's' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: d }));
    assert.deepEqual(issues(`question_id = '${d}'`).map((i) => i.severity), ['major']);
  });
});

describe('15b. numeric final answers are recomputed in the sandbox', () => {
  const circuit = 'Due resistori da 1 kΩ in parallelo. Calcola la resistenza equivalente.';
  const verdict = (o: Record<string, unknown>) => answer({ independentAnswer: '500 Ω', resultsAgree: true, agrees: true, problems: [], ...o });
  const program = 'r = 1 / (1 / 1000 + 1 / 1000)\nprint(f"R_eq = {r} ohm")';

  test('a computation that agrees adds a numeric check and costs no extra call', async () => {
    const id = q({ statement: circuit, solution: 'R = 500 Ω' });
    fake.next(verdict({ computation: program, statedValues: [{ name: 'R_eq', value: '0.50 kΩ' }] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0, recomputed: 1, mismatches: 0 });
    assert.equal(fake.calls.length, 1);
    assert.equal(row(id).status, 'verified');
    assert.deepEqual(json<{ method: string; ok: boolean }[]>(row(id).checks, []).map((c) => [c.method, c.ok]), [['independent-solve', true], ['numeric', true]]);
    assert.equal(issues().length, 0);
  });

  test('a mismatch asks the reviewer, and the blocker names both numbers', async () => {
    const id = q({ statement: circuit, solution: 'R = 5 kΩ' });
    const bad = verdict({ computation: program, statedValues: [{ name: 'R_eq', value: '5.0 kΩ' }] });
    fake.next(bad, bad);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 0, recomputed: 1, mismatches: 1 });
    assert.equal(fake.calls.length, 2, 'the checker, then the reviewer');
    assert.equal(row(id).status, 'issue');
    const [issue] = issues(`question_id = '${id}'`);
    assert.equal(issue.severity, 'blocker');
    assert.match(issue.message, /R_eq is 500\.0 ohm by the computation and 5\.0 kΩ in the solution/);
    assert.equal(json<{ method: string; ok: boolean }[]>(row(id).checks, []).find((c) => c.method === 'numeric')!.ok, false);
  });

  test('a computation that throws is ignored and the model verdict stands', async () => {
    const id = q({ statement: circuit, solution: 'R = 500 Ω' });
    fake.next(verdict({ computation: 'print(1 / 0)', statedValues: [{ name: 'R_eq', value: '500 Ω' }] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0 });
    assert.equal(row(id).status, 'verified');
    assert.deepEqual(json<{ method: string }[]>(row(id).checks, []).map((c) => c.method), ['independent-solve']);
  });

  test('a symbolic answer stays on the model check', async () => {
    const id = q();
    fake.next(verdict({ computation: '', statedValues: [] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0 });
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0].prompt, /leave computation empty/);
  });
});

describe('4. practice generation stages', () => {
  const topic = (key: string) => {
    const id = `${P.slice(0, 8)}-${key}`;
    ctx.db.insert('topics', { id, project_id: P, name: key, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    return id;
  };
  const gen = (n: number, kind: string) => ({ questions: Array.from({ length: n }, (_, i) => ({ topics: ['limiti'], difficulty: 'medio', statement: `${kind} ${i}`, hint: 'h', solution: 's', finalAnswer: '1' })) });

  test('chapterPractice enqueues a separate exam stage only when there are no authentic questions', async () => {
    const t = topic('limiti');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    const task = startTask('chapter.practice', { chapterId: 'c1' });
    await chapterPractice(ctx, task);
    assert.deepEqual(taskKeys(task.task.runId).filter((k) => k.startsWith('generate:')), ['generate:c1:exercise', 'generate:c1:exam']);
    const inputs = ctx.db.all<{ input: string }>(`SELECT input FROM tasks WHERE kind = 'practice.generate' ORDER BY key`).map((r) => json<Record<string, unknown>>(r.input, {}));
    assert.deepEqual(inputs, [{ chapterId: 'c1', kind: 'exam' }, { chapterId: 'c1', kind: 'exercise' }]);
  });

  test('a retry after the exercises were saved reuses them, enqueues their checks, and still does the exam stage', async () => {
    const t = topic('limiti');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    const runId = newId();
    // First attempt of the exercise stage saved its questions but crashed before enqueueing verification.
    const ex = startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' }, { runId, key: 'generate:c1:exercise' });
    fake.next(answer(gen(2, 'esercizio')));
    await practiceGenerate(ctx, ex);
    ctx.db.run(`DELETE FROM tasks WHERE kind = 'question.verify'`);
    assert.equal(ctx.db.all('SELECT 1 FROM questions WHERE kind = ?', 'exercise').length, 2);

    const calls = fake.calls.length;
    const again = await practiceGenerate(ctx, ex);
    assert.equal(fake.calls.length, calls, 'no new model call');
    assert.deepEqual(again, { generated: 0, reused: 2 });
    assert.equal(taskKeys(runId).filter((k) => k.startsWith('verify:')).length, 2);

    // The exam stage is its own task: it generates exam questions even though exercises exist.
    const exam = startTask('practice.generate', { chapterId: 'c1', kind: 'exam' }, { runId, key: 'generate:c1:exam' });
    fake.next(answer(gen(1, 'esame')));
    const r = await practiceGenerate(ctx, exam);
    assert.deepEqual(r, { generated: 1, reused: 0 });
    assert.deepEqual(ctx.db.all<{ hint: string }>(`SELECT hint FROM questions WHERE kind = 'exam' AND origin = 'generated'`).map((x) => x.hint), [''], 'exams have no hints');
    assert.equal(taskKeys(runId).filter((k) => k.startsWith('verify:')).length, 3);
  });

  test('the exercise writer sees up to 6 classified collection items on the chapter topics, known answers first; the exam stage and the book do not', async () => {
    const t = topic('limiti');
    const other = topic('serie');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    seedResource(ctx, { projectId: P, id: 'coll', role: 'exercises' });
    seedResource(ctx, { projectId: P, id: 'off', role: 'exercises', included: 0 });
    const item = (statement: string, o: Record<string, unknown> = {}) => q({ kind: 'exercise', origin: 'authentic', resource_id: 'coll', exam_group: 'Quiz A', statement, solution: '', topic_ids: [t], ...o });
    for (let i = 0; i < 5; i++) item(`SENZA RISPOSTA ${i}`);
    const answered = [item('CON RISPOSTA 1', { solution: 'Risposta corretta: b' }), item('CON RISPOSTA 2', { solution: 'Risposta corretta: c' })];
    item('ALTRO ARGOMENTO', { topic_ids: [other] });
    item('NON CLASSIFICATO', { topic_ids: [] });
    item('FUORI DAL LIBRO', { resource_id: 'off' });
    item('SCRITTO DA NOI', { origin: 'generated', resource_id: null });

    fake.next(answer(gen(1, 'esercizio')));
    await practiceGenerate(ctx, startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' }));
    const prompt = fake.calls[0].prompt;
    assert.match(prompt, /match their level and style, do not copy them/);
    assert.equal(prompt.match(/RISPOSTA \d/g)!.length, 6, 'both answered items and four of the others');
    assert.ok(answered.every((id) => prompt.includes(row(id).statement)) && prompt.includes('Risposta corretta: b'));
    assert.ok(!/ALTRO ARGOMENTO|NON CLASSIFICATO|FUORI DAL LIBRO|SCRITTO DA NOI/.test(prompt));

    fake.next(answer(gen(1, 'esame')));
    await practiceGenerate(ctx, startTask('practice.generate', { chapterId: 'c1', kind: 'exam' }));
    assert.ok(!fake.calls[1].prompt.includes('RISPOSTA'));
    // The generated exercises are the only ones in the chapter.
    assert.deepEqual(ctx.db.all(`SELECT 1 FROM questions WHERE chapter_id = 'c1' AND origin = 'authentic'`), []);
  });

  test('without collection items the prompt has no such section', async () => {
    const t = topic('limiti');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    fake.next(answer(gen(1, 'esercizio')));
    await practiceGenerate(ctx, startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' }));
    assert.doesNotMatch(fake.calls[0].prompt, /exercise collections/);
  });
});

describe('4b. collection examples are found by search, not classified', () => {
  const topic = (key: string) => {
    const id = `${P.slice(0, 8)}-${key}`;
    ctx.db.insert('topics', { id, project_id: P, name: key, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    return id;
  };
  const gen = { questions: [{ topics: ['limiti'], difficulty: 'medio', statement: 'esercizio', hint: 'h', solution: 's', finalAnswer: '1' }] };
  const item = (statement: string, page: number, o: Record<string, unknown> = {}) =>
    q({ kind: 'exercise', origin: 'authentic', resource_id: 'coll', page_from: page, page_to: page, exam_group: 'Quiz A', statement, solution: '', topic_ids: [], ...o });

  test('unclassified items on the pages that match the chapter topics, whose own text names the topic, with known answers first and no extra model call', async () => {
    topic('limiti');
    seedOutline([['c1', ['s1']]], { topicIds: [`${P.slice(0, 8)}-limiti`] });
    seedResource(ctx, { projectId: P, id: 'coll', role: 'exercises' });
    seedResource(ctx, { projectId: P, id: 'off', role: 'exercises', included: 0 });
    seedPage(ctx, 'coll', 0, '1. Calcolare i limiti notevoli. 2. Sia z un numero complesso.');
    seedPage(ctx, 'coll', 1, '3. Studiare la serie numerica.');
    seedPage(ctx, 'off', 0, 'Calcolare i limiti.');
    item('SENZA RISPOSTA: calcolare i limiti notevoli', 0);
    const answered = item('CON RISPOSTA: i limiti di successioni', 0, { solution: 'Risposta corretta: b' });
    item('STESSA PAGINA, ALTRO: sia z un numero complesso', 0);
    item('ALTRA PAGINA: la serie numerica', 1);
    item('FUORI DAL LIBRO: i limiti', 0, { resource_id: 'off' });
    item('GIA CLASSIFICATO ALTROVE: i limiti', 0, { topic_ids: ['x-serie'] });
    fake.next(answer(gen));
    await practiceGenerate(ctx, startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' }));
    assert.equal(fake.calls.length, 1, 'only the writer is called: nothing is classified');
    const prompt = fake.calls[0].prompt;
    assert.ok(prompt.includes('SENZA RISPOSTA') && prompt.includes(row(answered).statement) && prompt.includes('Risposta corretta: b'));
    assert.ok(prompt.indexOf('CON RISPOSTA') < prompt.indexOf('SENZA RISPOSTA'), 'known answers first');
    assert.ok(!/STESSA PAGINA|ALTRA PAGINA|FUORI DAL LIBRO|GIA CLASSIFICATO/.test(prompt));
    assert.equal(ctx.db.all(`SELECT 1 FROM questions WHERE topic_ids != '[]' AND resource_id = 'coll'`).length, 1, 'the items stay unclassified');
  });

  test('classified items fill the examples first, and the search only fills what is left', async () => {
    const t = topic('limiti');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    seedResource(ctx, { projectId: P, id: 'coll', role: 'exercises' });
    seedPage(ctx, 'coll', 0, 'limiti limiti limiti');
    for (let i = 0; i < 5; i++) item(`CLASSIFICATO ${i}: limiti`, 0, { topic_ids: [t] });
    item('CERCATO A: limiti', 0);
    item('CERCATO B: limiti', 0);
    fake.next(answer(gen));
    await practiceGenerate(ctx, startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' }));
    const prompt = fake.calls[0].prompt;
    assert.equal(prompt.match(/CLASSIFICATO \d/g)!.length, 5);
    assert.equal(prompt.match(/CERCATO/g)!.length, 1, 'six examples at most');
  });

  test('a book whose collection has no matching page gets no collection section', async () => {
    const t = topic('limiti');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    seedResource(ctx, { projectId: P, id: 'coll', role: 'exercises' });
    seedPage(ctx, 'coll', 0, 'Argomento diverso: serie numeriche.');
    item('Studiare una serie', 0);
    fake.next(answer(gen));
    await practiceGenerate(ctx, startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' }));
    assert.doesNotMatch(fake.calls[0].prompt, /exercise collections/);
  });
});

describe('4c. one extraction call per exam session', () => {
  const T = `${P.slice(0, 8)}-limiti`;
  const session = (extra: Record<string, unknown> = {}) => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    for (let i = 0; i < 3; i++) seedPage(ctx, 'r-exam', i, `testo ${i}`, `PAGINA ${i}: esercizio ${i + 1}`);
    return [1, 2, 3].map((n) => q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: n - 1, page_to: n - 1, exam_group: 'Giugno', number: String(n), statement: `grezzo ${n}`, solution: `testo soluzione ${n}`, topic_ids: [T], exam_date: '2024-06-01', ...extra }));
  };
  const ex = (n: number, o: Record<string, unknown> = {}) => ({ number: String(n), statement: `Calcola ${n}.`, solution: `Fatto ${n}.`, readable: true, ...o });
  const read = async (ids: string[], key: string, result: unknown) => {
    const run = newId();
    const out: unknown[] = [];
    for (const id of ids) {
      const t = startTask('question.import', { questionId: id }, { runId: run, key: `import:${id}` });
      t.deps[key] = result;
      out.push(await questionImport(ctx, t));
    }
    return out;
  };
  const key = sessionImportKey('r-exam', 'Giugno');

  test('three exercises of one session on three pages make one call, and no import makes another', async () => {
    const ids = session();
    fake.next(answer({ exercises: [ex(1), ex(2), ex(3)] }));
    const result = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].prompt.match(/PAGINA \d/g)!.length, 3, 'each page is sent once');
    assert.match(fake.calls[0].prompt, /Exercises to copy: 1, 2, 3/);
    assert.match(fake.calls[0].prompt, /testo soluzione 2/, 'the text layer of the solutions is offered');
    assert.equal((result as { exercises: number }).exercises, 3);
    assert.deepEqual(await read(ids, key, result), [{ readable: true }, { readable: true }, { readable: true }]);
    assert.equal(fake.calls.length, 1, 'the imports read their text from the session answer');
    assert.deepEqual(ids.map((id) => [row(id).statement, row(id).solution, row(id).rev]), [['Calcola 1.', 'Fatto 1.', 2], ['Calcola 2.', 'Fatto 2.', 2], ['Calcola 3.', 'Fatto 3.', 2]]);
    assert.ok(ids.every((id) => row(id).imported_at));
  });

  test('a chapter plans one session task that its imports wait for; a lone question has none', async () => {
    seedOutline([['c1', ['s1']]], { topicIds: [T] });
    ctx.db.insert('topics', { id: T, project_id: P, name: 'limiti', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    const [a, b, c] = session();
    ctx.db.run(`UPDATE questions SET exam_group = 'Luglio' WHERE id = ?`, c);
    const task = startTask('chapter.practice', { chapterId: 'c1' });
    await chapterPractice(ctx, task);
    const tasks = ctx.db.all<{ kind: string; key: string; pool: string }>('SELECT kind, key, pool FROM tasks WHERE run_id = ? ORDER BY rowid', task.task.runId);
    assert.deepEqual(tasks.filter((x) => x.kind === 'question.session').map((x) => [x.key, x.pool]), [[key, 'vision']]);
    const dep = (id: string) => ctx.db.all<{ k: string }>(`SELECT dt.key AS k FROM task_deps d JOIN tasks t ON t.id = d.task_id JOIN tasks dt ON dt.id = d.dep_id WHERE t.key = ?`, `import:${id}`).map((r) => r.k);
    assert.deepEqual(dep(a), [key]);
    assert.deepEqual(dep(b), [key]);
    assert.deepEqual(dep(c), [], 'alone in its session: read on its own, as before');
  });

  test('a question the author edited, or that was already read, is not asked for', async () => {
    const [a, b, c] = session();
    ctx.db.run(`UPDATE questions SET edited_at = '2024-01-01', statement = 'Testo dell''autrice' WHERE id = ?`, a);
    fake.next(answer({ exercises: [ex(2), ex(3)] }));
    const result = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
    assert.match(fake.calls[0].prompt, /Exercises to copy: 2, 3/);
    assert.ok(!fake.calls[0].prompt.includes('PAGINA 0'));
    assert.deepEqual(Object.keys((result as { extracted: object }).extracted), [b, c]);
    ctx.db.run(`UPDATE questions SET imported_at = '2024-01-02' WHERE id = ?`, b);
    assert.deepEqual(await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key })), { fallback: 'fewer than two questions to read' });
    assert.equal(fake.calls.length, 1);
    assert.equal(row(a).statement, "Testo dell'autrice");
  });

  test('an answer that misses, invents or repeats an exercise falls back to one call per question', async () => {
    const ids = session();
    for (const bad of [[ex(1), ex(2)], [ex(1), ex(2), ex(4)], [ex(1), ex(2), ex(2)], [ex(1), ex(2), ex(3), ex(4)]]) {
      fake.next(answer({ exercises: bad }));
      const r = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
      assert.match((r as { fallback: string }).fallback, /instead of 1, 2, 3/);
    }
    const before = fake.calls.length;
    fake.next(answer({ statement: 'Calcola 1.', solution: 'Fatto 1.', readable: true }));
    await read([ids[0]], key, { fallback: 'x' });
    assert.equal(fake.calls.length, before + 1, 'the import made its own call');
    assert.match(fake.calls.at(-1)!.prompt, /Exercise number: 1/);
    assert.equal(row(ids[0]).statement, 'Calcola 1.');
  });

  test('a session over the page limit, or two questions with one number, is not sent to the model', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    for (let i = 0; i < 15; i++) seedPage(ctx, 'r-exam', i, `testo ${i}`, `PAGINA ${i}`);
    const mk = (n: string, from: number, to: number) => q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: from, page_to: to, exam_group: 'Giugno', number: n, solution: '' });
    // Each question reads at most 4 pages from its first.
    mk('1', 0, 5); mk('2', 4, 9); mk('3', 8, 12); mk('4', 12, 14);
    const r = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
    assert.equal((r as { fallback: string }).fallback, 'the session spans 15 pages, more than 12');
    ctx.db.run(`DELETE FROM questions`);
    mk('1', 0, 0); mk('1', 1, 1);
    assert.match(((await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }))) as { fallback: string }).fallback, /distinct numbers/);
    assert.equal(fake.calls.length, 0);
  });

  test('a model that cannot give a valid answer falls back, and a failure a retry can cure is thrown', async () => {
    session();
    fake.next(answer({ nothing: true }), answer({ nothing: true }));
    const r = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
    assert.match((r as { fallback: string }).fallback, /invalid answer/);
    const hangUp = () => new Error('socket hang up');
    fake.next(hangUp, hangUp, hangUp);
    await assert.rejects(sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key })), (e: unknown) => e instanceof TaskError && e.kind === 'temporary');
  });

  test('an unreadable exercise leaves the book with an issue, and one without an official solution gets a worked one', async () => {
    const ids = session();
    ctx.db.run(`UPDATE questions SET chapter_id = 'c1' WHERE id IN (?, ?)`, ids[1], ids[2]);
    const result = { extracted: { [ids[1]]: ex(2, { readable: false, statement: '', solution: '' }), [ids[2]]: ex(3, { solution: '' }) } };
    fake.next(answer({ markdown: 'Soluzione scritta.' }));
    await read([ids[1], ids[2]], key, result);
    assert.equal(row(ids[1]).status, 'issue');
    assert.equal(row(ids[1]).chapter_id, null);
    assert.equal(issues(`question_id = '${ids[1]}'`)[0].category, 'unreadable');
    assert.equal(row(ids[2]).solution, 'Soluzione scritta.');
    assert.equal(fake.calls.length, 1, 'the solution call is the only one');
  });

  test('an edit made after the session was read wins over the session answer', async () => {
    const ids = session();
    ctx.db.run(`UPDATE questions SET edited_at = '2024-02-02', statement = 'Testo dell''autrice' WHERE id = ?`, ids[0]);
    const out = await read([ids[0]], key, { extracted: { [ids[0]]: ex(1) } });
    assert.deepEqual(out, [{ skipped: 'edited by the author' }]);
    assert.equal(row(ids[0]).statement, "Testo dell'autrice");
  });

  test('a chapter planned after the session task already ran waits for it too', async () => {
    seedOutline([['c1', ['s1']], ['c2', ['s2']]], { topicIds: [T] });
    ctx.db.insert('topics', { id: T, project_id: P, name: 'limiti', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    const [a, b, c] = session();
    ctx.db.run(`UPDATE questions SET chapter_id = 'c1' WHERE id = ?`, a);
    const runId = newId();
    await chapterPractice(ctx, startTask('chapter.practice', { chapterId: 'c1' }, { runId, key: 'practice:c1' }));
    // The first chapter read the session; one question is done by now, so only one is left to read for the second chapter.
    ctx.db.run(`UPDATE questions SET imported_at = '2024-01-02' WHERE id IN (?, ?)`, a, b);
    ctx.db.run(`UPDATE questions SET chapter_id = NULL WHERE id = ?`, c);
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[1].sections[0].topicIds', json_array(?))`, T);
    await chapterPractice(ctx, startTask('chapter.practice', { chapterId: 'c2' }, { runId, key: 'practice:c2' }));
    const deps = ctx.db.all<{ k: string }>(`SELECT dt.key AS k FROM task_deps d JOIN tasks t ON t.id = d.task_id JOIN tasks dt ON dt.id = d.dep_id WHERE t.key = ?`, `import:${c}`).map((r) => r.k);
    assert.deepEqual(deps, [key]);
    assert.equal(ctx.db.all(`SELECT 1 FROM tasks WHERE run_id = ? AND kind = 'question.session'`, runId).length, 1);
  });

  test('through the real queue: the session task runs first, its imports read nothing more, and the chapter practice completes', async () => {
    seedOutline([['c1', ['s1']]], { topicIds: [T] });
    ctx.db.insert('topics', { id: T, project_id: P, name: 'limiti', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    const ids = session();
    // Which answer a call needs depends on its prompt, because the pools run side by side.
    const dispatch = (input: { prompt: string }) => {
      const body = /Exercises to copy/.test(input.prompt)
        ? { exercises: [ex(1), ex(2), ex(3)] }
        : /^STATEMENT:/.test(input.prompt) ? { independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] }
          : { questions: [{ topics: ['limiti'], difficulty: 'medio', statement: 'Esercizio nuovo.', hint: 'h', solution: 's', finalAnswer: '1' }] };
      return { structured: body as never, text: JSON.stringify(body), usage: usageOf(1, 1) };
    };
    for (let i = 0; i < 20; i++) fake.next(dispatch);
    registerHandlers(ctx);
    const runId = ctx.queue.createRun(P, 'generate', [{ kind: 'chapter.practice', key: 'practice:c1', label: 'Plan practice', input: { chapterId: 'c1' } }]);
    ctx.queue.start();
    const start = Date.now();
    while (ctx.queue.runSummary(runId)!.status !== 'completed' && Date.now() - start < 20_000) await new Promise((r) => setTimeout(r, 25));
    await ctx.queue.stop();
    assert.equal(ctx.queue.runSummary(runId)!.status, 'completed');
    assert.equal(fake.calls.filter((c) => /Exercises to copy/.test(c.prompt)).length, 1);
    assert.equal(fake.calls.filter((c) => /Exercise number/.test(c.prompt)).length, 0);
    assert.deepEqual(ids.map((id) => row(id).statement), ['Calcola 1.', 'Calcola 2.', 'Calcola 3.']);
    assert.deepEqual(ids.map((id) => row(id).status), ['verified', 'verified', 'verified']);
  });

  test('model calls for the reading of exam questions, three sessions of three exercises: 9 before, 3 now', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    const groups = ['Gennaio', 'Giugno', 'Luglio'];
    const ids: string[][] = groups.map((g, gi) => [1, 2, 3].map((n) => {
      seedPage(ctx, 'r-exam', gi * 3 + n - 1, `testo`, `PAGINA ${g} ${n}`);
      return q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: gi * 3 + n - 1, page_to: gi * 3 + n - 1, exam_group: g, number: String(n), solution: '' });
    }));
    for (const [gi, g] of groups.entries()) {
      fake.next(answer({ exercises: [ex(1, { solution: '' }), ex(2, { solution: '' }), ex(3, { solution: '' })] }));
      const result = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: g }, { key: sessionImportKey('r-exam', g) }));
      fake.next(answer({ markdown: 's' }), answer({ markdown: 's' }), answer({ markdown: 's' }));
      await read(ids[gi], sessionImportKey('r-exam', g), result);
    }
    // 3 extraction calls instead of 9 (the per-exercise kind, "Exercise number"), plus 9 worked solutions that both versions write.
    assert.equal(fake.calls.filter((c) => /Exercises to copy/.test(c.prompt)).length, 3);
    assert.equal(fake.calls.filter((c) => /Exercise number/.test(c.prompt)).length, 0);
    assert.equal(fake.calls.filter((c) => /^EXERCISE:/.test(c.prompt)).length, 9);
  });
});

describe('14. practice-done barrier and the first-chapter gate', () => {
  test('generateSpecs: the gate waits for review and practice-done, which waits for the planner', () => {
    seedOutline([['c1', ['s1']], ['c2', ['s2']]]);
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ firstChapterGate: true }), P);
    const specs = generateSpecs(ctx, P);
    const done = specs.find((s) => s.kind === 'practice.done')!;
    assert.equal(done.key, 'practice-done:c1');
    assert.deepEqual(done.deps, ['practice:c1']);
    assert.deepEqual(specs.find((s) => s.kind === 'gate')!.deps, ['review:c1', 'practice-done:c1']);
  });

  test('throws a "later" error while practice tasks are open and succeeds once all are terminal', async () => {
    seedOutline([['c1', ['s1']]]);
    const runId = newId();
    const qid = q({ chapter_id: 'c1', origin: 'authentic', kind: 'exam' });
    const verify = startTask('question.verify', { questionId: qid }, { runId, key: `verify:${qid}` });
    const gen = startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' }, { runId, key: 'generate:c1:exercise' });
    ctx.db.run(`UPDATE tasks SET state = 'queued' WHERE id IN (?, ?)`, verify.task.id, gen.task.id);
    const barrier = startTask('practice.done', { chapterId: 'c1' }, { runId, key: 'practice-done:c1' });
    await assert.rejects(practiceDone(ctx, barrier), (e: unknown) => e instanceof TaskError && e.kind === 'later');
    ctx.db.run(`UPDATE tasks SET state = 'succeeded' WHERE id = ?`, gen.task.id);
    await assert.rejects(practiceDone(ctx, barrier), (e: unknown) => e instanceof TaskError && e.kind === 'later');
    ctx.db.run(`UPDATE tasks SET state = 'succeeded' WHERE id = ?`, verify.task.id);
    assert.deepEqual(await practiceDone(ctx, barrier), { tasks: 2, failed: 0, blocked: 0 });
  });

  test('a failed import does not keep the barrier waiting on the tasks it blocks', async () => {
    seedOutline([['c1', ['s1']]]);
    const runId = newId();
    const qid = q({ chapter_id: 'c1', origin: 'authentic', kind: 'exam' });
    const imp = startTask('question.import', { questionId: qid }, { runId, key: `import:${qid}` });
    const verify = startTask('question.verify', { questionId: qid }, { runId, key: `verify:${qid}` });
    ctx.db.run(`UPDATE tasks SET state = 'failed' WHERE id = ?`, imp.task.id);
    ctx.db.run(`UPDATE tasks SET state = 'queued' WHERE id = ?`, verify.task.id);
    ctx.db.insert('task_deps', { task_id: verify.task.id, dep_id: imp.task.id });
    const barrier = startTask('practice.done', { chapterId: 'c1' }, { runId, key: 'practice-done:c1' });
    assert.deepEqual(await practiceDone(ctx, barrier), { tasks: 2, failed: 1, blocked: 1 });
  });
});

describe('5. enrichment: pick once, one child task per extra', () => {
  const graph = { id: 'g1', title: 'Grafico', description: 'd', functions: [{ fn: 'x^2', label: 'f' }], xDomain: [-2, 2], yDomain: [0, 4], xLabel: 'x', yLabel: 'y' };

  test('chapter.enrich only picks and enqueues; a retry reuses the children instead of picking again', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', 'Testo uno.');
    seedRevision('s2', 'Testo due.');
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ graphs: true, ide: true }), P);
    const t = startTask('chapter.enrich', { chapterId: 'c1' });
    fake.next(answer({ graphs: [{ sectionId: 's1', purpose: 'parabola' }], ide: [{ sectionId: 's2', purpose: 'serie' }] }));
    const r = await chapterEnrich(ctx, t);
    assert.deepEqual(r, { picked: 2 });
    assert.deepEqual(taskKeys(t.task.runId).filter((k) => k.startsWith('enrich.')), ['enrich.graph:s1', 'enrich.ide:s2']);
    const child = json<Record<string, unknown>>(ctx.db.get<{ input: string }>(`SELECT input FROM tasks WHERE key = 'enrich.graph:s1'`)!.input, {});
    assert.deepEqual(child, { nodeId: 's1', purpose: 'parabola' });
    assert.equal(fake.calls.length, 1);
    const again = await chapterEnrich(ctx, t);
    assert.deepEqual(again, { reused: 2 });
    assert.equal(fake.calls.length, 1);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0, 'the picker saves nothing itself');
  });

  test('a MATLAB book gets a script for each picked section; a Python book still gets one per chapter', async () => {
    seedOutline([['c1', ['s1', 's2', 's3']]]);
    for (const s of ['s1', 's2', 's3']) seedRevision(s, `Testo ${s}.`);
    const picks = { graphs: [], ide: [{ sectionId: 's1', purpose: 'a' }, { sectionId: 's1', purpose: 'doppione' }, { sectionId: 's2', purpose: 'b' }, { sectionId: 's3', purpose: 'c' }] };

    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ graphs: false, ide: true, labLanguage: 'matlab' }), P);
    const m = startTask('chapter.enrich', { chapterId: 'c1' });
    fake.next(answer(picks));
    assert.deepEqual(await chapterEnrich(ctx, m), { picked: 3 });
    assert.deepEqual(taskKeys(m.task.runId).filter((k) => k.startsWith('enrich.')), ['enrich.ide:s1', 'enrich.ide:s2', 'enrich.ide:s3']);
    assert.match(fake.calls.at(-1)!.prompt, /at most 3 sections for a MATLAB example/);

    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ graphs: false, ide: true }), P);
    const py = startTask('chapter.enrich', { chapterId: 'c1' });
    fake.next(answer(picks));
    assert.deepEqual(await chapterEnrich(ctx, py), { picked: 1 });
  });

  test('picks for unknown sections do not use up the places for graphs and examples', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    for (const s of ['s1', 's2']) seedRevision(s, `Testo ${s}.`);
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ graphs: true, ide: true, labLanguage: 'matlab' }), P);
    const t = startTask('chapter.enrich', { chapterId: 'c1' });
    fake.next(answer({
      graphs: [{ sectionId: 'x9', purpose: 'inventata' }, { sectionId: 's1', purpose: 'a' }, { sectionId: 's1', purpose: 'doppione' }, { sectionId: 's2', purpose: 'b' }],
      ide: [{ sectionId: 'x9', purpose: 'inventata' }, { sectionId: 's1', purpose: 'a' }, { sectionId: 's2', purpose: 'b' }],
    }));
    assert.deepEqual(await chapterEnrich(ctx, t), { picked: 4 });
    assert.deepEqual(taskKeys(t.task.runId).filter((k) => k.startsWith('enrich.')), ['enrich.graph:s1', 'enrich.graph:s2', 'enrich.ide:s1', 'enrich.ide:s2']);
  });

  test('MATLAB code with A\\b and a string holding \\n is stored exactly as written', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'La divisione a sinistra.');
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ ide: true, labLanguage: 'matlab' }), P);
    const code = "A = [2 1; 1 3];\nb = [3; 5];\nx = A\\b;\nfprintf('x1 = %g\\n', x(1));\nfprintf('%s\\n', 'a\\tb');";
    fake.next(wroteCode({ id: 'sistema', title: 'Sistema', description: 'Cambia b', code, expectedOutput: 'x1 = 0.8' }));
    assert.deepEqual(await enrichIde(ctx, startTask('enrich.ide', { nodeId: 's1', purpose: 'sistema lineare' })), { made: 1 });
    const row = ctx.db.get<{ payload: string; status: string }>(`SELECT payload, status FROM enrichments WHERE kind = 'ide'`)!;
    assert.equal(json<{ code: string }>(row.payload, { code: '' }).code, code);
    assert.equal(row.status, 'verified');
  });

  test('a MATLAB example is saved as matlab after numbl runs it', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il ciclo for.');
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ ide: true, labLanguage: 'matlab' }), P);
    const t = startTask('enrich.ide', { nodeId: 's1', purpose: 'cicli' });
    fake.next(wroteCode({ id: 'somma', title: 'Somma', description: 'Cambia n', code: "s = 0;\nfor k = 1:4\n  s = s + k;\nend\nfprintf('s = %d\\n', s);", expectedOutput: 's = 10' }));
    assert.deepEqual(await enrichIde(ctx, t), { made: 1 });
    const row = ctx.db.get<{ payload: string; status: string; checks: string }>(`SELECT payload, status, checks FROM enrichments WHERE kind = 'ide'`)!;
    assert.equal(json<{ language: string }>(row.payload, { language: '' }).language, 'matlab');
    assert.equal(row.status, 'verified');
    assert.match(row.checks, /Ran in numbl/);
    assert.match(fake.calls.at(-1)!.system ?? '', /numbl/);
  });

  test('a child is idempotent: it saves one graph and skips when the section already has one', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno.');
    const t = startTask('enrich.graph', { nodeId: 's1', purpose: 'p' });
    fake.next(answer(graph));
    assert.deepEqual(await enrichGraph(ctx, t), { made: 1 });
    assert.deepEqual(await enrichGraph(ctx, t), { reused: true });
    assert.equal(fake.calls.length, 1);
    assert.equal(ctx.db.all(`SELECT 1 FROM enrichments WHERE kind = 'graph'`).length, 1);
  });

  test('a Bode pair saves two graphs on the same log frequency axis', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il filtro passa-basso.');
    const t = startTask('enrich.graph', { nodeId: 's1', purpose: 'Bode' });
    fake.next(answer({
      id: 'bode', title: 'Modulo', description: 'Modulo in dB', functions: [{ fn: '-10*log10(1+(x/1000)^2)', label: '|H|' }],
      xDomain: [10, 100000], yDomain: [-40, 5], xScale: 'log', yScale: null, xLabel: 'f (Hz)', yLabel: 'dB',
      pair: { id: 'bode', title: 'Fase', description: 'Fase in gradi', functions: [{ fn: '-atan(x/1000)*180/pi', label: 'fase' }], yDomain: [-100, 10], yScale: null, yLabel: 'gradi' },
    }));
    assert.deepEqual(await enrichGraph(ctx, t), { made: 2 });
    const rows = ctx.db.all<{ payload: string; status: string }>(`SELECT payload, status FROM enrichments WHERE kind = 'graph' ORDER BY rowid`);
    const layouts = rows.map((r) => json<{ id: string; config: { layout: { xaxis: { type: string; range: number[]; title: string } } } }>(r.payload, { id: '', config: { layout: { xaxis: { type: '', range: [], title: '' } } } }));
    assert.deepEqual(layouts.map((l) => l.id), ['bode', 'bode-2'], 'the second graph gets its own id');
    for (const l of layouts) assert.deepEqual(l.config.layout.xaxis, { title: 'f (Hz)', type: 'log', range: [1, 5] });
    assert.deepEqual(rows.map((r) => r.status), ['verified', 'verified']);
  });
});

describe('Auto Fix redraws a graph that failed its check (issue 36)', () => {
  const graph = { id: 'g1', title: 'Grafico', description: 'd', functions: [{ fn: 'x^2', label: 'f' }], xDomain: [-2, 2], yDomain: [0, 4], xLabel: 'x', yLabel: 'y' };
  const off = { ...graph, yDomain: [10, 20] };
  const failing = async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno.');
    fake.next(answer(off));
    await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'parabola' }));
    return { enrichment: ctx.db.get<{ id: string }>(`SELECT id FROM enrichments`)!.id, issue: ctx.db.get<{ id: string }>(`SELECT id FROM review_issues WHERE source = 'verification'`)!.id };
  };

  test('the redraw replaces the failing graph only when the new one passes, and then closes the issue', async () => {
    const { enrichment, issue } = await failing();
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM enrichments')!.status, 'issue', 'the failed graph is stored with a verification issue, as the issue describes');
    assert.deepEqual(await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [issue] })), { skipped: 'routed', routed: { graphs: 1 } });
    assert.equal(fake.calls.length, 1, 'the text writer is not asked');
    const input = json<Record<string, unknown>>(ctx.db.get<{ input: string }>(`SELECT input FROM tasks WHERE kind = 'enrich.graph' AND key LIKE 'fixgraph:%'`)!.input, {});
    assert.deepEqual([input.force, input.replaceId, input.issueIds], [true, enrichment, [issue]]);
    assert.match(String(input.purpose), /failed its check[\s\S]*never enters the visible range/);

    // The redraw fails again: the old graph stays, no second graph and no second issue appear, the reason is shown.
    fake.next(answer(off));
    await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.match(fake.calls[1].prompt, /failed its check/);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 1);
    assert.equal(ctx.db.all(`SELECT 1 FROM review_issues`).length, 1);
    assert.match(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues')!.resolution, /redrawn but failed its check again: .*never enters the visible range/);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'open');

    fake.next(answer(graph));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', input)), { made: 1, replaced: true });
    const rows = ctx.db.all<{ id: string; status: string }>('SELECT id, status FROM enrichments').map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ id: enrichment, status: 'verified' }]);
    assert.deepEqual({ ...ctx.db.get<Record<string, unknown>>('SELECT status, resolution FROM review_issues') }, { status: 'fixed', resolution: 'The graph was redrawn and passes its check.' });
  });

  test('a graph the author edited or deleted during the redraw is left alone and the issue stays open', async () => {
    const { enrichment, issue } = await failing();
    const input = { nodeId: 's1', purpose: 'p', force: true, replaceId: enrichment, issueIds: [issue] };
    const edited = { ...graph, title: "Grafico dell'autrice" };
    fake.next(() => { ctx.db.run('UPDATE enrichments SET payload = ? WHERE id = ?', JSON.stringify(edited), enrichment); return answer(graph)(); });
    const r = await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.equal(r.made, 0);
    assert.match(String(r.skipped), /edited the graph/);
    assert.deepEqual(json(ctx.db.get<{ payload: string }>('SELECT payload FROM enrichments')!.payload, {}), edited);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'open');
    assert.match(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues')!.resolution, /edited the graph/);

    fake.next(() => { ctx.db.run('DELETE FROM enrichments WHERE id = ?', enrichment); return answer(graph)(); });
    const gone = await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.equal(gone.made, 0);
    assert.match(String(gone.skipped), /deleted the graph/);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0, 'a deleted graph is not recreated');
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'open');
  });

  test('an issue whose failing graph is gone, or passes now, closes without a model call', async () => {
    const { enrichment, issue } = await failing();
    ctx.db.run(`UPDATE enrichments SET status = 'verified' WHERE id = ?`, enrichment);
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [issue] }));
    assert.deepEqual(r, { skipped: 'nothing requested' });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual({ ...ctx.db.get<Record<string, unknown>>('SELECT status, resolution FROM review_issues') }, { status: 'fixed', resolution: 'The graph passes its check now.' });
    ctx.db.run(`UPDATE review_issues SET status = 'open'`);
    ctx.db.run('DELETE FROM enrichments');
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [issue] }));
    assert.equal(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues')!.resolution, 'The graph that failed its check is no longer in the book.');
  });
});

describe('Auto Fix redraws each failing graph of a Bode pair for its own issues', () => {
  const mag = (over = {}) => ({ id: 'bode', title: 'Modulo', description: 'Modulo in dB', functions: [{ fn: '-10*log10(1+(x/1000)^2)', label: '|H|' }], xDomain: [10, 100000], yDomain: [-40, 5], xScale: 'log', yScale: null, xLabel: 'f (Hz)', yLabel: 'dB', ...over });
  const phase = (over = {}) => ({ id: 'bode', title: 'Fase', description: 'Fase in gradi', functions: [{ fn: '-atan(x/1000)*180/pi', label: 'fase' }], yDomain: [-100, 10], yScale: null, yLabel: 'gradi', ...over });
  /** Both graphs of the pair fail: their y ranges are far from the curves. */
  const failingPair = async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il filtro passa-basso.');
    fake.next(answer({ ...mag({ yDomain: [10, 20] }), pair: phase({ yDomain: [500, 600] }) }));
    await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'Bode' }));
    const rows = ctx.db.all<{ id: string; payload: string }>(`SELECT id, payload FROM enrichments ORDER BY rowid`).map((r) => ({ id: r.id, graphId: json<{ id: string }>(r.payload, { id: '' }).id }));
    const issues = ctx.db.all<{ id: string; quote: string }>(`SELECT id, quote FROM review_issues ORDER BY rowid`);
    return { magRow: rows[0]!.id, phaseRow: rows[1]!.id, magIssue: issues[0]!.id, phaseIssue: issues[1]!.id, issues, rows };
  };
  const redrawInputs = () => ctx.db.all<{ input: string }>(`SELECT input FROM tasks WHERE kind = 'enrich.graph' AND key LIKE 'fixgraph:%' ORDER BY rowid`).map((r) => json<Record<string, unknown>>(r.input, {}));
  const redrawsOf = (f: { magRow: string; phaseRow: string }) => [f.magRow, f.phaseRow].map((id) => redrawInputs().find((i) => i.replaceId === id)!);
  const statusOf = (id: string) => ctx.db.get<{ status: string }>('SELECT status FROM review_issues WHERE id = ?', id)!.status;

  test('each failing graph gets its own redraw for its own issue', async () => {
    const f = await failingPair();
    assert.deepEqual(f.rows.map((r) => r.graphId), ['bode', 'bode-2']);
    assert.deepEqual(await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [f.magIssue, f.phaseIssue] })), { skipped: 'routed', routed: { graphs: 2 } });
    const inputs = redrawInputs();
    assert.deepEqual(inputs.map((i) => [i.replaceId, i.issueIds]).sort(), [[f.magRow, [f.magIssue]], [f.phaseRow, [f.phaseIssue]]].sort());
  });

  test('the answer graph with the failing row\'s id replaces that row, and only its issue closes', async () => {
    const f = await failingPair();
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [f.magIssue, f.phaseIssue] }));
    const [magInput, phaseInput] = redrawsOf(f);
    // The redraw of the phase row answers with a good magnitude as the graph and a good phase as its pair.
    fake.next(answer({ ...mag(), pair: phase() }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', phaseInput!)), { made: 1, replaced: true });
    const rows = ctx.db.all<{ id: string; payload: string; status: string }>('SELECT id, payload, status FROM enrichments ORDER BY rowid');
    assert.equal(rows.length, 2, 'no duplicate graph appears');
    assert.deepEqual(rows.map((r) => [r.id, json<{ title: string }>(r.payload, { title: '' }).title, r.status]), [[f.magRow, 'Modulo', 'issue'], [f.phaseRow, 'Fase', 'verified']]);
    assert.deepEqual([statusOf(f.magIssue), statusOf(f.phaseIssue)], ['open', 'fixed']);
    // The magnitude row is still failing, and its own redraw fixes it.
    fake.next(answer({ ...mag(), pair: phase() }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', magInput!)), { made: 1, replaced: true });
    assert.deepEqual(ctx.db.all<{ status: string }>('SELECT status FROM enrichments ORDER BY rowid').map((r) => r.status), ['verified', 'verified']);
    assert.deepEqual([statusOf(f.magIssue), statusOf(f.phaseIssue)], ['fixed', 'fixed']);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 2);
  });

  test('an answer with a single graph of another id still replaces the failing row, and an answer with none of its id leaves the issues open', async () => {
    const f = await failingPair();
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [f.magIssue, f.phaseIssue] }));
    const [magInput, phaseInput] = redrawsOf(f);
    fake.next(answer(phase({ id: 'fase', xDomain: [10, 100000], xScale: 'log', xLabel: 'f (Hz)' })));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', phaseInput!)), { made: 1, replaced: true });
    assert.equal(statusOf(f.phaseIssue), 'fixed');
    // Two graphs, neither with the id of the magnitude row: nothing in the answer is for that row.
    fake.next(answer({ ...mag({ id: 'one' }), pair: phase({ id: 'two' }) }));
    const r = await enrichGraph(ctx, startTask('enrich.graph', magInput!));
    assert.equal(r.made, 0);
    assert.equal(statusOf(f.magIssue), 'open');
    assert.match(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues WHERE id = ?', f.magIssue)!.resolution, /no graph with the id "bode"/);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM enrichments WHERE id = ?', f.magRow)!.status, 'issue');
  });
});

describe('2. figure files are scoped to their section', () => {
  const plot = (expr: string) => ({ xRange: [-1, 1], yRange: [-1, 1], xLabel: null, yLabel: null, functions: [{ expr, label: null, domain: null, style: null }], points: null, asymptotes: null });
  const draft = (expr: string) => ({
    markdown: 'Un paragrafo semplice sulla funzione.\n\n:::image{src="assets/example.svg" alt="Grafico" caption="Fig"}\n:::',
    figures: [{ key: 'example', kind: 'plot', caption: 'Fig', alt: 'Grafico', plot: plot(expr), structure: null, photo: null, levels: null, orbitals: null, cell: null, periodic: null }], noFigureReason: null, summary: 'riassunto',
  });

  test('two sections with the same figure key keep their own drawing and references', async () => {
    const [s1, s2] = [newId(), newId()];
    seedOutline([['c1', [s1, s2]]]);
    fake.next(written(draft('x^2')), answer(keepFigures(1)), written(draft('x^3')), answer(keepFigures(1)));
    const r1 = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    const r2 = await sectionDraft(ctx, startTask('section.draft', { nodeId: s2 }));
    assert.equal(r1.status, 'current');
    const assets = ctx.db.all<{ id: string; node_id: string; filename: string; path: string }>('SELECT * FROM assets ORDER BY rowid');
    assert.deepEqual(assets.map((a) => a.filename), [`${s1.slice(0, 8)}-example.svg`, `${s2.slice(0, 8)}-example.svg`]);
    assert.ok(assets.every((a) => !a.path.startsWith('/')), 'stored relative to the data dir');
    const files = assets.map((a) => readFileSync(resolveDataPath(ctx.config, a.path), 'utf8'));
    assert.notEqual(files[0], files[1]);
    for (const [i, s] of [s1, s2].entries()) {
      const md = ctx.db.get<{ markdown: string }>(`SELECT markdown FROM content_revisions WHERE node_id = ? AND status = 'current'`, s)!.markdown;
      assert.match(md, new RegExp(`src="assets/${assets[i].filename}"`));
      assert.doesNotMatch(md, /assets\/example\.svg/);
    }
  });

  test('regenerating a section replaces only its own asset (same node and file name)', async () => {
    const [s1, s2] = [newId(), newId()];
    seedOutline([['c1', [s1, s2]]]);
    fake.next(written(draft('x^2')), answer(keepFigures(1)), written(draft('x^3')), answer(keepFigures(1)), written(draft('x^4')), answer(keepFigures(1)));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: s2 }));
    const before = ctx.db.all<{ id: string; node_id: string; path: string }>('SELECT * FROM assets ORDER BY rowid');
    await sectionDraft(ctx, startTask('section.draft', { nodeId: s1, force: true }));
    const after = ctx.db.all<{ id: string; node_id: string; path: string }>('SELECT * FROM assets ORDER BY rowid');
    assert.equal(after.length, 2);
    assert.equal(after.find((a) => a.node_id === s2)!.id, before.find((a) => a.node_id === s2)!.id);
    assert.notEqual(after.find((a) => a.node_id === s1)!.id, before.find((a) => a.node_id === s1)!.id);
    assert.equal(existsSync(resolveDataPath(ctx.config, before.find((a) => a.node_id === s1)!.path)), false, 'old file removed');
    assert.ok(existsSync(resolveDataPath(ctx.config, before.find((a) => a.node_id === s2)!.path)));
  });

  test('a redraft that becomes a proposal leaves the current figure alone and names its own', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written(draft('x^2')), answer(keepFigures(1)));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    const [first] = ctx.db.all<{ id: string; filename: string; path: string }>('SELECT * FROM assets');
    const drawing = readFileSync(resolveDataPath(ctx.config, first.path), 'utf8');
    // The author saves the section while the model writes the redraft.
    const redraft = written(draft('x^4'));
    fake.next(() => {
      ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = ? AND status = 'current'`, s1);
      seedRevision(s1, `Testo dell'autore.\n\n:::image{src="assets/${first.filename}" alt="Grafico" caption="Fig"}\n:::`);
      return redraft();
    }, answer(keepFigures(1)));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1, force: true }));
    assert.equal(r.status, 'proposal');
    const assets = ctx.db.all<{ id: string; filename: string; path: string }>('SELECT * FROM assets ORDER BY rowid');
    assert.equal(assets.length, 2);
    assert.equal(assets[0].id, first.id);
    assert.equal(readFileSync(resolveDataPath(ctx.config, first.path), 'utf8'), drawing, 'the current figure is unchanged');
    assert.notEqual(assets[1].filename, first.filename);
    const proposal = ctx.db.get<{ markdown: string }>(`SELECT markdown FROM content_revisions WHERE node_id = ? AND status = 'proposal'`, s1)!.markdown;
    assert.match(proposal, new RegExp(`src="assets/${assets[1].filename}"`));
  });

  test('assets and the revision are committed together: a failing commit leaves no asset row and no file', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written(draft('x^2')), answer(keepFigures(1)));
    ctx.db.run(`CREATE TRIGGER boom BEFORE INSERT ON content_revisions BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    await assert.rejects(sectionDraft(ctx, startTask('section.draft', { nodeId: s1 })), /disk full/);
    assert.equal(ctx.db.all('SELECT 1 FROM assets').length, 0);
    const dir = ctx.db.get<{ n: number }>('SELECT 1 AS n')!;
    assert.ok(dir);
    const { readdirSync } = await import('node:fs');
    const { paths } = await import('../config.ts');
    assert.deepEqual(readdirSync(paths.assets(ctx.config, P)), []);
  });

  test('a retry of the same task returns its committed revision without calling the model', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written(draft('x^2')), answer(keepFigures(1)));
    const t = startTask('section.draft', { nodeId: s1, force: true });
    const first = await sectionDraft(ctx, t);
    const again = await sectionDraft(ctx, t);
    assert.equal(again.reused, true);
    assert.equal(again.revId, first.revId);
    assert.equal(fake.calls.length, 2);
  });
});

describe('7, 8, 9. revising keeps citations, is checkpointed and supersedes', () => {
  test('citation markers of the base revision are sent to the model and come back as citations', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Prima frase.\n\nSeconda frase.', { citations: { '0': ['n1'], '1': ['n2', 'n3'] } });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Prima frase corretta. [[n1]]' }] }));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', instruction: 'correggi' }));
    assert.match(fake.calls[0].prompt, /Prima frase\. \[\[n1\]\]/);
    assert.match(fake.calls[0].prompt, /\[\[n2,n3\]\]/);
    const rev = ctx.db.get<Record<string, any>>('SELECT * FROM content_revisions WHERE id = ?', r.revId!)!;
    assert.deepEqual(json(rev.citations, {}), { '0': ['n1'], '1': ['n2', 'n3'] });
    assert.equal(rev.markdown.includes('[['), false);
  });

  test('same task again: no second model call and no second proposal; a new task supersedes the older pending proposal', async () => {
    seedOutline([['c1', ['s1']]]);
    const head = seedRevision('s1', 'Testo.');
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo uno.' }] }), patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo due.' }] }));
    const t1 = startTask('section.revise', { nodeId: 's1', instruction: 'a' });
    const a = await sectionRevise(ctx, t1);
    const a2 = await sectionRevise(ctx, t1);
    assert.equal(a2.revId, a.revId);
    assert.equal(fake.calls.length, 1);
    const stored = ctx.db.get<Record<string, any>>('SELECT * FROM content_revisions WHERE id = ?', a.revId!)!;
    assert.equal(stored.task_id, t1.task.id);
    assert.equal(stored.parent_rev_id, head);
    const b = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', instruction: 'b' }));
    const statuses = Object.fromEntries(ctx.db.all<{ id: string; status: string }>('SELECT id, status FROM content_revisions').map((r) => [r.id, r.status]));
    assert.equal(statuses[a.revId!], 'superseded');
    assert.equal(statuses[b.revId!], 'proposal');
    assert.equal(statuses[head], 'current');
  });

  test('a late AI proposal records the revision the model used as its parent, not the new human head', () => {
    seedOutline([['c1', ['s1']]]);
    const a = seedRevision('s1', 'A');
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, a);
    const b = seedRevision('s1', 'B (human)');
    const out = commitAiRevision(ctx, { projectId: P, nodeId: 's1', kind: 'section', markdown: 'AI based on A', baseRevId: a, model: 'm', taskId: 'task-x' });
    assert.equal(out.status, 'proposal');
    const rev = ctx.db.get<Record<string, any>>('SELECT * FROM content_revisions WHERE id = ?', out.revId)!;
    assert.equal(rev.parent_rev_id, a);
    assert.notEqual(rev.parent_rev_id, b);
    assert.equal(rev.task_id, 'task-x');
  });
});

describe('AI text keeps display math apart from inline math', () => {
  test('commitAiRevision separates it and moves the block citations along; a human save is left alone', () => {
    seedOutline([['c1', ['s1']]]);
    const out = commitAiRevision(ctx, { projectId: P, nodeId: 's1', kind: 'section', markdown: 'Intro.\n\nCon $a$ e $$b$$ qui', baseRevId: null, model: 'm', citations: { '0': ['n1'], '1': ['n2'] } });
    const rev = ctx.db.get<Record<string, any>>('SELECT * FROM content_revisions WHERE id = ?', out.revId)!;
    assert.equal(rev.markdown, 'Intro.\n\nCon $a$ e\n\n$$\nb\n$$\n\nqui');
    assert.deepEqual(json(rev.citations, {}), { '0': ['n1'], '1': ['n2'] });
    const human = saveHuman(ctx, P, 's2', 'Con $a$ e $$b$$ qui', null);
    assert.equal(human.markdown, 'Con $a$ e $$b$$ qui');
  });
});

describe('AI text never defines a formula key another section owns', () => {
  test('the repeated formula block keeps its math and loses its key', () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', ':::formula{key="teorema-weierstrass" label="Teorema di Weierstrass"}\n$$f(x)\\le M$$\n:::');
    const md = 'Richiamo.\n\n:::formula{key="teorema-weierstrass" label="Teorema di Weierstrass"}\n$$f(x)\\le M$$\n:::\n\n:::formula{key="nuova" label="Nuova"}\n$$y$$\n:::';
    const out = commitAiRevision(ctx, { projectId: P, nodeId: 's2', kind: 'section', markdown: md, baseRevId: null, model: 'm' });
    const rev = ctx.db.get<Record<string, any>>('SELECT * FROM content_revisions WHERE id = ?', out.revId)!;
    assert.equal(rev.markdown, 'Richiamo.\n\n$$f(x)\\le M$$\n\n:::formula{key="nuova" label="Nuova"}\n$$y$$\n:::');
  });
});

describe('17. chapter review persists compile findings with the book context', () => {
  test('an unresolved reference becomes a lint issue; a valid cross-chapter reference does not', async () => {
    seedOutline([['c1', ['s1']], ['c2', ['s2']]]);
    seedRevision('s1', 'Si veda [la sezione](ref:section/s2) e [un\'altra](ref:section/nonexiste).');
    seedRevision('s2', 'Testo.');
    fake.next(answer({ issues: [] }));
    await chapterReview(ctx, startTask('chapter.review', { chapterId: 'c1' }));
    const lint = issues(`source = 'lint'`);
    assert.ok(lint.length >= 1, 'a finding is stored');
    assert.ok(lint.every((i) => i.severity === 'blocker' || i.severity === 'major'));
    assert.ok(lint.some((i) => /nonexiste/.test(i.message + i.quote)), JSON.stringify(lint));
    assert.ok(!lint.some((i) => /ref:section\/s2\)/.test(i.quote) && /s2/.test(i.message) && !/nonexiste/.test(i.message)), 'the valid reference is not reported');
    assert.equal(lint[0].node_id, 's1');
  });
});

describe('12, 13. topic map: labels, fingerprint, mutex, classification; priorities from exams only', () => {
  const insertIndex = (rid: string) => ctx.db.run('INSERT INTO source_indexes (resource_id, origin, entries) VALUES (?, ?, ?)', rid, 'extracted', JSON.stringify([{ title: `Argomenti di ${rid}`, level: 1, page: 0 }]));
  const topics = (sources: { resource: string }[] = [{ resource: 'R1' }]) => ({
    topics: [{ key: 'limiti', name: 'Limiti', aliases: [], description: '', prerequisites: [], sources: sources.map((s) => ({ ...s, pageFrom: 1, pageTo: 3 })) }],
  });

  test('labels are assigned once over the theory sources: exams uploaded first do not shift them', async () => {
    seedResource(ctx, { projectId: P, id: 'exam1', role: 'exams', filename: 'esami.pdf' });
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory', filename: 'teoria.pdf' });
    ctx.db.run(`UPDATE resources SET created_at = '2020-01-01' WHERE id = 'exam1'`);
    ctx.db.run(`UPDATE resources SET created_at = '2020-01-02' WHERE id = 'theory1'`);
    insertIndex('theory1');
    fake.next(answer(topics()));
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.match(fake.calls[0].prompt, /R1 teoria\.pdf/);
    const tp = ctx.db.get<{ sources: string }>('SELECT sources FROM topics')!;
    assert.equal(json<{ resourceId: string }[]>(tp.sources, [])[0].resourceId, 'theory1');
    assert.deepEqual([...labelResources([{ id: 'a' }, { id: 'b' }]).byLabel], [['R1', 'a'], ['R2', 'b']]);
  });

  test('a new theory source rebuilds the map and re-classifies exam questions; collection items lose their old topics and are not classified; unchanged sources do nothing', async () => {
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    insertIndex('theory1');
    const exam = q({ kind: 'exam', origin: 'authentic', exam_group: 'G1', statement: 'Limite?' });
    const quiz = q({ kind: 'exercise', origin: 'authentic', exam_group: 'Quiz A', statement: 'Quiz?' });
    const written = q({ kind: 'exercise', origin: 'generated', statement: 'Scritto da noi' });
    fake.next(answer(topics()), answer({ items: [{ id: exam, topics: ['limiti'], difficulty: 'medio' }] }));
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.deepEqual(json(row(exam).topic_ids, []), [`${P.slice(0, 8)}-limiti`]);
    assert.equal(row(quiz).topic_ids, '[]', 'exercise-collection items are not classified by Prepare');
    assert.equal(row(written).topic_ids, '[]', 'questions the book wrote itself are not');
    assert.ok(fake.calls[1].prompt.includes(exam));
    assert.ok(!fake.calls[1].prompt.includes(quiz) && !fake.calls[1].prompt.includes(written));
    assert.equal(ctx.db.get<{ n: number }>(`SELECT exam_sessions AS n FROM topics WHERE id = ?`, `${P.slice(0, 8)}-limiti`)!.n, 1);
    const stored = ctx.db.get<{ topic_fingerprint: string }>('SELECT topic_fingerprint FROM projects')!.topic_fingerprint;
    assert.ok(stored);

    // Unchanged: no model call at all.
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.equal(fake.calls.length, 2);

    // A second theory source: topics are rebuilt (two sources in the prompt) and the exam is classified again.
    seedResource(ctx, { projectId: P, id: 'theory2', role: 'theory', filename: 'altro.pdf' });
    insertIndex('theory2');
    ctx.db.run(`UPDATE questions SET topic_ids = '["old"]' WHERE id = ?`, quiz);
    fake.next(answer({ topics: [...topics().topics, { key: 'serie', name: 'Serie', aliases: [], description: '', prerequisites: [], sources: [{ resource: 'R2', pageFrom: 1, pageTo: 2 }] }] }), answer({ items: [{ id: exam, topics: ['serie'], difficulty: 'facile' }] }));
    const r = await topicsMap(ctx, startTask('topics.map', {}));
    assert.match(fake.calls[2].prompt, /R2 altro\.pdf/);
    assert.equal(r.topics, 2);
    assert.deepEqual(json(row(exam).topic_ids, []), [`${P.slice(0, 8)}-serie`]);
    assert.equal(row(quiz).topic_ids, '[]', 'the old topic ids of a collection item are dropped with the old map');
    assert.equal(fake.calls.length, 4, 'a map call and an exam classification call, none for the quiz');
    assert.equal(ctx.db.get<{ n: number }>(`SELECT exam_sessions AS n FROM topics WHERE id = ?`, `${P.slice(0, 8)}-serie`)!.n, 1, 'the quiz group is not a session');
    assert.notEqual(ctx.db.get<{ topic_fingerprint: string }>('SELECT topic_fingerprint FROM projects')!.topic_fingerprint, stored);
  });

  test('Prepare classifies the exam questions only: 45 exams and 100 collection items take 3 bulk calls, not 8', async () => {
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    insertIndex('theory1');
    for (let i = 0; i < 45; i++) q({ kind: 'exam', origin: 'authentic', exam_group: `G${i % 9}`, statement: `Esame ${i}` });
    for (let i = 0; i < 100; i++) q({ kind: 'exercise', origin: 'authentic', exam_group: 'Quiz A', statement: `Quiz ${i}` });
    fake.next(answer(topics()), answer({ items: [] }), answer({ items: [] }), answer({ items: [] }));
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.equal(fake.calls.length, 4, 'one map call and three classification calls of up to 20');
    assert.ok(fake.calls.slice(1).every((c) => !c.prompt.includes('Quiz ')));
  });

  test('a rebuilt map keeps the priority the author set by hand on a topic that keeps its key', async () => {
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    insertIndex('theory1');
    fake.next(answer(topics()));
    await topicsMap(ctx, startTask('topics.map', {}));
    ctx.db.run(`UPDATE topics SET priority = 'high', priority_locked = 1 WHERE id = ?`, `${P.slice(0, 8)}-limiti`);
    seedResource(ctx, { projectId: P, id: 'theory2', role: 'theory', filename: 'altro.pdf' });
    insertIndex('theory2');
    fake.next(answer({ topics: [...topics().topics, { key: 'serie', name: 'Serie', aliases: [], description: '', prerequisites: [], sources: [{ resource: 'R2', pageFrom: 1, pageTo: 2 }] }] }));
    await topicsMap(ctx, startTask('topics.map', {}));
    const rows = ctx.db.all<{ id: string; priority: string; priority_locked: number }>('SELECT id, priority, priority_locked FROM topics ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.id.slice(9), r.priority, r.priority_locked]), [['limiti', 'high', 1], ['serie', 'normal', 0]]);
  });

  test('a map from before fingerprints is adopted, not rebuilt', async () => {
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    insertIndex('theory1');
    ctx.db.insert('topics', { id: `${P.slice(0, 8)}-old`, project_id: P, name: 'Vecchio', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'normal' });
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.equal(fake.calls.length, 0);
    assert.ok(ctx.db.get<{ topic_fingerprint: string }>('SELECT topic_fingerprint FROM projects')!.topic_fingerprint);
  });

  test('two map tasks of one project run one after the other', async () => {
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    insertIndex('theory1');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fake.next(async () => { await gate; return { structured: topics() as never, text: '{}', usage: usageOf(1, 1) }; });
    const a = topicsMap(ctx, startTask('topics.map', {}));
    const b = topicsMap(ctx, startTask('topics.map', {}));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fake.calls.length, 1);
    release();
    await Promise.all([a, b]);
    assert.equal(fake.calls.length, 1, 'the second task saw the finished map and the same sources');
    assert.equal(ctx.db.all('SELECT 1 FROM topics').length, 1);
  });
});

// ---- second review ----

const events = (type: string) => ctx.db.all<{ data: string }>('SELECT data FROM events WHERE type = ? ORDER BY seq', type).map((e) => json<Record<string, any>>(e.data, {}));

// startRun wakes the queue; these tests only look at the planned tasks.
const parkQueue = () => { (ctx.queue as unknown as { wake(): void }).wake = () => undefined; };

describe('r3. verifying again never overwrites an author-repaired authentic question', () => {
  beforeEach(parkQueue);
  const examQ = (o: Record<string, unknown> = {}) => {
    if (!ctx.db.get('SELECT 1 FROM resources WHERE id = ?', 'r-exam')) {
      seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
      seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    }
    return q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo', solution: '', ...o });
  };

  test('import marks the question as imported; a second import (even after the checks were cleared) reuses it without a model call', async () => {
    const id = examQ();
    fake.next(answer({ statement: 'Calcola.', solution: 'Fatto.', readable: true }));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.ok(row(id).imported_at);
    ctx.db.run(`UPDATE questions SET checks = '[]', status = 'draft' WHERE id = ?`, id);
    const calls = fake.calls.length;
    assert.deepEqual(await questionImport(ctx, startTask('question.import', { questionId: id })), { reused: true });
    assert.equal(fake.calls.length, calls);
  });

  test('an imported question whose solution is empty is read again; an unreadable one is not marked as imported', async () => {
    const id = examQ({ imported_at: '2026-01-01', solution: '' });
    fake.next(answer({ statement: 'Calcola.', solution: 'Ora c\'è.', readable: true }));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(row(id).solution, "Ora c'è.");
    const bad = examQ();
    fake.next(answer({ statement: '', solution: '', readable: false }));
    await questionImport(ctx, startTask('question.import', { questionId: bad }));
    assert.equal(row(bad).imported_at, null);
  });

  test('the unreadable-question repair: author types statement and solution, verify checks that text and never imports it again', async () => {
    const id = examQ({ status: 'issue' });
    // The author repairs it through the API path (repo updateQuestion), which marks it as edited.
    updateQuestion(ctx, id, 1, { statement: 'Testo riscritto a mano', solution: 'Soluzione a mano', chapterId: 'c1' });
    assert.ok(row(id).edited_at);

    // "Verify again": no import step for an edited question.
    const run = startRun(ctx, P, 'review', { questionIds: [id] });
    assert.deepEqual(taskKeys(run.id), [`verify:${id}`]);
    assert.deepEqual(ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND key LIKE 'import:%'`, run.id)[0].n, 0);

    // Even if an import task ran, it would leave the text alone.
    const calls = fake.calls.length;
    assert.deepEqual(await questionImport(ctx, startTask('question.import', { questionId: id })), { skipped: 'edited by the author' });
    assert.equal(fake.calls.length, calls);

    fake.next(answer({ independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.match(fake.calls.at(-1)!.prompt, /Testo riscritto a mano/);
    assert.equal(row(id).statement, 'Testo riscritto a mano');
    assert.equal(row(id).solution, 'Soluzione a mano');
    assert.equal(row(id).status, 'verified');
    assert.ok(row(id).edited_at, 'verification does not clear the edit mark');
  });

  test('"Verify again" on an authentic question: import first only when it was never read from its pages', () => {
    const fresh = examQ();
    const done = examQ({ imported_at: '2026-01-01', solution: 'Ok.' });
    const a = startRun(ctx, P, 'review', { questionIds: [fresh] });
    assert.deepEqual(taskKeys(a.id), [`import:${fresh}`, `verify:${fresh}`]);
    const b = startRun(ctx, P, 'review', { questionIds: [done] });
    assert.deepEqual(taskKeys(b.id), [`verify:${done}`]);
  });

  test('an edit through updateQuestion keeps imported_at; chapterPractice skips the import of edited questions', async () => {
    const t = `${P.slice(0, 8)}-limiti`;
    ctx.db.insert('topics', { id: t, project_id: P, name: 'Limiti', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'normal' });
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    const edited = examQ({ topic_ids: [t], imported_at: '2026-01-01', solution: 'Ok.', exam_date: '2024-01-01' });
    const plain = examQ({ topic_ids: [t], exam_date: '2023-01-01' });
    updateQuestion(ctx, edited, 1, { solution: 'Ok, corretta' });
    assert.equal(row(edited).imported_at, '2026-01-01');
    const task = startTask('chapter.practice', { chapterId: 'c1' });
    await chapterPractice(ctx, task);
    const keys = taskKeys(task.task.runId);
    assert.ok(keys.includes(`import:${plain}`));
    assert.ok(!keys.includes(`import:${edited}`));
    assert.ok(keys.includes(`verify:${edited}`));
    const dep = ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM task_deps WHERE task_id = (SELECT id FROM tasks WHERE key = ?)`, `verify:${edited}`)[0].n;
    assert.equal(dep, 0);
  });
});

describe('r4. classification does not overwrite question edits', () => {
  const setup = () => {
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    ctx.db.run('INSERT INTO source_indexes (resource_id, origin, entries) VALUES (?, ?, ?)', 'theory1', 'extracted', JSON.stringify([{ title: 'Argomenti', level: 1, page: 0 }]));
    ctx.db.insert('topics', { id: `${P.slice(0, 8)}-limiti`, project_id: P, name: 'Limiti', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'normal' });
  };

  test('a question edited while the model classifies keeps its topics and difficulty; only the batch is accepted; classified rows bump rev', async () => {
    setup();
    const a = q({ kind: 'exam', origin: 'authentic', exam_group: 'G1', statement: 'Limite A?' });
    const b = q({ kind: 'exam', origin: 'authentic', exam_group: 'G2', statement: 'Limite B?' });
    const outsider = q({ kind: 'exam', origin: 'authentic', exam_group: 'G3', statement: 'Altro', topic_ids: ['x'], difficulty: 'facile' });
    fake.next(() => {
      // The author fixes topics and difficulty of A while the batch is in flight.
      ctx.db.run(`UPDATE questions SET topic_ids = '["mine"]', difficulty = 'difficile', rev = rev + 1 WHERE id = ?`, a);
      return { structured: { items: [
        { id: a, topics: ['limiti'], difficulty: 'facile' },
        { id: b, topics: ['limiti'], difficulty: 'medio' },
        { id: outsider, topics: ['limiti'], difficulty: 'medio' },
        { id: 'not-a-question', topics: ['limiti'], difficulty: 'medio' },
      ] } as never, text: '{}', usage: usageOf(1, 1) };
    });
    const r = await topicsMap(ctx, startTask('topics.map', {}));
    assert.equal(r.classified, 1);
    assert.deepEqual([json(row(a).topic_ids, []), row(a).difficulty, row(a).rev], [['mine'], 'difficile', 2], 'the author\'s values stay');
    assert.deepEqual([json(row(b).topic_ids, []), row(b).rev], [[`${P.slice(0, 8)}-limiti`], 2]);
    assert.deepEqual([json(row(outsider).topic_ids, []), row(outsider).difficulty, row(outsider).rev], [['x'], 'facile', 1], 'ids outside the batch are ignored');
    assert.deepEqual(events('question.updated').at(-1), { questionIds: [b] });
  });
});

describe('r5. a superseded proposal gives its issues back', () => {
  // The author edits the section while the model runs: the fix cannot be applied and waits as a proposal.
  const editDuring = (obj: unknown) => () => {
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = 's1' AND status = 'current'`);
    seedRevision('s1', 'Testo dell\'autrice.');
    return { text: patchText(obj as Parameters<typeof patchText>[0]), usage: usageOf(10, 10) };
  };

  test('regenerating before accepting reopens the issues of the replaced proposal; accepting the replacement fixes the right ones', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    ctx.db.insert('review_issues', { id: 'iA', project_id: P, node_id: 's1', source: 'review', severity: 'blocker', category: 'math', message: 'A', suggestion: 'a', status: 'open', resolution: '', created_at: now() });
    fake.next(editDuring({ figures: [], changes: [{ block: 0, text: 'Testo uno.' }] }), answer(checkGood([0])));
    const first = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['iA'] }));
    const issue = () => ({ ...ctx.db.get<Record<string, any>>(`SELECT status, resolution FROM review_issues WHERE id = 'iA'`)! });
    assert.equal(first.status, 'proposal');
    assert.deepEqual(issue(), { status: 'proposed', resolution: `Proposal ${first.revId}` });

    // Regenerate the same section with an instruction: the first proposal is superseded.
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo due.' }] }));
    const second = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', instruction: 'più breve' }));
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', first.revId!)!.status, 'superseded');
    assert.deepEqual(issue(), { status: 'open', resolution: '' });
    assert.ok(events('issue.updated').some((e) => e.issueIds.includes('iA')));

    // The issue can be sent to the AI again and, with the head unchanged, the fix is applied.
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo tre dell\'autrice.' }] }), answer(checkGood([0])));
    const third = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['iA'] }));
    assert.equal(third.status, 'current');
    assert.deepEqual(issue(), { status: 'fixed', resolution: `Fixed by AI in revision ${third.revId}` });
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', second.revId!)!.status, 'proposal', 'the author\'s instruction proposal survives an applied fix');
  });

  test('a replacement proposal reopens, an applied one leaves other proposals alone, and rejecting reopens too', () => {
    seedOutline([['c1', ['s1']]]);
    const head = seedRevision('s1', 'Testo.');
    ctx.db.insert('review_issues', { id: 'iB', project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'x', message: 'B', status: 'proposed', resolution: 'Proposal p-old', created_at: now() });
    const p1 = seedRevision('s1', 'Proposta', { status: 'proposal', parent: head });
    ctx.db.run(`UPDATE review_issues SET resolution = ? WHERE id = 'iB'`, `Proposal ${p1}`);
    rejectProposal(ctx, P, 's1', p1);
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'iB'`)!.status, 'open');
    ctx.db.run(`UPDATE review_issues SET status = 'proposed', resolution = ? WHERE id = 'iB'`, `Proposal ${p1}`);
    ctx.db.run(`UPDATE content_revisions SET status = 'proposal' WHERE id = ?`, p1);
    const applied = insertProposal(ctx, P, 's1', 'Nuovo', head, 'ai', 'm');
    assert.equal(applied.applied, true);
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'iB'`)!.status, 'proposed', 'applied text does not reopen issues of a pending proposal');
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', p1)!.status, 'proposal');
    const replacement = insertProposal(ctx, P, 's1', 'Altro', head, 'ai', 'm');
    assert.equal(replacement.applied, false);
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'iB'`)!.status, 'open');
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', p1)!.status, 'superseded');
  });

  test('accepting is refused when the head is not the one the author compared with, and nothing changes', () => {
    seedOutline([['c1', ['s1']]]);
    const head = seedRevision('s1', 'Testo.');
    const prop = seedRevision('s1', 'Proposta', { status: 'proposal', parent: head });
    ctx.db.insert('review_issues', { id: 'iC', project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'x', message: 'C', status: 'proposed', resolution: `Proposal ${prop}`, created_at: now() });
    assert.throws(() => acceptProposal(ctx, P, 's1', prop, 'older-head'), (e: any) => e.status === 409 && e.message === 'The section changed after you opened this proposal.' && e.action === 'Reload to compare the proposal with the latest text.');
    assert.throws(() => acceptProposal(ctx, P, 's1', prop, null), (e: any) => e.status === 409);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', head)!.status, 'current');
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'iC'`)!.status, 'proposed');
    acceptProposal(ctx, P, 's1', prop, head);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', prop)!.status, 'current');
    // A section that had no text: the author saw null.
    const none = seedRevision('s2', 'P', { status: 'proposal' });
    assert.throws(() => acceptProposal(ctx, P, 's2', none, 'something'), (e: any) => e.status === 409);
    acceptProposal(ctx, P, 's2', none, null);
  });
});

describe('fixes are applied directly, behind guards and a cheap check', () => {
  const FORMULA = ':::formula{key="k1" label="L"}\n$$x=1$$\n:::';
  const issue = (id: string, o: Record<string, unknown> = {}) => ctx.db.insert('review_issues', { id, project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'clarity', quote: '', message: `Problema ${id}`, suggestion: '', status: 'open', resolution: '', created_at: now(), ...o });
  const state = (id: string) => ({ ...ctx.db.get<Record<string, any>>('SELECT status, resolution FROM review_issues WHERE id = ?', id)! });
  const head = () => ctx.db.get<Record<string, any>>(`SELECT * FROM content_revisions WHERE node_id = 's1' AND status = 'current' ORDER BY rowid DESC`)!;
  const fix = (ids: string[]) => sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ids }));

  test('the fix becomes the current text, the issue is fixed, lints and events follow, and the check ran on the checker model', async () => {
    seedOutline([['c1', ['s1']]]);
    const before = seedRevision('s1', 'Prima frase.\n\nSeconda frase.');
    issue('i1', { quote: 'Prima frase.' });
    ctx.db.insert('review_issues', { id: 'lint-old', project_id: P, node_id: 's1', source: 'lint', severity: 'minor', category: 'old', quote: '', message: 'vecchio', suggestion: '', status: 'open', resolution: '', created_at: now() });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Prima frase corretta.' }] }), answer(checkGood([0])));
    const r = await fix(['i1']);
    assert.equal(r.status, 'current');
    assert.equal(head().markdown, 'Prima frase corretta.\n\nSeconda frase.');
    assert.equal(head().id, r.revId);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', before)!.status, 'superseded');
    assert.deepEqual(state('i1'), { status: 'fixed', resolution: `Fixed by AI in revision ${r.revId}` });
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].selection.model, ctx.settings().routes.checker.primary.model);
    assert.match(fake.calls[1].prompt, /\[B0\][\s\S]*Prima frase\.[\s\S]*Prima frase corretta\./);
    assert.equal(r.checked, true);
    assert.equal(issues(`id = 'lint-old'`).length, 0, 'the section lints were run again');
    assert.deepEqual(events('content.saved').at(-1), { nodeId: 's1', revId: r.revId, origin: 'repair', status: 'current' });
    assert.ok(events('issue.updated').some((e) => e.issueIds.includes('i1')));
  });

  test('a fix for issues is told the guard rules and gets only the evidence notes its blocks cite; an instruction gets neither', async () => {
    seedOutline([['c1', ['s1']]]);
    const notes = ['n1', 'n2', 'n3'].map((id) => ({ id, quote: `Citazione ${id}`, resourceId: null, page: null, url: 'https://x.example', verified: true, claim: '' }));
    ctx.db.insert('evidence_packets', { id: newId(), project_id: P, node_id: 's1', provider: 'local', query: 'q', answer: '', notes, created_at: now() });
    seedRevision('s1', 'Prima frase.\n\nSeconda frase.\n\nTerza frase.', { citations: { '0': ['n1'], '1': ['n2', 'n3'] } });
    issue('i1', { quote: 'Prima frase.' });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Prima corretta.' }] }), answer(checkGood([0])));
    await fix(['i1']);
    const [system, prompt] = [fake.calls[0].system ?? '', fake.calls[0].prompt];
    assert.match(system, /Rules the builder enforces on every change/);
    assert.match(system, new RegExp(`Delete at most ${MAX_DELETED_BLOCKS} blocks`));
    assert.match(prompt, /Citazione n1/);
    assert.doesNotMatch(prompt, /Citazione n2|Citazione n3/);

    // A passage that is not found, or blocks that cite nothing, send the whole packet.
    issue('i2', { quote: 'Frase che non esiste.' });
    fake.next(patchAnswer({ figures: [], changes: [] }));
    await fix(['i2']);
    assert.match(fake.calls[2].prompt, /Citazione n1[\s\S]*Citazione n2[\s\S]*Citazione n3/);
    issue('i3', { quote: 'Terza frase.' });
    fake.next(patchAnswer({ figures: [], changes: [] }));
    await fix(['i3']);
    assert.match(fake.calls[3].prompt, /Citazione n1[\s\S]*Citazione n3/);

    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Con istruzione.' }] }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', instruction: 'riscrivi' }));
    assert.doesNotMatch(fake.calls.at(-1)!.system ?? '', /Rules the builder enforces/);
    assert.match(fake.calls.at(-1)!.prompt, /Citazione n2/);
  });

  test('a batch with a cited and an uncited passage gets the whole evidence packet', async () => {
    seedOutline([['c1', ['s1']]]);
    const notes = ['n1', 'n2', 'n3'].map((id) => ({ id, quote: `Citazione ${id}`, resourceId: null, page: null, url: 'https://x.example', verified: true, claim: '' }));
    ctx.db.insert('evidence_packets', { id: newId(), project_id: P, node_id: 's1', provider: 'local', query: 'q', answer: '', notes, created_at: now() });
    seedRevision('s1', 'Prima frase.\n\nSeconda frase.\n\nTerza frase.', { citations: { '0': ['n1'] } });
    issue('i1', { quote: 'Prima frase.' });
    issue('i2', { quote: 'Terza frase.' });
    fake.next(patchAnswer({ changes: [] }));
    await fix(['i1', 'i2']);
    assert.match(fake.calls[0].prompt, /Citazione n1[\s\S]*Citazione n2[\s\S]*Citazione n3/);
  });

  test('the new text arrives as written, backslashes included; terminal codes are removed; a malformed answer gets one repair turn', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Vale $x$.\n\nAltro.');
    issue('i1', { quote: 'Vale $x$.' });
    const formula = 'Vale $\\frac{1}{2}\\nu + \\theta + \\beta\\tau$ ed è \\text{vero}.';
    fake.next(() => ({ text: `@@@ block 0 | issues 1\n\x1b[32m${formula}\x1b[0m\u0001`, usage: usageOf(10, 10) }), answer(checkGood([0])));
    const r = await fix(['i1']);
    assert.equal(r.status, 'current');
    assert.equal(head().markdown, `${formula}\n\nAltro.`);
    assert.equal(fake.calls.length, 2, 'no repair turn for a good answer');
    assert.equal(fake.calls[0].responseSchema, undefined, 'no provider JSON schema is sent for the patch');

    issue('i2', { quote: 'Altro.' });
    fake.next(() => ({ text: 'Ho corretto il blocco 1.', usage: usageOf(10, 10) }), patchAnswer({ changes: [{ block: 1, text: 'Altro corretto.' }] }), answer(checkGood([1])));
    const again = await fix(['i2']);
    assert.equal(again.status, 'current');
    assert.equal(head().markdown, `${formula}\n\nAltro corretto.`);
    assert.match(fake.calls[3].prompt, /Problems:\nText before the first "@@@" line[\s\S]*full corrected answer in the same format/);
  });

  describe('a fix that finds the text already resolves an issue (issue 37)', () => {
    const verdicts = (...v: [boolean, string][]) => answer({ issues: v.map(([resolved, reason], k) => ({ index: k + 1, resolved, reason })) });
    const revisions = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_revisions')!.n;

    test('a confirmed claim closes the issue as fixed with the reason, and no revision is written', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', 'La fenolftaleina vira tra pH 8,2 e 10.\n\nAltro.');
      issue('i1', { quote: 'La fenolftaleina' });
      const n = revisions();
      fake.next(patchAnswer({ changes: [], resolved: [{ issues: [1], reason: 'Il testo nomina già la fenolftaleina e il suo intervallo.' }] }), verdicts([true, 'Il primo blocco indica indicatore e intervallo.']));
      const r = await fix(['i1']);
      assert.equal(r.skipped, 'the text already fixes the issues');
      assert.equal(r.resolved, 1);
      assert.deepEqual(state('i1'), { status: 'fixed', resolution: 'Already resolved in the current text: Il primo blocco indica indicatore e intervallo.' });
      assert.equal(revisions(), n);
      assert.equal(fake.calls[1].selection.model, ctx.settings().routes.checker.primary.model);
      assert.match(fake.calls[1].prompt, /Claim: Il testo nomina già la fenolftaleina[\s\S]*\[B0\]\nLa fenolftaleina vira/);
      assert.ok(events('issue.updated').some((e) => e.issueIds.includes('i1')));
    });

    test('an unconfirmed claim leaves the issue open with the reason shown; a check that cannot run does too', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', 'Testo uno.\n\nTesto due.');
      issue('i1', { quote: 'Testo uno.' });
      issue('i2', { quote: 'Testo due.' });
      fake.next(patchAnswer({ changes: [], resolved: [{ issues: [1, 2], reason: 'Già detto.' }] }), verdicts([false, 'La soglia non è nominata.'], [true, 'Sì.']));
      const r = await fix(['i1', 'i2']);
      assert.equal(r.resolved, 1);
      assert.deepEqual(state('i1'), { status: 'open', resolution: 'The AI said the text already fixes this, but the check disagreed: La soglia non è nominata.' });
      assert.equal(state('i2').status, 'fixed');

      fake.next(patchAnswer({ changes: [], resolved: [{ issues: [1], reason: 'Già detto.' }] }), () => new TaskError('rete assente', 'temporary'));
      const again = await fix(['i1']);
      assert.equal(again.skipped, 'no change survived the checks');
      assert.match(state('i1').resolution, /the check could not run/);
    });

    test('the author saved new text while the claim was checked: the issue stays open with that reason', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', 'Testo uno.\n\nAltro.');
      issue('i1', { quote: 'Testo uno.' });
      fake.next(patchAnswer({ changes: [], resolved: [{ issues: [1], reason: 'Già detto.' }] }), () => {
        ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = 's1'`);
        seedRevision('s1', 'Testo uno, riscritto dall\'autrice.\n\nAltro.');
        return verdicts([true, 'Sì.'])();
      });
      await fix(['i1']);
      assert.equal(state('i1').status, 'open');
      assert.match(state('i1').resolution, /section changed while the fix and the check ran/);
    });

    test('with other changes: the changed blocks are checked against their own issues, and the claim is settled apart', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', 'Prima frase.\n\nSeconda frase.');
      issue('i1', { quote: 'Prima frase.' });
      issue('i2', { quote: 'Seconda frase.' });
      fake.next(
        () => ({ text: '@@@ block 0 | issues 1\nPrima corretta.\n@@@ resolved | issues 2\nLa seconda è già giusta.', usage: usageOf(10, 10) }),
        answer(checkGood([0], 1)),
        verdicts([true, 'Corretta.']),
      );
      const r = await fix(['i1', 'i2']);
      assert.equal(r.status, 'current');
      assert.equal(head().markdown, 'Prima corretta.\n\nSeconda frase.');
      assert.equal(r.resolved, 1);
      assert.match(state('i1').resolution, /^Fixed by AI in revision/);
      assert.match(state('i2').resolution, /^Already resolved in the current text: Corretta\./);
      const change = fake.calls.find((c) => /CHANGED BLOCKS/.test(c.prompt))!;
      assert.match(change.prompt, /1\. \[major\] Problema i1/);
      assert.doesNotMatch(change.prompt, /Problema i2/, 'the change check does not judge the claimed issue');
    });

    test('a problem the model changed text for is not a claim, and the resolution says when the quoted passage is gone', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', 'Frase nuova.');
      issue('i1', { quote: 'Frase vecchia che non c\'è più.' });
      fake.next(patchAnswer({ changes: [], resolved: [{ issues: [1], reason: 'Riscritta in precedenza.' }] }), verdicts([true, 'La frase nuova è corretta.']));
      await fix(['i1']);
      assert.match(state('i1').resolution, /Already resolved in the current text: La frase nuova è corretta\. The passage it quoted is no longer in the section\./);
      assert.match(fake.calls[1].prompt, /a passage that is no longer in the section/);

      issue('i2', { quote: 'Frase nuova.' });
      fake.next(() => ({ text: '@@@ block 0 | issues 1\nFrase corretta.\n@@@ resolved | issues 1\nGià a posto.', usage: usageOf(10, 10) }), answer(checkGood([0])));
      const r = await fix(['i2']);
      assert.equal(r.resolved, undefined);
      assert.match(state('i2').resolution, /^Fixed by AI in revision/);
    });
  });

  test('a cited formula block does not merge the blocks after it: the fix model sees every block and can change a later one', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', `Intro.\n\n${FORMULA}\n\nSecondo paragrafo.\n\nTerzo paragrafo.`, { citations: { '0': ['n1'], '1': ['n1'], '2': ['n1'] } });
    issue('i1', { quote: 'Secondo paragrafo.' });
    fake.next(patchAnswer({ changes: [{ block: 2, text: 'Secondo corretto. [[n1]]' }] }), answer(checkGood([2])));
    const r = await fix(['i1']);
    assert.match(fake.calls[0].prompt, /\[B0\][\s\S]*\[B1\]\n:::formula[\s\S]*\[B2\]\nSecondo paragrafo\.[\s\S]*\[B3\]\nTerzo paragrafo\./);
    assert.equal(r.status, 'current');
    assert.deepEqual(r.reverted, []);
    assert.match(head().markdown, /Secondo corretto\.\n\nTerzo paragrafo\./);
  });

  test('the head changed while the model ran: the fix stays a proposal and the issue is proposed', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    issue('i1');
    fake.next(() => {
      ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = 's1'`);
      seedRevision('s1', 'Testo dell\'autrice.');
      return { text: patchText({ changes: [{ block: 0, text: 'Testo AI.' }] }), usage: usageOf(1, 1) };
    }, answer(checkGood([0])));
    const r = await fix(['i1']);
    assert.equal(r.status, 'proposal');
    assert.equal(head().markdown, 'Testo dell\'autrice.');
    assert.deepEqual(state('i1'), { status: 'proposed', resolution: `Proposal ${r.revId}` });
  });

  test('an author instruction is a proposal, is not checked, and survives a later applied fix', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    issue('i1');
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo con istruzione.' }] }));
    const p = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', instruction: 'riscrivi' }));
    assert.equal(p.status, 'proposal');
    assert.equal(fake.calls.length, 1, 'no check for an instruction');
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo corretto.' }] }), answer(checkGood([0])));
    const r = await fix(['i1']);
    assert.equal(r.status, 'current');
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', p.revId!)!.status, 'proposal');
  });

  test('deleting a formula block is reverted: the other change is applied, the issue in the formula stays open; with nothing left, nothing is stored', async () => {
    seedOutline([['c1', ['s1']]]);
    const base = seedRevision('s1', `Intro.\n\n${FORMULA}\n\nFine.`);
    issue('i1', { quote: 'Intro.' });
    issue('i2', { quote: '$$x=1$$' });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Introduzione.' }, { block: 1, text: '' }] }), answer(checkGood([0], 2)));
    const r = await fix(['i1', 'i2']);
    assert.equal(r.status, 'current');
    assert.equal(head().markdown, `Introduzione.\n\n${FORMULA}\n\nFine.`);
    assert.equal(state('i1').status, 'fixed');
    assert.deepEqual(state('i2'), { status: 'open', resolution: 'The AI fix was not applied: it would delete a heading, a formula or another special block' });
    assert.equal(r.reverted!.length, 1);

    // Only the deletion is proposed: nothing is committed.
    const revisions = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_revisions')!.n;
    const n = revisions();
    issue('i3', { quote: '$$x=1$$' });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 1, text: '' }] }));
    const none = await fix(['i3']);
    assert.equal(none.skipped, 'no change survived the checks');
    assert.equal(revisions(), n);
    assert.equal(state('i3').status, 'open');
    assert.match(state('i3').resolution, /^The AI fix was not applied: /);
    assert.equal(fake.calls.length, 3, 'no check when nothing is left to check');
    assert.notEqual(base, head().id);
  });

  test('other guards: a moved formula key, a broken fence and more than 3 deletions', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', `A.\n\n${FORMULA}\n\nB.\n\nC.\n\nD.\n\nE.`);
    issue('i1', { quote: 'A.' });
    fake.next(patchAnswer({ figures: [], changes: [
      { block: 1, text: ':::formula{key="altro" label="L"}\n$$x=1$$\n:::' },
      { block: 0, text: ':::note\nA.' },
      { block: 2, text: '' }, { block: 3, text: '' }, { block: 4, text: '' }, { block: 5, text: '' },
    ] }), answer(checkGood([2, 3, 4], 1)));
    const r = await fix(['i1']);
    assert.deepEqual(r.reverted!.map((x: string) => x.replace(/"[^"]*"/, '"k"')), ['it drops the formula "k"', 'it leaves a ::: fence open', 'it would delete more than 3 blocks']);
    assert.equal(head().markdown, `A.\n\n${FORMULA}\n\nE.`);
  });

  test('a change that breaks KaTeX is reverted and its issue stays open', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Vale $x+1$ qui.\n\nAltro $y$.');
    issue('i1', { quote: 'Vale $x+1$ qui.' });
    issue('i2', { quote: 'Altro $y$.' });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Vale $\\frac{1}{$ qui.' }, { block: 1, text: 'Altro $z$.' }] }), answer(checkGood([1], 2)));
    const r = await fix(['i1', 'i2']);
    assert.equal(head().markdown, 'Vale $x+1$ qui.\n\nAltro $z$.');
    assert.equal(state('i2').status, 'fixed');
    assert.deepEqual(state('i1'), { status: 'open', resolution: 'The AI fix was not applied: it introduces a formula or formatting error' });
    assert.equal(r.reverted!.length, 1);
  });

  test('a harmful verdict reverts the change and leaves the issue open; an unresolved issue stays open with the reason', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Uno.\n\nDue.\n\nTre.');
    issue('i1', { quote: 'Uno.' });
    issue('i2', { quote: 'Due.' });
    issue('i3', { quote: 'Tre.' });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Uno falso.' }, { block: 1, text: 'Due bis.' }, { block: 2, text: 'Tre bis.' }] }), answer({
      changes: [{ block: 0, verdict: 'harmful', reason: 'afferma il falso' }, { block: 1, verdict: 'good', reason: '' }, { block: 2, verdict: 'good', reason: '' }],
      issues: [{ index: 1, fixed: true, reason: '' }, { index: 2, fixed: true, reason: '' }, { index: 3, fixed: false, reason: 'il problema resta' }],
    }));
    const r = await fix(['i1', 'i2', 'i3']);
    assert.equal(head().markdown, 'Uno.\n\nDue bis.\n\nTre bis.');
    assert.deepEqual(state('i1'), { status: 'open', resolution: 'The AI fix was not applied: the check found it harmful (afferma il falso)' });
    assert.equal(state('i2').status, 'fixed');
    assert.deepEqual(state('i3'), { status: 'open', resolution: 'The AI fix did not resolve it: il problema resta' });
    assert.equal(r.reverted!.length, 1);

    // Everything judged harmful: nothing is committed.
    seedOutline([['c1', ['s1']]]);
    const cur = head().id;
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Uno peggio.' }] }), answer({ figures: [], changes: [{ block: 0, verdict: 'harmful', reason: 'errore' }], issues: [{ index: 1, fixed: false, reason: 'no' }] }));
    const none = await fix(['i1']);
    assert.equal(none.skipped, 'no change survived the checks');
    assert.equal(head().id, cur);
    assert.match(state('i1').resolution, /harmful/);
  });

  test('when the check cannot run the guards decide, and the result says so', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    issue('i1');
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo corretto.' }] }), () => new TaskError('rete assente', 'temporary'));
    const r = await fix(['i1']);
    assert.equal(r.status, 'current');
    assert.equal(r.checked, false);
    assert.equal(state('i1').status, 'fixed');
  });

  test('a fix that removes more than a fifth of the text is a proposal, unless the issue is about repetition', async () => {
    seedOutline([['c1', ['s1']]]);
    const long = (w: string) => `${w} `.repeat(30).trim();
    seedRevision('s1', [long('uno'), long('due'), long('tre'), long('quattro'), long('cinque')].join('\n\n'));
    issue('i1');
    fake.next(patchAnswer({ figures: [], changes: [{ block: 1, text: '' }, { block: 2, text: '' }] }), answer(checkGood([1, 2])));
    const r = await fix(['i1']);
    assert.equal(r.status, 'proposal');
    assert.equal(head().markdown.includes('due'), true, 'the text is unchanged');
    assert.deepEqual(state('i1'), { status: 'proposed', resolution: `Proposal ${r.revId}` });

    issue('i2', { category: 'repetition' });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 1, text: '' }, { block: 2, text: '' }] }), answer(checkGood([1, 2])));
    const again = await fix(['i2']);
    assert.equal(again.status, 'current');
    assert.equal(state('i2').status, 'fixed');
  });
});

describe('the review converges', () => {
  const finding = (o: Record<string, unknown> = {}) => ({ sectionId: 's1', severity: 'major', category: 'correctness', quote: 'Una frase.', message: 'Poco chiara', suggestion: 'Riscrivi', ...o });
  const review = () => chapterReview(ctx, startTask('chapter.review', { chapterId: 'c1' }));

  test('the prompt carries decided and fixed issues and marks changed and unchanged sections', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    const r1 = seedRevision('s1', 'Una frase.');
    const r2 = seedRevision('s2', 'Altro testo.');
    fake.next(answer({ issues: [] }));
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    assert.equal(first.reviewed, [r1, r2].sort().join(','));
    assert.match(fake.calls[0].prompt, /full review: review all of the text/);
    assert.doesNotMatch(fake.calls[0].prompt, /ALREADY FIXED|DECIDED ARE FINE/);

    const old = { project_id: P, source: 'review', severity: 'major', category: 'clarity', suggestion: '', resolution: '', created_at: now() };
    ctx.db.insert('review_issues', { ...old, id: 'd1', node_id: 's1', quote: 'Frase scelta', message: 'Preferirei un altro ordine', status: 'dismissed' });
    ctx.db.insert('review_issues', { ...old, id: 'a1', node_id: 's2', quote: 'Altro', message: 'Ipotesi mancante', status: 'accepted' });
    ctx.db.insert('review_issues', { ...old, id: 'f1', node_id: 's1', quote: 'x'.repeat(300), message: 'm'.repeat(300), status: 'fixed' });
    // s1 changes, s2 does not.
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Una frase nuova.');
    fake.next(answer({ issues: [] }));
    await review();
    const prompt = fake.calls[1].prompt;
    assert.match(prompt, /only the passages below are new or rewritten[\s\S]*--- \[s1\] ---\nUna frase nuova\./);
    assert.doesNotMatch(prompt, /--- \[s2\] ---/);
    assert.match(prompt, /DECIDED ARE FINE[\s\S]*"Frase scelta" Preferirei un altro ordine/);
    assert.match(prompt, /"Altro" Ipotesi mancante/);
    assert.match(prompt, /ALREADY FIXED[\s\S]*"x{120}" m{200}\n/);
    assert.doesNotMatch(prompt, /x{121}|m{201}/);
    assert.match(fake.calls[1].system ?? '', /report each problem once/);
  });

  test('an issue whose quote matches one the author dismissed or accepted is not stored again; stale proposed issues are cleaned, live ones stay', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.');
    const base = { project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'clarity', quote: '', message: 'm', suggestion: '', created_at: now() };
    ctx.db.insert('review_issues', { ...base, id: 'd1', quote: 'Una   frase.\nIntera', status: 'dismissed', resolution: '' });
    const live = seedRevision('s1', 'Proposta', { status: 'proposal' });
    ctx.db.insert('review_issues', { ...base, id: 'p-live', status: 'proposed', resolution: `Proposal ${live}` });
    ctx.db.insert('review_issues', { ...base, id: 'p-stale', status: 'proposed', resolution: 'Proposal gone' });
    fake.next(answer({ issues: [finding({ quote: 'Una frase.' }), finding({ quote: 'Un altro punto.', message: 'Altro' })] }));
    const r = await review();
    assert.equal(r.issues, 1);
    assert.deepEqual(issues(`source = 'review' AND status = 'open'`).map((i) => i.quote), ['Un altro punto.']);
    assert.deepEqual(issues(`id IN ('p-live', 'p-stale')`).map((i) => i.id), ['p-live']);
  });

  test('a re-review only reports and replaces issues in the passages written since the last review', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    const r1 = seedRevision('s1', 'Primo blocco.\n\nSecondo blocco.');
    seedRevision('s2', 'Altro testo.');
    fake.next(answer({ issues: [
      finding({ sectionId: 's1', quote: 'Primo blocco.', message: 'Resta' }),
      finding({ sectionId: 's1', quote: 'Secondo blocco.', message: 'Riletto' }),
      finding({ sectionId: 's2', severity: 'blocker', quote: 'Altro testo.', message: 'Errato' }),
    ] }), answer({ findings: [] }));
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    assert.equal(first.issues, 3);
    // Only the second block of s1 is rewritten. The reviewer still reports old passages; they are ignored.
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Primo blocco.\n\nSecondo blocco riscritto.');
    fake.next(answer({ issues: [
      finding({ sectionId: 's1', quote: 'Secondo blocco riscritto.', message: 'Nuovo' }),
      finding({ sectionId: 's1', quote: 'Primo blocco.', message: 'Trovato solo ora' }),
      finding({ sectionId: 's2', severity: 'blocker', quote: 'Altro testo.', message: 'Altro blocker' }),
    ] }), answer({ findings: [] }));
    const second = await review();
    assert.match(fake.calls[2].prompt, /--- \[s1\] ---\nSecondo blocco riscritto\.\n/);
    assert.equal(second.issues, 1);
    assert.equal(second.outOfScope, 2);
    // "Riletto" pointed at a passage that no longer exists; the open issues on unchanged passages stay.
    assert.deepEqual(issues(`source = 'review' AND status = 'open'`).map((i) => i.message).sort(), ['Errato', 'Nuovo', 'Resta']);
  });

  test('a re-review with no new passages does not call the reviewer', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Primo blocco.\n\nSecondo blocco.');
    fake.next(answer({ issues: [] }));
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    // A new revision that only drops a block: nothing new to read.
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Primo blocco.');
    const second = await review();
    assert.equal(fake.calls.length, 1);
    assert.equal(second.issues, 0);
  });

  test('the first review reports minors, a review of changed text asks for blockers and majors and drops any minor before the second opinion', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Una frase.\n\nSimbolo sbagliato.');
    fake.next(answer({ issues: [finding({ quote: 'Simbolo sbagliato.', severity: 'minor', message: 'Simbolo diverso dall\'enunciato' })] }), answer({ findings: [{ index: 1, verdict: 'real', severity: 'minor', reason: '' }] }));
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    assert.equal(first.issues, 1, 'the first review reports a minor');
    assert.doesNotMatch(fake.calls[0].prompt, /Report only blockers and majors/);
    assert.match(fake.calls[0].prompt, /Minor: only a wrong word, symbol, unit or reference that could mislead/);

    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Una frase.\n\nSimbolo riscritto.\n\nNuovo passo.');
    fake.next(answer({ issues: [
      finding({ quote: 'Simbolo riscritto.', severity: 'minor', message: 'Minore' }),
      finding({ quote: 'Nuovo passo.', severity: 'major', message: 'Maggiore' }),
    ] }), answer({ findings: [{ index: 1, verdict: 'real', severity: 'major', reason: '' }] }));
    const second = await review();
    assert.match(fake.calls[2].prompt, /Report only blockers and majors/);
    assert.deepEqual([second.issues, second.minorsDropped], [1, 1]);
    assert.match(fake.calls[3].prompt, /\[major\] "Nuovo passo\." Maggiore/);
    assert.doesNotMatch(fake.calls[3].prompt, /Minore/);
    // A full review keeps reporting everything.
    fake.next(answer({ issues: [finding({ quote: 'Nuovo passo.', severity: 'minor', message: 'Minore ancora' })] }), answer({ findings: [{ index: 1, verdict: 'real', severity: 'minor', reason: '' }] }));
    const full = await chapterReview(ctx, startTask('chapter.review', { chapterId: 'c1', mode: 'full' }));
    assert.equal(full.issues, 1);
  });

  test('a review of changed text sends the changed section in full, the others as summaries, and the evidence of the changed section only', async () => {
    const ids = ['s1', 's2', 's3', 's4'];
    seedOutline([['c1', ids]]);
    const heads = new Map<string, string>();
    const bodies = new Map<string, string>();
    const runId = newId();
    ctx.db.insert('runs', { id: runId, project_id: P, kind: 'generate', status: 'completed', snapshot: {}, created_at: now() });
    for (const id of ids) {
      const body = Array.from({ length: 12 }, (_, k) => `Paragrafo ${k} della sezione ${id}: ${'testo lungo '.repeat(40)}`).join('\n\n');
      bodies.set(id, body);
      heads.set(id, seedRevision(id, body));
      ctx.db.insert('evidence_packets', { id: newId(), project_id: P, node_id: id, provider: 'local', query: 'q', answer: '', notes: Array.from({ length: 8 }, (_, k) => ({ id: `n${k}`, quote: `Citazione ${id} ${k} ${'fonte '.repeat(60)}`, resourceId: null, page: null, url: 'https://x.example', verified: true, claim: '' })), created_at: now() });
      ctx.db.insert('tasks', { id: newId(), run_id: runId, project_id: P, kind: 'section.draft', label: 'd', key: `draft:${id}`, input: { nodeId: id }, state: 'succeeded', result: { summary: `Riassunto di ${id}.` }, pool: 'writer', attempts: 1, max_attempts: 3, created_at: now(), finished_at: now() });
    }
    fake.next(answer({ issues: [] }));
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, heads.get('s2')!);
    seedRevision('s2', bodies.get('s2')!.replace('Paragrafo 3', 'Paragrafo tre'));
    fake.next(answer({ issues: [] }));
    await review();
    const [a, b] = [fake.calls[0], fake.calls[1]].map((c) => (c.system ?? '').length + c.prompt.length);
    const prompt = fake.calls[1].prompt;
    assert.match(prompt, /=== \[s1\] Sezione 1\.1 \(reviewed before, summary only\) ===\nRiassunto di s1\./);
    assert.doesNotMatch(prompt, /Paragrafo 5 della sezione s1/);
    assert.match(prompt, /Paragrafo 5 della sezione s2/);
    assert.match(prompt, /Citazione s2 3/);
    assert.doesNotMatch(prompt, /Citazione s1 3|Citazione s3 3/);
    assert.ok(b < a / 2, `the second prompt (${b}) is less than half the first (${a})`);
  });

  test('a round that leaves no blocker or major says so, in the task result and in the project summary the Review screen reads', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Una frase.\n\nAltro blocco.');
    assert.equal(getProjectSummary(ctx, P).review, null, 'nothing reviewed yet');
    fake.next(answer({ issues: [finding({ severity: 'major' })] }), answer({ findings: [{ index: 1, verdict: 'real', severity: 'major', reason: '' }] }));
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    assert.deepEqual([first.clean, first.openSerious], [false, 1]);
    assert.equal(getProjectSummary(ctx, P).review!.clean, false);
    assert.equal(getProjectSummary(ctx, P).review!.openSerious, 1);

    // The author fixes the issue by hand. The next review reads the new text and finds nothing.
    ctx.db.run(`UPDATE review_issues SET status = 'fixed' WHERE source = 'review'`);
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Una frase corretta.\n\nAltro blocco.');
    assert.equal(getProjectSummary(ctx, P).review!.clean, false, 'changed text has not been reviewed');
    fake.next(answer({ issues: [] }));
    const second = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review' AND state = 'running'`, now(), JSON.stringify(second));
    assert.deepEqual([second.clean, second.openSerious], [true, 0]);
    assert.deepEqual(getProjectSummary(ctx, P).review, { clean: true, openSerious: 0, reviewedAt: getProjectSummary(ctx, P).review!.reviewedAt });

    // A blocker from another source, or text written after the review, ends it.
    ctx.db.insert('review_issues', { id: 'lint1', project_id: P, node_id: 's1', source: 'lint', severity: 'blocker', category: 'katex', quote: '', message: 'm', suggestion: '', status: 'open', resolution: '', created_at: now() });
    assert.equal(getProjectSummary(ctx, P).review!.clean, false);
    ctx.db.run(`UPDATE review_issues SET status = 'accepted' WHERE id = 'lint1'`);
    assert.equal(getProjectSummary(ctx, P).review!.clean, true);
    assert.equal((await review()).clean, true, 'a review with no new text reports it too');
  });

  test('the reviewer cannot raise the style categories, and issues stored with them still load', () => {
    assert.equal(reviewSchema.safeParse({ issues: [{ sectionId: 's1', quote: 'q', severity: 'minor', category: 'clarity', message: 'm', suggestion: 's' }] }).success, false);
    assert.equal(reviewSchema.safeParse({ issues: [{ sectionId: 's1', quote: 'q', severity: 'minor', category: 'repetition', message: 'm', suggestion: 's' }] }).success, false);
    assert.equal(reviewSchema.safeParse({ issues: [{ sectionId: 's1', quote: 'q', severity: 'major', category: 'correctness', message: 'm', suggestion: 's' }] }).success, true);
    seedOutline([['c1', ['s1']]]);
    ctx.db.insert('review_issues', { id: 'old1', project_id: P, node_id: 's1', source: 'review', severity: 'minor', category: 'clarity', quote: 'q', message: 'm', suggestion: '', status: 'open', resolution: '', created_at: now() });
    ctx.db.insert('review_issues', { id: 'old2', project_id: P, node_id: 's1', source: 'review', severity: 'minor', category: 'repetition', quote: 'q', message: 'm', suggestion: '', status: 'fixed', resolution: '', created_at: now() });
    assert.deepEqual(listIssues(ctx, P).map((i) => i.category), ['clarity', 'repetition']);
  });

  test('Run review no longer forces: identical text is reused, changed text is read again', async () => {
    parkQueue();
    seedOutline([['c1', ['s1']]]);
    const h = seedRevision('s1', 'Una frase.');
    const run = startRun(ctx, P, 'review');
    const tasks = ctx.db.all<{ input: string }>('SELECT input FROM tasks WHERE run_id = ?', run.id);
    assert.deepEqual(tasks.map((x) => json(x.input, {})), [{ chapterId: 'c1' }]);
    fake.next(answer({ issues: [] }));
    await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review' AND state = 'running'`, now(), JSON.stringify({ reviewed: h }));
    const again = await review();
    assert.equal(again.reused, true);
    assert.equal(fake.calls.length, 1);
  });
});

describe('second opinion, full review and recheck', () => {
  const finding = (o: Record<string, unknown> = {}) => ({ sectionId: 's1', severity: 'blocker', category: 'correctness', quote: 'Una frase.', message: 'Errore', suggestion: 'Correggi', ...o });
  const opinion = (...v: [string, string][]) => answer({ findings: v.map(([verdict, severity], k) => ({ index: k + 1, verdict, severity, reason: verdict === 'not-real' ? 'Il testo lo dice già.' : '' })) });
  const review = (input: Record<string, unknown> = {}) => chapterReview(ctx, startTask('chapter.review', { chapterId: 'c1', ...input }));
  const done = (r: unknown) => ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review' AND state = 'running'`, now(), JSON.stringify(r));

  test('a finding the second opinion calls not real is stored as dismissed; severity can go down, never up', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.\n\nUn altro passo.\n\nTerzo passo.');
    fake.next(
      answer({ issues: [finding(), finding({ quote: 'Un altro passo.', message: 'Pedante' }), finding({ quote: 'Terzo passo.', severity: 'minor', message: 'Piccolo' })] }),
      opinion(['real', 'blocker'], ['not-real', 'minor'], ['real', 'blocker']),
    );
    const r = await review();
    assert.deepEqual([r.issues, r.dropped, r.lowered, r.checked], [2, 1, 0, true]);
    assert.match(fake.calls[1].system ?? '', /also invent problems/);
    assert.match(fake.calls[1].prompt, /1\. \[s1\] \[blocker\] "Una frase\." Errore/);
    assert.deepEqual(issues(`source = 'review'`).map((i) => [i.message, i.severity, i.status]), [
      ['Errore', 'blocker', 'open'], ['Piccolo', 'minor', 'open'], ['Pedante', 'blocker', 'dismissed'],
    ]);
    assert.match(issues(`status = 'dismissed'`)[0].resolution, /^Second opinion: not a real problem\. Il testo lo dice già\./);
  });

  test('a lowered severity is stored; a failed second opinion keeps every finding', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.');
    fake.next(answer({ issues: [finding()] }), opinion(['real', 'minor']));
    assert.equal((await review({ force: true })).lowered, 1);
    assert.equal(issues(`status = 'open'`)[0].severity, 'minor');
    fake.next(answer({ issues: [finding()] }), () => new Error('boom'));
    const r = await review({ force: true });
    assert.deepEqual([r.issues, r.checked], [1, false]);
    assert.equal(issues(`status = 'open'`)[0].severity, 'blocker');
  });

  test('a full review reads each section on its own call, even when the text did not change', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    const r1 = seedRevision('s1', 'Prima sezione.');
    const r2 = seedRevision('s2', 'Seconda sezione.');
    fake.next(answer({ issues: [] }));
    done(await review());
    fake.next(answer({ issues: [finding({ sectionId: 'c1', quote: 'Prima sezione.' })] }), answer({ issues: [] }), opinion(['real', 'blocker']));
    const r = await review({ mode: 'full' });
    assert.equal(r.reviewed, [r1, r2].sort().join(','));
    const [one, two] = [fake.calls[1].prompt, fake.calls[2].prompt];
    assert.match(one, /Prima sezione\./); assert.doesNotMatch(one, /Seconda sezione\./);
    assert.match(two, /Seconda sezione\./); assert.doesNotMatch(two, /Prima sezione\./);
    assert.match(one, /full review of one section/);
    // A finding the model filed under another id belongs to the section it was reading.
    assert.deepEqual(issues(`status = 'open'`).map((i) => i.node_id), ['s1']);
  });

  test('the second opinion reads the sections its findings are in; a finding filed under no section goes with the section that holds its quote', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', 'Prima sezione.');
    seedRevision('s2', 'Seconda sezione.');
    fake.next(answer({ issues: [finding({ sectionId: 'inventato', quote: 'Seconda sezione.' })] }), opinion(['real', 'blocker']));
    await review();
    assert.match(fake.calls[1].prompt, /Seconda sezione\./);
    assert.doesNotMatch(fake.calls[1].prompt, /Prima sezione\./);
  });

  test('recheck gives open issues a second opinion without a new review, and the next review still compares with the last one', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Una frase.\n\nUn altro passo.');
    fake.next(answer({ issues: [finding(), finding({ quote: 'Un altro passo.', message: 'Pedante' })] }), answer({ findings: [] }));
    done(await review());
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Una frase.\n\nUn altro passo.\n\nNuovo passo.');
    fake.next(opinion(['real', 'major'], ['not-real', 'blocker']));
    const r = await review({ mode: 'recheck' });
    done(r);
    assert.deepEqual([r.rechecked, r.dropped, r.lowered, r.reviewed], [2, 1, 1, r1]);
    assert.equal(fake.calls.length, 3, 'one call, no reviewer call');
    assert.match(fake.calls[2].system ?? '', /also invent problems/);
    assert.deepEqual(issues(`source = 'review'`).map((i) => [i.message, i.severity, i.status]), [['Errore', 'major', 'open'], ['Pedante', 'blocker', 'dismissed']]);
    fake.next(answer({ issues: [] }));
    await review();
    assert.match(fake.calls[3].prompt, /--- \[s1\] ---\nNuovo passo\./);
  });

  test('a review run can ask for a full review or a recheck', () => {
    parkQueue();
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.');
    const tasks = (mode?: 'full' | 'recheck') => ctx.db.all<{ input: string; label: string }>('SELECT input, label FROM tasks WHERE run_id = ?', startRun(ctx, P, 'review', mode ? { reviewMode: mode } : {}).id);
    assert.deepEqual(tasks('full').map((x) => [json(x.input, {}), x.label]), [[{ chapterId: 'c1', mode: 'full' }, 'Full review "Capitolo 1"']]);
    assert.deepEqual(tasks('recheck').map((x) => json(x.input, {})), [{ chapterId: 'c1', mode: 'recheck' }]);
  });

  test('fixes for issues ask for the smallest edit; author instructions do not', () => {
    const base = { language: 'it', blocks: '[B0]\nx', requests: '1. y', evidence: '', knownFormulas: '', sectionIds: '' };
    assert.match(patchPrompt({ ...base, minimal: true }).system, /smallest edit/);
    assert.doesNotMatch(patchPrompt(base).system, /smallest edit/);
  });
});

describe('r7. section-scoped generation', () => {
  beforeEach(parkQueue);
  const keys = (specs: { key: string }[]) => specs.map((s) => s.key);

  test('only the requested section is drafted; the chapter extras wait until the rest of the chapter is written; no gate', () => {
    seedOutline([['c1', ['s1', 's2']], ['c2', ['s3']]]);
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ firstChapterGate: true }), P);
    // s2 is not written, so asking for s1 does not trigger the chapter's extras.
    assert.deepEqual(keys(generateSpecs(ctx, P, undefined, ['s1'])), ['evidence:s1', 'draft:s1']);
    // s3 is the whole of its chapter: its extras follow, without waiting for chapter 1 or a gate.
    const specs = generateSpecs(ctx, P, undefined, ['s3']);
    assert.deepEqual(keys(specs), ['evidence:s3', 'draft:s3', 'intro:c2', 'practice:c2', 'enrich:c2', 'review:c2']);
    assert.ok(specs.every((s) => !(s.deps ?? []).includes('gate:first-chapter')));
    assert.ok(!specs.some((s) => s.kind === 'gate' || s.kind === 'practice.done'));
    assert.deepEqual(specs.find((s) => s.key === 'practice:c2')!.deps, ['draft:s3']);
  });

  test('a chapter whose other sections are already written gets its extras after the requested draft', () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s2', 'Già scritta.');
    const specs = generateSpecs(ctx, P, undefined, ['s1']);
    assert.deepEqual(keys(specs), ['evidence:s1', 'draft:s1', 'intro:c1', 'practice:c1', 'enrich:c1', 'review:c1']);
    assert.deepEqual(specs.find((s) => s.key === 'intro:c1')!.deps, ['draft:s1']);
    // Both sections asked: both drafts, one set of extras.
    assert.deepEqual(keys(generateSpecs(ctx, P, undefined, ['s1', 's2'])), ['evidence:s1', 'draft:s1', 'evidence:s2', 'draft:s2', 'intro:c1', 'practice:c1', 'enrich:c1', 'review:c1']);
    // The chapter id asks for its introduction.
    assert.ok(keys(generateSpecs(ctx, P, undefined, ['c1'])).includes('intro:c1'));
  });

  test('startRun forwards nodeIds, shares an in-flight draft instead of duplicating it, and rejects unknown sections', () => {
    seedOutline([['c1', ['s1']], ['c2', ['s2']]]);
    const run = startRun(ctx, P, 'generate', { nodeIds: ['s2'] });
    assert.deepEqual(taskKeys(run.id), ['evidence:s2', 'draft:s2', 'intro:c2', 'practice:c2', 'enrich:c2', 'review:c2']);
    assert.equal(startRun(ctx, P, 'generate', { nodeIds: ['s2'] }).id, run.id);
    assert.throws(() => startRun(ctx, P, 'generate', { nodeIds: ['nope'] }), (e: any) => e.status === 409 && e.code === 'empty_scope');
    // The whole-book run is a different run.
    const book = startRun(ctx, P, 'generate');
    assert.notEqual(book.id, run.id);
    assert.ok(taskKeys(book.id).includes('draft:s1'));
  });
});

describe('r8. excluded sources stop counting', () => {
  const examsIn = (resource: string, group: string, topic: string, extra: Record<string, unknown> = {}) =>
    q({ kind: 'exam', origin: 'authentic', resource_id: resource, exam_group: group, number: '1', topic_ids: [topic], exam_date: '2024-01-01', ...extra });

  test('classification, priorities and practice candidates use only included sources whose role holds questions', async () => {
    const t = `${P.slice(0, 8)}-limiti`;
    ctx.db.insert('topics', { id: t, project_id: P, name: 'Limiti', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'normal' });
    seedResource(ctx, { projectId: P, id: 'in', role: 'exams' });
    seedResource(ctx, { projectId: P, id: 'out', role: 'exams', included: 0 });
    seedResource(ctx, { projectId: P, id: 'wrong', role: 'theory' });
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    ctx.db.run('INSERT INTO source_indexes (resource_id, origin, entries) VALUES (?, ?, ?)', 'theory1', 'extracted', JSON.stringify([{ title: 'Argomenti', level: 1, page: 0 }]));

    // Classification only sees included exam sources (and generated questions are not authentic exams).
    const keep = q({ kind: 'exam', origin: 'authentic', resource_id: 'in', exam_group: 'S1', number: '1', statement: 'DENTRO' });
    const gone = q({ kind: 'exam', origin: 'authentic', resource_id: 'out', exam_group: 'S2', number: '1', statement: 'ESCLUSO' });
    const wrong = q({ kind: 'exam', origin: 'authentic', resource_id: 'wrong', exam_group: 'S3', number: '1', statement: 'RUOLO' });
    fake.next(answer({ items: [{ id: keep, topics: ['limiti'], difficulty: 'medio' }] }));
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.ok(fake.calls.at(-1)!.prompt.includes('DENTRO'));
    assert.ok(!fake.calls.at(-1)!.prompt.includes('ESCLUSO') && !fake.calls.at(-1)!.prompt.includes('RUOLO'));
    assert.equal(row(gone).topic_ids, '[]');
    assert.equal(row(wrong).topic_ids, '[]');

    // Frequency: two sessions in an excluded source do not make the topic hot.
    ctx.db.run('DELETE FROM questions');
    examsIn('in', 'S1', t);
    examsIn('out', 'S2', t); examsIn('out', 'S3', t); examsIn('wrong', 'S4', t);
    computePriorities(ctx, P);
    assert.equal(ctx.db.get<Record<string, any>>('SELECT exam_sessions AS n FROM topics WHERE id = ?', t)!.n, 1);
    ctx.db.run(`UPDATE resources SET included = 1 WHERE id = 'out'`);
    computePriorities(ctx, P);
    assert.equal(ctx.db.get<Record<string, any>>('SELECT exam_sessions AS n FROM topics WHERE id = ?', t)!.n, 3);

    // Practice candidates.
    ctx.db.run(`UPDATE resources SET included = 0 WHERE id = 'out'`);
    ctx.db.run('DELETE FROM questions');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    const ok = examsIn('in', 'S1', t);
    const bad = examsIn('out', 'S2', t);
    const bad2 = examsIn('wrong', 'S3', t);
    const generated = q({ kind: 'exam', origin: 'authentic', resource_id: null, exam_group: 'S9', number: '1', topic_ids: [t] });
    const task = startTask('chapter.practice', { chapterId: 'c1' });
    await chapterPractice(ctx, task);
    assert.equal(row(ok).chapter_id, 'c1');
    assert.equal(row(generated).chapter_id, 'c1', 'questions without a source are unaffected');
    assert.equal(row(bad).chapter_id, null);
    assert.equal(row(bad2).chapter_id, null);

    // The writer's session count agrees with the exam guide's.
    ctx.db.run(`UPDATE resources SET included = 0 WHERE id = 'out'`);
    ctx.db.run('DELETE FROM questions');
    examsIn('in', 'S1', t); examsIn('out', 'S2', t); examsIn('out', 'S3', t);
    const [d1] = [newId()];
    seedOutline([['c1', [d1]]], { topicIds: [t] });
    fake.next(written({ markdown: 'Un paragrafo.', figures: [], noFigureReason: 'nessuna', summary: 's' }));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: d1 }));
    assert.match(fake.calls.at(-1)!.prompt, /Limiti: \d+ of 1 exam sessions/);
  });
});

describe('r11. chapter-level review findings do not accumulate', () => {
  test('a second review replaces the open chapter-level finding; resolved history stays; a clean review leaves none open', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    const finding = { sectionId: 'unknown', severity: 'major', category: 'coverage', quote: '', message: 'Manca un obiettivo', suggestion: 'Aggiungilo' };
    const task = () => startTask('chapter.review', { chapterId: 'c1', force: true });
    const real = answer({ findings: [{ index: 1, verdict: 'real', severity: 'major', reason: '' }] });
    fake.next(answer({ issues: [finding] }), real, answer({ issues: [finding] }), real, answer({ issues: [] }));
    await chapterReview(ctx, task());
    assert.equal(issues(`source = 'review' AND node_id = 'c1'`).length, 1);
    // Resolved history stays across reviews.
    ctx.db.insert('review_issues', { id: 'old', project_id: P, node_id: 'c1', source: 'review', severity: 'major', category: 'coverage', message: 'vecchio', status: 'dismissed', resolution: 'ok', created_at: now() });
    await chapterReview(ctx, task());
    assert.deepEqual(issues(`source = 'review' AND node_id = 'c1'`).map((i) => i.status).sort(), ['dismissed', 'open']);
    await chapterReview(ctx, task());
    assert.deepEqual(issues(`source = 'review' AND node_id = 'c1'`).map((i) => i.status), ['dismissed']);
  });
});

describe('author-set topic priority', () => {
  test('survives priority recomputation', async () => {
    const { computePriorities } = await import('./prepare.ts');
    const { updateTopic } = await import('../repo/resources.ts');
    const id = `${P.slice(0, 8)}-locked-topic`;
    ctx.db.insert('topics', { id, project_id: P, name: 'locked', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'normal' });
    updateTopic(ctx, id, { priority: 'high' });
    computePriorities(ctx, P);
    assert.equal(ctx.db.get<{ priority: string }>('SELECT priority FROM topics WHERE id = ?', id)!.priority, 'high');
  });
});

describe('cheap check first', () => {
  test('a clean check stays on the checker; a problem goes to the reviewer for the recorded verdict', async () => {
    const a = q();
    fake.next(answer({ independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: a }));
    assert.equal(fake.calls.at(-1)!.selection.model, ctx.settings().routes.checker.primary.model);
    const before = fake.calls.length;
    const b = q();
    fake.next(answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [] }), answer({ independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: b }));
    assert.equal(fake.calls.length, before + 2);
    assert.equal(fake.calls.at(-1)!.selection.model, ctx.settings().routes.reviewer.primary.model);
    assert.deepEqual(issues(`question_id = '${b}'`), []);
  });
});

describe('a ready exercises source that gave no questions is split again by Prepare', () => {
  test('0 questions: split on the next run; some questions: kept unless forced', async () => {
    seedResource(ctx, { projectId: P, id: 'quiz1', role: 'exercises', filename: 'DBQuiz_Fisica1.pdf' });
    seedPage(ctx, 'quiz1', 0, 'Quiz fisica 1\nSolo una nota.');
    assert.deepEqual(await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'quiz1' })), { questions: 0, duplicates: 0 });
    // The same source with pages the splitter now reads (stands in for a newer splitter): Prepare splits it, no force needed.
    ctx.db.run('UPDATE pages SET text = ? WHERE resource_id = ?', '1) Primo?\na) uno\nb) due\n2) Secondo?\na) tre\nb) quattro\n3) Terzo?\na) cinque\nb) sei', 'quiz1');
    const r = await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'quiz1' }));
    assert.deepEqual(r, { questions: 3, duplicates: 0 });
    assert.deepEqual(ctx.db.all<{ kind: string; origin: string; chapter_id: string | null; topic_ids: string }>('SELECT kind, origin, chapter_id, topic_ids FROM questions').map((x) => [x.kind, x.origin, x.chapter_id, x.topic_ids].join()), Array(3).fill('exercise,authentic,,[]'));
    assert.deepEqual(await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'quiz1' })), { questions: 3, reused: true });
  });
});

describe('chemistry figures: structures and photos', () => {
  beforeEach(() => ctx.db.run('UPDATE projects SET options = ? WHERE id = ?', JSON.stringify({ subjectArea: 'chemistry', selfCheck: false }), P));
  const fig = (o: Record<string, unknown>) => ({ key: 'acqua', kind: 'structure', caption: "Struttura di Lewis dell'acqua", alt: "Molecola d'acqua", plot: null, structure: null, photo: null, levels: null, orbitals: null, cell: null, periodic: null, ...o });
  const draft = (figures: unknown[], body = ':::image{src="assets/acqua.svg" alt="x" caption="y"}\n:::') => ({
    markdown: `L'acqua ha due coppie solitarie sull'ossigeno.\n\n${body}`, figures, noFigureReason: null, summary: 'riassunto',
  });
  const current = (s: string) => ctx.db.get<{ markdown: string }>(`SELECT markdown FROM content_revisions WHERE node_id = ? AND status = 'current'`, s)!.markdown;

  test('a structure is drawn from SMILES, and its alt text gets the formula for the reviewer', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written(draft([fig({ structure: { smiles: 'O', style: 'lewis', lonePairs: true, formula: 'H2O' } })])), answer(keepFigures(1)));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    assert.equal(r.figures, 1);
    const a = ctx.db.get<{ filename: string; origin: string; alt: string; path: string }>('SELECT * FROM assets')!;
    assert.equal(a.origin, 'structure');
    assert.equal(a.filename, `${s1.slice(0, 8)}-acqua.svg`);
    assert.equal(a.alt, "Molecola d'acqua (H2O)");
    assert.match(readFileSync(resolveDataPath(ctx.config, a.path), 'utf8'), /<svg/);
    assert.match(current(s1), new RegExp(`:::image\\{src="assets/${a.filename}" alt="Molecola d'acqua \\(H2O\\)"`));
  });

  test('an invalid SMILES, a formula that does not match it or a photo without stock keys drops the figure and its block, with a note', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    const body = ':::image{src="assets/acqua.svg" alt="x" caption="y"}\n:::\n\n:::image{src="assets/ammonio.svg" alt="x" caption="y"}\n:::\n\n:::image{src="assets/fiamma.svg" alt="x" caption="y"}\n:::';
    fake.next(written(draft([
      fig({ structure: { smiles: 'not((a smiles', style: 'lewis', lonePairs: true, formula: 'H2O' } }),
      fig({ key: 'ammonio', structure: { smiles: '[NH4+]', style: 'lewis', lonePairs: true, formula: 'NH3' } }),
      fig({ key: 'fiamma', kind: 'photo', photo: { query: 'sodium flame test', mustShow: 'a yellow sodium flame' } }),
    ], body)), answer(keepFigures(3)));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    assert.equal(r.figures, 0);
    assert.equal(r.figureProblems.length, 3);
    assert.match(r.figureProblems[1], /ammonio: formula: "NH3" does not match the SMILES/);
    assert.match(r.figureProblems[2], /no stock photo service/);
    assert.doesNotMatch(current(s1), /:::image/);
    assert.equal(ctx.db.all('SELECT 1 FROM assets').length, 0);
    const { readdirSync } = await import('node:fs');
    const { paths } = await import('../config.ts');
    assert.deepEqual(readdirSync(paths.assets(ctx.config, P)), []);
  });

  test('the writer is told about photos only when a stock key is set', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written({ markdown: 'Testo.', figures: [], noFigureReason: 'Solo definizioni.', summary: 'r' }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    assert.equal(r.noFigureReason, 'Solo definizioni.');
    assert.match(fake.calls[0].system ?? '', /kind: "structure"|structure: a molecule/);
    assert.doesNotMatch(fake.calls[0].system ?? '', /photo: a stock photo/);
  });

  test('a fix for a useless figure can remove it, so the issue does not stay open for ever', async () => {
    seedOutline([['c1', ['s1']]]);
    const img = ':::image{src="assets/s1-retta.svg" alt="Retta" caption="Una retta"}\n:::';
    seedRevision('s1', `Il lavoro è proporzionale allo spostamento.\n\n${img}\n\nAltro.`);
    ctx.db.insert('review_issues', { id: 'g1', project_id: P, node_id: 's1', source: 'review', severity: 'minor', category: 'figure', quote: 'Una retta', message: 'Il grafico ripete la proporzionalità già detta nel testo.', suggestion: 'Eliminare la figura.', status: 'open', resolution: '', created_at: now() });
    fake.next(patchAnswer({ figures: [], changes: [{ block: 1, text: '' }] }), answer(checkGood([1])));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['g1'] }));
    assert.equal(r.status, 'current');
    assert.equal(current('s1'), 'Il lavoro è proporzionale allo spostamento.\n\nAltro.');
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'g1'`)!.status, 'fixed');
  });

  test('a figure issue on a drawn figure is fixed by a new "shows": the fix returns a new drawing and the image block points at it', async () => {
    seedOutline([['c1', ['s1']]]);
    const old = ':::image{src="assets/s1-partitore.svg" alt="Partitore" caption="Partitore di tensione"}\n:::';
    seedRevision('s1', `Un partitore con R1 e R2 divide la tensione.\n\n${old}\n\nAltro.`);
    ctx.db.insert('assets', { id: 'old-drawing', project_id: P, node_id: 's1', filename: 's1-partitore.svg', mime: 'image/svg+xml', path: 'none.svg', origin: 'generated-svg', spec: { kind: 'drawing', engine: 'typst', source: '#circle(radius: 4pt)', shows: 'A divider without labels.', family: 'circuit', symbols: 'american' }, caption: 'Partitore di tensione', alt: 'Partitore', checks: [], created_at: now() });
    ctx.db.insert('review_issues', { id: 'd1', project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'figure', quote: 'Partitore di tensione', message: 'La figura non mostra la tensione V2 su R2.', suggestion: 'Disegnare V2.', status: 'open', resolution: '', created_at: now() });
    const shows = 'A voltage divider: a source Vs in series with R1 and R2, the ground, and the voltage V2 across R2 drawn as an arrow.';
    fake.next(patchAnswer({
      figures: [{ ...fig({ key: 'partitore-v2', kind: 'drawing', caption: 'Partitore con V2', alt: 'Partitore con V2' }), drawing: { shows, family: 'circuit' } }],
      changes: [{ block: 1, text: ':::image{src="assets/partitore-v2.svg" alt="Partitore con V2" caption="Partitore con V2"}\n:::' }],
    }), answer(keepFigures(1)), () => ({ text: '#circle(radius: 8pt)', usage: usageOf(10, 10) }), () => ({ text: 'OK', usage: usageOf(10, 10) }), answer(checkGood([1])));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['d1'] }));
    assert.equal(r.status, 'current');
    const a = ctx.db.get<{ filename: string; origin: string; spec: string }>(`SELECT * FROM assets WHERE filename <> 's1-partitore.svg'`)!;
    assert.equal(a.origin, 'generated-svg');
    assert.equal(JSON.parse(a.spec).shows, shows);
    assert.match(current('s1'), new RegExp(`src="assets/${a.filename}"`));
    assert.doesNotMatch(current('s1'), /s1-partitore\.svg/);
    assert.equal(fake.calls[2].selection.model, 'gpt-6-sol', 'the third call is the illustrator');
    assert.match(fake.calls[2].prompt, /What the figure shows:\nA voltage divider/);
  });

  test('a fix for a problem with an existing figure can add another; an image block pointing at nothing is removed', async () => {
    seedOutline([['c1', ['s1']]]);
    const old = ':::image{src="assets/vecchia.svg" alt="Vecchia" caption="Figura vecchia"}\n:::';
    seedRevision('s1', `L'ammoniaca ha una coppia solitaria.\n\n${old}\n\nAltro.`);
    ctx.db.insert('review_issues', { id: 'f1', project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'figure', quote: 'Figura vecchia', message: "La figura non mostra l'ammoniaca", suggestion: 'Aggiungere la struttura di Lewis di NH3', status: 'open', resolution: '', created_at: now() });
    fake.next(patchAnswer({
      figures: [fig({ key: 'nh3', caption: "Struttura di Lewis dell'ammoniaca", alt: 'Ammoniaca', structure: { smiles: 'N', style: 'lewis', lonePairs: true, formula: 'NH3' } })],
      changes: [{ block: 0, text: "L'ammoniaca ha una coppia solitaria.\n\n:::image{src=\"assets/nh3.svg\" alt=\"a\" caption=\"c\"}\n:::\n\n:::image{src=\"assets/inventata.svg\" alt=\"a\" caption=\"c\"}\n:::" }],
    }), answer(keepFigures(1)), answer(checkGood([0])));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['f1'] }));
    assert.equal(r.status, 'current');
    const a = ctx.db.get<{ filename: string; origin: string }>('SELECT * FROM assets')!;
    assert.equal(a.origin, 'structure');
    const md = current('s1');
    assert.match(md, new RegExp(`src="assets/${a.filename}"`));
    assert.doesNotMatch(md, /inventata/);
    assert.match(fake.calls[0].system ?? '', /Add a figure only when a problem or the author's instruction asks for one/);
  });
});

describe('figures pass: figures for written sections, text untouched', () => {
  beforeEach(() => ctx.db.run('UPDATE projects SET options = ? WHERE id = ?', JSON.stringify({ subjectArea: 'chemistry', selfCheck: false }), P));
  const levels = {
    yLabel: 'Energia', columns: [{ label: 'Reagenti' }, { label: 'Prodotti' }],
    levels: [{ key: 'r', column: 0, energy: 0, label: 'H2 + 1/2 O2', boxes: null, electrons: null }, { key: 'p', column: 1, energy: -286, label: 'H2O', boxes: null, electrons: null }],
    links: [{ from: 'r', to: 'p', style: 'arrow', label: 'ΔH = −286 kJ' }],
  };
  const fig = (o: Record<string, unknown>) => ({ key: 'nh3', kind: 'structure', caption: "Struttura di Lewis dell'ammoniaca", alt: 'Ammoniaca', plot: null, structure: { smiles: 'N', style: 'lewis', lonePairs: true, formula: 'NH3' }, photo: null, levels: null, orbitals: null, cell: null, periodic: null, afterBlock: 1, ...o });
  const current = (s: string) => ctx.db.get<{ markdown: string; citations: string; status: string }>(`SELECT markdown, citations, status FROM content_revisions WHERE node_id = ? AND status = 'current' ORDER BY rowid DESC`, s)!;
  const keepAll = (n: number) => ({ figures: Array.from({ length: n }, (_, i) => ({ index: i + 1, keep: true, reason: 'utile' })) });

  test('inserts each kept figure after its block, keeps every word and moves citations with their blocks', async () => {
    seedOutline([['c1', ['s1']]]);
    const text = "L'ammoniaca ha una coppia solitaria.\n\nLa reazione libera calore.\n\nFine.";
    seedRevision('s1', text, { origin: 'ai', citations: { '1': ['n1'], '2': ['n2'] } });
    fake.next(answer({ figures: [fig({}), fig({ key: 'entalpia', kind: 'levels', caption: "Diagramma entalpico della formazione dell'acqua", alt: 'Diagramma', structure: null, levels, afterBlock: 2 })], noFigureReason: null }), answer(keepAll(2)));
    const r = await sectionFigures(ctx, startTask('section.figures', { nodeId: 's1' }));
    assert.equal(r.status, 'current');
    assert.equal(r.added, 2);
    const head = current('s1');
    const blocks = head.markdown.split('\n\n');
    assert.equal(blocks.length, 5);
    assert.equal(blocks[0], "L'ammoniaca ha una coppia solitaria.");
    assert.match(blocks[1], /^:::image\{src="assets\/s1-nh3\.svg" alt="Ammoniaca \(NH3\)" caption="Struttura di Lewis dell'ammoniaca"\}\n:::$/);
    assert.equal(blocks[2], 'La reazione libera calore.');
    assert.match(blocks[3], /^:::image\{src="assets\/s1-entalpia\.svg"/);
    assert.equal(blocks[4], 'Fine.');
    assert.deepEqual(json(head.citations, {}), { '2': ['n1'], '4': ['n2'] });
    const origins = ctx.db.all<{ origin: string }>('SELECT origin FROM assets ORDER BY filename').map((a) => a.origin);
    assert.deepEqual(origins, ['diagram', 'structure']);
    assert.match(fake.calls[0].system ?? '', /you do not change it/);
    assert.match(fake.calls[1].prompt, /passage: L'ammoniaca ha una coppia solitaria\.\n\nLa reazione libera calore\.\nafter the figure: Fine\./);
  });

  describe('Auto Fix sends an issue that asks for a missing figure to this pass (issue 36)', () => {
    const missing = (o: Record<string, unknown> = {}) => ctx.db.insert('review_issues', { id: 'f1', project_id: P, node_id: 's1', source: 'review', severity: 'minor', category: 'figure', quote: "L'ammoniaca ha una coppia solitaria.", message: 'Manca la struttura', suggestion: 'Struttura di Lewis di NH3', status: 'open', resolution: '', created_at: now(), ...o });
    const state = () => ({ ...ctx.db.get<{ status: string; resolution: string }>(`SELECT status, resolution FROM review_issues WHERE id = 'f1'`)! });

    test('the issue text is the brief, the text writer is not asked, and the issue closes when the figure lands', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', "L'ammoniaca ha una coppia solitaria.\n\nAltro.");
      missing();
      const fix = startTask('section.revise', { nodeId: 's1', issueIds: ['f1'] });
      assert.deepEqual(await sectionRevise(ctx, fix), { skipped: 'routed', routed: { figures: 1 } });
      assert.equal(fake.calls.length, 0, 'no text fix is requested');
      const child = ctx.db.get<{ id: string; input: string }>(`SELECT id, input FROM tasks WHERE kind = 'section.figures'`)!;
      const input = json<{ nodeId: string; issueIds: string[]; brief: string }>(child.input, {} as never);
      assert.deepEqual([input.nodeId, input.issueIds], ['s1', ['f1']]);
      assert.match(input.brief, /Manca la struttura[\s\S]*Suggested: Struttura di Lewis di NH3/);
      assert.deepEqual(ctx.db.all<{ dep_id: string }>('SELECT dep_id FROM task_deps WHERE task_id = ?', child.id).map((d) => d.dep_id), [fix.task.id], 'it starts after the text fix');
      assert.equal(state().status, 'open', 'nothing is closed before the figure lands');

      fake.next(answer({ figures: [fig({})], noFigureReason: null }), answer(keepAll(1)));
      const r = await sectionFigures(ctx, startTask('section.figures', input));
      assert.equal(r.added, 1);
      assert.match(fake.calls[0].prompt, /A REVIEW FOUND A FIGURE MISSING[\s\S]*Manca la struttura/);
      assert.match(state().resolution, /^Figure added by the figures pass in revision /);
      assert.equal(state().status, 'fixed');
    });

    test('with several issues, only the ones a surviving figure answers close', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', "L'ammoniaca ha una coppia solitaria.\n\nAltro.");
      missing();
      missing({ id: 'f2', quote: 'Altro.', message: 'Manca un secondo schema' });
      const input = { nodeId: 's1', issueIds: ['f1', 'f2'], brief: '1. Manca la struttura\n2. Manca un secondo schema' };
      fake.next(answer({ figures: [fig({ issue: 1 }), fig({ key: 'altro', issue: 2, afterBlock: 2 })], noFigureReason: null }), answer({ figures: [{ index: 1, keep: true, reason: 'utile' }, { index: 2, keep: false, reason: 'decorativa' }] }));
      const r = await sectionFigures(ctx, startTask('section.figures', input));
      assert.equal(r.added, 1);
      assert.match(fake.calls[0].prompt, /"issue"/);
      const of = (id: string) => ({ ...ctx.db.get<{ status: string; resolution: string }>('SELECT status, resolution FROM review_issues WHERE id = ?', id)! });
      assert.equal(of('f1').status, 'fixed');
      assert.equal(of('f2').status, 'open');
      assert.match(of('f2').resolution, /No figure answered this issue/);
    });

    test('when the pass proposes none, or the section is full, the issue stays open with the reason', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', "L'ammoniaca ha una coppia solitaria.\n\nAltro.");
      missing();
      const input = { nodeId: 's1', issueIds: ['f1'], brief: 'Manca la struttura' };
      fake.next(answer({ figures: [], noFigureReason: 'Il testo non descrive nulla di visibile.' }));
      await sectionFigures(ctx, startTask('section.figures', input));
      assert.deepEqual(state(), { status: 'open', resolution: 'No figure was added: Il testo non descrive nulla di visibile.' });

      const full = [1, 2, 3].map((n) => `:::image{src="assets/f${n}.svg" alt="a" caption="c${n}"}\n:::`).join('\n\n');
      ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = 's1'`);
      seedRevision('s1', `Testo.\n\n${full}`);
      await sectionFigures(ctx, startTask('section.figures', input));
      assert.match(state().resolution, /^No figure was added: the section already has 3 figures/);
    });

    test('an issue about an existing figure, one that quotes its caption, stays with the text fix', async () => {
      seedOutline([['c1', ['s1']]]);
      seedRevision('s1', `${'Il lavoro è proporzionale allo spostamento. '.repeat(10)}\n\n:::image{src="assets/f1.svg" alt="a" caption="Una retta"}\n:::`);
      missing({ quote: 'Una retta', message: 'Il grafico ripete il testo.' });
      fake.next(patchAnswer({ changes: [{ block: 1, text: '' }] }), answer(checkGood([1])));
      const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['f1'] }));
      assert.equal(r.routed, undefined);
      assert.equal(ctx.db.all(`SELECT 1 FROM tasks WHERE kind = 'section.figures'`).length, 0);
      assert.equal(state().status, 'fixed');
    });
  });

  test('a figure the check drops, or one placed after a block that does not exist, is left out with a note', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Uno.\n\nDue.');
    fake.next(answer({ figures: [fig({}), fig({ key: 'fuori', afterBlock: 9 }), fig({ key: 'ione', afterBlock: 2 })], noFigureReason: null }),
      answer({ figures: [{ index: 1, keep: true, reason: 'ok' }, { index: 2, keep: false, reason: 'Un singolo ione non aggiunge nulla.' }] }));
    const r = await sectionFigures(ctx, startTask('section.figures', { nodeId: 's1' }));
    assert.equal(r.added, 1);
    assert.ok(r.figureProblems!.some((n) => /fuori: block 9 does not exist/.test(n)));
    assert.ok(r.figureProblems!.some((n) => /ione: dropped by the check \(Un singolo ione/.test(n)));
    assert.doesNotMatch(current('s1').markdown, /ione/);
  });

  test('a section edited meanwhile gets the figures as a proposal', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Uno.');
    fake.next(() => { seedRevision('s1', 'Uno, riscritto.'); return answer({ figures: [fig({})], noFigureReason: null })(); }, answer(keepAll(1)));
    const r = await sectionFigures(ctx, startTask('section.figures', { nodeId: 's1' }));
    assert.equal(r.status, 'proposal');
    assert.equal(current('s1').markdown, 'Uno, riscritto.');
  });

  test('a full section is skipped, and a section with a photo is not offered another', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    const img = (f: string) => `:::image{src="assets/${f}" alt="a" caption="c"}\n:::`;
    seedRevision('s1', ['Testo.', img('a.svg'), img('b.svg'), img('c.svg')].join('\n\n'));
    assert.match(String((await sectionFigures(ctx, startTask('section.figures', { nodeId: 's1' }))).skipped), /already has 3 figures/);
    assert.equal(fake.calls.length, 0);

    seedRevision('s2', ['Testo.', img('foto.jpg')].join('\n\n'));
    ctx.db.insert('assets', { id: newId(), project_id: P, node_id: 's2', filename: 'foto.jpg', mime: 'image/jpeg', path: 'x', origin: 'stock', spec: {}, caption: 'Un cristallo', alt: 'a', checks: [], created_at: now() });
    setStockDeps({ commons: true });
    fake.next(answer({ figures: [], noFigureReason: 'Solo procedure.' }));
    const r = await sectionFigures(ctx, startTask('section.figures', { nodeId: 's2' }));
    assert.equal(r.noFigureReason, 'Solo procedure.');
    assert.doesNotMatch(fake.calls[0].system ?? '', /- photo: a real photo/);
    assert.match(fake.calls[0].prompt, /stock: Un cristallo/);
    assert.match(fake.calls[0].prompt, /at most 2 figures/);
  });

  test('a picture appears once in the book: a figure another section shows is dropped, and the writer sees the list', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', 'Il diossido di carbonio.\n\n:::image{src="assets/s1-co2.svg" alt="a" caption="Struttura di Lewis di CO2"}\n:::');
    ctx.db.insert('assets', { id: newId(), project_id: P, node_id: 's1', filename: 's1-co2.svg', mime: 'image/svg+xml', path: 'x', origin: 'structure', spec: { smiles: 'O=C=O', style: 'lewis', lonePairs: true, formula: 'CO2' }, caption: 'Struttura di Lewis di CO2', alt: 'a', checks: [], created_at: now() });
    seedRevision('s2', 'Il CO2 è apolare.\n\nFine.');
    // The same species as another SMILES string is still the same picture.
    fake.next(answer({ figures: [fig({ key: 'co2', caption: 'CO2', alt: 'CO2', structure: { smiles: 'C(=O)=O', style: 'lewis', lonePairs: true, formula: 'CO2' } }), fig({ afterBlock: 2 })], noFigureReason: null }), answer(keepAll(2)));
    const r = await sectionFigures(ctx, startTask('section.figures', { nodeId: 's2' }));
    assert.equal(r.added, 1);
    assert.ok(r.figureProblems!.some((n) => /co2: the same structure is already in "Sezione 1\.1"/.test(n)), r.figureProblems!.join(' | '));
    assert.match(fake.calls[0].prompt, /Figures other sections already show[\s\S]*- structure CO2 in "Sezione 1\.1": Struttura di Lewis di CO2/);
    assert.doesNotMatch(fake.calls[1].prompt, /lonePairs/, 'the check does not judge the lone-pair switch');
  });

  test('two equal figures proposed together keep only the first', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Uno.\n\nDue.');
    fake.next(answer({ figures: [fig({}), fig({ key: 'nh3-bis', afterBlock: 2 })], noFigureReason: null }), answer(keepAll(2)));
    const r = await sectionFigures(ctx, startTask('section.figures', { nodeId: 's1' }));
    assert.equal(r.added, 1);
    assert.ok(r.figureProblems!.some((n) => /nh3-bis: the same structure is already in this section/.test(n)));
  });

  test('a figures run can target only the sections without a figure', async () => {
    seedOutline([['c1', ['s1', 's2', 's3']]]);
    seedRevision('s1', 'Testo.\n\n:::image{src="assets/a.svg" alt="a" caption="c"}\n:::');
    seedRevision('s2', 'Testo.');
    // Cancelled at once: the test only looks at which tasks the run plans.
    const run = startRun(ctx, P, 'figures', { missingOnly: true });
    ctx.queue.cancel(run.id);
    assert.deepEqual(ctx.db.all<{ input: string }>('SELECT input FROM tasks WHERE run_id = ?', run.id).map((t) => json<{ nodeId: string }>(t.input, { nodeId: '' }).nodeId), ['s2']);
    const all = startRun(ctx, P, 'figures', {});
    ctx.queue.cancel(all.id);
    assert.equal(ctx.queue.tasks(all.id).length, 2);
    // Let the queue's scheduled tick run while the database is still open.
    await new Promise((r) => setImmediate(r));
  });

  test('a section already in an active figures run is not added again: a double click joins the run', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', 'Testo uno.');
    seedRevision('s2', 'Testo due.');
    const first = startRun(ctx, P, 'figures', { nodeIds: ['s1'] });
    const again = startRun(ctx, P, 'figures', { nodeIds: ['s1'] });
    assert.equal(again.id, first.id);
    const book = startRun(ctx, P, 'figures', {});
    assert.notEqual(book.id, first.id);
    const nodes = (id: string) => ctx.db.all<{ input: string }>('SELECT input FROM tasks WHERE run_id = ?', id).map((t) => json<{ nodeId: string }>(t.input, { nodeId: '' }).nodeId);
    assert.deepEqual(nodes(first.id), ['s1']);
    assert.deepEqual(nodes(book.id), ['s2']);
    // Every section taken, by two different runs: refused, since no single run covers the request.
    assert.throws(() => startRun(ctx, P, 'figures', {}), (e: Error & { status?: number; code?: string }) => e.status === 409 && e.code === 'figures_running');
    ctx.queue.cancel(first.id);
    ctx.queue.cancel(book.id);
    // Once the first run is over, the section can be illustrated again.
    const later = startRun(ctx, P, 'figures', { nodeIds: ['s1'] });
    ctx.queue.cancel(later.id);
    assert.notEqual(later.id, first.id);
    // A run that is cancelling while its task still runs keeps the section.
    ctx.db.run(`UPDATE runs SET status = 'cancelling' WHERE id = ?`, later.id);
    ctx.db.run(`UPDATE tasks SET state = 'running' WHERE run_id = ?`, later.id);
    assert.equal(startRun(ctx, P, 'figures', { nodeIds: ['s1'] }).id, later.id);
    ctx.db.run(`UPDATE tasks SET state = 'cancelled' WHERE run_id = ?`, later.id);
    ctx.db.run(`UPDATE runs SET status = 'cancelled' WHERE id = ?`, later.id);
    await new Promise((r) => setImmediate(r));
  });
});


describe('figures are checked where they are born', () => {
  const plot = (expr: string) => ({ xRange: [-1, 1], yRange: [-1, 1], xLabel: null, yLabel: null, functions: [{ expr, label: null, domain: null, style: null }], points: null, asymptotes: null });
  const fig = (key: string, expr: string) => ({ key, kind: 'plot', caption: `Grafico ${key}`, alt: 'Grafico', plot: plot(expr), structure: null, photo: null, levels: null, orbitals: null, cell: null, periodic: null });
  const img = (key: string) => `:::image{src="assets/${key}.svg" alt="x" caption="y"}\n:::`;
  const twoFigures = () => ({
    markdown: `Testo uno.\n\n${img('a')}\n\nTesto due.\n\n${img('b')}`,
    figures: [fig('a', 'x^2'), fig('b', 'x^3')], noFigureReason: null, summary: 'riassunto',
  });
  const current = (s: string) => ctx.db.get<{ markdown: string }>(`SELECT markdown FROM content_revisions WHERE node_id = ? AND status = 'current'`, s)!.markdown;
  const verdict = (...keep: boolean[]) => ({ figures: keep.map((k, i) => ({ index: i + 1, keep: k, reason: k ? 'utile' : 'Ripete il testo.' })) });

  test('a drafted figure the check drops is not built, its block goes, and the note says why', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written(twoFigures()), answer(verdict(true, false)));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    assert.equal(r.figures, 1);
    assert.deepEqual(r.figureProblems, ['b: dropped by the check (Ripete il testo.)']);
    assert.equal(ctx.db.all('SELECT 1 FROM assets').length, 1);
    assert.doesNotMatch(current(s1), /-b\.svg/);
    assert.match(current(s1), /-a\.svg/);
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[1].system ?? '', /You check figures proposed/);
    assert.match(fake.calls[1].prompt, /1\. kind: plot\ncaption: Grafico a[\s\S]*passage: Testo uno\.\nafter the figure: Testo due\./);
    assert.match(fake.calls[1].prompt, /2\. kind: plot\ncaption: Grafico b[\s\S]*passage: Testo uno\.\n\nTesto due\.\n\nReturn JSON/);
  });

  test('a draft that proposes no figure makes no check call', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written({ markdown: 'Solo definizioni.', figures: [], noFigureReason: null, summary: 'r' }));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    assert.equal(fake.calls.length, 1);
  });

  test('the check also runs in generous mode, where it drops decorative figures', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    ctx.db.run('UPDATE projects SET options = ? WHERE id = ?', JSON.stringify({ figurePolicy: 'generous', selfCheck: false }), P);
    fake.next(written(twoFigures()), answer(verdict(false, false)));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    assert.match(fake.calls[0].system ?? '', /Most sections have at least one place where a figure shows something faster than words/);
    assert.equal(r.figures, 0);
    assert.equal(r.figureProblems.length, 2);
    assert.doesNotMatch(current(s1), /:::image/);
  });

  test('when the check cannot run, the draft keeps its figures and says so', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(written(twoFigures()), () => new TaskError('rete assente', 'temporary'));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: s1 }));
    assert.equal(r.figures, 2);
    assert.match(r.figureProblems[0], /could not run/);
  });

  test('a fix for a figure problem carries the figure rules and the check drops a decorative figure it adds', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno.\n\n:::image{src="assets/vecchio.svg" alt="Vecchio" caption="Grafico vecchio"}\n:::');
    ctx.db.insert('review_issues', { id: 'f1', project_id: P, node_id: 's1', source: 'review', severity: 'minor', category: 'figure', quote: 'Grafico vecchio', message: 'Il grafico non corrisponde.', suggestion: 'Disegnare x^2', status: 'open', resolution: '', created_at: now() });
    fake.next(
      patchAnswer({ figures: [fig('a', 'x^2')], changes: [{ block: 0, text: `Testo uno corretto.\n\n${img('a')}` }] }),
      answer(verdict(false)), answer(checkGood([0])),
    );
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['f1'] }));
    assert.match(fake.calls[0].system ?? '', /Add a figure only when a problem or the author's instruction asks for one[\s\S]*- plot:/);
    assert.equal(r.status, 'current');
    assert.deepEqual(r.figureProblems, ['a: dropped by the check (Ripete il testo.)']);
    assert.equal(current('s1'), 'Testo uno corretto.\n\n:::image{src="assets/vecchio.svg" alt="Vecchio" caption="Grafico vecchio"}\n:::');
    assert.equal(ctx.db.all('SELECT 1 FROM assets').length, 0);
  });

  test('a fix for another kind of problem gets no figure rules, and an author instruction gets them', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno.');
    ctx.db.insert('review_issues', { id: 'c1', project_id: P, node_id: 's1', source: 'review', severity: 'minor', category: 'clarity', quote: 'Testo uno.', message: 'Poco chiaro.', suggestion: '', status: 'open', resolution: '', created_at: now() });
    fake.next(patchAnswer({ changes: [{ block: 0, text: 'Testo uno chiaro.' }] }), answer(checkGood([0])));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['c1'] }));
    assert.doesNotMatch(fake.calls[0].system ?? '', /FIGURES|Kinds \(/);
    fake.next(patchAnswer({ figures: [], changes: [{ block: 0, text: 'Testo uno con grafico.' }] }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', instruction: 'Aggiungi un grafico di x^2.' }));
    assert.match(fake.calls.at(-1)!.system ?? '', /FIGURES[\s\S]*- plot:/);
  });
});
