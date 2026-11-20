// Handler tests: scripted model answers (FakeFunnel), a real temp database, handlers called directly with a hand-made task.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { compileBook, lintQuestionText, MAX_DELETED_BLOCKS, sampleGraph, type GraphSpec } from '@smartbuilder/content';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { json, newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, examRead, examText, makeCtx, patchAnswer, patchText, seedPage, seedProject, seedResource, usageOf, written, wroteCode } from '../llm/testkit.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { resolveDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { commitAiRevision, sectionDraft } from './draft.ts';
import { chapterEnrich, enrichGraph, enrichIde, saveEnrichment } from './enrich.ts';
import { chapterPractice, practiceDone, practiceGenerate, questionImport, questionRevise, questionVerify, sessionImport, sessionImportKey, sessionGivesWay, problemSeverity, quoteFound, itemProblems, verifyVerdict, correctionRefused, reconcileMismatches, restates, differentResultBlocker, type CheckProblem, type OpenMismatch, type VerifyAnswer } from './practice.ts';
import { labelResources, resourceIndex, resourceQuestions, topicsMap } from './prepare.ts';
import { chapterReview, mergeRepeats, sectionRevise } from './review.ts';
import { sectionFigures } from './figures.ts';
import { setStockDeps } from '../figures/stock.ts';
import { examReadParser, generatedQuestionsSchema, parseQuestionText, patchPrompt, PROBLEM_KINDS, reviewSchema, verifyPrompt, verifySchema, type CheckedItem } from './prompts.ts';
import { toProviderSchema } from '../llm/schema.ts';
import { generateSpecs, startRun } from './runs.ts';
import { registerHandlers } from './index.ts';
import { computePriorities } from './prepare.ts';
import { acceptProposal, getProjectSummary, rejectProposal, insertProposal, listEnrichments, listIssues, loadBookInput, repairQuestionText, saveHuman, sweepDue, updateEnrichmentPayload, updateQuestion } from '../repo/index.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';
const answer = (obj: unknown) => () => ({ structured: obj as never, text: JSON.stringify(obj), usage: usageOf(10, 10) });
/** The cross review's answer when it finds nothing: a whole-chapter review makes this call after its reviewer calls. */
const crossNone = answer({ issues: [] });
/** The independent graph checker's answer when it finds nothing wrong. */
const checkerFits = answer({ traces: [{ label: 'f', expected: '', problem: '' }], fit: 'fits' });
/**
 * Stores the graphs of a writer's answer for section s1 as drawn, with their sampling check and an issue when it fails. Generation
 * no longer saves a failing graph, but an edited or re-checked one can fail, and Fix redraws it.
 */
function storeAnswer(a: Record<string, any>) {
  const spec = (id: string, title: string, yDomain: [number, number], yScale: 'log' | null | undefined, yLabel: string, traces: GraphSpec['traces']): GraphSpec => ({ id, title, xDomain: a.xDomain, yDomain, xScale: a.xScale ?? undefined, yScale: yScale ?? undefined, xLabel: a.xLabel, yLabel, traces });
  const specs = [spec(a.id, a.title, a.yDomain, a.yScale, a.yLabel, a.traces), ...(a.pair ? [spec(a.pair.id === a.id ? `${a.pair.id}-2` : a.pair.id, a.pair.title, a.pair.yDomain, a.pair.yScale, a.pair.yLabel, a.pair.traces)] : [])];
  for (const s of specs) {
    const g = sampleGraph(s);
    saveEnrichment(ctx, P, 's1', 'graph', g.payload, [{ method: 'numeric', ok: g.ok, detail: g.detail }], { spec: s });
  }
}
/** The data part of an exercise check that finds nothing wrong with the statement. No program: nothing to run in the sandbox. */
const posed = { wellPosed: true, wellPosedReason: 'I dati determinano una sola risposta.', dataProblems: [] as string[], consistency: '' };
/** What one exercise check finds, in the fields of the single-call answer the tests were written with. */
type Verdict = Partial<VerifyAnswer> & { stepProgram?: string; asked?: { request: string; answer: string }[]; items?: CheckedItem[]; steps?: { quote: string; work: string; holds: boolean; why: string }[]; matches?: boolean; quote?: string; stated?: boolean };
/** The solution a check prompt carries, so a scripted item can quote it. */
const solutionIn = (prompt: string) => /GIVEN SOLUTION:\n([\s\S]*?)\n\n(?:The text may contain|First list|Return JSON)/.exec(prompt)?.[1] ?? '';
const itemsOf = (v: Verdict, prompt: string): CheckedItem[] => v.items ?? [{ request: 'Calcola.', answer: v.independentAnswer ?? '1', quote: v.quote ?? solutionIn(prompt), stated: v.stated ?? true, matches: v.matches ?? true }];
/**
 * The three calls of one exercise check (the blind solve, the comparison, the step audit), each answered from the prompt it
 * gets, so the order of the two calls that run together does not matter. `computation` is both the blind program and the
 * step program, and `statedValues` are final values.
 */
const check = (v: Verdict) => {
  const step = (input: { prompt: string }) => {
    const data = input.prompt.includes('REFERENCE ANSWERS')
      ? { items: itemsOf(v, input.prompt), resultsAgree: v.resultsAgree ?? true, agrees: v.agrees ?? true, problems: v.problems ?? [], statedValues: (v.statedValues ?? []).map((x) => ({ ...x, final: true })), computation: v.stepProgram ?? v.computation ?? '', dataProblems: [] }
      : input.prompt.includes('Return JSON with steps:')
        ? { steps: v.steps ?? [] }
        : { items: v.asked ?? [{ request: 'Calcola.', answer: v.independentAnswer ?? '1' }], computation: v.computation ?? '', wellPosed: v.wellPosed ?? true, wellPosedReason: v.wellPosedReason ?? 'I dati determinano una sola risposta.', dataProblems: v.dataProblems ?? [], consistency: v.consistency ?? '' };
    return { structured: data as never, text: JSON.stringify(data), usage: usageOf(10, 10) };
  };
  return [step, step, step];
};
/** The reconcile step's answer when it explains no mismatch: every one stands. */
const stands = answer({ mismatches: [], programs: [] });
/** The reviewer's answer: one call with the item table, as `verifyPrompt` asks it. */
const review = (v: Verdict) => (input: { prompt: string }) => {
  const data = { ...posed, independentAnswer: '1', resultsAgree: true, agrees: true, problems: [], ...v, items: itemsOf(v, input.prompt) };
  return { structured: data as never, text: JSON.stringify(data), usage: usageOf(10, 10) };
};
/** The editor's answer to a formatting repair: the three parts as plain text. */
const questionText = (statement: string, hint: string, solution: string) => () => ({ text: `@@@ statement\n${statement}\n@@@ hint\n${hint}\n@@@ solution\n${solution}`, usage: usageOf(10, 10) });
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
    const [solve, ...rest] = check({});
    fake.next((input) => { edit(id)(); return solve(input); }, ...rest);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { stale: true });
    assert.equal(row(id).status, 'draft');
    assert.equal(row(id).statement, "Testo dell'autrice");
    assert.equal(issues().length, 0);
  });

  test('verify: without an edit the question is verified and rev moves on', async () => {
    const id = q();
    fake.next(...check({}));
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
    fake.next(() => { edit(id)(); return { text: examText([{ number: '1', statement: 'Calcola.', solution: 'Fatto.' }]), usage: usageOf(1, 1) }; });
    const r = await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.deepEqual(r, { stale: true });
    assert.equal(row(id).statement, "Testo dell'autrice");
    assert.match(issues()[0].suggestion, /Fatto\./);
  });

  test('import: applied when nobody edited', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(examRead({ number: '1', statement: 'Calcola.', solution: 'Fatto.' }));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(row(id).statement, 'Calcola.');
    assert.equal(row(id).rev, 2);
  });

  test('import: text that would not render gets one formatting repair', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(examRead({ number: '1', statement: 'Calcola $\\lim_{x\\to 0} f(x).', solution: 'Vale $1$.' }), questionText('Calcola $\\lim_{x\\to 0} f(x)$.', 'inventato', 'Vale $1$.'));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(row(id).statement, 'Calcola $\\lim_{x\\to 0} f(x)$.');
    assert.equal(row(id).hint, '');
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[1].prompt, /plain text, not JSON/);
  });

  test('import: the formatting repair keeps a backslash and a line break as written, and a malformed answer gets one repair turn', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(
      examRead({ number: '1', statement: 'Calcola $\\nu = 1. a) il valore.', solution: 'Vale $1$.' }),
      () => ({ text: 'Ecco il testo corretto.', usage: usageOf(10, 10) }),
      questionText('Calcola $\\nu = 1$.\n\na) il valore.', '', 'Vale $1$.'),
    );
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(row(id).statement, 'Calcola $\\nu = 1$.\n\na) il valore.', 'the backslash before n is not read as a line break');
    assert.equal(fake.calls.length, 3);
    assert.match(fake.calls[2].prompt, /text before the first/, 'the repair turn names the problem');
  });

  test('the question text parser: what it accepts and what it sends back', () => {
    assert.deepEqual(parseQuestionText('@@@ statement\nCalcola $\\nu$.\n\na) il valore\n@@@ hint\n@@@ solution\nVale $\\neq 0$.'), { ok: true, data: { statement: 'Calcola $\\nu$.\n\na) il valore', hint: '', solution: 'Vale $\\neq 0$.' } });
    const problem = (text: string) => { const r = parseQuestionText(text); assert.equal(r.ok, false, text); return (r as { problem: string }).problem; };
    assert.match(problem('@@@ statement\nA.\n@@@ solution\nB.'), /"@@@ hint" part is missing/);
    assert.match(problem('@@@ statement\nA.\n@@@ statement\nB.\n@@@ hint\n@@@ solution\nC.'), /two "@@@ statement" parts/);
    assert.match(problem('@@@ statement\n\n@@@ hint\n@@@ solution\nB.'), /statement is empty/);
    assert.match(problem('@@@ statement\nA.\n@@@ suggerimento\nB.\n@@@ hint\n@@@ solution\nC.'), /not a valid part header/);
    assert.match(problem('@@@ statement\nA.\n @@@ hint\n@@@ hint\n@@@ solution\nC.'), /not a valid part header/, 'an indented header is not part of the statement');
  });

  test('import: a formatting repair that adds a word is not applied', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(examRead({ number: '1', statement: 'Calcola $\\lim_{x\\to 0} f(x).', solution: 'Vale $1$.' }), questionText('Calcola $\\lim_{x\\to 0} f(x)$.', '', 'Vale $1$. acu'));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(fake.calls.length, 2, 'the editor answered in the plain-text format, so no repair turn was needed');
    assert.equal(row(id).statement, 'Calcola $\\lim_{x\\to 0} f(x).', 'the text before the repair stays');
    assert.equal(row(id).solution, 'Vale $1$.');
  });

  test('import: a formatting repair that answers with an empty solution keeps the worked solution', async () => {
    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const id = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo' });
    fake.next(examRead({ number: '1', statement: 'Calcola $\\lim_{x\\to 0} f(x).', solution: 'Vale $1$.' }), questionText('Calcola $\\lim_{x\\to 0} f(x)$.', '', ''));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(fake.calls.length, 2, 'the empty part parses, so only the word guard can refuse it');
    assert.equal(row(id).statement, 'Calcola $\\lim_{x\\to 0} f(x).', 'the repair is refused as a whole');
    assert.equal(row(id).solution, 'Vale $1$.');
  });
});

describe('1b. a formatting fix of question text changes no word or number', () => {
  const broken = String.raw`### Problema 2.\n\na) $\tau = RC = 22\,\mathrm{ms}$.\n\nc) $E = 0{,}742\,\mu\mathrm{J}$.`;
  const clean = String.raw`### Problema 2.

a) $\tau = RC = 22\,\mathrm{ms}$.

c) $E = 0{,}742\,\mu\mathrm{J}$.`;
  const lintIssue = (qid: string, category = 'compile:literal-escape') => {
    const id = newId();
    ctx.db.insert('review_issues', { id, project_id: P, node_id: null, question_id: qid, rev_id: null, source: 'lint', severity: 'blocker', category, quote: '', message: 'A literal backslash followed by n', suggestion: '', status: 'open', resolution: '', created_at: now() });
    return id;
  };

  test('a fix that appends a word leaves the text as it was and the issue open with the reason', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', statement: 'Calcola.', solution: broken });
    const iid = lintIssue(id);
    fake.next(answer({ statement: 'Calcola.', hint: '', solution: `${clean} acu` }));
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
    assert.equal((r as { skipped?: string }).skipped, 'the repair changed words or numbers');
    assert.equal(row(id).solution, broken);
    assert.equal(row(id).origin, 'authentic');
    const [issue] = issues(`id = '${iid}'`);
    assert.equal(issue.status, 'open');
    assert.match(issue.resolution, /^The AI fix was not applied: .*solution: it adds "acu"/);
  });

  test('a fix that returns an empty solution leaves the text and the issue open with the reason', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', statement: 'Calcola.', solution: broken });
    const iid = lintIssue(id);
    fake.next(answer({ statement: 'Calcola.', hint: '', solution: '' }));
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
    assert.equal((r as { skipped?: string }).skipped, 'the repair changed words or numbers');
    assert.equal(row(id).solution, broken);
    const [issue] = issues(`id = '${iid}'`);
    assert.equal(issue.status, 'open');
    assert.match(issue.resolution, /^The AI fix was not applied: solution: it removes /);
  });

  test('a fix that only sets line breaks is applied', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', statement: 'Calcola.', solution: broken });
    const iid = lintIssue(id);
    fake.next(answer({ statement: 'Calcola.', hint: '', solution: clean }));
    await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
    assert.equal(row(id).solution, clean);
    assert.equal(issues(`id = '${iid}'`)[0].status, 'fixed');
  });

  test('a fix for a rule that is about words (a leaked comment) may remove them', async () => {
    const id = q({ statement: 'Calcola. Come riportato nelle note.', solution: 'Vale 1.' });
    const iid = lintIssue(id, 'compile:meta-leak');
    fake.next(answer({ statement: 'Calcola.', hint: '', solution: 'Vale 1.' }));
    await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
    assert.equal(row(id).statement, 'Calcola.');
  });
});

describe('1c. a decision the author makes on an issue while the editor runs stays', () => {
  const broken = String.raw`### Problema 2.\n\na) $\tau = RC = 22\,\mathrm{ms}$.`;
  const clean = String.raw`### Problema 2.

a) $\tau = RC = 22\,\mathrm{ms}$.`;
  const lintIssue = (qid: string) => {
    const id = newId();
    ctx.db.insert('review_issues', { id, project_id: P, node_id: null, question_id: qid, rev_id: null, source: 'lint', severity: 'blocker', category: 'compile:literal-escape', quote: '', message: 'A literal backslash followed by n', suggestion: '', status: 'open', resolution: '', created_at: now() });
    return id;
  };
  const decide = (iid: string, status: string) => () => { ctx.db.run(`UPDATE review_issues SET status = ?, resolution = 'Decided by the author' WHERE id = ?`, status, iid); };
  const answering = (during: () => void, solution: string) => () => { during(); return { structured: { statement: 'Calcola.', hint: '', solution } as never, text: '{}', usage: usageOf(1, 1) }; };
  const state = (iid: string) => issues(`id = '${iid}'`)[0];

  for (const status of ['dismissed', 'accepted', 'fixed']) {
    test(`a refused repair does not reopen an issue the author marked ${status}`, async () => {
      const id = q({ kind: 'exam', origin: 'authentic', statement: 'Calcola.', solution: broken });
      const iid = lintIssue(id);
      fake.next(answering(decide(iid, status), `${clean} acu`));
      await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
      assert.equal(state(iid).status, status);
      assert.equal(state(iid).resolution, 'Decided by the author');
      assert.equal(row(id).solution, broken);
    });
  }

  test('a refused repair writes its reason on the issues that are still open and leaves the decided one', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', statement: 'Calcola.', solution: broken });
    const [a, b] = [lintIssue(id), lintIssue(id)];
    fake.next(answering(decide(a, 'dismissed'), `${clean} acu`));
    await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [a, b] }));
    assert.equal(state(a).status, 'dismissed');
    assert.equal(state(a).resolution, 'Decided by the author');
    assert.equal(state(b).status, 'open');
    assert.match(state(b).resolution, /^The AI fix was not applied/);
  });

  test('a repair that arrives after the author closed every issue is not applied', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', statement: 'Calcola.', solution: broken });
    const iid = lintIssue(id);
    fake.next(answering(decide(iid, 'dismissed'), clean));
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
    assert.deepEqual(r, { stale: true });
    assert.equal(row(id).solution, broken);
    assert.equal(state(iid).status, 'dismissed');
    assert.equal(state(iid).resolution, 'Decided by the author');
  });

  test('a repair that arrives while one issue is still open is applied and closes only that one', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', statement: 'Calcola.', solution: broken });
    const [a, b] = [lintIssue(id), lintIssue(id)];
    fake.next(answering(decide(a, 'accepted'), clean));
    await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [a, b] }));
    assert.equal(row(id).solution, clean);
    assert.equal(state(a).status, 'accepted');
    assert.equal(state(a).resolution, 'Decided by the author');
    assert.equal(state(b).status, 'fixed');
  });
});

describe('5b. a corrected solution of an authentic exam question leaves a trace', () => {
  const NUMERIC = 'Recomputing the final values in Python gives a different result: f_c is 3386.2754 Hz by the computation and 21,28 kHz in the solution.';
  const issue = (qid: string, message: string, source = 'verification') => {
    const id = newId();
    ctx.db.insert('review_issues', { id, project_id: P, node_id: null, question_id: qid, rev_id: null, source, severity: 'blocker', category: 'solution', quote: '', message, suggestion: '', status: 'open', resolution: '', created_at: now() });
    return id;
  };
  const fix = (id: string, iid: string, solution: string) => {
    fake.next(answer({ statement: 'Calcola $f_c$.', hint: '', solution }));
    return questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
  };

  test('the resolution says what changed, with the old value and the value the numeric check gives; the question is marked adapted', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', exam_group: 'Appello', number: '2', statement: 'Calcola $f_c$.', solution: 'a) $f_c = 21{,}28\\,\\mathrm{kHz}$.' });
    const iid = issue(id, NUMERIC);
    await fix(id, iid, 'a) $f_c = 3{,}386\\,\\mathrm{kHz}$.');
    assert.equal(row(id).origin, 'adapted');
    const [i] = issues(`id = '${iid}'`);
    assert.equal(i.status, 'fixed');
    assert.equal(i.resolution, `The printed solution was corrected by ${DEFAULT_ROUTES.editor.primary.model}: f_c was 21,28 kHz and the numeric check gives 3386.2754 Hz.`);
  });

  test('without numbers from the numeric check the resolution says the solution was rewritten, and by which model', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', exam_group: 'Appello', number: '2', statement: 'Calcola $f_c$.', solution: 'Vale 1.' });
    const iid = issue(id, 'The independent solution reaches a different result: 2');
    await fix(id, iid, 'Vale 2.');
    assert.equal(issues(`id = '${iid}'`)[0].resolution, `The printed solution was rewritten by ${DEFAULT_ROUTES.editor.primary.model}.`);
    assert.equal(row(id).origin, 'adapted');
  });

  test('a fix of the same text with other line breaks, or of a generated question, keeps the short resolution', async () => {
    const a = q({ kind: 'exam', origin: 'authentic', exam_group: 'Appello', number: '1', statement: 'Calcola $f_c$.', solution: 'Vale 1.\\n\\nFine.' });
    const ia = issue(a, 'A literal backslash followed by n', 'lint');
    await fix(a, ia, 'Vale 1.\n\nFine.');
    assert.match(issues(`id = '${ia}'`)[0].resolution, /^Rewritten by /);
    const g = q({ solution: 'Vale 1.' });
    const ig = issue(g, NUMERIC);
    await fix(g, ig, 'Vale 2.');
    assert.match(issues(`id = '${ig}'`)[0].resolution, /^Rewritten by /);
    assert.equal(row(g).origin, 'generated');
  });
});

describe('15. disagreement is a blocker', () => {
  test('a different result adds a blocker next to the listed problems, which are major at most', async () => {
    const a = q();
    fake.next(...check({ independentAnswer: '2', resultsAgree: false, agrees: false }), review({ independentAnswer: '2', resultsAgree: false, agrees: false }));
    await questionVerify(ctx, startTask('question.verify', { questionId: a }));
    assert.deepEqual(issues(`question_id = '${a}'`).map((i) => i.severity), ['blocker']);

    const b = q();
    const wrong = { independentAnswer: '2', resultsAgree: false, agrees: false, problems: [{ kind: 'wrong-value' as const, message: 'm', suggestion: 's' }] };
    fake.next(...check(wrong), review(wrong));
    await questionVerify(ctx, startTask('question.verify', { questionId: b }));
    assert.deepEqual(issues(`question_id = '${b}'`).map((i) => i.severity).sort(), ['blocker', 'major']);
    assert.equal(row(b).status, 'issue');

    // Same result, a wrong step: no extra blocker.
    const d = q();
    const gap = { independentAnswer: '1', resultsAgree: true, agrees: false, problems: [{ kind: 'wrong-method' as const, message: 'gap', suggestion: 's' }] };
    fake.next(...check(gap), review(gap));
    await questionVerify(ctx, startTask('question.verify', { questionId: d }));
    assert.deepEqual(issues(`question_id = '${d}'`).map((i) => i.severity), ['major']);
  });
});

