// Exam split warnings in the sources API and the run, and "Split with AI" with scripted model answers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, seedPage, seedProject, seedResource, usageOf } from '../llm/testkit.ts';
import type { TaskContext } from '../queue/queue.ts';
import { deleteResource, listResources, updateResource } from '../repo/index.ts';
import { authenticExtractPrompt, sessionExtractPrompt } from './prompts.ts';
import { installFakes, projectBody, startApp, type TestApp } from '../routes/testkit.ts';
import { splitExams } from '../extract/segment.ts';
import { buildAiSplit, resourceSplit, splitMessage, type ExamSplitAnswer } from './examSplit.ts';
import { resourceQuestions } from './prepare.ts';
import { startRun } from './runs.ts';

const P = 'project01';
let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  ctx = kit.ctx;
  ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(ctx, P);
});
afterEach(() => {
  setFunnel(null);
  kit.cleanup();
});

function startTask(kind: string, input: Record<string, unknown>): TaskContext {
  const runId = newId();
  ctx.db.insert('runs', { id: runId, project_id: P, kind: 'prepare', status: 'running', snapshot: {}, created_at: now() });
  const id = newId();
  ctx.db.insert('tasks', { id, run_id: runId, project_id: P, kind, label: `Split esami.pdf`, key: `${kind}:${id}`, input, state: 'running', pool: 'local', attempts: 1, max_attempts: 3, created_at: now() });
  return {
    task: { id, runId, projectId: P, kind, key: `${kind}:${id}`, label: kind, input, attempts: 1 }, signal: new AbortController().signal, deps: {},
    enqueue: (specs) => ctx.queue.addTasks(runId, P, specs), progress: () => undefined, setProvider: () => undefined,
  };
}
const answer = (obj: unknown) => () => ({ structured: obj as never, text: JSON.stringify(obj), usage: usageOf(10, 10) });
const resource = (id: string, role: string, texts: string[], o: { filename?: string; included?: number } = {}) => {
  seedResource(ctx, { id, projectId: P, role, filename: o.filename ?? `${id}.pdf`, included: o.included });
  texts.forEach((t, i) => seedPage(ctx, id, i, t));
};
const questionRows = (id: string) => ctx.db.all<Record<string, any>>('SELECT id, exam_group, number, page_from, page_to, statement FROM questions WHERE resource_id = ? ORDER BY rowid', id);
const split = (id: string) => listResources(ctx, P).find((r) => r.id === id)!;

// A paper layout the text rules do not know: "Es. 1" and no recognised session heading.
const ES_LAYOUT = [
  'Prova intermedia di Circuiti\nGruppo 1 - 10 aprile 2024\nEs. 1 Un resistore da 10 Ω è collegato a un generatore.\nCalcolare la corrente.\nEs. 2 Un condensatore si carica attraverso R.\nCalcolare la costante di tempo.',
  'Prova intermedia di Circuiti\nGruppo 2 - 11 aprile 2024\nEs. 1 Un diodo ideale in serie a R.\nTracciare la caratteristica.',
];
const ES_ANSWER: ExamSplitAnswer = {
  sessions: [
    { title: 'Prova intermedia, gruppo 1', date: '2024-04-10', page: 1, start: 'Prova intermedia di Circuiti', exercises: [
      { number: '1', page: 1, start: 'Es. 1 Un resistore da 10 Ω' }, { number: '2', page: 1, start: 'Es. 2 Un condensatore' }] },
    { title: 'Prova intermedia, gruppo 2', date: '2024-04-11', page: 2, start: 'Prova intermedia di Circuiti', exercises: [{ number: '1', page: 2, start: 'Es. 1 Un diodo ideale' }] },
  ],
};