describe('15b. numeric final answers are recomputed in the sandbox', () => {
  const circuit = 'Due resistori da 1 kΩ in parallelo. Calcola la resistenza equivalente.';
  const verdict = (o: Verdict) => check({ independentAnswer: '500 Ω', ...o });
  const program = 'r = 1 / (1 / 1000 + 1 / 1000)\nprint(f"R_eq = {r} ohm")';

  test('a computation that agrees adds a numeric check and costs no extra call', async () => {
    const id = q({ statement: circuit, solution: 'R = 500 Ω' });
    fake.next(...verdict({ computation: program, statedValues: [{ name: 'R_eq', value: '0.50 kΩ' }] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0, recomputed: 1, mismatches: 0 });
    assert.equal(fake.calls.length, 3, 'the solve, the comparison and the step audit');
    assert.equal(row(id).status, 'verified');
    assert.deepEqual(json<{ method: string; ok: boolean }[]>(row(id).checks, []).map((c) => [c.method, c.ok]), [['independent-solve', true], ['numeric', true], ['consistency', true]]);
    assert.equal(issues().length, 0);
  });

  test('a mismatch blocks without a second opinion, and the blocker names both numbers', async () => {
    const id = q({ statement: circuit, solution: 'R = 5 kΩ' });
    fake.next(...verdict({ computation: program, statedValues: [{ name: 'R_eq', value: '5.0 kΩ' }] }), stands);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 0, recomputed: 1, mismatches: 1 });
    assert.equal(fake.calls.length, 4, 'the code proved it: the reconcile step is asked, the reviewer is not');
    assert.match(fake.calls[3]!.prompt, /MISMATCHES[^\n]*\n- R_eq: blind printed 500\.0 ohm; the solution states 5\.0 kΩ/);
    assert.equal(row(id).status, 'issue');
    const [issue] = issues(`question_id = '${id}'`);
    assert.equal(issue.severity, 'blocker');
    assert.match(issue.message, /R_eq is 500\.0 ohm by the computation and 5\.0 kΩ in the solution/);
    assert.equal(json<{ method: string; ok: boolean }[]>(row(id).checks, []).find((c) => c.method === 'numeric')!.ok, false);
  });

  test('the step program catches a wrong intermediate value the final one does not show', async () => {
    const id = q({ statement: circuit, solution: 'Ogni ramo porta 1 kΩ; in parallelo 1/R = 1/1000 + 1/1000 = 0,005 S, quindi R = 500 Ω.' });
    fake.next(...check({ computation: 'g = 1/1000 + 1/1000\nprint(f"G = {g} S")\nprint(f"R_eq = {1/g} ohm")', statedValues: [{ name: 'R_eq', value: '500 Ω' }],
      items: undefined, steps: [] }).map((step) => (input: { prompt: string }) => {
      const out = step(input);
      // The comparison lists the intermediate conductance too, as not final.
      if (input.prompt.includes('REFERENCE ANSWERS')) (out.structured as { statedValues: unknown[] }).statedValues.unshift({ name: 'G', value: '0,005 S', final: false });
      return out;
    }), stands);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 0, recomputed: 2, mismatches: 1 });
    assert.match(issues(`question_id = '${id}'`)[0]!.message, /G is 0\.002 S by the computation and 0,005 S in the solution/);
  });

  test('a last digit off by three units blocks: the 0.1 % room of the final check does not clear what the step check found', async () => {
    // Injected into Fisica 15ce7430: Q2 = ΔU + W2 = 6235,5 J written as 6235,8 J.
    const id = q({ statement: 'Calcola Q2.', solution: 'Q2 = 6235,8 J' });
    fake.next(...check({ computation: 'print("Q2 = 6235.5 J")', statedValues: [{ name: 'Q2', value: '6235,8 J' }] }), stands);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 0, recomputed: 1, mismatches: 1 });
    assert.match(issues(`question_id = '${id}'`)[0]!.message, /Q2 is 6235\.5 J by the computation and 6235,8 J in the solution/);
  });

  test('a final value the blind program could not compare is not settled by the step program: the model\'s wrong value stands', async () => {
    // The blind program rounds, and its 0.5 agrees with the stated 0.55 only within its last printed digit; the step
    // program follows the solution and matches. Nothing proved the final value right.
    const id = q({ statement: 'Calcola m.', solution: 'm = 0,55 kg' });
    const wrong = { problems: [{ kind: 'wrong-value' as const, message: 'm vale 0,50 kg.', suggestion: 's' }], computation: 'print("m =", round(0.5, 1), "kg")', stepProgram: 'print("m = 0.55 kg")', statedValues: [{ name: 'm', value: '0,55 kg' }] };
    fake.next(...check(wrong), review(wrong));
    await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal(row(id).status, 'issue');
    assert.equal(fake.calls.length, 4, 'the wrong value rests on the model\'s word, so the reviewer is asked');
  });

  test('a value listed first as a step and again as the final answer is still checked as final', async () => {
    const id = q({ statement: 'Calcola m.', solution: 'm = 0,55 kg' });
    fake.next(...check({ computation: 'print("m = 0.5 kg")', stepProgram: 'print("m = 0.55 kg")' }).map((step) => (input: { prompt: string }) => {
      const out = step(input);
      if (input.prompt.includes('REFERENCE ANSWERS')) (out.structured as { statedValues: unknown[] }).statedValues = [{ name: 'm', value: '0,55 kg', final: false }, { name: 'm', value: '0,55 kg', final: true }];
      return out;
    }), stands);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 0, recomputed: 1, mismatches: 1 });
  });

  test('a name listed with two different values keeps each value\'s own mark', async () => {
    // The intermediate 9,02587 is not final; the final, wrongly written 9,10, is. Marking the first listing final would
    // check 9,02587 against the blind 9,02498 and never look at 9,10.
    const id = q({ statement: 'Quanti atomi?', solution: 'N ≈ 9,02587 × 10^23, cioè 9,10 × 10^23.' });
    fake.next(...check({ computation: 'print("N = 9.02498e23")', stepProgram: 'print("N = 9.02587e23")' }).map((step) => (input: { prompt: string }) => {
      const out = step(input);
      if (input.prompt.includes('REFERENCE ANSWERS')) (out.structured as { statedValues: unknown[] }).statedValues = [{ name: 'N', value: '9,02587 × 10^23', final: false }, { name: 'N', value: '9,10 × 10^23', final: true }];
      return out;
    }), stands);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal((r as { mismatches: number }).mismatches, 1, '9,10 against 9,02498 is a mismatch of the final value');
    assert.match(issues(`question_id = '${id}'`)[0]!.message, /9,10 × 10\^23 in the solution/);
    // Both programs print only the final value: neither listing can be tied to it, so nothing blocks on the numbers.
    const right = q({ statement: 'Calcola m.', solution: 'Prima m = 0,50 kg, poi m = 0,55 kg.' });
    fake.next(...check({ computation: 'print("m = 0.55 kg")' }).map((step) => (input: { prompt: string }) => {
      const out = step(input);
      if (input.prompt.includes('REFERENCE ANSWERS')) (out.structured as { statedValues: unknown[] }).statedValues = [{ name: 'm', value: '0,50 kg', final: false }, { name: 'm', value: '0,55 kg', final: true }];
      return out;
    }));
    assert.equal((await questionVerify(ctx, startTask('question.verify', { questionId: right })) as { ok: boolean }).ok, true);
  });

  test('a computation that throws is ignored and the model verdict stands', async () => {
    const id = q({ statement: circuit, solution: 'R = 500 Ω' });
    fake.next(...verdict({ computation: 'print(1 / 0)', statedValues: [{ name: 'R_eq', value: '500 Ω' }] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0 });
    assert.equal(row(id).status, 'verified');
    assert.deepEqual(json<{ method: string }[]>(row(id).checks, []).map((c) => c.method), ['independent-solve', 'consistency']);
  });

  test('a symbolic answer stays on the model check', async () => {
    const id = q();
    fake.next(...verdict({ computation: '', statedValues: [] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0 });
    assert.equal(fake.calls.length, 3);
    assert.match(fake.calls[0].prompt, /Empty for every other kind of answer/);
  });
});

describe('15c. the exercise check asks whether the problem is well posed', () => {
  const good = { ...posed, independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] as VerifyAnswer['problems'] };
  // Fisica E8.4: principal moments 3, 3 and 12 kg m^2 break the triangle inequality, and both models agree on the ellipsoid.
  const tensor = 'I tensore d\'inerzia è diag(3, 3, 12) kg m². Scrivi l\'ellissoide d\'inerzia.';
  const triangle = (a: number, b: number, c: number) => `I = sorted([${a}, ${b}, ${c}])\nprint("CONSISTENT" if I[2] <= I[0] + I[1] else f"INCONSISTENT: {I[2]} > {I[0]} + {I[1]}")`;

  test('the answer must carry the new fields: one without them does not parse', () => {
    assert.equal(verifySchema.safeParse({ ...good, consistency: 'print("CONSISTENT")' }).success, true);
    for (const field of ['wellPosed', 'wellPosedReason', 'dataProblems', 'consistency'] as const) {
      const { [field]: _left, ...rest } = good;
      assert.equal(verifySchema.safeParse(rest).success, false, field);
    }
    const g = { topics: [], difficulty: 'medio', statement: 's', hint: '', solution: 's', finalAnswer: '1' };
    assert.equal(generatedQuestionsSchema.safeParse({ questions: [{ ...g, solvable: true }] }).success, true);
    assert.equal(generatedQuestionsSchema.safeParse({ questions: [g] }).success, false);
  });

  test('the verdict: each failing field blocks on its own', () => {
    const consistent = { verdict: 'consistent', detail: 'CONSISTENT' } as const;
    const mismatch = { name: 'p2', stated: '140 kPa', computed: '170000 Pa' };
    assert.equal(verifyVerdict(good, null, consistent).ok, true);
    assert.equal(verifyVerdict(good, null, null).ok, true, 'no program: the prompt allows it for a problem with no numeric data');
    assert.equal(verifyVerdict({ ...good, problems: [{ kind: 'rigor', message: 'm', suggestion: 's' }] }, null, consistent).ok, true);
    assert.equal(verifyVerdict({ ...good, dataProblems: ['', ' '] }, null, consistent).ok, true, 'blank entries are not problems');
    const blocked: [string, ReturnType<typeof verifyVerdict>][] = [
      ['agrees', verifyVerdict({ ...good, agrees: false }, null, consistent)],
      ['resultsAgree', verifyVerdict({ ...good, resultsAgree: false }, null, consistent)],
      ['numeric mismatch', verifyVerdict(good, { compared: [mismatch], mismatches: [mismatch], complete: true }, consistent)],
      ['major problem', verifyVerdict({ ...good, problems: [{ kind: 'wrong-unit', message: 'm', suggestion: 's' }] }, null, consistent)],
      ['wellPosed', verifyVerdict({ ...good, wellPosed: false, wellPosedReason: 'Gli atomi di O risultano 3,75.' }, null, consistent)],
      ['dataProblems', verifyVerdict({ ...good, dataProblems: ['La massa molare 60 non è quella di C3H6O.'] }, null, consistent)],
      ['INCONSISTENT', verifyVerdict(good, null, { verdict: 'inconsistent', detail: 'INCONSISTENT: 12 > 3 + 3' })],
      ['program failed', verifyVerdict(good, null, { verdict: 'failed', detail: 'The consistency program failed: Timed out after 15 s' })],
    ];
    for (const [field, v] of blocked) assert.equal(v.ok, false, field);
    assert.equal(blocked[4]![1].data, "The statement's data do not determine one answer: Gli atomi di O risultano 3,75.");
    assert.equal(blocked[5]![1].data, 'Data problems: La massa molare 60 non è quella di C3H6O.');
    assert.equal(blocked[6]![1].data, 'The consistency check printed: INCONSISTENT: 12 > 3 + 3');
    assert.equal(blocked[7]![1].data, 'The consistency program failed: Timed out after 15 s');
    assert.equal(blocked[0]![1].data, null, 'a disagreement is not a data problem');
  });

  test('data the checker finds impossible are blocked without a second opinion: one data blocker is added', async () => {
    ctx.db.run(`UPDATE projects SET title = 'Fisica 1', subject = 'Fisica' WHERE id = ?`, P);
    const id = q({ statement: tensor, solution: 'L\'ellissoide è 3x²+3y²+12z²=1.' });
    const both = { independentAnswer: '3x²+3y²+12z²=1', wellPosed: false, wellPosedReason: 'I momenti principali violano la disuguaglianza triangolare.' };
    fake.next(...check(both));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal(fake.calls.length, 3, 'the data check stands: the reviewer cleared real data defects when it was asked');
    assert.match(fake.calls[0].prompt, /principal moments of inertia satisfy the triangle inequality/, 'a physics book gets the physics constraints');
    assert.equal(row(id).status, 'issue');
    assert.equal((r as { ok: boolean }).ok, false);
    const found = issues(`question_id = '${id}'`);
    assert.deepEqual(found.map((i) => [i.severity, i.category]), [['blocker', 'data']]);
    assert.match(found[0]!.message, /disuguaglianza triangolare/);
    assert.deepEqual(json<{ method: string; ok: boolean }[]>(row(id).checks, []).map((c) => [c.method, c.ok]), [['independent-solve', false], ['consistency', false]]);
  });

  test('in the real sandbox: an INCONSISTENT program and a crashing one block, a CONSISTENT one verifies', async () => {
    const run = async (consistency: string, reviewed = false) => {
      const id = q({ statement: tensor, solution: 'L\'ellissoide è 3x²+3y²+12z²=1.' });
      fake.next(...check({ consistency }), ...(reviewed ? [review({ consistency })] : []));
      await questionVerify(ctx, startTask('question.verify', { questionId: id }));
      return { status: row(id).status, issues: issues(`question_id = '${id}'`).map((i) => `${i.severity} ${i.category}: ${i.message}`), checks: json<{ method: string; ok: boolean; detail: string }[]>(row(id).checks, []) };
    };
    const bad = await run(triangle(3, 3, 12));
    assert.equal(bad.status, 'issue');
    assert.deepEqual(bad.issues, ['blocker data: The consistency check printed: INCONSISTENT: 12 > 3 + 3']);
    const crashed = await run('import sympy\nprint("CONSISTENT")');
    assert.equal(crashed.status, 'issue');
    assert.match(crashed.issues[0]!, /^blocker data: The consistency program failed: .*ModuleNotFoundError/);
    const calls = fake.calls.length;
    const fine = await run(triangle(3, 4, 5));
    assert.equal(fake.calls.length, calls + 3, 'nothing suspicious: no second opinion');
    assert.equal(fine.status, 'verified');
    assert.deepEqual(fine.issues, []);
    assert.deepEqual(fine.checks.find((c) => c.method === 'consistency'), { method: 'consistency', ok: true, detail: 'CONSISTENT' });
  });

  test('a data blocker stays without a reviewer; a doubt about the solution alone goes to the reviewer, whose own data check also counts', async () => {
    const a = q({ statement: tensor });
    fake.next(...check({ consistency: triangle(3, 3, 12) }));
    await questionVerify(ctx, startTask('question.verify', { questionId: a }));
    assert.equal(row(a).status, 'issue');
    assert.equal(fake.calls.length, 3);
    const b = q({ statement: tensor });
    const doubt = { problems: [{ kind: 'wrong-method' as const, message: 'Un passaggio non segue.', suggestion: 's' }] };
    fake.next(...check(doubt), review({ consistency: triangle(3, 3, 12) }));
    await questionVerify(ctx, startTask('question.verify', { questionId: b }));
    assert.equal(fake.calls.length, 7);
    assert.equal(row(b).status, 'issue', 'the reviewer cleared the step but its program found the data inconsistent');
    assert.deepEqual(issues(`question_id = '${b}'`).map((i) => i.category), ['data']);
    const c = q({ statement: tensor });
    fake.next(...check(doubt), review({}));
    await questionVerify(ctx, startTask('question.verify', { questionId: c }));
    assert.equal(row(c).status, 'verified');
  });
});