describe('the split of an exam file is recorded and shows trouble', () => {
  test('an unknown layout is reported by the sources API and by the task result', async () => {
    resource('ex1', 'exams', ['Sessione invernale\nEsercizio 1\nUno.\nEsercizio 2\nDue.'], { filename: 'esami-2024.pdf' });
    const out = await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex1' }));
    assert.deepEqual(out, {
      questions: 2, duplicates: 0, sessions: 1, splitWarning: 'no_heading',
      warning: '1 session and 2 questions found in esami-2024.pdf. No session heading was recognised, so the whole file is one session.',
    });
    assert.deepEqual([split('ex1').splitSessions, split('ex1').splitQuestions, split('ex1').splitWarning], [1, 2, 'no_heading']);
    // A second Prepare reuses the questions and still says so.
    const { duplicates, ...again } = { ...out, reused: true } as Record<string, unknown>;
    assert.equal(duplicates, 0);
    assert.deepEqual(await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex1' })), again);
  });

  test('a file with nothing found says "0 questions", and the sentence matches the Sources row', async () => {
    resource('ex2', 'exams', ['Testo senza intestazioni.'], { filename: 'esami-2024.pdf' });
    const out = await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex2' })) as Record<string, unknown>;
    assert.equal(out.splitWarning, 'no_questions');
    assert.equal(out.warning, '0 sessions and 0 questions found in esami-2024.pdf. No exercise heading was recognised.');
    assert.equal(splitMessage('a.pdf', { sessions: 1, questions: 0, warning: null }), '1 session and 0 questions found in a.pdf.');
  });

  test('a file that splits well has the counts and no warning', async () => {
    resource('ok', 'exams', ['Appello del 12/02/2024\nProblema 1\nUno.\nProblema 2\nDue.', 'Appello del 05/07/2024\nProblema 1\nUno.\nProblema 2\nDue.']);
    const out = await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ok' }));
    assert.deepEqual(out, { questions: 4, duplicates: 0, sessions: 2 });
    assert.deepEqual([split('ok').splitSessions, split('ok').splitQuestions, split('ok').splitWarning], [2, 4, null]);
  });

  test('a file whose questions were stored before the summary existed gets its summary from those rows, which stay as they are', async () => {
    resource('old', 'exams', ['Sessione\nEsercizio 1\nUno.\nEsercizio 2\nDue.'], { filename: 'esami-2024.pdf' });
    resource('fine', 'exams', ['Appello del 12/02/2024\nProblema 1\nUno.\nProblema 2\nDue.', 'Appello del 05/07/2024\nProblema 1\nUno.\nProblema 2\nDue.'], { filename: 'esami-b.pdf' });
    for (const id of ['old', 'fine']) await resourceQuestions(ctx, startTask('resource.questions', { resourceId: id }));
    // As a book prepared by an earlier version: questions, no recorded split.
    ctx.db.run(`UPDATE resources SET meta = '{}'`);
    assert.deepEqual([split('old').splitSessions, split('old').splitQuestions, split('old').splitWarning], [null, null, null]);
    const before = questionRows('old').concat(questionRows('fine'));
    const out = await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'old' })) as Record<string, unknown>;
    assert.deepEqual([out.reused, out.questions, out.sessions, out.splitWarning], [true, 2, 1, 'no_heading']);
    assert.match(String(out.warning), /^1 session and 2 questions found in esami-2024\.pdf\. No session heading was recognised/);
    const fine = await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'fine' })) as Record<string, unknown>;
    assert.deepEqual([fine.reused, fine.questions, fine.sessions, fine.splitWarning], [true, 4, 2, undefined]);
    assert.deepEqual([split('old').splitSessions, split('old').splitQuestions, split('old').splitWarning], [1, 2, 'no_heading']);
    assert.deepEqual([split('fine').splitSessions, split('fine').splitQuestions, split('fine').splitWarning], [2, 4, null]);
    assert.deepEqual(questionRows('old').concat(questionRows('fine')), before);
  });

  test('the warning follows the role and inclusion; other sources carry no counts', async () => {
    resource('ex1', 'exams', ['Sessione\nEsercizio 1\nUno.'], { filename: 'esami-2024.pdf' });
    await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex1' }));
    assert.equal(split('ex1').splitWarning, 'no_heading');
    updateResource(ctx, 'ex1', { included: false });
    assert.deepEqual([split('ex1').splitSessions, split('ex1').splitWarning], [1, null], 'left out of the book: counts stay, no warning');
    updateResource(ctx, 'ex1', { included: true, role: 'theory' });
    assert.deepEqual([split('ex1').splitSessions, split('ex1').splitQuestions, split('ex1').splitWarning], [null, null, null], '"Mark as not an exam" clears it');
    updateResource(ctx, 'ex1', { role: 'exercises' });
    assert.equal(split('ex1').splitWarning, null);
    updateResource(ctx, 'ex1', { role: 'exams' });
    assert.equal(split('ex1').splitWarning, 'no_heading', 'the split recorded under Exams applies again');
    resource('quiz', 'exercises', ['Esercizio 1\nUno.\nEsercizio 2\nDue.']);
    await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'quiz' }));
    assert.deepEqual([split('quiz').splitSessions, split('quiz').splitWarning], [null, null]);
  });

  test('the run summary lists the warnings of its finished tasks, so the run is not a plain success', async () => {
    resource('ex1', 'exams', ['Sessione\nEsercizio 1\nUno.\nEsercizio 2\nDue.'], { filename: 'esami-2024.pdf' });
    const t = startTask('resource.questions', { resourceId: 'ex1' });
    const result = await resourceQuestions(ctx, t);
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', result = ? WHERE id = ?`, JSON.stringify(result), t.task.id);
    const clean = startTask('resource.index', { resourceId: 'ex1' });
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', result = ? WHERE id = ?`, JSON.stringify({ origin: 'inferred' }), clean.task.id);
    ctx.db.run('UPDATE tasks SET run_id = ? WHERE id = ?', t.task.runId, clean.task.id);
    assert.deepEqual(ctx.queue.runSummary(t.task.runId)!.warnings, [{ taskId: t.task.id, label: 'Split esami.pdf', message: (result as unknown as { warning: string }).warning }]);
  });
});

describe('Split with AI', () => {
  test('a valid answer stores sessions and exercises through the same path, and clears the warning', async () => {
    resource('ex1', 'exams', ES_LAYOUT, { filename: 'esami-2024.pdf' });
    await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex1' }));
    assert.equal(split('ex1').splitWarning, 'no_questions');
    fake.next(answer(ES_ANSWER));
    const out = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' }));
    assert.deepEqual(out, { applied: true, questions: 3, duplicates: 0, sessions: 2 });
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0].prompt ?? JSON.stringify(fake.calls[0]), /page 1:\n {2}Prova intermedia di Circuiti/);
    assert.deepEqual(questionRows('ex1').map((q) => `${q.exam_group} #${q.number} p${q.page_from}-${q.page_to}`), [
      'Esame del 10 aprile 2024 #1 p0-0', 'Esame del 10 aprile 2024 #2 p0-0', 'Esame del 11 aprile 2024 #1 p1-1',
    ]);
    // Two exercises on one page do not share text.
    assert.match(questionRows('ex1')[0].statement, /^Es\. 1 Un resistore .*\nCalcolare la corrente\.$/);
    assert.match(questionRows('ex1')[1].statement, /^Es\. 2 Un condensatore .*\nCalcolare la costante di tempo\.$/);
    assert.ok(ctx.db.all<Record<string, any>>('SELECT kind, origin, status, exam_date FROM questions WHERE resource_id = ?', 'ex1').every((q) => q.kind === 'exam' && q.origin === 'authentic' && q.status === 'draft' && q.exam_date));
    assert.deepEqual([split('ex1').splitSessions, split('ex1').splitQuestions, split('ex1').splitWarning], [2, 3, null]);
  });

  test('a Markdown exam file: the model is shown the heading lines without their marks, and quotes them as they are shown', async () => {
    const md = readFileSync(new URL('../extract/testdata/appelli-elettrotecnica-2024.md', import.meta.url), 'utf8');
    resource('ex1', 'exams', [md], { filename: 'appelli-elettrotecnica-2024.md' });
    const exercise = (n: number) => ({ number: String(n), page: 1, start: `Problema ${n} (12 punti)`, solution: { page: 1, start: `Problema ${n}.` } });
    fake.next(answer({ sessions: [
      { title: 'Prova scritta, Appello del 12 febbraio 2024', date: '2024-02-12', page: 1, start: 'Prova scritta, Appello del 12 febbraio 2024', exercises: [exercise(1), exercise(2)] },
      { title: 'Prova scritta, Appello del 3 luglio 2024', date: '2024-07-03', page: 1, start: 'Prova scritta, Appello del 3 luglio 2024', exercises: [exercise(1), exercise(2)] },
    ] }));
    const out = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' }));
    const prompt = String(fake.calls[0].prompt);
    for (const line of ['Prova scritta, Appello del 12 febbraio 2024', 'Problema 1 (12 punti)', 'Problema 2 (12 punti)']) assert.ok(prompt.includes(`  ${line}\n`), `${line} is shown`);
    assert.doesNotMatch(prompt, /\*\*|\| /);
    assert.deepEqual(out, { applied: true, questions: 4, duplicates: 0, sessions: 2 });
    const rows = ctx.db.all<Record<string, any>>('SELECT exam_group, number, statement, solution FROM questions WHERE resource_id = ? ORDER BY rowid', 'ex1');
    assert.deepEqual(rows.map((r) => `${r.exam_group} #${r.number}`), ['Prova scritta del 12 febbraio 2024 #1', 'Prova scritta del 12 febbraio 2024 #2', 'Prova scritta del 3 luglio 2024 #1', 'Prova scritta del 3 luglio 2024 #2']);
    assert.match(rows[0].statement, /^Problema 1 \(12 punti\)\n+Un generatore/);
    assert.match(rows[3].solution, /^Problema 2\.\n+a\) \$\\tau = RC = 22/);
  });

  test('an answer that does not hold up leaves the file as it was, with the warning still shown', async () => {
    // The text rules read this paper as one session without a heading ("no heading"), three questions.
    resource('ex1', 'exams', [
      'Prova intermedia di Circuiti\nEsercizio 1 Un resistore.\nCalcolare I.\nEsercizio 2 Un condensatore.\nCalcolare tau.',
      'Prova intermedia di Circuiti\nGruppo 2\nEsercizio 1 Un diodo.\nTracciare.',
    ], { filename: 'esami-2024.pdf' });
    await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex1' }));
    const before = questionRows('ex1');
    assert.equal(before.length, 3);
    const good: ExamSplitAnswer = { sessions: [
      { title: 'Gruppo 1', date: null, page: 1, start: 'Prova intermedia di Circuiti', exercises: [{ number: '1', page: 1, start: 'Esercizio 1 Un resistore' }, { number: '2', page: 1, start: 'Esercizio 2 Un condensatore' }] },
      { title: 'Gruppo 2', date: null, page: 2, start: 'Prova intermedia di Circuiti', exercises: [{ number: '1', page: 2, start: 'Esercizio 1 Un diodo' }] },
    ] };
    const clone = (f: (a: ExamSplitAnswer) => void) => { const a = structuredClone(good); f(a); return a; };
    const bad: [string, ExamSplitAnswer, RegExp][] = [
      ['a quote that is not on the page', clone((a) => { a.sessions[0].start = 'Esame inventato di Fisica'; }), /does not start with the line the model quoted/],
      ['a page beyond the file', clone((a) => { a.sessions[1].page = 9; }), /file has 2 pages/],
      ['sessions out of page order', { sessions: [good.sessions[1], good.sessions[0]] }, /out of page order/],
      ['an exercise that belongs to the next session', clone((a) => { a.sessions[0].exercises[1] = { number: '1', page: 2, start: 'Esercizio 1 Un diodo' }; }), /out of (page )?order/],
      ['exercises out of order', clone((a) => { a.sessions[0].exercises.reverse(); }), /out of order/],
      ['no exercise at all', clone((a) => { a.sessions = [{ ...a.sessions[0], exercises: [] }]; }), /found no exercise/],
    ];
    for (const [name, answerObj, reason] of bad) {
      fake.next(answer(answerObj));
      const out = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' })) as Record<string, unknown>;
      assert.equal(out.applied, false, name);
      assert.match(String(out.reason), reason, name);
      assert.match(String(out.warning), /^The AI split of esami-2024\.pdf was not applied\. /, name);
      assert.equal(out.splitWarning, 'no_heading', name);
      assert.deepEqual(questionRows('ex1'), before, name);
      assert.deepEqual([split('ex1').splitSessions, split('ex1').splitQuestions, split('ex1').splitWarning], [1, 3, 'no_heading'], name);
    }
    // The same file with a good answer is split.
    fake.next(answer(good));
    assert.deepEqual(await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' })), { applied: true, questions: 3, duplicates: 0, sessions: 2 });
    assert.deepEqual(questionRows('ex1').map((q) => `${q.exam_group} #${q.number}`), ['Gruppo 1 #1', 'Gruppo 1 #2', 'Gruppo 2 #1']);
    assert.deepEqual([split('ex1').splitSessions, split('ex1').splitQuestions, split('ex1').splitWarning], [2, 3, null]);
  });

  test('questions the author edited or checked are never replaced, and the model is not asked', async () => {
    resource('ex1', 'exams', ['Sessione\nEsercizio 1\nUno.\nEsercizio 2\nDue.']);
    await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex1' }));
    ctx.db.run(`UPDATE questions SET edited_at = ? WHERE resource_id = 'ex1' AND number = '1'`, now());
    const out = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' })) as Record<string, unknown>;
    assert.equal(out.applied, false);
    assert.match(String(out.reason), /edited or checked already/);
    assert.equal(fake.calls.length, 0);
    assert.equal(questionRows('ex1').length, 2);
  });

  test('a source that is not an exam source is skipped without a model call', async () => {
    resource('th', 'theory', ['Capitolo 1']);
    assert.deepEqual(await resourceSplit(ctx, startTask('resource.split', { resourceId: 'th' })), { skipped: 'not an exam source' });
    assert.equal(fake.calls.length, 0);
  });

  test('buildAiSplit: the same date twice gives numbered versions; an undated session takes the model title', () => {
    const pages = [{ idx: 0, text: 'Prova A\nEs. 1 Uno\nProva B\nEs. 1 Due' }];
    const out = buildAiSplit('r', pages, { sessions: [
      { title: 'Prova A', date: null, page: 1, start: 'Prova A', exercises: [{ number: '1', page: 1, start: 'Es. 1 Uno' }] },
      { title: 'Prova B', date: null, page: 1, start: 'Prova B', exercises: [{ number: '1', page: 1, start: 'Es. 1 Due' }] },
    ] }, 'file');
    assert.ok('rows' in out);
    assert.deepEqual(out.rows.map((r) => [r.examGroup, r.examDate, r.statement]), [['Prova A', null, 'Es. 1 Uno'], ['Prova B', null, 'Es. 1 Due']]);
  });

  test('buildAiSplit: a solution from another session, or one solution for two exercises, is refused', () => {
    const pages = [
      { idx: 0, text: 'Appello del 12 febbraio 2024\nEsercizio 1 Uno\nEsercizio 2 Due' },
      { idx: 1, text: 'Appello del 5 luglio 2024\nEsercizio 1 Tre\nSoluzione 1 Tre\nSoluzione 2 Quattro' },
    ];
    const answer = (a1: ExamSplitAnswer['sessions'][number]['exercises'], b1: ExamSplitAnswer['sessions'][number]['exercises']): ExamSplitAnswer => ({ sessions: [
      { title: 'Appello del 12 febbraio 2024', date: '2024-02-12', page: 1, start: 'Appello del 12 febbraio 2024', exercises: a1 },
      { title: 'Appello del 5 luglio 2024', date: '2024-07-05', page: 2, start: 'Appello del 5 luglio 2024', exercises: b1 },
    ] });
    const ex = (n: string, page: number, start: string, solution?: { page: number; start: string }) => ({ number: n, page, start, solution });
    // Both sessions point at the second paper's "Soluzione 1".
    const shared = buildAiSplit('r', pages, answer([ex('1', 1, 'Esercizio 1 Uno', { page: 2, start: 'Soluzione 1' })], [ex('1', 2, 'Esercizio 1 Tre', { page: 2, start: 'Soluzione 1' })]), 'f');
    assert.ok('reason' in shared);
    // The first paper alone points into the second paper.
    const later = buildAiSplit('r', pages, answer([ex('1', 1, 'Esercizio 1 Uno', { page: 2, start: 'Soluzione 1' })], [ex('1', 2, 'Esercizio 1 Tre')]), 'f');
    assert.ok('reason' in later);
    assert.match(later.reason, /later session/);
    // Two exercises of one session share a solution.
    const twice = buildAiSplit('r', pages, answer([ex('1', 1, 'Esercizio 1 Uno'), ex('2', 1, 'Esercizio 2 Due')], [ex('1', 2, 'Esercizio 1 Tre', { page: 2, start: 'Soluzione 1' }), ex('2', 2, 'Esercizio 1 Tre', { page: 2, start: 'Soluzione 1' })]), 'f');
    assert.ok('reason' in twice);
    // Each solution inside its own session is stored.
    const ok = buildAiSplit('r', pages, answer([ex('1', 1, 'Esercizio 1 Uno'), ex('2', 1, 'Esercizio 2 Due')], [ex('1', 2, 'Esercizio 1 Tre', { page: 2, start: 'Soluzione 1' })]), 'f');
    assert.ok('rows' in ok);
    assert.deepEqual(ok.rows.map((r) => r.solution.split('\n')[0]), ['', '', 'Soluzione 1 Tre']);
  });
});