describe('15f. the Python recompute settles numbers, and a verified question files no issue', () => {
  const verdict = (o: Verdict) => check({ independentAnswer: '-', ...o });
  const minor = (message: string) => ({ kind: 'rigor' as const, message, suggestion: 's' });
  const checksOf = (id: string) => json<{ method: string; ok: boolean; detail: string }[]>(row(id).checks, []);

  test('a last-digit "different result" is not a blocker when the recompute matched every stated value (339 N, 79,9 %, 79,7 %)', async () => {
    const cases = [
      { id: '785e1c65', program: 'import math\nprint(f"R = {9.8*230/(5*math.tan(math.radians(53)))} N")', stated: [{ name: 'R', value: '339 N' }], model: '339,7 N' },
      { id: '4d3131a0', program: 'print(f"resa = {11.2/14.0074*100} %")', stated: [{ name: 'resa', value: '79,9 %' }], model: '80,0 %' },
      { id: 'fd4d6c96', program: 'print(f"m_teorica = {25.0757} g")\nprint(f"resa = {20.0/25.0757*100} %")', stated: [{ name: 'm_teorica', value: '25,08 g' }, { name: 'resa', value: '79,7 %' }], model: '79,8 %' },
    ];
    for (const c of cases) {
      const id = q({ statement: `Esercizio ${c.id}`, solution: `Risultato ${c.stated.map((v) => v.value).join(', ')}` });
      const calls = fake.calls.length;
      fake.next(...verdict({ independentAnswer: c.model, resultsAgree: false, agrees: false, problems: [minor(`L'ultima cifra è ${c.model}.`)], computation: c.program, statedValues: c.stated }));
      const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
      assert.equal((r as { ok: boolean }).ok, true, c.id);
      assert.equal(fake.calls.length, calls + 3, `${c.id}: the recompute settled it, so no second opinion`);
      assert.equal(row(id).status, 'verified', c.id);
      assert.deepEqual(issues(`question_id = '${id}'`), [], `${c.id}: no blocker, and the minor note files no issue`);
      assert.match(checksOf(id).find((k) => k.method === 'independent-solve')!.detail, /Minor notes: L'ultima cifra/, c.id);
    }
  });

  test('"9,02 × 10^23 atomi" is recomputed, and the model\'s wrong 9,03 does not block it', async () => {
    const id = q({ statement: 'Quanti atomi ci sono in 9,00 g di acqua?', solution: 'Gli atomi sono $9{,}02 \\times 10^{23}$.' });
    fake.next(...verdict({ independentAnswer: '9,03 × 10^23 atomi', resultsAgree: false, agrees: false, computation: 'print(f"N_atomi = {3*9.00/18.015*6.02214e23}")', statedValues: [{ name: 'N_atomi', value: '9,02 × 10^23 atomi' }] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0, recomputed: 1, mismatches: 0 });
    assert.equal(row(id).status, 'verified');
  });

  test('a real mismatch still blocks (Fisica 6e84f71e, 170 against 140 kPa)', async () => {
    const program = 'p2 = 200000 + 0.5*1000*(2**2 - 8**2)\nprint(f"p2 = {p2} Pa")';
    const id = q({ statement: 'Bernoulli: calcola p2.', solution: 'p2 = 140 kPa' });
    fake.next(...verdict({ computation: program, statedValues: [{ name: 'p2', value: '140 kPa' }] }), stands);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 0, recomputed: 1, mismatches: 1 });
    assert.match(issues(`question_id = '${id}'`)[0]!.message, /p2 is 170000\.0 Pa by the computation and 140 kPa in the solution/);
  });

  test('a verified question files no minor issue and loses its old open ones; a failed one files its minors with the rest', async () => {
    const id = q();
    ctx.db.insert('review_issues', { id: newId(), project_id: P, node_id: null, question_id: id, rev_id: null, source: 'verification', severity: 'minor', category: 'solution', quote: '', message: 'Segnaposto {{formula:@x}}.', suggestion: '', status: 'open', resolution: '', created_at: now() });
    fake.next(...verdict({ problems: [minor('Non dice che il piano è semplicemente connesso.'), minor('Nomina la norma.')] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal(row(id).status, 'verified');
    assert.deepEqual(issues(`question_id = '${id}'`), []);
    assert.match(checksOf(id)[0]!.detail, /Minor notes: Non dice che il piano è semplicemente connesso\. Nomina la norma\./);
    const bad = q();
    const failing: Verdict = { problems: [{ kind: 'answer-missing', message: 'Il risultato richiesto non è mai scritto.', suggestion: 's' }, minor('Nomina la norma.')] };
    fake.next(...verdict(failing), review(failing));
    await questionVerify(ctx, startTask('question.verify', { questionId: bad }));
    assert.deepEqual(issues(`question_id = '${bad}'`).map((i) => i.severity).sort(), ['major', 'minor']);
  });

  test('the prompt tells the checker what a formula reference is and explains each kind of problem', () => {
    const { system, prompt } = verifyPrompt({ language: 'it', statement: 's', solution: 'v' });
    assert.match(prompt, /\{\{formula:@key\}\}.*cross-references, not placeholders/s);
    for (const kind of PROBLEM_KINDS) assert.match(prompt, new RegExp(`^- ${kind}: `, 'm'), kind);
    assert.match(prompt, /answer-missing: .*Use it only when the statement asks for that item in so many words/);
    assert.match(system, /Do not report rigor or wording/);
  });
});

describe('15h. the model names the kind of each problem and the code sets its severity', () => {
  const good = { ...posed, independentAnswer: '1', resultsAgree: true, agrees: true, problems: [] as VerifyAnswer['problems'] };
  const problem = (kind: VerifyAnswer['problems'][number]['kind'], message = 'm') => ({ kind, message, suggestion: 's' });

  test('each kind maps to its severity, and a major kind blocks whatever the model\'s agrees says', () => {
    const severities = Object.fromEntries(PROBLEM_KINDS.map((k) => [k, problemSeverity(k)]));
    assert.deepEqual(severities, {
      'wrong-value': 'major', 'wrong-unit': 'major', 'answer-missing': 'major', 'inconsistent-statement': 'major', 'wrong-method': 'major',
      rigor: 'minor', wording: 'minor', other: 'minor',
    });
    for (const kind of PROBLEM_KINDS) {
      const v = verifyVerdict({ ...good, problems: [problem(kind)] }, null, null);
      assert.equal(v.ok, severities[kind] === 'minor', kind);
      assert.deepEqual(v.problems.map((p) => p.severity), [severities[kind]], kind);
    }
    // Fisica F1-4: the checker said agrees with "Q = 450R J" listed; the kind blocks it.
    assert.equal(verifyVerdict({ ...good, problems: [problem('wrong-unit', 'Q = 450R J non è in joule.')] }, null, null).ok, false);
    // A1: agrees false over two rigor nits, which stay notes.
    assert.equal(verifyVerdict({ ...good, agrees: false, problems: [problem('rigor'), problem('wording')] }, null, null).ok, true);
    assert.equal(verifyVerdict({ ...good, agrees: false }, null, null).ok, false, 'a disagreement with nothing named still blocks');
  });

  test('a wrong-value problem is dropped when the recompute compared every stated value without a mismatch, and kept otherwise', () => {
    const match = { name: 'x', stated: '2,7017', computed: '2.70178' };
    const settled = { compared: [match], mismatches: [], complete: true };
    const wrongValue = { ...good, resultsAgree: false, agrees: false, problems: [problem('wrong-value', '2,7017 è troncato.'), problem('rigor', 'Nomina la norma.')] };
    const v = verifyVerdict(wrongValue, settled, null);
    assert.equal(v.ok, true);
    assert.deepEqual(v.problems.map((p) => p.message), ['Nomina la norma.']);
    assert.equal(verifyVerdict(wrongValue, { ...settled, complete: false }, null).ok, false, 'a recompute that could not read every value settles nothing');
    assert.equal(verifyVerdict(wrongValue, null, null).ok, false, 'no recompute: the model\'s word stands');
    assert.equal(verifyVerdict({ ...wrongValue, problems: [problem('wrong-unit')] }, settled, null).ok, false, 'only wrong-value is settled by the numbers');
  });

  test('in the handler: a wrong-value cleared by the recompute files nothing and makes no second call; an answer-missing blocks', async () => {
    const id = q({ statement: 'Calcola il rapporto.', solution: 'Il rapporto è 3,331.' });
    const calls = fake.calls.length;
    fake.next(...check({ independentAnswer: '3,330', resultsAgree: false, agrees: false, problems: [problem('wrong-value', '40,00/12,01 = 3,330, non 3,331.')], computation: 'print(f"r = {40.00/12.01}")', statedValues: [{ name: 'r', value: '3,331' }] }));
    assert.deepEqual(await questionVerify(ctx, startTask('question.verify', { questionId: id })), { ok: true, problems: 0, recomputed: 1, mismatches: 0 });
    assert.equal(fake.calls.length, calls + 3);
    assert.equal(row(id).status, 'verified');
    assert.deepEqual(issues(`question_id = '${id}'`), []);

    const missing = q({ statement: 'Bilancia la reazione e calcola la massa.', solution: 'La massa è 3 g.' });
    const a: Verdict = { problems: [problem('answer-missing', 'L\'equazione bilanciata non è mai scritta.')] };
    fake.next(...check(a), review(a));
    await questionVerify(ctx, startTask('question.verify', { questionId: missing }));
    assert.equal(row(missing).status, 'issue');
    assert.deepEqual(issues(`question_id = '${missing}'`).map((i) => [i.severity, i.message]), [['major', 'L\'equazione bilanciata non è mai scritta.']]);
  });

  test('an answer written before problem kinds still parses: a minor reads as other, anything above blocks as wrong-method', () => {
    const old = verifySchema.parse({ ...good, consistency: '', problems: [
      { severity: 'minor', message: 'a', suggestion: 's' }, { severity: 'major', message: 'b', suggestion: 's' }, { severity: 'blocker', message: 'c', suggestion: 's' },
    ] });
    assert.deepEqual(old.problems.map((p) => p.kind), ['other', 'wrong-method', 'wrong-method']);
    assert.deepEqual(verifySchema.parse({ ...good, problems: [{ kind: 'rigor', severity: 'major', message: 'a', suggestion: 's' }] }).problems, [{ kind: 'rigor', message: 'a', suggestion: 's' }], 'the model\'s own severity is ignored');
    assert.equal(verifySchema.safeParse({ ...good, problems: [{ kind: 'notation', message: 'a', suggestion: 's' }] }).success, false);
    const sent = JSON.stringify(toProviderSchema(verifySchema));
    assert.doesNotMatch(sent, /severity/, 'the model is not asked for a severity');
    assert.match(sent, /"wrong-value"/);
  });
});

describe('15i. the check lists the requested items with a quote of the solution, and redoes every step', () => {
  // Chimica 417816a9 (CH-1): asked to balance the equation, the solution names the coefficients one by one and never writes it.
  const balance = { statement: 'Bilancia l\u2019equazione $\\mathrm{Ca_3(PO_4)_2+SiO_2+C\\rightarrow P_4+CaSiO_3+CO}$.', solution: 'Si pongono $2$ unità di $\\mathrm{Ca_3(PO_4)_2}$ e $6\\,\\mathrm{SiO_2}$. Il controllo degli atomi dà coefficienti bilanciati.' };
  const item = (o: Partial<CheckedItem>): CheckedItem => ({ request: 'Bilancia l\u2019equazione', answer: '2Ca3(PO4)2 + 6SiO2 + 10C → P4 + 6CaSiO3 + 10CO', quote: '', stated: true, matches: true, ...o });

  test('a quote is found whatever the markup, spacing, dashes and case; one that is not in the solution is not', () => {
    const solution = 'Come funzione $f:\\operatorname{dom}(f)\\to\\mathbb{R}$, $f$ non è suriettiva poiché il valore $2$ non viene mai assunto.';
    assert.equal(quoteFound('come funzione $f:\\operatorname{dom}(f)\\to\\mathbb{R}$, $f$ non è suriettiva', solution), true, 'Analisi 1 366e682c: the model lowercased the first word');
    assert.equal(quoteFound('$\\Delta p = J = 2{,}0\\,\\mathrm{kg\\,m/s}$', 'Quindi $\\Delta p=J=2,0\\ \\text{kg m/s}$.'), true);
    assert.equal(quoteFound('$x = −3$', 'Si ha $x=-3$.'), true);
    assert.equal(quoteFound('Come funzione … non è suriettiva', solution), true, 'an ellipsis skips text');
    assert.equal(quoteFound('non è suriettiva … Come funzione', solution), false, 'the pieces must come in order');
    assert.equal(quoteFound('L\u2019equazione bilanciata è $2Ca_3(PO_4)_2+6SiO_2+10C\\rightarrow P_4+6CaSiO_3+10CO$', balance.solution), false);
    assert.equal(quoteFound('  ', balance.solution), false);
  });

  test('each item becomes a problem: no quote or a made-up one in code, an answer not stated as asked or a different one on the model\u2019s word', () => {
    const found = (o: Partial<CheckedItem>) => itemProblems([item(o)], balance.solution).map((p) => [p.kind, p.evidence]);
    assert.deepEqual(found({ quote: 'Il controllo degli atomi dà coefficienti bilanciati.' }), []);
    assert.deepEqual(found({ quote: '' }), [['answer-missing', 'code']]);
    assert.deepEqual(found({ quote: 'L\u2019equazione bilanciata è 2Ca3(PO4)2 + ...' }), [['answer-missing', 'code']]);
    // Fisica c22031a1 (F1-7): "the change of momentum equals the impulse" quotes the solution but never gives the value.
    assert.deepEqual(found({ quote: 'Il controllo degli atomi dà coefficienti bilanciati.', stated: false }), [['answer-missing', 'model']]);
    assert.deepEqual(found({ quote: 'Il controllo degli atomi dà coefficienti bilanciati.', matches: false }), [['wrong-value', 'model']]);
    const [missing] = itemProblems([item({ quote: '' })], balance.solution);
    assert.match(missing!.message, /^The solution never states the answer to "Bilancia l\u2019equazione"\.$/);
    assert.match(missing!.suggestion, /10CO/);
    // A recompute that settled the numbers clears neither an answer the quote check found missing nor an item that differs:
    // nothing ties an item to the values it compared ("x = 1; y = 3" with only x listed), and its answer may be a classification.
    const settled = { compared: [{ name: 'x', stated: '1', computed: '1' }], mismatches: [], complete: true };
    const v = verifyVerdict({ ...posed, independentAnswer: '1', resultsAgree: true, agrees: true, problems: [{ kind: 'wrong-value', message: 'Arrotondamento.', suggestion: 's' }], items: [item({ quote: '' }), item({ request: 'Calcola y', answer: 'y = 2', quote: 'Il controllo degli atomi dà coefficienti bilanciati.', matches: false }), item({ request: 'La successione è crescente?', answer: 'decrescente; L = 1', quote: 'Il controllo degli atomi dà coefficienti bilanciati.', matches: false })] }, settled, null, balance.solution);
    assert.deepEqual(v.problems.map((p) => p.message.match(/^[^"]*"([^"]+)"/)?.[1] ?? p.message), ['Bilancia l\u2019equazione', 'Calcola y', 'La successione è crescente?'], 'the model\'s own wrong value is cleared, as in #139');
    assert.equal(v.ok, false);
  });

  test('in the handler: an answer the solution never states blocks in code, with no second opinion', async () => {
    const id = q(balance);
    fake.next(...check({ items: [item({ quote: '' })] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 1 });
    assert.equal(fake.calls.length, 3, 'proved in code: the reviewer is not asked');
    assert.deepEqual(issues(`question_id = '${id}'`).map((i) => [i.severity, i.message]), [['major', 'The solution never states the answer to "Bilancia l\u2019equazione".']]);
    assert.equal(row(id).status, 'issue');
  });

  test('an item the comparison leaves out is a doubt for the reviewer, not a silent pass', async () => {
    const id = q(balance);
    const quote = 'Il controllo degli atomi dà coefficienti bilanciati.';
    fake.next(...check({ asked: [{ request: 'Bilancia l\u2019equazione', answer: '…' }, { request: 'Indica i coefficienti', answer: '2, 6, 10, 1, 6, 10' }], items: [item({ quote })] }), review({ items: [item({ quote: '' })] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal(fake.calls.length, 4, 'the reviewer is asked');
    assert.equal(row(id).status, 'issue');
  });

  test('an item listed twice by the comparison does not stand in for the one it left out', async () => {
    const id = q(balance);
    const quote = 'Il controllo degli atomi dà coefficienti bilanciati.';
    fake.next(...check({ asked: [{ request: 'Bilancia l\u2019equazione', answer: '…' }, { request: 'Indica i coefficienti', answer: '2, 6, 10, 1, 6, 10' }], items: [item({ quote }), item({ quote })] }), review({ items: [item({ quote: '' })] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal(fake.calls.length, 4, 'the reviewer is asked');
    assert.equal(row(id).status, 'issue');
  });

  test('an answer named only in passing goes to the reviewer, whose own item table decides', async () => {
    const quote = 'Il controllo degli atomi dà coefficienti bilanciati.';
    const kept = q(balance);
    fake.next(...check({ items: [item({ quote, stated: false })] }), review({ items: [item({ quote, stated: false })] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: kept }));
    assert.equal(fake.calls.length, 4);
    assert.equal(row(kept).status, 'issue');
    assert.match(issues(`question_id = '${kept}'`)[0]!.message, /does not state the answer to "Bilancia l\u2019equazione" in the form asked/);
    const cleared = q(balance);
    fake.next(...check({ items: [item({ quote, stated: false })] }), review({ items: [item({ quote })] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: cleared }));
    assert.equal(row(cleared).status, 'verified');
  });

  test('the blind solve never sees the solution; a step the audit finds false blocks only when its quote is in the solution', async () => {
    // Fisica 24dbd9bb: Φ(R) = −∫ GM/s² ds = −GM/R, where the integral is already −GM/R.
    const statement = 'Una sfera omogenea di massa M e raggio R. Determina il potenziale gravitazionale.';
    const solution = 'Pertanto $\\Phi(R)=-\\int_\\infty^R GM/s^2\\,ds=-GM/R$. All\u2019interno $\\Phi(r)=-GM(3R^2-r^2)/(2R^3)$.';
    const wrong = { quote: '$\\Phi(R)=-\\int_\\infty^R GM/s^2\\,ds=-GM/R$', work: '+GM/R', holds: false, why: 'L\u2019integrale vale già −GM/R: con il segno meno davanti si ottiene +GM/R.' };
    const id = q({ statement, solution });
    fake.next(...check({ steps: [wrong, { quote: 'All\u2019interno', work: '', holds: true, why: '' }] }), review({ problems: [{ kind: 'wrong-method', message: 'Il segno di Φ(R) è sbagliato.', suggestion: 's' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    const solve = fake.calls.find((c) => !c.prompt.includes('GIVEN SOLUTION'))!;
    assert.match(solve.prompt, /^STATEMENT:\nUna sfera omogenea/);
    assert.doesNotMatch(solve.prompt, /GM\/s\^2/, 'the solve call sees the statement only');
    assert.equal(row(id).status, 'issue');
    const made = q({ statement, solution });
    fake.next(...check({ steps: [{ ...wrong, quote: '$\\Phi(R)=+GM/R$' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: made }));
    assert.equal(row(made).status, 'verified', 'a step the solution does not contain was made up');
  });
});

describe('15j. a recompute mismatch gets one reconcile step, decided in code', () => {
  // Chimica bdab177b, 2026-11-20: a program printed ΔV in m³ under the label L.
  const texts = { statement: 'Un gas si espande da $2{,}0\\,\\mathrm{L}$ a $5{,}5\\,\\mathrm{L}$ contro $1{,}20\\,\\mathrm{atm}$. Calcola $\\Delta U$ ($q = 450\\,\\mathrm{J}$).', solution: 'La variazione di volume è $\\Delta V=3{,}5\\,\\mathrm{L}$; $\\Delta U=24{,}4\\,\\mathrm{J}$.' };
  const blind = 'dV = 5.5 - 2.0\nprint("DeltaV =", dV*1e-3, "L")';
  const open: OpenMismatch[] = [{ name: 'DeltaV', stated: '3.5 L', computed: '0.0035 L', program: 'blind' }];
  const stated = [{ name: 'DeltaV', value: '3.5 L' }];
  const programs = { blind: { code: blind, output: 'DeltaV = 0.0035 L', relative: 1e-3 }, steps: { code: '', output: '' } };
  const ran: string[] = [];
  const run = (stdout: string) => async (code: string) => { ran.push(code); return { ok: true, stdout, version: 'test' }; };
  const answering = (cause: string, code: string) => async () => ({ data: { mismatches: [{ name: 'DeltaV', cause, why: 'Il programma stampa m³ con l\'etichetta L.' }], programs: [{ program: 'blind', code }] } as never });

  test('a corrected program may not type the value it checks, nor add a number neither text gives; a change of unit and a constant of the solution are allowed', () => {
    const m = open[0]!;
    assert.equal(correctionRefused(blind, 'print("DeltaV =", 3.5, "L")', m, texts), 'the corrected program types the stated value 3.5');
    assert.equal(correctionRefused(blind, 'dV = 5.5 - 2.0 + 0.0002\nprint("DeltaV =", dV, "L")', m, texts), 'the corrected program adds the number 0.0002, which neither text gives');
    assert.equal(correctionRefused(blind, 'dV = 5.5 - 2.0\nprint("DeltaV =", dV*1e-3*1000, "L")', m, texts), null, 'a power of ten is a change of unit');
    // Chimica f9d7a036: E° = 0,337 V is in the solution, not in the statement.
    const nernst = { name: 'E', stated: '0.269 V', computed: '0.2719 V' };
    const t2 = { statement: 'Calcola la f.e.m. con [Cu2+] = 4,99·10^-3 M.', solution: '$E = 0{,}337 - \\frac{0{,}0592}{2}\\log(1/4{,}99\\cdot10^{-3}) = 0{,}269\\ \\mathrm{V}$' };
    assert.equal(correctionRefused('E0 = 0.340\nc = 4.99e-3', 'E0 = 0.337\nc = 4.99e-3', nernst, t2), null);
    // A stated value the statement itself gives may be typed: it is a datum.
    assert.equal(correctionRefused('', 'x = 5.5', { name: 'x', stated: '5.5 L', computed: '0.0055 L' }, texts), null);
  });

  test('a mismatch is cleared only when its cause is not the solution and the corrected program prints the solution\'s value', async () => {
    const fixed = 'dV = 5.5 - 2.0\nprint("DeltaV =", dV, "L")';
    assert.deepEqual((await reconcileMismatches(texts, open, programs, stated, answering('unit-or-scale', fixed), run('DeltaV = 3.5 L'))).map((r) => [r.cause, r.cleared]), [['unit-or-scale', true]]);
    ran.length = 0;
    assert.deepEqual((await reconcileMismatches(texts, open, programs, stated, answering('solution-wrong', fixed), run('DeltaV = 3.5 L'))).map((r) => [r.cause, r.cleared]), [['solution-wrong', false]]);
    assert.deepEqual(ran, [], 'a solution the model calls wrong stays proved; nothing runs');
    const still = await reconcileMismatches(texts, open, programs, stated, answering('program-wrong', fixed), run('DeltaV = 3.3 L'));
    assert.deepEqual(still.map((r) => [r.cleared, r.refused]), [[false, 'the corrected program still prints 3.3 L']]);
    const typed = await reconcileMismatches(texts, open, programs, stated, answering('unit-or-scale', 'print("DeltaV = 3.5 L")'), run('DeltaV = 3.5 L'));
    assert.deepEqual(typed.map((r) => [r.cleared, r.refused]), [[false, 'the corrected program types the stated value 3.5']]);
    const both: OpenMismatch[] = [open[0]!, { ...open[0]!, program: 'steps' }];
    const named = async () => ({ data: { mismatches: [{ name: 'DeltaV (blind)', cause: 'unit-or-scale', why: 'm³.' }, { name: 'DeltaV (steps)', cause: 'solution-wrong', why: 'x' }], programs: [{ program: 'blind', code: fixed }] } as never });
    const twice = await reconcileMismatches(texts, both, { ...programs, steps: { code: blind, output: 'DeltaV = 0.0035 L' } }, stated, named, run('DeltaV = 3.5 L'));
    assert.deepEqual(twice.map((r) => [r.program, r.cause, r.cleared]), [['blind', 'unit-or-scale', true], ['steps', 'solution-wrong', false]], 'a name listed under both programs is told apart by the program');
    const silent = await reconcileMismatches(texts, open, programs, stated, async () => ({ data: { mismatches: [], programs: [] } as never }), run(''));
    assert.deepEqual(silent.map((r) => [r.cause, r.cleared]), [['unexplained', false]], 'a mismatch the answer does not explain stands');
  });

  test('in the handler: a value printed in another scale is reconciled and the exercise is verified; the numeric check says why', async () => {
    const id = q(texts);
    const reconcile = answer({ mismatches: [{ name: 'DeltaV', cause: 'unit-or-scale', why: 'Il programma stampa m³ con l\'etichetta L.' }], programs: ['blind', 'steps'].map((program) => ({ program, code: 'dV = 5.5 - 2.0\nprint("DeltaV =", dV, "L")' })) });
    // The helper gives one program as both the blind and the step program, so the mismatch is listed under both.
    fake.next(...check({ computation: blind, statedValues: [{ name: 'DeltaV', value: '3,5 L' }] }), reconcile);
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: true, problems: 0, recomputed: 1, mismatches: 0 });
    assert.equal(row(id).status, 'verified');
    assert.match(json<{ method: string; detail: string }[]>(row(id).checks, []).find((c) => c.method === 'numeric')!.detail, /Differences explained and recomputed: DeltaV \(unit-or-scale: /);
    // The same answer for a solution whose value is really wrong: the corrected program still disagrees, so it blocks.
    const wrong = q({ ...texts, solution: texts.solution.replace('3{,}5', '3{,}9') });
    fake.next(...check({ computation: blind, statedValues: [{ name: 'DeltaV', value: '3,9 L' }] }), reconcile);
    assert.deepEqual(await questionVerify(ctx, startTask('question.verify', { questionId: wrong })), { ok: false, problems: 0, recomputed: 1, mismatches: 1 });
  });

  test('no reconcile when the data check fails: the mismatch may come from data that do not fix one answer, and it stays', async () => {
    // Fisica 41d80bd6: the statement does not say which end of the rod is hit; reconciled, the blind program took the solution's side.
    const id = q(texts);
    fake.next(...check({ computation: blind, statedValues: [{ name: 'DeltaV', value: '3,5 L' }], wellPosed: false, wellPosedReason: 'Il verso non è determinato.' }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.equal((r as { mismatches: number }).mismatches, 1);
    assert.equal(fake.calls.length, 3, 'no reconcile call');
  });
});

describe('15k. one defect, one issue', () => {
  // Chimica 036788d3, 2026-11-20: four issues for one precipitate never named.
  const statement = 'Si mescolano nitrato d\'argento e cloruro di sodio. Scrivi l\'equazione ionica netta. Indica il precipitato e gli ioni spettatori.';
  const solution = 'L\'equazione ionica netta è $\\mathrm{Ag^+ + Cl^- \\rightarrow AgCl(s)}$. Gli ioni Na+ e NO3- si eliminano.';
  const items: CheckedItem[] = [
    { request: 'Scrivi l\'equazione ionica netta', answer: 'Ag+ + Cl- → AgCl(s)', quote: 'L\'equazione ionica netta è $\\mathrm{Ag^+ + Cl^- \\rightarrow AgCl(s)}$', stated: true, matches: true },
    { request: 'Indica il precipitato', answer: 'AgCl', quote: '', stated: false, matches: false },
  ];
  const missing: CheckProblem = { kind: 'answer-missing', evidence: 'model', message: 'La soluzione non indica esplicitamente il precipitato.', suggestion: 's' };

  test('an answer never stated is one problem, and the model\'s problem that says the same is dropped; another one stays', () => {
    const fromItems = itemProblems(items, solution);
    assert.deepEqual(fromItems.map((p) => [p.kind, p.evidence]), [['answer-missing', 'code']], 'no second problem saying it "differs: (nothing)"');
    const requests = items.map((i) => i.request);
    assert.equal(restates(missing, fromItems, requests), true);
    assert.equal(restates({ ...missing, kind: 'wrong-method' }, fromItems, requests), false, 'another kind is another problem');
    assert.equal(restates({ ...missing, message: 'Gli ioni spettatori non sono nominati.' }, fromItems, requests), false, 'another item');
    assert.equal(restates({ ...missing, message: 'La soluzione non scrive l\'equazione ionica netta.' }, fromItems, requests), false, 'a word shared by two requests names neither');
  });

  test('the "different result" blocker is filed only when a result differs, not for an answer that is missing', () => {
    const problems = itemProblems(items, solution);
    assert.equal(differentResultBlocker(false, [], items, problems, solution), false);
    assert.equal(differentResultBlocker(true, [], items, problems, solution), false);
    const differs = [items[0]!, { ...items[1]!, quote: 'Gli ioni Na+ e NO3- si eliminano.', stated: true }];
    assert.equal(differentResultBlocker(false, [], differs.map((i, n) => (n === 0 ? { ...i, matches: false } : i)), itemProblems(differs, solution), solution), true, 'a stated answer that differs');
    assert.equal(differentResultBlocker(false, [{ name: 'x', stated: '1', computed: '2' }], items, problems, solution), true, 'a numeric mismatch');
    assert.equal(differentResultBlocker(false, [], undefined, [], solution), true, 'no item table: the model\'s word');
  });

  test('in the handler: one issue for the precipitate, and the verdict does not change', async () => {
    const id = q({ statement, solution });
    fake.next(...check({ items, resultsAgree: false, agrees: false, problems: [missing] }));
    const r = await questionVerify(ctx, startTask('question.verify', { questionId: id }));
    assert.deepEqual(r, { ok: false, problems: 1 });
    assert.deepEqual(issues(`question_id = '${id}'`).map((i) => [i.severity, i.message]), [['major', 'The solution never states the answer to "Indica il precipitato".']]);
  });
});

describe('15l. the editor leaves correct text alone', () => {
  const blocker = (qid: string, message: string) => {
    const id = newId();
    ctx.db.insert('review_issues', { id, project_id: P, node_id: null, question_id: qid, rev_id: null, source: 'verification', severity: 'blocker', category: 'solution', quote: '', message, suggestion: 's', status: 'open', resolution: '', created_at: now() });
    return id;
  };
  const text = { statement: 'Calcola $\\Delta U$.', solution: 'Il lavoro è {{formula:@lavoro-di-espansione}}: $w=-4{,}2\\,\\mathrm{L\\,atm}$, $\\Delta V=3{,}5\\,\\mathrm{L}$.' };
  const notThere = { number: 1, inText: false, why: 'ΔV = 3,5 L è giusto: 0,0035 è lo stesso valore in m³.' };

  test('a problem the editor finds is not in the text: nothing is saved, the issue stays open with the reason, and the check after the fix does not run', async () => {
    const id = q({ ...text, status: 'issue' });
    const iid = blocker(id, 'Recomputing the final values in Python gives a different result: DeltaV is 0.0035 L by the computation and 3.5 L in the solution.');
    fake.next(answer({ ...text, hint: '', problems: [notThere] }));
    const runId = newId();
    const fix = startTask('question.revise', { questionId: id, issueIds: [iid] }, { runId, key: `qfix:${id}:1` });
    const fixed = await questionRevise(ctx, fix);
    assert.deepEqual(fixed, { skipped: 'The AI fix changed nothing', rev: 1 });
    assert.equal(row(id).status, 'issue');
    assert.equal(row(id).rev, 1);
    const [i] = issues(`id = '${iid}'`);
    assert.equal(i.status, 'open');
    assert.match(i.resolution, /^The AI fix found the text already right on this point and changed nothing for it: ΔV = 3,5 L è giusto/);
    const verify = startTask('question.verify', { questionId: id }, { runId, key: `qverify:${id}:1` });
    verify.deps = { [fix.task.key]: fixed };
    assert.deepEqual(await questionVerify(ctx, verify), { skipped: 'the fix changed no words or numbers' });
    assert.equal(fake.calls.length, 1, 'no check: the question keeps its open issue for the author');
    assert.match(fake.calls[0]!.system ?? '', /never mention the correction, the check/);
  });

  test('a rewrite for two problems, one of them not in the text: only the other is fixed, and the first stays open with the reason', async () => {
    const id = q({ ...text, status: 'issue' });
    const [a, b] = [blocker(id, 'DeltaV is 0.0035 L by the computation and 3.5 L in the solution.'), blocker(id, 'Il lavoro vale −4,2 L·atm, non −4,3.')];
    // The problems are numbered in the order the issues are read, so the answer takes the numbers from the prompt.
    fake.next((input: { prompt: string }) => {
      const n = (re: RegExp) => Number(new RegExp(`^(\\d+)\\. ${re.source}`, 'm').exec(input.prompt)![1]);
      return answer({ statement: text.statement, hint: '', solution: text.solution.replace('w=', 'w = '), problems: [{ ...notThere, number: n(/DeltaV/) }, { number: n(/Il lavoro/), inText: true, why: '' }] })();
    });
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [a, b] }));
    assert.deepEqual((r as { fixed: string[] }).fixed, [b]);
    assert.equal(issues(`id = '${a}'`)[0]!.status, 'open');
    assert.match(issues(`id = '${a}'`)[0]!.resolution, /^The AI fix found the text already right on this point and changed nothing for it: ΔV = 3,5 L/);
    assert.equal(issues(`id = '${b}'`)[0]!.status, 'fixed');
  });

  test('a rewrite that drops a formula reference no problem is about is not applied', async () => {
    const id = q({ ...text, status: 'issue' });
    const iid = blocker(id, 'Il lavoro vale −4,2 L·atm, non −4,3.');
    fake.next(answer({ statement: text.statement, hint: '', solution: text.solution.replace('{{formula:@lavoro-di-espansione}}', '$w=-P\\Delta V$') }));
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iid] }));
    assert.deepEqual(r, { skipped: 'The AI fix was not applied: it removed the formula reference {{formula:@lavoro-di-espansione}}, which no problem is about', rev: 1 });
    assert.equal(row(id).solution, text.solution);
    assert.equal(issues(`id = '${iid}'`)[0]!.status, 'open');
  });
});

describe('15g. a fix whose check fails is undone; a data issue on a statement that was not generated stays with the author', () => {
  const blocker = (qid: string, category = 'solution', message = 'Il risultato è sbagliato.') => {
    const id = newId();
    ctx.db.insert('review_issues', { id, project_id: P, node_id: null, question_id: qid, rev_id: null, source: 'verification', severity: 'blocker', category, quote: '', message, suggestion: 's', status: 'open', resolution: '', created_at: now() });
    return id;
  };
  const history = (id: string) => ctx.db.all<Record<string, any>>('SELECT * FROM question_revisions WHERE question_id = ? ORDER BY created_at, rowid', id);
  /** The fix task, then the check queued after it in the same run, as `generateSpecs` plans them. */
  async function fixThenCheck(id: string, issueIds: string[], editor: Record<string, string>, steps: ReturnType<typeof check>) {
    const runId = newId();
    fake.next(answer(editor));
    const fix = startTask('question.revise', { questionId: id, issueIds }, { runId, key: `qfix:${id}:1` });
    const fixed = await questionRevise(ctx, fix);
    const verify = startTask('question.verify', { questionId: id }, { runId, key: `qverify:${id}:1` });
    ctx.db.run('INSERT INTO task_deps (task_id, dep_id) VALUES (?, ?)', verify.task.id, fix.task.id);
    verify.deps = { [fix.task.key]: fixed };
    fake.next(...steps);
    return { fixed, checked: await questionVerify(ctx, verify) };
  }
  const failing: Verdict = { independentAnswer: '9,03', resultsAgree: false, agrees: false, problems: [{ kind: 'wrong-value', message: 'Ora il risultato è 9,03, ma è 9,02.', suggestion: 's' }] };
  /** A check that fails on the model's word: the three checker calls, then the reviewer, which agrees. */
  const fails = () => [...check(failing), review(failing)];
  const passes = () => check({ independentAnswer: '9,02' });

  test('the check after a fix fails: the text and status come back from question_revisions, and the closed issues reopen with the reason', async () => {
    const id = q({ status: 'issue', solution: 'Sono 9,02 atomi.' });
    const iid = blocker(id);
    const { checked } = await fixThenCheck(id, [iid], { statement: 'Calcola il limite.', hint: '', solution: 'Sono 9,03 atomi.' }, fails());
    assert.deepEqual(checked, { ok: false, restored: true, reopened: 1 });
    assert.equal(row(id).solution, 'Sono 9,02 atomi.');
    assert.equal(row(id).status, 'issue');
    const [i, ...rest] = issues(`question_id = '${id}'`);
    assert.equal(rest.length, 0, 'the failed check files nothing about the text it undid');
    assert.equal(i!.status, 'open');
    assert.match(i!.resolution, /^The AI fix was undone because the check after it failed: Ora il risultato è 9,03, ma è 9,02; the independent solution reaches a different result: 9,03/);
    assert.deepEqual(history(id).map((r) => [r.origin, r.solution]), [['revised', 'Sono 9,03 atomi.'], ['restored', 'Sono 9,02 atomi.']]);
  });

  test('once: the same check run again on the restored text does not undo anything more', async () => {
    const id = q({ status: 'issue', solution: 'Sono 9,02 atomi.' });
    const iid = blocker(id);
    const runId = newId();
    fake.next(answer({ statement: 'Calcola il limite.', hint: '', solution: 'Sono 9,03 atomi.' }));
    const fix = startTask('question.revise', { questionId: id, issueIds: [iid] }, { runId, key: `qfix:${id}:1` });
    const fixed = await questionRevise(ctx, fix);
    const verify = startTask('question.verify', { questionId: id }, { runId, key: `qverify:${id}:1` });
    ctx.db.run('INSERT INTO task_deps (task_id, dep_id) VALUES (?, ?)', verify.task.id, fix.task.id);
    verify.deps = { [fix.task.key]: fixed };
    fake.next(...fails(), ...fails());
    assert.equal((await questionVerify(ctx, verify) as { restored?: boolean }).restored, true);
    const again = await questionVerify(ctx, verify);
    assert.equal((again as { restored?: boolean }).restored, undefined);
    assert.equal(row(id).solution, 'Sono 9,02 atomi.');
    assert.deepEqual(history(id).map((r) => r.origin), ['revised', 'restored']);
  });

  test('a check after a fix that passes keeps the fix, and an author edit after the fix is never undone', async () => {
    const a = q({ status: 'issue', solution: 'Sono 9,03 atomi.' });
    await fixThenCheck(a, [blocker(a)], { statement: 'Calcola il limite.', hint: '', solution: 'Sono 9,02 atomi.' }, passes());
    assert.equal(row(a).solution, 'Sono 9,02 atomi.');
    assert.equal(row(a).status, 'verified');

    const b = q({ status: 'issue', solution: 'Sono 9,02 atomi.' });
    const iid = blocker(b);
    const runId = newId();
    fake.next(answer({ statement: 'Calcola il limite.', hint: '', solution: 'Sono 9,03 atomi.' }));
    const fix = startTask('question.revise', { questionId: b, issueIds: [iid] }, { runId, key: `qfix:${b}:1` });
    const fixed = await questionRevise(ctx, fix);
    updateQuestion(ctx, b, row(b).rev, { solution: 'Sono 9,025 atomi.' });
    const verify = startTask('question.verify', { questionId: b }, { runId, key: `qverify:${b}:1` });
    ctx.db.run('INSERT INTO task_deps (task_id, dep_id) VALUES (?, ?)', verify.task.id, fix.task.id);
    verify.deps = { [fix.task.key]: fixed };
    fake.next(...fails());
    await questionVerify(ctx, verify);
    assert.equal(row(b).solution, 'Sono 9,025 atomi.');
    assert.equal(row(b).status, 'issue');
  });

  test('an author edit of the origin after the fix, or a fix result of the older shape, is never undone', async () => {
    const c = q({ status: 'issue', solution: 'Sono 9,02 atomi.' });
    const runId = newId();
    fake.next(answer({ statement: 'Calcola il limite.', hint: '', solution: 'Sono 9,03 atomi.' }));
    const fix = startTask('question.revise', { questionId: c, issueIds: [blocker(c)] }, { runId, key: `qfix:${c}:1` });
    const fixed = await questionRevise(ctx, fix);
    updateQuestion(ctx, c, row(c).rev, { origin: 'adapted' });
    const verify = startTask('question.verify', { questionId: c }, { runId, key: `qverify:${c}:1` });
    ctx.db.run('INSERT INTO task_deps (task_id, dep_id) VALUES (?, ?)', verify.task.id, fix.task.id);
    verify.deps = { [fix.task.key]: fixed };
    fake.next(...fails());
    await questionVerify(ctx, verify);
    assert.deepEqual([row(c).origin, row(c).solution], ['adapted', 'Sono 9,03 atomi.']);

    // A fix that finished before this version returned { revised: true } alone.
    const d = q({ status: 'issue', solution: 'Sono 9,02 atomi.' });
    const run2 = newId();
    fake.next(answer({ statement: 'Calcola il limite.', hint: '', solution: 'Sono 9,03 atomi.' }));
    const fix2 = startTask('question.revise', { questionId: d, issueIds: [blocker(d)] }, { runId: run2, key: `qfix:${d}:1` });
    await questionRevise(ctx, fix2);
    const verify2 = startTask('question.verify', { questionId: d }, { runId: run2, key: `qverify:${d}:1` });
    ctx.db.run('INSERT INTO task_deps (task_id, dep_id) VALUES (?, ?)', verify2.task.id, fix2.task.id);
    verify2.deps = { [fix2.task.key]: { revised: true } };
    fake.next(...fails());
    const r = await questionVerify(ctx, verify2);
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal(row(d).solution, 'Sono 9,03 atomi.', 'the check files its issues as usual');
  });

  test('an authentic exam question: the editor never sees a data issue, and the statement stays', async () => {
    const id = q({ kind: 'exam', origin: 'authentic', exam_group: 'Appello', number: '1', status: 'issue', statement: 'Un fluido scorre con v = 2 m/s.', solution: 'p2 = 140 kPa' });
    const data = blocker(id, 'data', 'Manca l\'ipotesi di moto stazionario.');
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [data] }));
    assert.deepEqual(r, { skipped: 'a data issue on this statement stays with the author', rev: row(id).rev });
    assert.equal(fake.calls.length, 0);
    assert.equal(row(id).statement, 'Un fluido scorre con v = 2 m/s.');
    const [i] = issues(`id = '${data}'`);
    assert.equal(i!.status, 'open');
    assert.match(i!.resolution, /does not change the data of a statement that was not generated/);

    // With a solution issue too, only that one reaches the editor.
    const sol = blocker(id, 'solution', 'p2 vale 170 kPa.');
    fake.next(answer({ statement: 'Un fluido stazionario scorre con v = 2 m/s.', hint: '', solution: 'p2 = 170 kPa' }));
    await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [data, sol] }));
    assert.doesNotMatch(String(fake.calls[0]!.prompt), /stazionario/);
    assert.match(String(fake.calls[0]!.prompt), /p2 vale 170 kPa/);
    assert.equal(issues(`id = '${data}'`)[0]!.status, 'open');
    assert.equal(row(id).statement, 'Un fluido scorre con v = 2 m/s.', 'the editor added the hypothesis, and it is not saved');
    assert.equal(row(id).solution, 'p2 = 170 kPa');

    // The check queued after a fix that changed nothing makes no call, unless the author edited the question since.
    const e = q({ kind: 'exam', origin: 'authentic', exam_group: 'Appello', number: '2', status: 'issue', statement: 'Un gas ideale.', solution: 'p = 2 atm' });
    const skipped = await questionRevise(ctx, startTask('question.revise', { questionId: e, issueIds: [blocker(e, 'data', 'Manca la temperatura.')] }));
    const verify = startTask('question.verify', { questionId: e });
    verify.deps = { [`qfix:${e}:1`]: skipped };
    assert.deepEqual(await questionVerify(ctx, verify), { skipped: 'the fix changed no words or numbers' });
    assert.equal(fake.calls.length, 1);
    updateQuestion(ctx, e, row(e).rev, { statement: 'Un gas ideale a 300 K.' });
    fake.next(...check({ independentAnswer: '2 atm' }));
    await questionVerify(ctx, verify);
    assert.equal(fake.calls.length, 4, 'the edited text is checked');
    assert.equal(row(e).status, 'verified');

    // A formatting finding selected with the data issue: the formatter has nothing to change, so the check makes no call either.
    const f = q({ kind: 'exam', origin: 'authentic', exam_group: 'Appello', number: '3', status: 'issue', statement: 'Un gas ideale.', solution: 'p = 2 atm' });
    const format = newId();
    ctx.db.insert('review_issues', { id: format, project_id: P, node_id: null, question_id: f, rev_id: null, source: 'lint', severity: 'blocker', category: 'compile:math-mixed', quote: '', message: 'm', suggestion: '', status: 'open', resolution: '', created_at: now() });
    const formatted = await questionRevise(ctx, startTask('question.revise', { questionId: f, issueIds: [blocker(f, 'data', 'Manca la temperatura.'), format] }));
    assert.deepEqual(formatted, { skipped: 'the formatter changed nothing', rev: row(f).rev });
    const verifyAfter = startTask('question.verify', { questionId: f });
    verifyAfter.deps = { [`qfix:${f}:1`]: formatted };
    assert.deepEqual(await questionVerify(ctx, verifyAfter), { skipped: 'the fix changed no words or numbers' });
    assert.equal(fake.calls.length, 4);
  });
});

describe('15d. every rewrite of a question is kept in question_revisions', () => {
  const history = (id: string) => ctx.db.all<Record<string, any>>('SELECT * FROM question_revisions WHERE question_id = ? ORDER BY created_at, rowid', id);
  const topic = (key: string) => {
    const id = `${P.slice(0, 8)}-${key}`;
    ctx.db.insert('topics', { id, project_id: P, name: key, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    return id;
  };

  test('generation: a problem the writer marks as having no answer is not stored, and each stored one has its first revision', async () => {
    const t = topic('limiti');
    seedOutline([['c1', ['s1']]], { topicIds: [t] });
    const g = { topics: ['limiti'], difficulty: 'medio', hint: 'h', solution: 's' };
    fake.next(answer({ questions: [
      { ...g, statement: 'Calcola il limite.', finalAnswer: '1', solvable: true },
      { ...g, statement: 'Trova la formula del composto.', finalAnswer: 'Nessuna soluzione: i dati implicano 3,75 atomi di ossigeno', solvable: false },
    ] }));
    const task = startTask('practice.generate', { chapterId: 'c1', kind: 'exercise' });
    assert.deepEqual(await practiceGenerate(ctx, task), { generated: 1, reused: 0 });
    const [stored] = ctx.db.all<{ id: string; statement: string }>(`SELECT id, statement FROM questions WHERE origin = 'generated'`);
    assert.equal(stored!.statement, 'Calcola il limite.');
    const [first] = history(stored!.id);
    assert.deepEqual([first!.origin, first!.old_statement, first!.statement, first!.task_id], ['generated', null, 'Calcola il limite.', task.task.id]);
    assert.equal(first!.model, DEFAULT_ROUTES.exercises.primary.model);
  });

  test('an author edit and a back-port through updateQuestion record old and new text; a patch that keeps the text records nothing', () => {
    const id = q();
    updateQuestion(ctx, id, 1, { solution: 'Vale 2.' });
    updateQuestion(ctx, id, 2, { statement: 'Calcola il limite per x → 0.' }, { origin: 'backport' });
    updateQuestion(ctx, id, 3, { difficulty: 'facile' });
    updateQuestion(ctx, id, 4, { solution: 'Vale 2.' });
    const rows = history(id);
    assert.deepEqual(rows.map((r) => [r.origin, r.old_solution, r.solution, r.old_statement, r.statement]), [
      ['author', 'Vale 1.', 'Vale 2.', 'Calcola il limite.', 'Calcola il limite.'],
      ['backport', 'Vale 2.', 'Vale 2.', 'Calcola il limite.', 'Calcola il limite per x → 0.'],
    ]);
  });

  test('an AI fix, a page import and a code repair each record who wrote the text', async () => {
    const id = q();
    const issue = newId();
    ctx.db.insert('review_issues', { id: issue, project_id: P, node_id: null, question_id: id, rev_id: null, source: 'verification', severity: 'blocker', category: 'data', quote: '', message: 'Dati incoerenti.', suggestion: 'Correggi.', status: 'open', resolution: '', created_at: now() });
    fake.next(answer({ statement: 'Calcola il limite corretto.', hint: '', solution: 'Vale 1.' }));
    const fix = startTask('question.revise', { questionId: id, issueIds: [issue] });
    await questionRevise(ctx, fix);
    assert.deepEqual(history(id).map((r) => [r.origin, r.old_statement, r.statement, r.model, r.task_id]),
      [['revised', 'Calcola il limite.', 'Calcola il limite corretto.', DEFAULT_ROUTES.editor.primary.model, fix.task.id]]);

    seedResource(ctx, { projectId: P, id: 'r-exam', role: 'exams' });
    seedPage(ctx, 'r-exam', 0, 'Esercizio 1 testo', '# Esercizio 1\nCalcola.');
    const ex = q({ origin: 'authentic', kind: 'exam', resource_id: 'r-exam', page_from: 0, page_to: 0, exam_group: 'Giugno', number: '1', statement: 'grezzo', solution: '' });
    fake.next(examRead({ number: '1', statement: 'Calcola.', solution: 'Fatto.' }));
    await questionImport(ctx, startTask('question.import', { questionId: ex }));
    assert.deepEqual(history(ex).map((r) => [r.origin, r.old_statement, r.statement, r.old_solution, r.solution]), [['imported', 'grezzo', 'Calcola.', '', 'Fatto.']]);

    assert.equal(repairQuestionText(ctx, ex, (text) => text.replace('Calcola.', 'Calcola:')), true);
    assert.equal(repairQuestionText(ctx, ex, (text) => text), false);
    assert.deepEqual(history(ex).map((r) => r.origin), ['imported', 'format']);
  });

  test('deleting a question deletes its history', () => {
    const id = q();
    updateQuestion(ctx, id, 1, { solution: 'Vale 2.' });
    ctx.db.run('DELETE FROM questions WHERE id = ?', id);
    assert.equal(history(id).length, 0);
  });
});

describe('15e. checking again every generated question of a book', () => {
  // startRun wakes the queue; these tests only look at the planned tasks.
  beforeEach(() => { (ctx.queue as unknown as { wake(): void }).wake = () => undefined; });

  test('a review run with generatedQuestions verifies the generated questions in a chapter of the book, and nothing else', () => {
    seedOutline([['c1', ['s1']], ['c2', ['s2']]]);
    const a = q({ chapter_id: 'c1' });
    const b = q({ chapter_id: 'c2', kind: 'exam' });
    q({ chapter_id: null });
    q({ chapter_id: 'removed-chapter' });
    q({ chapter_id: 'c1', origin: 'authentic', kind: 'exam' });
    const run = startRun(ctx, P, 'review', { generatedQuestions: true });
    assert.deepEqual(ctx.db.all<{ kind: string; key: string }>('SELECT kind, key FROM tasks WHERE run_id = ? ORDER BY rowid', run.id).map((t) => `${t.kind} ${t.key}`), [`question.verify verify:${a}`, `question.verify verify:${b}`]);
  });

  test('a book without generated questions gets a clear refusal', () => {
    assert.throws(() => startRun(ctx, P, 'review', { generatedQuestions: true }), /no generated exercises/);
  });
});

describe('4. practice generation stages', () => {
  const topic = (key: string) => {
    const id = `${P.slice(0, 8)}-${key}`;
    ctx.db.insert('topics', { id, project_id: P, name: key, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    return id;
  };
  const gen = (n: number, kind: string) => ({ questions: Array.from({ length: n }, (_, i) => ({ topics: ['limiti'], difficulty: 'medio', statement: `${kind} ${i}`, hint: 'h', solution: 's', finalAnswer: '1', solvable: true })) });

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

describe('an index task queued before a source was excluded', () => {
  test('stops between two calls when the source is excluded while the first one runs', async () => {
    seedResource(ctx, { projectId: P, id: 'r-long', role: 'theory' });
    for (let i = 0; i < 151; i++) seedPage(ctx, 'r-long', i, `Pagina ${i + 1}`, `Titolo ${i + 1}\nTesto.`);
    // The author excludes the source while the first group of pages is with the model.
    fake.next(() => { ctx.db.run(`UPDATE resources SET included = 0 WHERE id = 'r-long'`); return answer({ entries: [{ title: 'Titolo 1', level: 1, page: 1 }] })(); });
    assert.deepEqual(await resourceIndex(ctx, startTask('resource.index', { resourceId: 'r-long' })), { skipped: 'excluded' });
    assert.equal(fake.calls.length, 1, 'the second group of pages is not sent');
    assert.equal(ctx.db.get(`SELECT 1 FROM source_indexes WHERE resource_id = 'r-long'`), undefined);
  });

  test('sends nothing of the excluded source to a model, and indexes it once it is included again', async () => {
    seedResource(ctx, { projectId: P, id: 'r-theory', role: 'theory', included: 0 });
    seedPage(ctx, 'r-theory', 0, 'Introduzione ai limiti', 'Introduzione ai limiti\nTesto.');
    const indexed = () => ctx.db.get(`SELECT 1 FROM source_indexes WHERE resource_id = 'r-theory'`);
    fake.next(answer({ entries: [{ title: 'Introduzione ai limiti', level: 1, page: 1 }] }));
    assert.deepEqual(await resourceIndex(ctx, startTask('resource.index', { resourceId: 'r-theory' })), { skipped: 'excluded' });
    assert.equal(fake.calls.length, 0, 'no model call for an excluded source');
    assert.equal(indexed(), undefined);
    ctx.db.run(`UPDATE resources SET included = 1 WHERE id = 'r-theory'`);
    assert.deepEqual(await resourceIndex(ctx, startTask('resource.index', { resourceId: 'r-theory' })), { origin: 'inferred', entries: 1 });
    assert.equal(fake.calls.length, 1);
    assert.ok(indexed());
  });
});

describe('4b. collection examples are found by search, not classified', () => {
  const topic = (key: string) => {
    const id = `${P.slice(0, 8)}-${key}`;
    ctx.db.insert('topics', { id, project_id: P, name: key, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    return id;
  };
  const gen = { questions: [{ topics: ['limiti'], difficulty: 'medio', statement: 'esercizio', hint: 'h', solution: 's', finalAnswer: '1', solvable: true }] };
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
    fake.next(examRead(ex(1), ex(2), ex(3)));
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
    // The history names the model that read the session, which the imports did not call themselves.
    assert.deepEqual(ctx.db.all<{ origin: string; model: string }>('SELECT origin, model FROM question_revisions WHERE question_id = ?', ids[0]).map((r) => [r.origin, r.model]), [['imported', DEFAULT_ROUTES.bulk.primary.model]]);
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
    fake.next(examRead(ex(2), ex(3)));
    const result = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
    assert.match(fake.calls[0].prompt, /Exercises to copy: 2, 3/);
    assert.ok(!fake.calls[0].prompt.includes('PAGINA 0'));
    assert.deepEqual(Object.keys((result as { extracted: object }).extracted), [b, c]);
    ctx.db.run(`UPDATE questions SET imported_at = '2024-01-02' WHERE id = ?`, b);
    assert.deepEqual(await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key })), { fallback: 'fewer than two questions to read' });
    assert.equal(fake.calls.length, 1);
    assert.equal(row(a).statement, "Testo dell'autrice");
  });

  test('an answer that misses, invents or repeats an exercise gets one repair turn, and falls back to one call per question when that fails too', async () => {
    const ids = session();
    for (const bad of [[ex(1), ex(2)], [ex(1), ex(2), ex(4)], [ex(1), ex(2), ex(2), ex(3)], [ex(1), ex(2), ex(3), ex(4)]]) {
      fake.next(examRead(...bad), examRead(...bad));
      const r = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
      assert.match((r as { fallback: string }).fallback, /invalid answer twice/);
    }
    assert.match(fake.calls[1].prompt, /Exercise 3 is missing/, 'the repair turn names the problem');
    const before = fake.calls.length;
    fake.next(examRead({ number: '1', statement: 'Calcola 1.', solution: 'Fatto 1.' }));
    await read([ids[0]], key, { fallback: 'x' });
    assert.equal(fake.calls.length, before + 1, 'the import made its own call');
    assert.match(fake.calls.at(-1)!.prompt, /Exercise number: 1/);
    assert.equal(row(ids[0]).statement, 'Calcola 1.');
  });

  test('a session read that keeps failing with a temporary error is retried, and on its last attempt gives way to the reads of the single questions', async () => {
    session();
    const hangUp = () => new Error('socket hang up');
    const attempt = (n: number) => { const t = startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }); t.task.attempts = n; return t; };
    fake.next(hangUp, hangUp, hangUp);
    await assert.rejects(sessionImport(ctx, attempt(1)), (e: unknown) => e instanceof TaskError && e.kind === 'temporary', 'the first attempt is left to the queue to retry');
    fake.next(hangUp, hangUp, hangUp);
    assert.match((await sessionImport(ctx, attempt(3)) as { fallback: string }).fallback, /socket hang up/);
  });

  test('on its last attempt the session read also gives way for an error that is not a TaskError, and never for a cancelled task or one that waits', () => {
    const last = { aborted: false, lastAttempt: true };
    assert.equal(sessionGivesWay(new Error('the page did not render'), last), true);
    assert.equal(sessionGivesWay(new TaskError('timeout'), last), true);
    assert.equal(sessionGivesWay(new Error('the page did not render'), { aborted: false, lastAttempt: false }), false, 'earlier attempts are left to the queue');
    assert.equal(sessionGivesWay(new Error('cancelled'), { aborted: true, lastAttempt: true }), false);
    assert.equal(sessionGivesWay(new TaskError('Usage limit reached', 'quota'), last), false);
    assert.equal(sessionGivesWay(new TaskError('Sign in again', 'auth'), last), false);
  });

  test('the exam answer parser: what it accepts and what it sends back', () => {
    const parse = examReadParser(['1', '2']);
    const ok = parse('@@@ statement 1\nPrimo.\n\na) Calcolare $\\nu$.\n@@@ solution 1\nVale $\\neq 0$.\n@@@ unreadable 2');
    assert.deepEqual(ok, { ok: true, data: { exercises: [{ number: '1', statement: 'Primo.\n\na) Calcolare $\\nu$.', solution: 'Vale $\\neq 0$.', readable: true }, { number: '2', statement: '', solution: '', readable: false }] } });
    assert.deepEqual(parse('@@@ statement 2\nB.\n@@@ statement 1\nA.'), { ok: true, data: { exercises: [{ number: '1', statement: 'A.', solution: '', readable: true }, { number: '2', statement: 'B.', solution: '', readable: true }] } }, 'the order of the answer does not matter, the result is in the listed order');
    assert.deepEqual(examReadParser(['7'])('@@@ statement\nSolo.'), { ok: true, data: { exercises: [{ number: '7', statement: 'Solo.', solution: '', readable: true }] } }, 'one exercise may leave its number off');
    const problem = (text: string, p = parse) => { const r = p(text); assert.equal(r.ok, false, text); return (r as { problem: string }).problem; };
    assert.match(problem('@@@ statement 1\nA.'), /Exercise 2 is missing/);
    assert.match(problem('Ecco.\n@@@ statement 1\nA.\n@@@ statement 2\nB.'), /text before the first/);
    assert.match(problem('@@@ statement 1\nA.\n@@@ statement 2\nB.\n@@@ statement 3\nC.'), /"3" is not one of the listed/);
    assert.match(problem('@@@ statement 1\nA.\n@@@ statement 1\nB.\n@@@ statement 2\nC.'), /two "statement" parts/);
    assert.match(problem('@@@ statement 1\nA.\n@@@ unreadable 1\n@@@ statement 2\nB.'), /both unreadable and given/);
    assert.match(problem('@@@ statement 1\n\n@@@ statement 2\nB.'), /Exercise 1 has no statement/);
    assert.match(problem('@@@ statement 1\nA.\n@@@ soluzione 1\nB.\n@@@ statement 2\nC.'), /not a valid part header/);
    assert.match(problem('@@@ statement 1\nA.\n  @@@ solution 1\nB.\n@@@ statement 2\nC.'), /not a valid part header/, 'an indented header is not part of the statement');
    assert.match(problem('@@@ statement 1\nA.\n\t@@@ solution 1\nB.\n@@@ statement 2\nC.'), /not a valid part header/);
    assert.match(problem('@@@ statement\nA.\n@@@ statement 2\nB.'), /has no exercise number/);
  });

  test('a wrong first answer is put right by the repair turn: two calls, the corrected text is stored', async () => {
    const ids = session();
    fake.next(examRead(ex(1), ex(2)), examRead(ex(1), ex(2), ex(3)));
    const result = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
    assert.equal(fake.calls.length, 2);
    assert.equal((result as { exercises: number }).exercises, 3);
    assert.deepEqual(await read(ids, key, result), [{ readable: true }, { readable: true }, { readable: true }]);
  });

  test('the July session of the acceptance run: line breaks, \\nu and a solution heading come out as the model wrote them', async () => {
    // The first model answer was a JSON string in which "\n" stayed two characters, so the stored text was one long line.
    const ids = session();
    const statement1 = 'Un amplificatore invertente ha $R_1 = 3{,}3\\,\\mathrm{k\\Omega}$ e $\\nu = 2$.\n\na) Calcolare il guadagno $G = v_{out}/v_{in}$.\n\nb) Calcolare la tensione di uscita $v_{out}$.';
    const solution1 = 'a) $G = -R_2/R_1 = -10$.\n\nb) $v_{out} = G v_{in} = -2{,}5\\,\\mathrm{V}$ e $G \\neq 0$.';
    fake.next(examRead(ex(1, { statement: statement1, solution: solution1 }), ex(2), ex(3)));
    const result = await sessionImport(ctx, startTask('question.session', { resourceId: 'r-exam', examGroup: 'Giugno' }, { key }));
    await read(ids, key, result);
    assert.equal(row(ids[0]).statement, statement1);
    assert.equal(row(ids[0]).solution, solution1);
    for (const id of ids) {
      assert.ok(!/\\[nt]\b|\\n\\n/.test(row(id).statement.replace(/\$[^$]*\$/g, '')), 'no literal \\n outside math');
      assert.deepEqual(lintQuestionText(row(id).statement, { file: 's', language: 'it' }).filter((f) => f.rule === 'literal-escape'), []);
    }
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
    fake.next(answer({ exercises: [] }), () => ({ text: 'Ecco gli esercizi: 1, 2 e 3.', usage: usageOf(1, 1) }));
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
    const verify = check({})[0]!;
    const dispatch = (input: { prompt: string }) => {
      if (/Exercises to copy/.test(input.prompt)) return { text: examText([ex(1), ex(2), ex(3)]), usage: usageOf(1, 1) };
      if (/^STATEMENT:/.test(input.prompt)) return verify(input);
      const body = { questions: [{ topics: ['limiti'], difficulty: 'medio', statement: 'Esercizio nuovo.', hint: 'h', solution: 's', finalAnswer: '1', solvable: true }] };
      return { structured: body as never, text: JSON.stringify(body), usage: usageOf(1, 1) };
    };
    for (let i = 0; i < 40; i++) fake.next(dispatch);
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
      fake.next(examRead(ex(1, { solution: '' }), ex(2, { solution: '' }), ex(3, { solution: '' })));
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
  const graph = { verdict: 'graph', reason: 'r', id: 'g1', title: 'Grafico', description: 'd', traces: [{ kind: 'function', fn: 'x^2', label: 'f', source: 'y = x^2' }], xDomain: [-2, 2], yDomain: [0, 4], xLabel: 'x', yLabel: 'y' };

  test('chapter.enrich only picks and enqueues; a retry reuses the children instead of picking again', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', 'Testo uno.');
    seedRevision('s2', 'Testo due.');
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ graphs: true, ide: true }), P);
    const t = startTask('chapter.enrich', { chapterId: 'c1' });
    fake.next(answer({ graphs: [{ sectionId: 's1', relation: 'y = x^2', purpose: 'parabola' }], ide: [{ sectionId: 's2', purpose: 'serie' }] }));
    const r = await chapterEnrich(ctx, t);
    assert.deepEqual(r, { picked: 2 });
    assert.deepEqual(taskKeys(t.task.runId).filter((k) => k.startsWith('enrich.')), ['enrich.graph:s1', 'enrich.ide:s2']);
    const child = json<Record<string, unknown>>(ctx.db.get<{ input: string }>(`SELECT input FROM tasks WHERE key = 'enrich.graph:s1'`)!.input, {});
    assert.deepEqual(child, { nodeId: 's1', purpose: 'parabola', relation: 'y = x^2' });
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
      graphs: [{ sectionId: 'x9', relation: 'y = x', purpose: 'inventata' }, { sectionId: 's1', relation: 'y = x', purpose: 'a' }, { sectionId: 's1', relation: 'y = x', purpose: 'doppione' }, { sectionId: 's2', relation: 'y = 2x', purpose: 'b' }],
      ide: [{ sectionId: 'x9', purpose: 'inventata' }, { sectionId: 's1', purpose: 'a' }, { sectionId: 's2', purpose: 'b' }],
    }));
    assert.deepEqual(await chapterEnrich(ctx, t), { picked: 4 });
    assert.deepEqual(taskKeys(t.task.runId).filter((k) => k.startsWith('enrich.')), ['enrich.graph:s1', 'enrich.graph:s2', 'enrich.ide:s1', 'enrich.ide:s2']);
  });

  test('a graph pick that states no relation is dropped, and the relation of a kept one reaches the graph prompt', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', 'Le classi di idrocarburi: alcani, alcheni, alchini.');
    seedRevision('s2', 'La legge di Hooke:\n\n$$F = k\\,x$$\n\nlega forza e allungamento.');
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ graphs: true, ide: false }), P);
    const t = startTask('chapter.enrich', { chapterId: 'c1' });
    fake.next(answer({ graphs: [{ sectionId: 's1', relation: ' ', purpose: 'confrontare le classi' }, { sectionId: 's2', relation: 'F = k x', purpose: 'Hooke' }], ide: [] }));
    assert.deepEqual(await chapterEnrich(ctx, t), { picked: 1 });
    assert.deepEqual(taskKeys(t.task.runId).filter((k) => k.startsWith('enrich.')), ['enrich.graph:s2']);
    assert.match(fake.calls.at(-1)!.prompt, /s2 \| .* \| formulas: F = k\\,x/, 'the picker sees the display formulas');
    fake.next(answer({ ...graph, traces: [{ kind: 'function', fn: 'x', label: 'F', source: 'F = k\\,x' }] }), checkerFits);
    await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's2', purpose: 'Hooke', relation: 'F = k x' }));
    assert.match(fake.calls.at(-2)!.prompt, /Relation to plot, as the section states it: F = k x/);
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
    const rev = seedRevision('s1', 'Testo uno: $$y = x^2$$');
    const t = startTask('enrich.graph', { nodeId: 's1', purpose: 'p' });
    fake.next(answer(graph), checkerFits);
    assert.deepEqual(await enrichGraph(ctx, t), { made: 1 });
    assert.deepEqual(await enrichGraph(ctx, t), { reused: true });
    assert.equal(fake.calls.length, 2, 'the drawing and its independent check');
    assert.equal(ctx.db.all(`SELECT 1 FROM enrichments WHERE kind = 'graph'`).length, 1);
    assert.equal(ctx.db.get<{ checked_rev_id: string }>(`SELECT checked_rev_id FROM enrichments`)!.checked_rev_id, rev, 'the graph remembers the section revision its checker read');
  });
  test('a graph that fails its checks is drawn once more with what failed, and a second failure saves nothing', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Le leggi di Charles, $V = k_1 T$, e di Gay-Lussac, $P = k_2 T$.');
    const twins = answer({ ...graph, traces: [{ kind: 'function', fn: 'x', label: 'Charles', source: 'V = k_1 T' }, { kind: 'function', fn: 'x', label: 'Gay-Lussac', source: 'P = k_2 T' }], yDomain: [-2, 2] });
    fake.next(twins, twins);
    const r = await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'gas' }));
    assert.equal(r.made, 0);
    assert.match(String(r.skipped), /failed its checks twice and was not saved: duplicate \("Gay-Lussac"\): same data as "Charles"/);
    assert.equal(fake.calls.length, 2, 'two drawings, and no checker call for a graph that failed the checks that cost nothing');
    assert.match(fake.calls[1]!.prompt, /A first draft failed its checks: duplicate \("Gay-Lussac"\)/);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0);
    assert.equal(ctx.db.all('SELECT 1 FROM review_issues').length, 0, 'nothing for the author to clean up');
    // A second drawing that passes is saved, with every check.
    fake.next(twins, answer({ ...graph, traces: [{ kind: 'function', fn: 'x', label: 'Charles', source: 'V = k_1 T' }, { kind: 'function', fn: '2*x', label: 'Gay-Lussac', source: 'P = k_2 T' }], yDomain: [-5, 5] }),
      answer({ traces: [{ label: 'Charles', expected: '', problem: '' }, { label: 'Gay-Lussac', expected: '', problem: '' }], fit: 'fits' }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'gas' })), { made: 1 });
    const row = ctx.db.get<{ status: string; checks: string }>(`SELECT status, checks FROM enrichments`)!;
    assert.equal(row.status, 'verified');
    assert.deepEqual(json<{ method: string; ok: boolean }[]>(row.checks, []).map((c) => [c.method, c.ok]), [['numeric', true], ['lint', true], ['source', true], ['independent', true]]);
  });
  test('a "none" verdict saves no graph: the section states no relation to plot', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Le classi di idrocarburi: alcani, alcheni, alchini.');
    fake.next(answer({ ...graph, verdict: 'none', reason: 'Una classificazione, nessuna relazione tra grandezze.', traces: [] }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'classi' })), { made: 0, skipped: 'The section states no relation a graph can show: Una classificazione, nessuna relazione tra grandezze.' });
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0);
    assert.equal(fake.calls.length, 1, 'no checker call');
  });

  test('a trace must quote a formula of the section: an invented one or a word of prose fails, and no checker is asked', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'La soluzione è $$y = \\frac{2}{2 - t^2}$$');
    const invented = answer({ ...graph, traces: [{ kind: 'function', fn: '1/(1-x^2/4)', label: 'y', source: 'y = \\frac{1}{1 - t^2/4}' }], yDomain: [0, 4] });
    const prose = answer({ ...graph, traces: [{ kind: 'function', fn: '1/(1-x^2/4)', label: 'y', source: 'La soluzione' }], yDomain: [0, 4] });
    fake.next(invented, prose);
    const r = await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'Cauchy' }));
    assert.match(String(r.skipped), /quotes "La soluzione", which the section does not contain/);
    assert.match(fake.calls[1]!.prompt, /quotes "y = \\frac\{1\}\{1 - t\^2\/4\}", which the section does not contain/);
    assert.equal(fake.calls.length, 2);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0);
  });
  test('the independent checker writes the expected curve; a trace whose data differs is drawn again with the expected curve', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo: la parabola $$y = x^2$$');
    // The label states no formula, so the lint cannot see that the curve is shifted up by one.
    fake.next(answer({ ...graph, traces: [{ kind: 'function', fn: 'x^2 + 1', label: 'parabola', source: 'y = x^2' }], yDomain: [0, 6] }),
      answer({ traces: [{ label: 'parabola', expected: 'x^2', problem: '' }], fit: 'fits' }),
      answer({ ...graph, traces: [{ kind: 'function', fn: 'x^2', label: 'parabola', source: 'y = x^2' }], yDomain: [0, 6] }),
      answer({ traces: [{ label: 'parabola', expected: 'x^2', problem: '' }], fit: 'fits' }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'parabola' })), { made: 1 });
    assert.match(fake.calls[1]!.prompt, /1\. parabola: a curve y = f\(x\) drawn for x from -2 to 2   \(source: y = x\^2\)/, 'the checker sees labels, intervals and sources, not the formulas');
    assert.doesNotMatch(fake.calls[1]!.prompt, /x\^2 \+ 1/);
    assert.match(fake.calls[2]!.prompt, /A first draft failed its checks: "parabola": \d+\/\d+ points differ from x\^2/, 'the second drawing is told the expected curve');
    const row = ctx.db.get<{ status: string; checks: string; spec: string }>('SELECT status, checks, spec FROM enrichments')!;
    assert.equal(row.status, 'verified');
    const independent = json<{ method: string; ok: boolean; detail: string; model?: string }[]>(row.checks, []).find((c) => c.method === 'independent')!;
    assert.match(independent.detail, /matches x\^2/);
    assert.ok(independent.model, 'the check names the model that wrote the expected curve');
    assert.deepEqual(json<{ traces: { fn: string; source: string }[] }>(row.spec, { traces: [] }).traces.map((t) => [t.fn, t.source]), [['x^2', 'y = x^2']], 'the spec is kept with the graph');
  });
  test('a checker that finds no relation for the graph, or a contradiction, fails the check', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo: la parabola $$y = x^2$$');
    const drawn = answer({ ...graph, traces: [{ kind: 'function', fn: 'x^2', label: 'y = x^2', source: 'y = x^2' }] });
    const twice = async (check: ReturnType<typeof answer>) => {
      fake.next(drawn, check, drawn, check);
      return String((await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'parabola', force: true }))).skipped);
    };
    assert.match(await twice(answer({ traces: [{ label: 'y = x^2', expected: 'x^2', problem: '' }], fit: 'not-a-function-graph' })), /finds no relation in the section/);
    assert.match(await twice(answer({ traces: [{ label: 'y = x^2', expected: 'x^2', problem: 'Il testo chiama y la velocità, l\'asse dice spazio.' }], fit: 'fits' })), /matches x\^2 .*problem: Il testo chiama y la velocità/);
    // An answer that leaves traces out checked only part of the graph.
    assert.match(await twice(answer({ traces: [], fit: 'fits' })), /The checker answered for 0 of 1 traces/);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0);
  });

  test('the checker is told where each trace lies, so a branch on the wrong side of the axis is a contradiction it can name', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il valore assoluto: $$|x| = -x \\text{ per } x < 0$$ e un punto angoloso in $x = 0$.');
    const branch = (domain: number[]) => answer({ ...graph, xDomain: [-5, 5], yDomain: [-6, 6], traces: [
      { kind: 'function', fn: '-x', label: 'y = -x (ramo sinistro, x < 0)', source: '|x| = -x', domain },
      { kind: 'points', label: 'Punto angoloso', source: 'x = 0', points: [{ x: 0, y: 0 }] },
    ] });
    const verdict = (problem: string) => answer({ traces: [{ label: 'y = -x', expected: '-x', problem }, { label: 'Punto angoloso', expected: '', problem: '' }], fit: 'fits' });
    fake.next(branch([0, 5]), verdict('Il ramo sinistro è disegnato per x da 0 a 5.'), branch([-5, 0]), verdict(''));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'modulo' })), { made: 1 });
    assert.match(fake.calls[1]!.prompt, /1\. y = −x \(ramo sinistro, x < 0\): a curve y = f\(x\) drawn for x from 0 to 5/, 'the label as the reader shows it, with a minus sign');
    assert.match(fake.calls[1]!.prompt, /2\. Punto angoloso: points \(0, 0\)/);
    assert.match(fake.calls[1]!.system ?? '', /only for a contradiction/);
    assert.match(fake.calls[2]!.prompt, /problem: Il ramo sinistro è disegnato per x da 0 a 5/);
    assert.match(fake.calls[3]!.prompt, /drawn for x from -5 to 0/);
  });

  test('a constant fitted to different values in the traces of one graph fails the check; one value for all passes', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Energia reticolare: $$U = -\\frac{k\\,|z_+ z_-|}{d}$$');
    const traces = (factors: number[]) => factors.map((f, k) => ({ kind: 'function', fn: `-${f}/x`, label: `Cariche ±${k + 1}`, source: 'U = -\\frac{k\\,|z_+ z_-|}{d}' }));
    const lattice = (factors: number[]) => answer({ ...graph, xDomain: [0.5, 4], yDomain: [-20, 0], traces: traces(factors) });
    // What the checker wrote for the published graph: the charges squared, with one unknown k.
    const expected = answer({ traces: ['-C/x', '-4*C/x', '-9*C/x'].map((e, k) => ({ label: `Cariche ±${k + 1}`, expected: e, problem: '' })), fit: 'fits' });
    fake.next(lattice([1, 2, 3]), expected, lattice([1, 4, 9]), expected);
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'reticolo' })), { made: 1 });
    assert.match(fake.calls[2]!.prompt, /C is fitted to 1 on "Cariche ±1", 0\.5 on "Cariche ±2", 0\.3333 on "Cariche ±3"/);
    const independent = json<{ method: string; ok: boolean; detail: string }[]>(ctx.db.get<{ checks: string }>('SELECT checks FROM enrichments')!.checks, []).find((c) => c.method === 'independent')!;
    assert.equal(independent.ok, true);
    assert.doesNotMatch(independent.detail, /is fitted to/);
  });

  test('writer and checker read the whole section, past the first 8000 characters', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', `${'Testo introduttivo. '.repeat(500)}\n\nEsempio finale: $$y = x^2$$`);
    fake.next(answer(graph), checkerFits);
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'p' })), { made: 1 });
    for (const call of fake.calls) assert.match(call.prompt, /Esempio finale: \$\$y = x\^2\$\$/);
  });

  test('a steep curve the sampler kept whole is accepted at generation, so an edit that keeps it does not fail', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Distribuzione di Fermi: $$f = \\frac{1}{e^{(E - 1)/0{,}0005} + 1}$$');
    const fermi = { ...graph, xDomain: [0, 2], yDomain: [0, 1.1], traces: [{ kind: 'function', fn: '1/(exp((x-1)/0.0005)+1)', label: 'Occupazione', source: 'f = \\frac{1}{e^{(E - 1)/0{,}0005} + 1}' }] };
    fake.next(answer(fermi), answer({ traces: [{ label: 'Occupazione', expected: '', problem: '' }], fit: 'fits' }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'Fermi' })), { made: 1 });
    const row = ctx.db.get<{ id: string; payload: string; lint_accepted: string }>('SELECT id, payload, lint_accepted FROM enrichments')!;
    assert.deepEqual(json(row.lint_accepted, []), ['joined-jump:Occupazione']);
    const payload = json<Record<string, unknown>>(row.payload, {});
    const edited = updateEnrichmentPayload(ctx, row.id, { ...payload, title: 'Occupazione dei livelli' });
    assert.equal(edited.status, 'verified');
    assert.deepEqual(edited.lintOpen, []);
    // The same data typed in by an author, with nothing accepted, is a joined jump.
    ctx.db.run(`UPDATE enrichments SET lint_accepted = '[]' WHERE id = ?`, row.id);
    assert.equal(updateEnrichmentPayload(ctx, row.id, payload).status, 'issue');
  });

  test('an edit drops the spec and the checker\'s revision; Accept anyway keeps them and the independent check', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno: $$y = x^2$$');
    fake.next(answer({ ...graph, traces: [{ kind: 'function', fn: 'x^2', label: 'Seno', source: 'y = x^2' }, { kind: 'function', fn: 'x', label: 'Coseno', source: 'y = x^2' }], yDomain: [-2, 4] }),
      answer({ traces: [{ label: 'Seno', expected: 'x^2', problem: '' }, { label: 'Coseno', expected: 'x', problem: '' }], fit: 'fits' }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'p' })), { made: 1 });
    const id = ctx.db.get<{ id: string }>('SELECT id FROM enrichments')!.id;
    const stored = listEnrichments(ctx, P)[0]!;
    assert.deepEqual(stored.lintOpen, ['placeholder:'], 'a warning the author has not accepted');
    assert.equal(stored.status, 'verified', 'a warning does not fail the graph');
    const accepted = updateEnrichmentPayload(ctx, id, stored.payload, { acceptLint: true });
    assert.deepEqual(accepted.lintAccepted, ['placeholder:'], 'Accept anyway takes warnings too');
    assert.deepEqual(accepted.lintOpen, []);
    assert.deepEqual(accepted.checks.map((c) => c.method), ['numeric', 'lint', 'source', 'independent'], 'the same payload keeps the checks that were about it');
    assert.ok(accepted.spec && accepted.checkedRevisionId);
    const edited = updateEnrichmentPayload(ctx, id, { ...stored.payload, title: 'Altro titolo' });
    assert.deepEqual(edited.checks.map((c) => c.method), ['numeric', 'lint']);
    assert.equal(edited.spec, null, 'the spec described the graph as drawn, not as edited');
    assert.equal(edited.checkedRevisionId, null);
  });

  test('a drawn graph is formatted before its checks, an author edit is formatted when saved, and formatting alone keeps the checks', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno: $$y = 0{,}5x^2$$');
    const half = { ...graph, title: 'Grafico di 0.5*x^2', xLabel: 'x', traces: [{ kind: 'function', fn: '0.5*x^2', label: 'y = 0.5*x^2', source: 'y = 0{,}5x^2' }] };
    fake.next(answer(half), answer({ traces: [{ label: 'y = 0,5x²', expected: '0.5*x^2', problem: '' }], fit: 'fits' }));
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'p' })), { made: 1 });
    assert.match(fake.calls.at(-1)!.prompt, /1\. y = 0,5x²: a curve/, 'the checker reads the label the reader will show');
    const stored = listEnrichments(ctx, P)[0]!;
    assert.equal(stored.payload.title, 'Grafico di 0,5x²');
    assert.equal((stored.payload.config as { data: { name: string }[] }).data[0]!.name, 'y = 0,5x²');
    assert.deepEqual(stored.lintOpen, []);
    // The same graph with its labels as the writer typed them: the formatter makes it the stored one, so nothing was edited.
    const typed = structuredClone(stored.payload) as { title: string; config: { data: { name: string }[] } };
    typed.title = 'Grafico di 0.5*x^2';
    typed.config.data[0]!.name = 'y = 0.5*x^2';
    const same = updateEnrichmentPayload(ctx, stored.id, typed);
    assert.deepEqual(same.payload, stored.payload);
    assert.deepEqual(same.checks.map((c) => c.method), ['numeric', 'lint', 'source', 'independent']);
    assert.ok(same.spec && same.checkedRevisionId);
    const edited = updateEnrichmentPayload(ctx, stored.id, { ...typed, title: 'Parabola y = 2*x^2 - 1.5' });
    assert.equal(edited.payload.title, 'Parabola y = 2x² − 1,5');
    assert.deepEqual(edited.checks.map((c) => c.method), ['numeric', 'lint'], 'a real edit still drops the checks about the old graph');
  });

  test('a graph whose section changed after its check is stale at export', async () => {
    seedOutline([['c1', ['s1']]]);
    const rev = seedRevision('s1', 'Testo uno: $$y = x^2$$');
    fake.next(answer(graph), checkerFits);
    await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'p' }));
    const stale = () => compileBook(loadBookInput(ctx, P)).findings.filter((f) => f.rule === 'graph-stale');
    assert.deepEqual(stale(), []);
    // A typo fix outside the quoted formula is a new revision of the section all the same.
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, rev);
    seedRevision('s1', 'Testo uno, corretto: $$y = x^2$$');
    assert.equal(stale().length, 1);
  });
  test('a Bode pair saves two graphs on the same log frequency axis', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il filtro passa-basso con $f_c = 1000$ Hz.');
    const t = startTask('enrich.graph', { nodeId: 's1', purpose: 'Bode' });
    fake.next(answer({
      verdict: 'graph', reason: 'r', id: 'bode', title: 'Modulo', description: 'Modulo in dB', traces: [{ kind: 'function', fn: '-10*log10(1+(x/1000)^2)', label: '|H|', source: 'f_c = 1000' }],
      xDomain: [10, 100000], yDomain: [-40, 5], xScale: 'log', yScale: null, xLabel: 'f (Hz)', yLabel: 'dB',
      pair: { id: 'bode', title: 'Fase', description: 'Fase in gradi', traces: [{ kind: 'function', fn: '-atan(x/1000)*180/pi', label: 'fase', source: 'f_c = 1000' }], yDomain: [-100, 10], yScale: null, yLabel: 'gradi' },
    }), checkerFits, checkerFits);
    assert.deepEqual(await enrichGraph(ctx, t), { made: 2 });
    const rows = ctx.db.all<{ payload: string; status: string }>(`SELECT payload, status FROM enrichments WHERE kind = 'graph' ORDER BY rowid`);
    const layouts = rows.map((r) => json<{ id: string; config: { layout: { xaxis: { type: string; range: number[]; title: string } } } }>(r.payload, { id: '', config: { layout: { xaxis: { type: '', range: [], title: '' } } } }));
    assert.deepEqual(layouts.map((l) => l.id), ['bode', 'bode-2'], 'the second graph gets its own id');
    const ticks = { tickvals: [10, 100, 1000, 10000, 100000], ticktext: ['10', '10²', '10³', '10⁴', '10⁵'] };
    for (const l of layouts) assert.deepEqual(l.config.layout.xaxis, { title: 'f (Hz)', type: 'log', range: [1, 5], ...ticks }, 'one log axis, with the same powers of ten');
    assert.deepEqual(rows.map((r) => r.status), ['verified', 'verified']);
  });

  test('a Bode pair is saved in one transaction: when the second graph cannot be written, the first is not kept, so a retry draws the pair again', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il filtro passa-basso con $f_c = 1000$ Hz.');
    ctx.db.raw.exec(`CREATE TRIGGER second_graph_fails BEFORE INSERT ON enrichments WHEN (SELECT count(*) FROM enrichments) >= 1 BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const pair = {
      verdict: 'graph', reason: 'r', id: 'bode', title: 'Modulo', description: 'Modulo in dB', traces: [{ kind: 'function', fn: '-10*log10(1+(x/1000)^2)', label: '|H|', source: 'f_c = 1000' }],
      xDomain: [10, 100000], yDomain: [-40, 5], xScale: 'log', yScale: null, xLabel: 'f (Hz)', yLabel: 'dB',
      pair: { id: 'bode', title: 'Fase', description: 'Fase in gradi', traces: [{ kind: 'function', fn: '-atan(x/1000)*180/pi', label: 'fase', source: 'f_c = 1000' }], yDomain: [-100, 10], yScale: null, yLabel: 'gradi' },
    };
    fake.next(answer(pair), checkerFits, checkerFits);
    await assert.rejects(enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'Bode' })), /disk full/);
    assert.equal(ctx.db.all(`SELECT 1 FROM enrichments WHERE kind = 'graph'`).length, 0);
    ctx.db.raw.exec('DROP TRIGGER second_graph_fails');
    fake.next(answer(pair), checkerFits, checkerFits);
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', { nodeId: 's1', purpose: 'Bode' })), { made: 2 });
  });
});

describe('Auto Fix redraws a graph that failed its check (issue 36)', () => {
  const graph = { verdict: 'graph', reason: 'r', id: 'g1', title: 'Grafico', description: 'd', traces: [{ kind: 'function', fn: 'x^2', label: 'f', source: 'y = x^2' }], xDomain: [-2, 2], yDomain: [0, 4], xLabel: 'x', yLabel: 'y' };
  const off = { ...graph, yDomain: [10, 20] };
  const failing = async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno: $$y = x^2$$');
    storeAnswer(off);
    return { enrichment: ctx.db.get<{ id: string }>(`SELECT id FROM enrichments`)!.id, issue: ctx.db.get<{ id: string }>(`SELECT id FROM review_issues WHERE source = 'verification'`)!.id };
  };

  test('the redraw replaces the failing graph only when the new one passes, and then closes the issue', async () => {
    const { enrichment, issue } = await failing();
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM enrichments')!.status, 'issue', 'the failed graph is stored with a verification issue, as the issue describes');
    assert.deepEqual(await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [issue] })), { skipped: 'routed', routed: { graphs: 1 } });
    assert.equal(fake.calls.length, 0, 'the text writer is not asked');
    const input = json<Record<string, unknown>>(ctx.db.get<{ input: string }>(`SELECT input FROM tasks WHERE kind = 'enrich.graph' AND key LIKE 'fixgraph:%'`)!.input, {});
    assert.deepEqual([input.force, input.replaceId, input.issueIds], [true, enrichment, [issue]]);
    assert.match(String(input.purpose), /failed its check[\s\S]*never enters the visible range/);

    // The redraw fails twice: the old graph stays, no second graph and no second issue appear, the reason is shown.
    fake.next(answer(off), answer(off));
    await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.match(fake.calls[0]!.prompt, /The last check of the graph failed: .*never enters the visible range/, 'the redraw is told the last failure');
    assert.match(fake.calls[1]!.prompt, /A first draft failed its checks/);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 1);
    assert.equal(ctx.db.all(`SELECT 1 FROM review_issues`).length, 1);
    assert.match(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues')!.resolution, /redrawn but failed its check again: .*never enters the visible range/);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'open');
    // The next Fix tells the redraw why the last one failed.
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [issue] }));
    const next = json<Record<string, unknown>>(ctx.db.get<{ input: string }>(`SELECT input FROM tasks WHERE kind = 'enrich.graph' AND key LIKE 'fixgraph:%' ORDER BY rowid DESC LIMIT 1`)!.input, {});
    assert.match(String(next.purpose), /redrawn but failed its check again: .*never enters the visible range/);

    fake.next(answer(graph), checkerFits);
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', input)), { made: 1, replaced: true });
    const rows = ctx.db.all<{ id: string; status: string }>('SELECT id, status FROM enrichments').map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ id: enrichment, status: 'verified' }]);
    assert.deepEqual({ ...ctx.db.get<Record<string, unknown>>('SELECT status, resolution FROM review_issues') }, { status: 'fixed', resolution: 'The graph was redrawn and passes its check.' });
  });

  test('a graph the author edited or deleted during the redraw is left alone and the issue stays open', async () => {
    const { enrichment, issue } = await failing();
    const input = { nodeId: 's1', purpose: 'p', force: true, replaceId: enrichment, issueIds: [issue] };
    const edited = { ...graph, title: "Grafico dell'autrice" };
    fake.next(() => { ctx.db.run('UPDATE enrichments SET payload = ? WHERE id = ?', JSON.stringify(edited), enrichment); return answer(graph)(); }, checkerFits);
    const r = await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.equal(r.made, 0);
    assert.match(String(r.skipped), /edited the graph/);
    assert.deepEqual(json(ctx.db.get<{ payload: string }>('SELECT payload FROM enrichments')!.payload, {}), edited);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'open');
    assert.match(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues')!.resolution, /edited the graph/);

    fake.next(() => { ctx.db.run('DELETE FROM enrichments WHERE id = ?', enrichment); return answer(graph)(); }, checkerFits);
    const gone = await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.equal(gone.made, 0);
    assert.match(String(gone.skipped), /deleted the graph/);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0, 'a deleted graph is not recreated');
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'open');
  });

  test('a queued redraw of a graph the author fixed or deleted before it started asks no model and leaves the graph alone', async () => {
    const { enrichment, issue } = await failing();
    const input = { nodeId: 's1', purpose: 'p', force: true, replaceId: enrichment, issueIds: [issue] };
    const edited = { ...graph, title: "Grafico dell'autrice" };
    ctx.db.run(`UPDATE enrichments SET payload = ?, status = 'verified' WHERE id = ?`, JSON.stringify(edited), enrichment);
    const calls = fake.calls.length;
    const r = await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.equal(r.made, 0);
    assert.match(String(r.skipped), /passes its check/);
    assert.equal(fake.calls.length, calls, 'no model call');
    assert.deepEqual(json(ctx.db.get<{ payload: string }>('SELECT payload FROM enrichments')!.payload, {}), edited);
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'fixed');

    ctx.db.run(`UPDATE review_issues SET status = 'open'`);
    ctx.db.run('DELETE FROM enrichments WHERE id = ?', enrichment);
    const gone = await enrichGraph(ctx, startTask('enrich.graph', input));
    assert.equal(gone.made, 0);
    assert.equal(fake.calls.length, calls, 'no model call for a graph that is gone');
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 0, 'a deleted graph is not recreated');
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM review_issues')!.status, 'fixed');
  });

  test('an issue whose failing graph is gone, or passes now, closes without a model call', async () => {
    const { enrichment, issue } = await failing();
    ctx.db.run(`UPDATE enrichments SET status = 'verified' WHERE id = ?`, enrichment);
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [issue] }));
    assert.deepEqual(r, { skipped: 'nothing requested' });
    assert.equal(fake.calls.length, 0);
    assert.deepEqual({ ...ctx.db.get<Record<string, unknown>>('SELECT status, resolution FROM review_issues') }, { status: 'fixed', resolution: 'The graph passes its check now.' });
    ctx.db.run(`UPDATE review_issues SET status = 'open'`);
    ctx.db.run('DELETE FROM enrichments');
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [issue] }));
    assert.equal(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues')!.resolution, 'The graph that failed its check is no longer in the book.');
  });
});

describe('Auto Fix redraws each failing graph of a Bode pair for its own issues', () => {
  const mag = (over = {}) => ({ verdict: 'graph', reason: 'r', id: 'bode', title: 'Modulo', description: 'Modulo in dB', traces: [{ kind: 'function', fn: '-10*log10(1+(x/1000)^2)', label: '|H|', source: 'f_c = 1000' }], xDomain: [10, 100000], yDomain: [-40, 5], xScale: 'log', yScale: null, xLabel: 'f (Hz)', yLabel: 'dB', ...over });
  const phase = (over = {}) => ({ id: 'bode', title: 'Fase', description: 'Fase in gradi', traces: [{ kind: 'function', fn: '-atan(x/1000)*180/pi', label: 'fase', source: 'f_c = 1000' }], yDomain: [-100, 10], yScale: null, yLabel: 'gradi', ...over });
  /** Both graphs of the pair fail: their y ranges are far from the curves. */
  const failingPair = async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il filtro passa-basso con $f_c = 1000$ Hz.');
    storeAnswer({ ...mag({ yDomain: [10, 20] }), pair: phase({ yDomain: [500, 600] }) });
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

  test('an issue that names neither of two failing graphs stays open, and with one failing graph it goes to that one', async () => {
    const f = await failingPair();
    // The magnitude graph's title was edited after the issue was written, so the issue's quote names no graph.
    ctx.db.run(`UPDATE review_issues SET quote = 'Titolo di prima' WHERE id = ?`, f.magIssue);
    assert.deepEqual(await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [f.magIssue, f.phaseIssue] })), { skipped: 'routed', routed: { graphs: 1 } });
    assert.deepEqual(redrawInputs().map((i) => [i.replaceId, i.issueIds]), [[f.phaseRow, [f.phaseIssue]]]);
    assert.equal(statusOf(f.magIssue), 'open');
    assert.match(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues WHERE id = ?', f.magIssue)!.resolution, /does not identify one of them/);
    // With one failing graph left there is no doubt which one the issue is about.
    ctx.db.run(`UPDATE enrichments SET status = 'verified' WHERE id = ?`, f.phaseRow);
    ctx.db.run(`DELETE FROM tasks WHERE key LIKE 'fixgraph:%'`);
    assert.deepEqual(await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [f.magIssue] })), { skipped: 'routed', routed: { graphs: 1 } });
    assert.deepEqual(redrawInputs().map((i) => [i.replaceId, i.issueIds]), [[f.magRow, [f.magIssue]]]);
  });

  test('two failing graphs with the same title are not told apart by an issue, so neither issue is routed to the first of them', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Il filtro passa-basso con $f_c = 1000$ Hz.');
    storeAnswer({ ...mag({ yDomain: [10, 20] }), pair: phase({ title: 'Modulo', yDomain: [500, 600] }) });
    const issues = ctx.db.all<{ id: string; quote: string }>('SELECT id, quote FROM review_issues ORDER BY rowid');
    assert.deepEqual(issues.map((i) => i.quote), ['Modulo', 'Modulo']);
    assert.deepEqual(await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: issues.map((i) => i.id) })), { skipped: 'nothing requested' });
    assert.equal(redrawInputs().length, 0, 'no graph is redrawn, so no issue can close for a graph that still fails');
    assert.deepEqual(issues.map((i) => statusOf(i.id)), ['open', 'open']);
    assert.match(ctx.db.get<{ resolution: string }>('SELECT resolution FROM review_issues WHERE id = ?', issues[0]!.id)!.resolution, /does not identify one of them/);
  });

  test('the answer graph with the failing row\'s id replaces that row, and only its issue closes', async () => {
    const f = await failingPair();
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [f.magIssue, f.phaseIssue] }));
    const [magInput, phaseInput] = redrawsOf(f);
    // The redraw of the phase row answers with a good magnitude as the graph and a good phase as its pair.
    fake.next(answer({ ...mag(), pair: phase() }), checkerFits);
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', phaseInput!)), { made: 1, replaced: true });
    const rows = ctx.db.all<{ id: string; payload: string; status: string }>('SELECT id, payload, status FROM enrichments ORDER BY rowid');
    assert.equal(rows.length, 2, 'no duplicate graph appears');
    assert.deepEqual(rows.map((r) => [r.id, json<{ title: string }>(r.payload, { title: '' }).title, r.status]), [[f.magRow, 'Modulo', 'issue'], [f.phaseRow, 'Fase', 'verified']]);
    assert.deepEqual([statusOf(f.magIssue), statusOf(f.phaseIssue)], ['open', 'fixed']);
    // The magnitude row is still failing, and its own redraw fixes it.
    fake.next(answer({ ...mag(), pair: phase() }), checkerFits);
    assert.deepEqual(await enrichGraph(ctx, startTask('enrich.graph', magInput!)), { made: 1, replaced: true });
    assert.deepEqual(ctx.db.all<{ status: string }>('SELECT status FROM enrichments ORDER BY rowid').map((r) => r.status), ['verified', 'verified']);
    assert.deepEqual([statusOf(f.magIssue), statusOf(f.phaseIssue)], ['fixed', 'fixed']);
    assert.equal(ctx.db.all('SELECT 1 FROM enrichments').length, 2);
  });

  test('an answer with a single graph of another id still replaces the failing row, and an answer with none of its id leaves the issues open', async () => {
    const f = await failingPair();
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [f.magIssue, f.phaseIssue] }));
    const [magInput, phaseInput] = redrawsOf(f);
    fake.next(answer(phase({ verdict: 'graph', reason: 'r', id: 'fase', xDomain: [10, 100000], xScale: 'log', xLabel: 'f (Hz)' })), checkerFits);
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
    fake.next(examRead({ number: '1', statement: 'Calcola.', solution: 'Fatto.' }));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.ok(row(id).imported_at);
    ctx.db.run(`UPDATE questions SET checks = '[]', status = 'draft' WHERE id = ?`, id);
    const calls = fake.calls.length;
    assert.deepEqual(await questionImport(ctx, startTask('question.import', { questionId: id })), { reused: true });
    assert.equal(fake.calls.length, calls);
  });

  test('an imported question whose solution is empty is read again; an unreadable one is not marked as imported', async () => {
    const id = examQ({ imported_at: '2026-01-01', solution: '' });
    fake.next(examRead({ number: '1', statement: 'Calcola.', solution: 'Ora c\'è.' }));
    await questionImport(ctx, startTask('question.import', { questionId: id }));
    assert.equal(row(id).solution, "Ora c'è.");
    const bad = examQ();
    fake.next(examRead({ number: '1', readable: false }));
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

    fake.next(...check({}));
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
    fake.next(answer({ issues: [] }), crossNone);
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    assert.equal(first.reviewed, [r1, r2].sort().join(','));
    assert.match(fake.calls[0].prompt, /full review: review all of the text/);
    assert.doesNotMatch(fake.calls[0].prompt, /ALREADY FIXED|DECIDED ARE FINE/);

    // Issues handled before the first review.
    const old = { project_id: P, source: 'review', severity: 'major', category: 'clarity', suggestion: '', resolution: '', created_at: '2000-01-01T00:00:00.000Z' };
    ctx.db.insert('review_issues', { ...old, id: 'd1', node_id: 's1', quote: 'Frase scelta', message: 'Preferirei un altro ordine', status: 'dismissed' });
    ctx.db.insert('review_issues', { ...old, id: 'a1', node_id: 's2', quote: 'Altro', message: 'Ipotesi mancante', status: 'accepted' });
    ctx.db.insert('review_issues', { ...old, id: 'f1', node_id: 's1', quote: 'x'.repeat(300), message: 'm'.repeat(300), status: 'fixed' });
    // s1 changes, s2 does not.
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Una frase nuova.');
    fake.next(answer({ issues: [] }));
    await review();
    const prompt = fake.calls[2].prompt;
    assert.match(prompt, /only the passages below are new or rewritten[\s\S]*--- \[s1\] ---\nUna frase nuova\./);
    assert.doesNotMatch(prompt, /--- \[s2\] ---/);
    assert.match(prompt, /DECIDED ARE FINE[\s\S]*"Frase scelta" Preferirei un altro ordine/);
    assert.match(prompt, /"Altro" Ipotesi mancante/);
    assert.match(prompt, /ALREADY FIXED[\s\S]*"x{120}" m{200}\n/);
    assert.doesNotMatch(prompt, /x{121}|m{201}/);
    assert.match(fake.calls[2].system ?? '', /report each problem once/);
  });

  test('the reviewer gets the symbols the exam papers use on the chapter topics, and the rule for a symbol that differs', async () => {
    seedOutline([['c1', ['s1']]], { topicIds: ['t-filtri'] });
    seedRevision('s1', 'La frequenza di taglio è $f_t$.');
    const exam = (statement: string, topic: string) => ctx.db.insert('questions', {
      id: newId(), project_id: P, kind: 'exam', origin: 'authentic', resource_id: null, exam_group: 'Appello del 12 febbraio 2024', exam_date: '2024-02-12', number: '1',
      statement, hint: '', solution: '', difficulty: 'medio', topic_ids: [topic], status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(),
    });
    exam('Calcolare la frequenza di taglio $f_c$ con $R_1 = 1\\,\\mathrm{k\\Omega}$.', 't-filtri');
    exam('Un altro argomento con $q_p$.', 't-altro');
    fake.next(answer({ issues: [] }), crossNone);
    await review();
    const { prompt, system } = fake.calls[0];
    assert.match(prompt, /\(standard\)\n\nSymbols used in the exam papers on this chapter's topics: f_c, R_1\.\n/);
    assert.doesNotMatch(prompt, /q_p/);
    assert.match(system ?? '', /A symbol that differs from the one the exam papers use for the same quantity is a major notation finding, reported once per symbol with the places where it occurs, unless the notation fixed for the whole book defines another symbol for that quantity\. The book's notation wins over the exam papers, as it does for the writer\./);
    ctx.db.run(`DELETE FROM questions`);
    fake.next(answer({ issues: [] }), crossNone);
    await chapterReview(ctx, startTask('chapter.review', { chapterId: 'c1', force: true }));
    assert.doesNotMatch(fake.calls[2].prompt, /Symbols used in the exam papers/);
    assert.equal(fake.calls[2].system, system, 'the static part does not depend on the exams');
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
    ] }), crossNone, answer({ findings: [] }));
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
    assert.match(fake.calls[3].prompt, /--- \[s1\] ---\nSecondo blocco riscritto\.\n/);
    assert.equal(second.issues, 1);
    assert.equal(second.outOfScope, 2);
    // "Riletto" pointed at a passage that no longer exists; the open issues on unchanged passages stay.
    assert.deepEqual(issues(`source = 'review' AND status = 'open'`).map((i) => i.message).sort(), ['Errato', 'Nuovo', 'Resta']);
  });

  test('a re-review with no new passages does not call the reviewer', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Primo blocco.\n\nSecondo blocco.');
    fake.next(answer({ issues: [] }), crossNone);
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    // A new revision that only drops a block: nothing new to read.
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Primo blocco.');
    const second = await review();
    assert.equal(fake.calls.length, 2);
    assert.equal(second.issues, 0);
  });

  test('the first review reports minors, a review of changed text asks for blockers and majors and drops any minor before the second opinion', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Una frase.\n\nSimbolo sbagliato.');
    fake.next(answer({ issues: [finding({ quote: 'Simbolo sbagliato.', severity: 'minor', message: 'Simbolo diverso dall\'enunciato' })] }), crossNone, answer({ findings: [{ index: 1, verdict: 'real', severity: 'minor', reason: '' }] }));
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
    assert.match(fake.calls[3].prompt, /Report only blockers and majors/);
    assert.deepEqual([second.issues, second.minorsDropped], [1, 1]);
    assert.match(fake.calls[4].prompt, /\[major\] "Nuovo passo\." Maggiore/);
    assert.doesNotMatch(fake.calls[4].prompt, /Minore/);
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
    fake.next(answer({ issues: [] }), crossNone);
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, heads.get('s2')!);
    seedRevision('s2', bodies.get('s2')!.replace('Paragrafo 3', 'Paragrafo tre'));
    fake.next(answer({ issues: [] }));
    await review();
    const [a, b] = [fake.calls[0], fake.calls[2]].map((c) => (c.system ?? '').length + c.prompt.length);
    const prompt = fake.calls[2].prompt;
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
    fake.next(answer({ issues: [finding({ severity: 'major' })] }), crossNone, answer({ findings: [{ index: 1, verdict: 'real', severity: 'major', reason: '' }] }));
    const first = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review'`, now(), JSON.stringify(first));
    assert.deepEqual([first.clean, first.openSerious], [false, 1]);
    assert.equal(getProjectSummary(ctx, P).review!.clean, false);
    assert.equal(getProjectSummary(ctx, P).review!.openSerious, 1);

    // The author fixes the issue by hand. The next review reads the changed text and finds nothing.
    ctx.db.run(`UPDATE review_issues SET status = 'fixed' WHERE source = 'review'`);
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Una frase corretta.\n\nAltro blocco.');
    assert.equal(getProjectSummary(ctx, P).review!.clean, false, 'changed text has not been reviewed');
    fake.next(answer({ issues: [] }));
    const second = await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review' AND state = 'running'`, now(), JSON.stringify(second));
    assert.deepEqual([second.clean, second.openSerious], [true, 0]);
    // The text changed since the first review read the whole chapter, so a sweep is on offer.
    assert.deepEqual(getProjectSummary(ctx, P).review, { clean: true, openSerious: 0, reviewedAt: getProjectSummary(ctx, P).review!.reviewedAt, sweepsDue: 1 });

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
    fake.next(answer({ issues: [] }), crossNone);
    await review();
    ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review' AND state = 'running'`, now(), JSON.stringify({ reviewed: h }));
    const again = await review();
    assert.equal(again.reused, true);
    assert.equal(fake.calls.length, 2);
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
      crossNone,
      opinion(['real', 'blocker'], ['not-real', 'minor'], ['real', 'blocker']),
    );
    const r = await review();
    assert.deepEqual([r.issues, r.dropped, r.lowered, r.checked], [2, 1, 0, true]);
    assert.match(fake.calls[2].system ?? '', /also invent problems/);
    assert.match(fake.calls[2].prompt, /1\. \[s1\] \[blocker\] "Una frase\." Errore/);
    assert.deepEqual(issues(`source = 'review'`).map((i) => [i.message, i.severity, i.status]), [
      ['Errore', 'blocker', 'open'], ['Piccolo', 'minor', 'open'], ['Pedante', 'blocker', 'dismissed'],
    ]);
    assert.match(issues(`status = 'dismissed'`)[0].resolution, /^Second opinion: not a real problem\. Il testo lo dice già\./);
  });

  test('a lowered severity is stored; a failed second opinion keeps every finding', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.');
    fake.next(answer({ issues: [finding({ category: 'notation' })] }), crossNone, opinion(['real', 'minor']));
    assert.equal((await review({ force: true })).lowered, 1);
    assert.equal(issues(`status = 'open'`)[0].severity, 'minor');
    fake.next(answer({ issues: [finding()] }), crossNone, () => new Error('boom'));
    const r = await review({ force: true });
    assert.deepEqual([r.issues, r.checked], [1, false]);
    assert.equal(issues(`status = 'open'`)[0].severity, 'blocker');
  });

  test('a full review reads each section on its own call, even when the text did not change', async () => {
    seedOutline([['c1', ['s1', 's2']]]);
    const r1 = seedRevision('s1', 'Prima sezione.');
    const r2 = seedRevision('s2', 'Seconda sezione.');
    fake.next(answer({ issues: [] }), crossNone);
    done(await review());
    fake.next(answer({ issues: [finding({ sectionId: 'c1', quote: 'Prima sezione.' })] }), answer({ issues: [] }), opinion(['real', 'blocker']));
    const r = await review({ mode: 'full' });
    assert.equal(r.reviewed, [r1, r2].sort().join(','));
    const [one, two] = [fake.calls[2].prompt, fake.calls[3].prompt];
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
    fake.next(answer({ issues: [finding({ sectionId: 'inventato', quote: 'Seconda sezione.' })] }), crossNone, opinion(['real', 'blocker']));
    await review();
    assert.match(fake.calls[2].prompt, /Seconda sezione\./);
    assert.doesNotMatch(fake.calls[2].prompt, /Prima sezione\./);
  });

  test('the second opinion gets the exam symbols and the rule that the book notation wins, on the first call and on a recheck', async () => {
    seedOutline([['c1', ['s1']]], { topicIds: ['t-filtri'] });
    seedRevision('s1', 'La frequenza di taglio è $f_t$.');
    ctx.db.insert('questions', {
      id: newId(), project_id: P, kind: 'exam', origin: 'authentic', resource_id: null, exam_group: 'Appello del 12 febbraio 2024', exam_date: '2024-02-12', number: '1',
      statement: 'Calcolare la frequenza di taglio $f_c$.', hint: '', solution: '', difficulty: 'medio', topic_ids: ['t-filtri'], status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(),
    });
    fake.next(answer({ issues: [finding({ quote: 'La frequenza di taglio è $f_t$.', category: 'notation', severity: 'major', message: 'Nei temi d\'esame è f_c' })] }), crossNone, opinion(['real', 'major']));
    await review();
    assert.match(fake.calls[2].system ?? '', /also invent problems/);
    assert.match(fake.calls[2].prompt, /Symbols used in the exam papers on this chapter's topics: f_c\./);
    assert.match(fake.calls[2].system ?? '', /the notation fixed for the whole book defines none for it/);
    assert.match(fake.calls[2].system ?? '', /not a preference about wording/);
    assert.match(fake.calls[2].system ?? '', /a symbol that differs from the exam papers in the way described above; minor for everything else/, 'the severity rule keeps such a finding major');
    fake.next(opinion(['real', 'major']));
    await review({ mode: 'recheck' });
    assert.match(fake.calls[3].prompt, /Symbols used in the exam papers on this chapter's topics: f_c\./);
    ctx.db.run(`DELETE FROM questions`);
    fake.next(opinion(['real', 'major']));
    await review({ mode: 'recheck' });
    assert.doesNotMatch(fake.calls[4].prompt, /Symbols used in the exam papers/);
  });

  test('recheck gives open issues a second opinion without a new review, and the next review still compares with the last one', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Una frase.\n\nUn altro passo.');
    fake.next(answer({ issues: [finding(), finding({ quote: 'Un altro passo.', message: 'Pedante' })] }), crossNone, answer({ findings: [] }));
    done(await review());
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, r1);
    seedRevision('s1', 'Una frase.\n\nUn altro passo.\n\nNuovo passo.');
    fake.next(opinion(['real', 'major'], ['not-real', 'blocker']));
    const r = await review({ mode: 'recheck' });
    done(r);
    assert.deepEqual([r.rechecked, r.dropped, r.lowered, r.reviewed], [2, 1, 1, r1]);
    assert.equal(fake.calls.length, 4, 'one call, no reviewer call');
    assert.match(fake.calls[3].system ?? '', /also invent problems/);
    assert.deepEqual(issues(`source = 'review'`).map((i) => [i.message, i.severity, i.status]), [['Errore', 'major', 'open'], ['Pedante', 'blocker', 'dismissed']]);
    fake.next(answer({ issues: [] }));
    await review();
    assert.match(fake.calls[4].prompt, /--- \[s1\] ---\nNuovo passo\./);
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

describe('independent samples, the sweep the author asks for, repeats merged in code and the severity floor', () => {
  const finding = (o: Record<string, unknown> = {}) => ({ sectionId: 's1', severity: 'major', category: 'correctness', quote: 'Una frase.', message: 'Errore', suggestion: 'Correggi', ...o });
  const verdicts = (...v: { verdict?: string; severity: string }[]) => answer({ findings: v.map((x, k) => ({ index: k + 1, verdict: x.verdict ?? 'real', severity: x.severity, reason: '' })) });
  const review = (input: Record<string, unknown> = {}) => chapterReview(ctx, startTask('chapter.review', { chapterId: 'c1', ...input }));
  const done = (r: unknown) => ctx.db.run(`UPDATE tasks SET state = 'succeeded', finished_at = ?, result = ? WHERE kind = 'chapter.review' AND state = 'running'`, now(), JSON.stringify(r));
  const samples = (n: number) => ctx.db.run('UPDATE projects SET options = ? WHERE id = ?', JSON.stringify({ selfCheck: false, reviewSamples: n }), P);
  /** A fix of the open review issues of a section: they are closed and the section gets a new revision. */
  const fix = (nodeId: string, to: string) => {
    ctx.db.run(`UPDATE review_issues SET status = 'fixed' WHERE source = 'review' AND status = 'open' AND node_id = ?`, nodeId);
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = ? AND status = 'current'`, nodeId);
    return seedRevision(nodeId, to);
  };
  const heads = (...ids: string[]) => ids.sort().join(',');
  const quota = () => () => Object.assign(new Error("You've hit your usage limit. Try again in 2 hours."), { code: 'cli-failed' });

  test('repeats are merged by section and block of at least 20 characters, keep the highest severity and take correctness from any member', () => {
    const long = 'Un blocco abbastanza lungo da contare come passaggio';
    const blocks: Record<string, string[]> = { s1: [long, 'Sia x = 1.', '.'], s2: [long] };
    const f = (o: Partial<{ sectionId: string; severity: 'blocker' | 'major' | 'minor'; category: string; quote: string; message: string }>) => ({ sectionId: 's1', severity: 'major' as const, category: 'correctness', quote: 'abbastanza lungo', message: 'm', suggestion: '', ...o });
    const { findings, merged } = mergeRepeats([
      f({ severity: 'minor', message: 'primo' }),
      f({ quote: 'Sia x = 1.', message: 'breve 1' }),
      f({ quote: 'Sia x', message: 'breve 2' }),
      f({ quote: '.', message: 'punto 1' }),
      f({ quote: '.', message: 'punto 2' }),
      f({ severity: 'blocker', category: 'unsupported', quote: 'Un blocco abbastanza', message: 'secondo' }),
      f({ sectionId: 's2', message: 'altra sezione' }),
      f({ quote: 'in nessun blocco', message: 'fuori 1' }),
      f({ quote: 'in nessun blocco', message: 'fuori 2' }),
      f({ quote: '', message: 'senza citazione 1' }),
      f({ quote: '', message: 'senza citazione 2' }),
    ], (id) => blocks[id] ?? []);
    assert.equal(merged, 1);
    assert.deepEqual(findings.map((x) => [x.message, x.severity, x.category]), [
      ['secondo', 'blocker', 'correctness'], ['breve 1', 'major', 'correctness'], ['breve 2', 'major', 'correctness'], ['punto 1', 'major', 'correctness'], ['punto 2', 'major', 'correctness'],
      ['altra sezione', 'major', 'correctness'], ['fuori 1', 'major', 'correctness'], ['fuori 2', 'major', 'correctness'], ['senza citazione 1', 'major', 'correctness'], ['senza citazione 2', 'major', 'correctness'],
    ]);
    assert.equal(mergeRepeats([f({ category: 'language' }), f({ category: 'notation', severity: 'minor' })], (id) => blocks[id] ?? []).findings[0].category, 'language', 'no correctness member, no correctness');
  });

  test('members of a group that raise different problems stay separate points; overlapping quotes or the same message are one point', () => {
    const block = 'Per k grande si ha b_k ~ 1/k e quindi a_k ~ 1/k², dunque la serie converge.';
    const f = (quote: string, message: string, o: Partial<{ severity: 'blocker' | 'major' | 'minor'; category: string }> = {}) => ({ sectionId: 's1', severity: 'major' as const, category: 'correctness', quote, message, suggestion: `fix ${message}`, ...o });
    const { findings, merged } = mergeRepeats([
      f('b_k ~ 1/k', 'b_k non è asintotico a 1/k'),
      f('a_k ~ 1/k²', 'a_k non è asintotico a 1/k²', { severity: 'blocker' }),
      f('si ha b_k ~ 1/k', 'Stima di b_k sbagliata', { severity: 'minor', category: 'language' }),
      f('dunque la serie converge', 'a_k non è asintotico a 1/k²'),
    ], () => [block]);
    assert.equal(merged, 3);
    assert.equal(findings.length, 1);
    const [g] = findings;
    assert.deepEqual([g.severity, g.category, g.quote], ['blocker', 'correctness', 'a_k ~ 1/k²']);
    assert.deepEqual((g as typeof g & { points?: { message: string; severity: string }[] }).points?.map((x) => [x.message, x.severity]), [['b_k non è asintotico a 1/k', 'major'], ['a_k non è asintotico a 1/k²', 'blocker']]);
    assert.equal(g.message, '(1) "b_k ~ 1/k": b_k non è asintotico a 1/k (2) "a_k ~ 1/k²": a_k non è asintotico a 1/k²');
    assert.equal(g.suggestion, '(1) fix b_k non è asintotico a 1/k (2) fix a_k non è asintotico a 1/k²');
  });

  test('the second opinion keeps the points of a merged finding that hold, or all of them when it names none', async () => {
    samples(2);
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Per k grande si ha b_k ~ 1/k e quindi a_k ~ 1/k², dunque la serie converge.\n\nUna seconda frase abbastanza lunga.');
    const two = () => [answer({ issues: [finding({ quote: 'b_k ~ 1/k', message: 'Stima di b_k falsa', suggestion: 'Scrivi b_k ~ 1/k²' })] }), answer({ issues: [finding({ quote: 'a_k ~ 1/k²', message: 'Stima di a_k falsa', suggestion: 'Scrivi a_k ~ 1/k³' })] }), crossNone];
    const verdict = (o: Record<string, unknown>) => answer({ findings: [{ index: 1, verdict: 'real', severity: 'major', reason: '', ...o }] });
    // One real point and one false one: only the real one is stored.
    fake.next(...two(), verdict({ points: [2], reason: 'Regge solo il punto 1.2.' }));
    const r = await review();
    assert.equal(r.merged, 1);
    assert.match(fake.calls[3].prompt, /1\. \[s1\] \[major\] 2 points raised by independent reviewers about this passage:\n {3}1\.1 "b_k ~ 1\/k" Stima di b_k falsa Suggested fix: Scrivi b_k ~ 1\/k²\n {3}1\.2 "a_k ~ 1\/k²" Stima di a_k falsa/);
    assert.match(fake.calls[3].system ?? '', /The finding is real when any of its points is real/);
    assert.deepEqual(issues(`status = 'open'`).map((i) => [i.quote, i.message, i.suggestion]), [['a_k ~ 1/k²', 'Stima di a_k falsa', 'Scrivi a_k ~ 1/k³']]);
    // Two different errors that both hold: both reach the stored issue, and so the fix prompt. The task above never succeeded,
    // so each review is again a first review that replaces the open issues.
    fake.next(...two(), verdict({ points: [1, 2] }));
    await review();
    assert.deepEqual(issues(`status = 'open'`).map((i) => [i.message, i.suggestion]), [['(1) "b_k ~ 1/k": Stima di b_k falsa (2) "a_k ~ 1/k²": Stima di a_k falsa', '(1) Scrivi b_k ~ 1/k² (2) Scrivi a_k ~ 1/k³']]);
    // A verdict that names no point keeps them all.
    fake.next(...two(), verdict({}));
    await review();
    assert.match(issues(`status = 'open'`)[0].message, /^\(1\) .*\(2\) /);
  });

  test('the first review keeps the union of the reviewer calls and the cross review, and merges repeats before the second opinion', async () => {
    samples(2);
    seedOutline([['c1', ['s1', 's2']]]);
    seedRevision('s1', 'Una frase che afferma una equivalenza.\n\nUn esempio con un conto sbagliato.\n\nUna frase troncata a metà del');
    seedRevision('s2', 'Una didascalia della figura.');
    fake.next(
      answer({ issues: [finding({ sectionId: 's2', quote: 'Una didascalia', message: 'La didascalia è falsa' }), finding({ quote: 'afferma una equivalenza', message: 'Equivalenza falsa', severity: 'minor' })] }),
      answer({ issues: [finding({ quote: 'Una frase che afferma', category: 'unsupported', message: 'Equivalenza non supportata', severity: 'blocker' }), finding({ quote: 'un conto sbagliato', message: 'Esempio sbagliato' })] }),
      answer({ issues: [finding({ quote: 'troncata a metà', category: 'language', severity: 'minor', message: 'Frase troncata' })] }),
      verdicts({ severity: 'minor' }, { severity: 'major' }, { severity: 'minor' }, { severity: 'major' }),
    );
    const r = await review();
    assert.deepEqual([r.samples, r.sampleModels, r.chapterRead, r.crossModel, r.model, r.merged, r.issues, r.lowered], [2, ['gpt-6-sol', 'gpt-6-sol'], true, 'claude-opus-5-5', 'gpt-6-sol', 1, 4, 1]);
    assert.deepEqual(fake.calls.slice(0, 3).map((c) => c.selection.model), ['gpt-6-sol', 'gpt-6-sol', 'claude-opus-5-5']);
    assert.equal(fake.calls[0].prompt, fake.calls[1].prompt, 'every sample reads the same prompt');
    assert.match(fake.calls[0].system ?? '', /Report every error you find; there is no limit\./);
    assert.doesNotMatch(fake.calls[0].system ?? '', /fewer, solid issues/);
    // The two findings on the first block reach the second opinion as one: the blocker, which takes correctness from its repeat.
    assert.match(fake.calls[3].prompt, /1\. \[s1\] \[blocker\] "Una frase che afferma" Equivalenza non supportata Suggested fix: Correggi\n2\. \[s1\] \[major\] "un conto sbagliato"[\s\S]*4\. \[s2\]/);
    assert.doesNotMatch(fake.calls[3].prompt, /Equivalenza falsa|sameAs/);
    assert.doesNotMatch(fake.calls[3].system ?? '', /sameAs/);
    // The floor keeps the merged false statement major although the second opinion said minor.
    assert.deepEqual(issues(`source = 'review' AND status = 'open'`).map((i) => [i.message, i.severity, i.category]), [
      ['Equivalenza non supportata', 'major', 'correctness'], ['Esempio sbagliato', 'major', 'correctness'], ['Frase troncata', 'minor', 'language'], ['La didascalia è falsa', 'major', 'correctness'],
    ]);
  });

  test('a cross review that fails leaves the reviewer findings; a reviewer call that fails fails the task', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.');
    fake.next(answer({ issues: [finding()] }), () => new Error('boom'), verdicts({ severity: 'major' }));
    const r = await review();
    assert.deepEqual([r.samples, r.crossModel, r.issues], [1, false, 1]);
    fake.next(() => new Error('boom'));
    await assert.rejects(review({ force: true }), TaskError);
  });

  test('the second opinion cannot lower a false statement below major, on a review and on a recheck; other categories still go down', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.\n\nUn simbolo.\n\nUna nota.');
    fake.next(
      answer({ issues: [finding({ severity: 'blocker' }), finding({ quote: 'Un simbolo.', category: 'notation', message: 'Simbolo' }), finding({ quote: 'Una nota.', severity: 'minor', message: 'Svista minore' })] }),
      crossNone,
      verdicts({ severity: 'minor' }, { severity: 'minor' }, { severity: 'minor' }),
    );
    const r = await review();
    assert.equal(r.lowered, 2);
    assert.deepEqual(issues(`status = 'open'`).map((i) => [i.message, i.severity]), [['Errore', 'major'], ['Simbolo', 'minor'], ['Svista minore', 'minor']]);
    done(r);
    fake.next(verdicts({ severity: 'minor' }, { severity: 'minor' }, { severity: 'minor' }));
    await review({ mode: 'recheck' });
    assert.equal(issues(`message = 'Errore'`)[0].severity, 'major', 'a recheck keeps the floor too');
  });

  test('an asked sweep reads the whole chapter with the fixed and open issues; a review without the ask reads changed text only', async () => {
    samples(2);
    seedOutline([['c1', ['s1', 's2']], ['c2', ['s3']]]);
    seedRevision('s1', 'Una frase.\n\nAltro.');
    seedRevision('s2', 'Seconda sezione intatta.');
    seedRevision('s3', 'Altro capitolo.');
    ctx.db.insert('review_issues', { id: 'elsewhere', project_id: P, node_id: 's3', source: 'review', severity: 'major', category: 'correctness', quote: 'Un estremo interno', message: 'Un estremo interno non richiede la derivabilità', suggestion: '', status: 'fixed', resolution: '', created_at: now() });
    fake.next(answer({ issues: [finding({ message: 'Ipotesi mancante' }), finding({ sectionId: 's2', quote: 'Seconda sezione intatta.', category: 'language', severity: 'minor', message: 'Resta aperto' })] }), answer({ issues: [] }), crossNone, verdicts({ severity: 'major' }, { severity: 'minor' }));
    const first = await review({ sweep: true });
    done(first);
    assert.deepEqual([first.full, first.sweep, first.samples, first.chapterRead], [true, undefined, 2, true], 'the first review is a whole-chapter read, not a sweep');

    // Fix round: the s1 issue is fixed. The asked review is the sweep: two calls on the whole chapter and the cross review, minors kept.
    fix('s1', 'Una frase corretta.\n\nAltro.');
    fake.next(
      answer({ issues: [finding({ sectionId: 's2', quote: 'Seconda sezione intatta.', severity: 'minor', message: 'Stesso errore altrove' })] }),
      answer({ issues: [] }), crossNone, verdicts({ severity: 'minor' }),
    );
    const sweep = await review({ sweep: true });
    done(sweep);
    assert.deepEqual([sweep.sweep, sweep.mode, sweep.samples, sweep.chapterRead, sweep.issues, sweep.minorsDropped], [true, 'sweep', 2, true, 1, undefined]);
    const prompt = fake.calls[4].prompt;
    assert.match(prompt, /This is a sweep after a round of fixes/);
    assert.match(prompt, /=== \[s2\] Sezione 1\.2 ===\nSeconda sezione intatta\./, 'unchanged sections are read in full');
    assert.doesNotMatch(prompt, /summary only|SINCE THE LAST REVIEW/);
    assert.match(prompt, /ISSUES ALREADY FIXED[\s\S]*Ipotesi mancante/);
    assert.match(prompt, /ISSUES STILL OPEN[\s\S]*Resta aperto/);
    assert.match(prompt, /MISTAKES FIXED IN OTHER CHAPTERS[\s\S]*Un estremo interno non richiede la derivabilità/);
    assert.equal(fake.calls[6].selection.model, 'claude-opus-5-5');
    assert.deepEqual(issues(`source = 'review' AND status = 'open'`).map((i) => i.message).sort(), ['Resta aperto', 'Stesso errore altrove']);

    // The next fix makes the chapter due again, but the review queued at the end of a generate run does not ask: one call on the changed text.
    fix('s2', 'Seconda sezione corretta.');
    fake.next(answer({ issues: [] }));
    const after = await review();
    done(after);
    assert.deepEqual([after.sweep, after.samples, after.chapterRead], [undefined, 1, undefined]);
    assert.match(fake.calls[8].prompt, /SINCE THE LAST REVIEW/);
    assert.equal(fake.calls.length, 9);
  });

  test('a sweep keeps an open issue whose passage is still there, and does not delete one in a rewritten block that still holds its quote', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.\n\nUn passo. Ancora.');
    fake.next(answer({ issues: [finding(), finding({ quote: 'Un passo.', severity: 'minor', category: 'language', message: 'Resta aperto' })] }), crossNone, verdicts({ severity: 'major' }, { severity: 'minor' }));
    done(await review());
    ctx.db.run(`UPDATE review_issues SET status = 'fixed' WHERE message = 'Errore'`);
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = 's1' AND status = 'current'`);
    seedRevision('s1', 'Una frase corretta.\n\nUn passo. Ancora riscritto.');
    fake.next(answer({ issues: [] }), crossNone);
    const sweep = await review({ sweep: true });
    assert.equal(sweep.sweep, true);
    assert.deepEqual(issues(`source = 'review' AND status = 'open'`).map((i) => i.message), ['Resta aperto']);
    assert.match(fake.calls[3].prompt, /ISSUES STILL OPEN[^\n]*\n- \[s1\] "Un passo\." Resta aperto/);
  });

  test('the sweep is not told to skip an open issue whose quote a rewrite removed, since that issue is replaced', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.\n\n2 + 2 = 5.');
    fake.next(answer({ issues: [finding(), finding({ quote: '2 + 2 = 5.', severity: 'minor', category: 'language', message: 'Somma sbagliata' })] }), crossNone, verdicts({ severity: 'major' }, { severity: 'minor' }));
    done(await review());
    ctx.db.run(`UPDATE review_issues SET status = 'fixed' WHERE message = 'Errore'`);
    ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE node_id = 's1' AND status = 'current'`);
    seedRevision('s1', 'Una frase corretta.\n\nLa somma di 2 e 2 è 5.');
    fake.next(answer({ issues: [] }), crossNone);
    assert.equal((await review({ sweep: true })).sweep, true);
    assert.doesNotMatch(fake.calls[3].prompt, /ISSUES STILL OPEN|Somma sbagliata/);
  });

  test('a chapter is due for a sweep when its text changed since its last whole-chapter read and no blocker or major from review is open', async () => {
    seedOutline([['c1', ['s1']]]);
    const nodes = ['c1', 's1'];
    const r1 = seedRevision('s1', 'Una frase.');
    assert.equal(sweepDue(ctx, P, 'c1', nodes, heads(r1)), false, 'never reviewed: the first review reads the whole chapter anyway');
    fake.next(answer({ issues: [finding()] }), crossNone, verdicts({ severity: 'major' }));
    done(await review());
    assert.equal(sweepDue(ctx, P, 'c1', nodes, heads(r1)), false, 'an open major from review, and the text was just read');
    const r2 = fix('s1', 'Una frase corretta.');
    assert.equal(sweepDue(ctx, P, 'c1', nodes, heads(r2)), true, 'the text changed since the read and nothing serious is open');
    assert.equal(getProjectSummary(ctx, P).review!.sweepsDue, 1);
    // An open major from review blocks it; one from the exercise check or lint does not.
    ctx.db.insert('review_issues', { id: 'open1', project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'correctness', quote: 'Una frase', message: 'm', suggestion: '', status: 'open', resolution: '', created_at: now() });
    assert.equal(sweepDue(ctx, P, 'c1', nodes, heads(r2)), false);
    ctx.db.run(`UPDATE review_issues SET source = 'lint' WHERE id = 'open1'`);
    assert.equal(sweepDue(ctx, P, 'c1', nodes, heads(r2)), true);
    ctx.db.run(`DELETE FROM review_issues WHERE id = 'open1'`);
    // A Full review reads section by section with one call each: it is not the read a sweep counts from.
    fake.next(answer({ issues: [] }));
    done(await review({ mode: 'full' }));
    assert.equal(sweepDue(ctx, P, 'c1', nodes, heads(r2)), true);
    fake.next(answer({ issues: [] }), crossNone);
    const sweep = await review({ sweep: true });
    done(sweep);
    assert.equal(sweep.sweep, true);
    assert.equal(sweepDue(ctx, P, 'c1', nodes, heads(r2)), false, 'one sweep per change of the text');
    assert.equal(getProjectSummary(ctx, P).review!.sweepsDue, 0);
  });

  test('reviews stored before the whole-chapter reads counted do not count: an old book is due, and the asked sweep runs on unchanged text', async () => {
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Una frase.');
    // What a review stored before #133 looks like: one call, no chapterRead.
    startTask('chapter.review', { chapterId: 'c1' });
    done({ reviewed: r1, full: true, issues: 0 });
    assert.equal(sweepDue(ctx, P, 'c1', ['c1', 's1'], heads(r1)), true);
    // Without the ask, unchanged text is not read again.
    assert.equal((await review()).reused, true);
    fake.next(answer({ issues: [] }), crossNone);
    const sweep = await review({ sweep: true });
    assert.deepEqual([sweep.reused, sweep.sweep, sweep.chapterRead], [undefined, true, true]);
  });

  test('a whole-chapter read with a reviewer call on the fallback model records the models and does not count as the read', async () => {
    samples(2);
    seedOutline([['c1', ['s1']]]);
    const r1 = seedRevision('s1', 'Una frase.');
    // The first reviewer call hits the Codex limit: both samples run on the fallback (Sonnet).
    fake.next(quota(), answer({ issues: [] }), answer({ issues: [] }), crossNone);
    const first = await review();
    done(first);
    assert.deepEqual([first.samples, first.sampleModels, first.chapterRead], [2, ['claude-sonnet-5-5', 'claude-sonnet-5-5'], undefined]);
    assert.equal(sweepDue(ctx, P, 'c1', ['c1', 's1'], heads(r1)), true, 'the chapter still needs a read on the reviewer model');
  });

  test('a chapter longer than the reviewer reads is not recorded as read whole', async () => {
    samples(2);
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', `${'Una frase lunga del capitolo. '.repeat(4200)}`);
    fake.next(answer({ issues: [] }), answer({ issues: [] }), crossNone);
    const r = await review();
    done(r);
    assert.deepEqual([r.samples, r.chapterRead], [2, undefined]);
  });

  test('only a review run started with the sweep asks for it; the review at the end of a generate run never does', () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Una frase.');
    // startRun wakes the queue; the test only looks at the planned tasks.
    (ctx.queue as unknown as { wake(): void }).wake = () => undefined;
    const inputs = (scope: Record<string, unknown>) => {
      const run = startRun(ctx, P, 'review', scope);
      return ctx.db.all<{ input: string }>(`SELECT input FROM tasks WHERE run_id = ? AND kind = 'chapter.review'`, run.id).map((t) => JSON.parse(t.input));
    };
    assert.deepEqual(inputs({ sweep: true }), [{ chapterId: 'c1', sweep: true }]);
    assert.deepEqual(inputs({}), [{ chapterId: 'c1' }]);
    assert.deepEqual(inputs({ sweep: true, reviewMode: 'full' }), [{ chapterId: 'c1', mode: 'full' }]);
    assert.ok(generateSpecs(ctx, P).filter((s) => s.kind === 'chapter.review').every((s) => !s.input?.sweep));
    assert.ok(generateSpecs(ctx, P, undefined, ['s1']).filter((s) => s.kind === 'chapter.review').every((s) => !s.input?.sweep));
  });

  test('a fix of a wrong formula rewrites its body under the same key', () => {
    const base = { language: 'it', blocks: '[B0]\nx', requests: '1. y', evidence: '', knownFormulas: '', sectionIds: '' };
    assert.match(patchPrompt({ ...base, minimal: true }).system, /When a formula is wrong, rewrite its body in the same block and keep its key/);
  });
});

describe('r11. chapter-level review findings do not accumulate', () => {
  test('a second review replaces the open chapter-level finding; resolved history stays; a clean review leaves none open', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    const finding = { sectionId: 'unknown', severity: 'major', category: 'coverage', quote: '', message: 'Manca un obiettivo', suggestion: 'Aggiungilo' };
    const task = () => startTask('chapter.review', { chapterId: 'c1', force: true });
    const real = answer({ findings: [{ index: 1, verdict: 'real', severity: 'major', reason: '' }] });
    fake.next(answer({ issues: [finding] }), crossNone, real, answer({ issues: [finding] }), crossNone, real, answer({ issues: [] }), crossNone);
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
    fake.next(...check({}));
    await questionVerify(ctx, startTask('question.verify', { questionId: a }));
    assert.equal(fake.calls.at(-1)!.selection.model, ctx.settings().routes.checker.primary.model);
    const before = fake.calls.length;
    const b = q();
    fake.next(...check({ independentAnswer: '2', resultsAgree: false, agrees: false }), review({}));
    await questionVerify(ctx, startTask('question.verify', { questionId: b }));
    assert.equal(fake.calls.length, before + 4);
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

  test('a fix whose only change is a figure the check drops still returns the reason', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo uno.\n\n:::image{src="assets/vecchio.svg" alt="Vecchio" caption="Grafico vecchio"}\n:::');
    ctx.db.insert('review_issues', { id: 'f1', project_id: P, node_id: 's1', source: 'review', severity: 'minor', category: 'figure', quote: 'Grafico vecchio', message: 'Il grafico non corrisponde.', suggestion: 'Disegnare x^2', status: 'open', resolution: '', created_at: now() });
    fake.next(patchAnswer({ figures: [fig('a', 'x^2')], changes: [{ block: 0, text: `Testo uno.\n\n${img('a')}` }] }), answer(verdict(false)));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['f1'] }));
    assert.equal(r.skipped, 'no change survived the checks');
    assert.deepEqual(r.figureProblems, ['a: dropped by the check (Ripete il testo.)']);
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