// The two versions of the exam file of the acceptance run: the same two papers, the second with the solutions attached.
const PAPER = (day: string, first: string) => `Prova scritta, Appello del ${day}\nProblema 1 (12 punti)\n${first}\nProblema 2 (12 punti)\nUn secondo circuito.`;
const EXAM_FILE = [PAPER('12 febbraio 2024', 'Un condensatore si carica.'), PAPER('3 luglio 2024', 'Un amplificatore invertente.')];

describe('deleting a source takes out what was read from it', () => {
  const prepare = (id: string) => resourceQuestions(ctx, startTask('resource.questions', { resourceId: id }));
  const count = (id: string) => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM questions WHERE resource_id = ?', id)!.n;

  test('the corrected file uploaded after the delete is stored in full, and nothing is counted as a duplicate of the old one', async () => {
    resource('v1', 'exams', EXAM_FILE, { filename: 'appelli.pdf' });
    assert.deepEqual(await prepare('v1'), { questions: 4, duplicates: 0, sessions: 2 });
    const [q] = questionRows('v1');
    ctx.db.insert('review_issues', { id: 'i1', project_id: P, node_id: null, question_id: q.id, source: 'verification', severity: 'blocker', category: 'solution', message: 'Il risultato è sbagliato.', status: 'open', resolution: '', created_at: now() });
    const out = deleteResource(ctx, 'v1');
    assert.deepEqual(out, { removedQuestions: 4, keptQuestions: 0 });
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM questions WHERE project_id = ?', P)!.n, 0, 'no question of the deleted file is left');
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_issues WHERE id = ?', 'i1')!.n, 0, 'the problem about a removed question goes with it, or it would block the export for ever');
    resource('v2', 'exams', EXAM_FILE, { filename: 'appelli-corretto.pdf' });
    assert.deepEqual(await prepare('v2'), { questions: 4, duplicates: 0, sessions: 2 });
    assert.equal(count('v2'), 4);
  });

  test('a question a chapter was given but that was not read yet goes with its file, because nothing could read it afterwards', async () => {
    resource('v1', 'exams', EXAM_FILE, { filename: 'appelli.pdf' });
    await prepare('v1');
    const [assigned] = questionRows('v1');
    ctx.db.run(`UPDATE questions SET chapter_id = 'c1' WHERE id = ?`, assigned.id);
    assert.deepEqual(deleteResource(ctx, 'v1'), { removedQuestions: 4, keptQuestions: 0 });
    assert.equal(count('v1'), 0);
  });

  test('a question you edited, or one already read into a chapter, stays as your own and is not read again from a copy of the file', async () => {
    resource('v1', 'exams', EXAM_FILE, { filename: 'appelli.pdf' });
    await prepare('v1');
    const [edited, inChapter] = questionRows('v1');
    ctx.db.run(`UPDATE questions SET edited_at = ?, statement = 'Testo corretto a mano.' WHERE id = ?`, now(), edited.id);
    ctx.db.run(`UPDATE questions SET chapter_id = 'c1', imported_at = ? WHERE id = ?`, now(), inChapter.id);
    assert.deepEqual(deleteResource(ctx, 'v1'), { removedQuestions: 2, keptQuestions: 2 });
    const kept = ctx.db.all<Record<string, any>>('SELECT id, resource_id, page_from, page_to, statement, exam_group, chapter_id FROM questions WHERE project_id = ? ORDER BY rowid', P);
    assert.deepEqual(kept.map((k) => [k.id, k.resource_id, k.page_from, k.page_to]), [[edited.id, null, null, null], [inChapter.id, null, null, null]]);
    assert.equal(kept[0].statement, 'Testo corretto a mano.');
    assert.equal(kept[1].chapter_id, 'c1');
    // They still count (no source says otherwise), so a new copy of the same paper does not add a second one of each.
    assert.ok(ctx.db.get(`SELECT 1 FROM questions WHERE id = ? AND resource_id IS NULL`, edited.id));
    resource('v2', 'exams', EXAM_FILE, { filename: 'appelli-corretto.pdf' });
    assert.deepEqual(await prepare('v2'), { questions: 2, duplicates: 2, sessions: 2 });
  });

  test('a source you excluded does not make the same paper in another file a duplicate', async () => {
    resource('v1', 'exams', EXAM_FILE, { filename: 'appelli.pdf' });
    await prepare('v1');
    updateResource(ctx, 'v1', { included: false });
    resource('v2', 'exams', EXAM_FILE, { filename: 'appelli-corretto.pdf' });
    assert.deepEqual(await prepare('v2'), { questions: 4, duplicates: 0, sessions: 2 });
  });
});

describe('the author asks for the AI split', () => {
  test('a Prepare run has no split task unless the author asked for one file', async () => {
    resource('ex1', 'exams', ES_LAYOUT);
    resource('ex2', 'exams', ES_LAYOUT);
    resource('th', 'theory', ['Capitolo 1']);
    const keys = (runId: string) => ctx.db.all<{ key: string; kind: string }>('SELECT key, kind FROM tasks WHERE run_id = ? ORDER BY rowid', runId).map((t) => t.key);
    // The queue is not started in tests; cancelling at once keeps its wake-up from running the tasks.
    const plain = keys(startRun(ctx, P, 'prepare').id);
    ctx.db.run(`UPDATE runs SET status = 'cancelled'`);
    assert.ok(!plain.some((k) => k.startsWith('split:')));
    assert.ok(plain.includes('questions:ex1') && plain.includes('questions:ex2'));
    const asked = startRun(ctx, P, 'prepare', { splitResourceId: 'ex1' });
    ctx.db.run(`UPDATE runs SET status = 'cancelled'`);
    const k = keys(asked.id);
    assert.ok(k.includes('split:ex1') && !k.includes('questions:ex1') && k.includes('questions:ex2'));
    const topics = ctx.db.get<{ id: string }>(`SELECT id FROM tasks WHERE run_id = ? AND kind = 'topics.map'`, asked.id)!;
    const deps = ctx.db.all<{ key: string }>('SELECT t.key FROM task_deps d JOIN tasks t ON t.id = d.dep_id WHERE d.task_id = ?', topics.id).map((r) => r.key);
    assert.ok(deps.includes('split:ex1'), 'the topic map waits for the split');
    assert.throws(() => startRun(ctx, P, 'prepare', { splitResourceId: 'th' }), /marked as Exams/);
    await new Promise((r) => setImmediate(r));
  });
});

describe('API', () => {
  let t: TestApp;
  let fakes: ReturnType<typeof installFakes>;
  beforeEach(async () => { t = await startApp(); fakes = installFakes(); });
  afterEach(async () => { fakes.restore(); await t.close(); });

  const seed = async (role: string) => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody(`split-${role}`));
    t.ctx.db.insert('resources', { id: `r-${role}`, project_id: p.id, kind: 'pdf', role, filename: 'esami-2024.pdf', sha256: `${role}`.padEnd(64, 'a'), size: 1, path: 'x/e.pdf', included: 1, status: 'ready', created_at: now(), meta: { split: { role: 'exams', sessions: 1, questions: 0, warning: 'no_questions' } } });
    return p.id as string;
  };

  test('the sources list carries the counts and the reason; "Mark as not an exam" is PATCH /api/resources/:rid with a role', async () => {
    const projectId = await seed('exams');
    const list = (await t.req('GET', `/api/projects/${projectId}/resources`)).body;
    assert.deepEqual([list[0].splitSessions, list[0].splitQuestions, list[0].splitWarning], [1, 0, 'no_questions']);
    const patched = (await t.req('PATCH', '/api/resources/r-exams', { role: 'theory' })).body;
    assert.deepEqual([patched.role, patched.splitSessions, patched.splitWarning], ['theory', null, null]);
  });

  test('DELETE /api/resources/:rid says how many questions went and how many stayed', async () => {
    const projectId = await seed('exams');
    const insert = (id: string, o: Record<string, unknown> = {}) => t.ctx.db.insert('questions', { id, project_id: projectId, kind: 'exam', origin: 'authentic', resource_id: 'r-exams', page_from: 0, page_to: 0, exam_group: 'Appello', exam_date: '2024-02-12', number: id, statement: 'Testo.', hint: '', solution: '', difficulty: 'medio', topic_ids: [], status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(), ...o });
    insert('q1');
    insert('q2', { chapter_id: 'c1', imported_at: now() });
    const res = await t.req('DELETE', '/api/resources/r-exams');
    assert.deepEqual(res.body, { ok: true, removedQuestions: 1, keptQuestions: 1 });
    assert.deepEqual(t.ctx.db.all<{ id: string; resource_id: string | null }>('SELECT id, resource_id FROM questions').map((q) => [q.id, q.resource_id]), [['q2', null]]);
  });

  test('POST /api/resources/:rid/split starts a prepare run for that one file', async () => {
    await seed('exams');
    const res = await t.req('POST', '/api/resources/r-exams/split');
    assert.equal(res.status, 200);
    assert.deepEqual(fakes.calls.startRun.at(-1), { projectId: res.body.projectId, kind: 'prepare', scope: { splitResourceId: 'r-exams' } });
  });

  test('it refuses a source that is not an exam source, one not read yet, and one whose questions were worked on', async () => {
    await seed('theory');
    const notExam = await t.req('POST', '/api/resources/r-theory/split');
    assert.equal(notExam.status, 409);
    assert.equal(notExam.body.error.code, 'not_an_exam');

    const projectId = await seed('exams');
    t.ctx.db.run(`UPDATE resources SET status = 'queued' WHERE id = 'r-exams'`);
    assert.equal((await t.req('POST', '/api/resources/r-exams/split')).body.error.code, 'not_ready');
    t.ctx.db.run(`UPDATE resources SET status = 'ready' WHERE id = 'r-exams'`);
    t.ctx.db.insert('questions', { id: newId(), project_id: projectId, kind: 'exam', origin: 'authentic', resource_id: 'r-exams', exam_group: 'S', number: '1', statement: 'x', topic_ids: [], status: 'verified', checks: [], rev: 1, created_at: now(), updated_at: now() });
    assert.equal((await t.req('POST', '/api/resources/r-exams/split')).body.error.code, 'questions_in_use');
    assert.equal(fakes.calls.startRun.length, 0);
  });
});

describe('review findings on the AI split', () => {
  const one = (title = 'Sessione') => ({ sessions: [{ title, date: null, page: 1, start: 'Sessione', exercises: [{ number: '1', page: 1, start: 'Esercizio 1' }, { number: '2', page: 1, start: 'Esercizio 2' }] }] }) as ExamSplitAnswer;

  test('1. a question the author edits while the model call is pending is not replaced', async () => {
    resource('ex1', 'exams', ['Sessione\nEsercizio 1\nUno.\nEsercizio 2\nDue.']);
    await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'ex1' }));
    const ids = questionRows('ex1').map((q) => q.id);
    fake.next(() => {
      ctx.db.run(`UPDATE questions SET statement = 'Testo scritto dall''autore', edited_at = ? WHERE resource_id = 'ex1' AND number = '1'`, now());
      return { structured: one() as never, text: '', usage: usageOf(10, 10) };
    });
    const out = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' })) as Record<string, unknown>;
    assert.equal(out.applied, false);
    assert.match(String(out.reason), /edited or checked already/);
    const after = questionRows('ex1');
    assert.deepEqual(after.map((q) => q.id), ids, 'the same rows, none replaced');
    assert.equal(after[0].statement, 'Testo scritto dall\'autore');
  });

  test('2. the model sees every exercise line of a layout the rules do not know, and the page cap is stated', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `Es. ${i + 1} Calcolare la grandezza numero ${i + 1} del circuito in figura.\nSi usi il metodo dei nodi.`);
    const many = Array.from({ length: 40 }, (_, i) => `Problema ${i + 1}`);
    resource('ex1', 'exams', [['Prova di Circuiti', 'Gruppo 1', 'Corso 2024', ...ten].join('\n'), many.join('\n')]);
    fake.next(answer({ sessions: [] }));
    await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' }));
    const prompt = String(fake.calls[0].prompt);
    for (let i = 1; i <= 10; i++) assert.ok(prompt.includes(`Es. ${i} Calcolare`), `Es. ${i} is shown`);
    const page2 = prompt.slice(prompt.indexOf('page 2:')).split('\n').filter((l) => l.startsWith('  '));
    assert.ok(page2.length > 20 && page2.length <= 25, `page 2 shows ${page2.length} lines`);
    assert.match(prompt, /at most 25 lines per page/);
  });

  test('4. a copy split by the AI path is stored once next to the same paper split by the rules', async () => {
    resource('a', 'exams', ['Appello del 12/02/2024\nProblema 1\nUno.\nProblema 2\nDue.'], { filename: 'a.pdf' });
    resource('b', 'exams', ['Appello del 12 febbraio 2024\nEs. 1 Uno.\nEs. 2 Due.'], { filename: 'b.pdf' });
    await resourceQuestions(ctx, startTask('resource.questions', { resourceId: 'a' }));
    fake.next(answer({ sessions: [{ title: 'Appello del 12 febbraio 2024', date: '2024-02-12', page: 1, start: 'Appello del 12 febbraio 2024', exercises: [
      { number: '1', page: 1, start: 'Es. 1 Uno' }, { number: '2', page: 1, start: 'Es. 2 Due' }] }] }));
    const out = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'b' })) as Record<string, unknown>;
    assert.equal(out.questions, 0);
    assert.equal(out.duplicates, 2);
    assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT exam_group) AS n FROM questions WHERE project_id = ?`, P)!.n, 1);
  });

  test('4. the name keeps the word of the heading and the turn printed after the date', () => {
    const pages = [{ idx: 0, text: 'Esame del 12 febbraio 2024 - Turno A\nEsercizio 1 Uno' }, { idx: 1, text: 'Compito del 3 marzo 2024\nEsercizio 1 Due' }, { idx: 2, text: 'Prova di Fisica\nEsercizio 1 Tre' }];
    const out = buildAiSplit('r', pages, { sessions: [
      { title: 'Esame del 12 febbraio 2024 - Turno A', date: '2024-02-12', page: 1, start: 'Esame del 12 febbraio 2024', exercises: [{ number: '1', page: 1, start: 'Esercizio 1 Uno' }] },
      { title: 'Compito del 3 marzo 2024', date: '2024-03-03', page: 2, start: 'Compito del 3 marzo 2024', exercises: [{ number: '1', page: 2, start: 'Esercizio 1 Due' }] },
      { title: 'Prova di Fisica', date: '2024-04-05', page: 3, start: 'Prova di Fisica', exercises: [{ number: '1', page: 3, start: 'Esercizio 1 Tre' }] },
    ] }, 'file');
    assert.ok('rows' in out);
    assert.deepEqual(out.rows.map((r) => r.examGroup), ['Esame del 12 febbraio 2024 - Turno A', 'Compito del 3 marzo 2024', 'Esame del 5 aprile 2024']);
    // The rules read the first heading to the same name.
    const rules = splitExams('r', pages, {}).rows;
    assert.equal(rules[0].examGroup, 'Esame del 12 febbraio 2024 - Turno A');
    assert.equal(rules[1].examGroup, 'Compito del 3 marzo 2024');
  });

  test('6. the official solutions printed after the exercises reach every exercise of the session', async () => {
    resource('ex1', 'exams', [
      'Prova di Circuiti\nEs. 1 Un resistore.\nCalcolare I.\nEs. 2 Un condensatore.\nCalcolare tau.',
      'Soluzioni\nEs. 1 I = 1 A.\nSi applica la legge di Ohm.\nEs. 2 tau = RC.',
    ], { filename: 'esami-2024.pdf' });
    const good = { sessions: [{ title: 'Prova di Circuiti', date: null, page: 1, start: 'Prova di Circuiti', exercises: [
      { number: '1', page: 1, start: 'Es. 1 Un resistore', solution: { page: 2, start: 'Es. 1 I = 1 A' } },
      { number: '2', page: 1, start: 'Es. 2 Un condensatore', solution: { page: 2, start: 'Es. 2 tau = RC' } }] }] };
    fake.next(answer(good));
    const out = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' })) as Record<string, unknown>;
    assert.equal(out.applied, true);
    const rows = ctx.db.all<Record<string, any>>(`SELECT number, statement, solution, page_from, page_to FROM questions WHERE resource_id = 'ex1' ORDER BY rowid`);
    assert.deepEqual(rows.map((r) => [r.number, r.page_from, r.page_to]), [['1', 0, 1], ['2', 0, 1]], 'both ranges reach the solution page');
    assert.equal(rows[0].statement, 'Es. 1 Un resistore.\nCalcolare I.');
    assert.equal(rows[1].statement, 'Es. 2 Un condensatore.\nCalcolare tau.', 'the "Soluzioni" line is not part of the statement');
    assert.equal(rows[0].solution, 'Es. 1 I = 1 A.\nSi applica la legge di Ohm.');
    assert.equal(rows[1].solution, 'Es. 2 tau = RC.');
    // A solution quoted from a line that is not on its page is refused like any other boundary.
    const bad = structuredClone(good);
    bad.sessions[0].exercises[0].solution = { page: 2, start: 'Es. 9 inventato' };
    fake.next(answer(bad));
    const refused = await resourceSplit(ctx, startTask('resource.split', { resourceId: 'ex1' })) as Record<string, unknown>;
    assert.equal(refused.applied, false);
    assert.match(String(refused.reason), /solution/i);
  });
});

describe('a split asked for while Prepare runs', () => {
  test('3. it is refused with a clear message, and a Prepare run without it still starts', async () => {
    resource('ex1', 'exams', ES_LAYOUT);
    const run = startRun(ctx, P, 'prepare');
    assert.throws(() => startRun(ctx, P, 'prepare', { splitResourceId: 'ex1' }), (e: any) => e.status === 409 && e.code === 'prepare_running' && /Prepare is running\. Split this file when it has finished\./.test(e.message));
    assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND kind = 'resource.split'`, run.id)!.n, 0);
    ctx.db.run(`UPDATE runs SET status = 'cancelled'`);
    assert.doesNotThrow(() => startRun(ctx, P, 'prepare', { splitResourceId: 'ex1' }));
    ctx.db.run(`UPDATE runs SET status = 'cancelled'`);
    await new Promise((r) => setImmediate(r));
  });
});

describe('the exam readers tell the model to leave out heading lines', () => {
  const SENTENCE = 'A statement and a solution carry the text only, without the heading line that names the exercise ("Problema 2.", "Esercizio 2") and without the word that opens the solutions ("Soluzioni", "Svolgimento").';

  test('the session reader and the per-question reader both carry the sentence', () => {
    const session = sessionExtractPrompt({ language: 'it', examGroup: 'Giugno', exercises: [{ number: '1', solutionText: '' }], pages: 'p' });
    const single = authenticExtractPrompt({ language: 'it', examGroup: 'Giugno', number: '1', statementPages: 'p', solutionPages: 'p' });
    assert.ok(session.prompt.includes(SENTENCE));
    assert.ok(single.prompt.includes(SENTENCE));
  });
});
