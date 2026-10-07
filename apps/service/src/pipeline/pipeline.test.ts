// Handler tests: scripted model answers (FakeFunnel), a real temp database, handlers called directly with a hand-made task.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { json, newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, seedPage, seedProject, seedResource, usageOf } from '../llm/testkit.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { resolveDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { commitAiRevision, sectionDraft } from './draft.ts';
import { chapterEnrich, enrichGraph } from './enrich.ts';
import { chapterPractice, practiceDone, practiceGenerate, questionImport, questionRevise, questionVerify } from './practice.ts';
import { labelResources, topicsMap } from './prepare.ts';
import { chapterReview, sectionRevise } from './review.ts';
import { generateSpecs, startRun } from './runs.ts';
import { computePriorities } from './prepare.ts';
import { acceptProposal, rejectProposal, insertProposal, updateQuestion } from '../repo/index.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';
const answer = (obj: unknown) => () => ({ structured: obj as never, text: JSON.stringify(obj), usage: usageOf(10, 10) });

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
});

describe('15. disagreement is a blocker', () => {
  test('agrees=false with no problems, or only minor/major ones, adds a blocker; an existing blocker is not duplicated', async () => {
    const a = q();
    fake.next(answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: a }));
    assert.deepEqual(issues(`question_id = '${a}'`).map((i) => i.severity), ['blocker']);

    const b = q();
    fake.next(answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [{ severity: 'major', message: 'm', suggestion: 's' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: b }));
    assert.deepEqual(issues(`question_id = '${b}'`).map((i) => i.severity).sort(), ['blocker', 'major']);

    const c = q();
    fake.next(answer({ independentAnswer: '2', resultsAgree: false, agrees: false, problems: [{ severity: 'blocker', message: 'wrong', suggestion: 's' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: c }));
    assert.deepEqual(issues(`question_id = '${c}'`).map((i) => i.severity), ['blocker']);
    assert.equal(row(c).status, 'issue');

    // Same result, gap in the argument: the reviewer's severity stands, no extra blocker.
    const d = q();
    fake.next(answer({ independentAnswer: '1', resultsAgree: true, agrees: false, problems: [{ severity: 'major', message: 'gap', suggestion: 's' }] }));
    await questionVerify(ctx, startTask('question.verify', { questionId: d }));
    assert.deepEqual(issues(`question_id = '${d}'`).map((i) => i.severity), ['major']);
  });
});

describe('4. practice generation stages', () => {
  const topic = (key: string) => {
    const id = `${P.slice(0, 8)}-${key}`;
    ctx.db.insert('topics', { id, project_id: P, name: key, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'high' });
    return id;
  };
  const gen = (n: number, kind: string) => ({ questions: Array.from({ length: n }, (_, i) => ({ topics: ['limiti'], difficulty: 'medio', statement: `${kind} ${i}`, hint: '', solution: 's', finalAnswer: '1' })) });

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
    assert.equal(ctx.db.all(`SELECT 1 FROM questions WHERE kind = 'exam' AND origin = 'generated'`).length, 1);
    assert.equal(taskKeys(runId).filter((k) => k.startsWith('verify:')).length, 3);
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
    assert.deepEqual(await practiceDone(ctx, barrier), { tasks: 2, failed: 0 });
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
});

describe('2. figure files are scoped to their section', () => {
  const plot = (expr: string) => ({ xRange: [-1, 1], yRange: [-1, 1], xLabel: null, yLabel: null, functions: [{ expr, label: null, domain: null, style: null }], points: null, asymptotes: null });
  const draft = (expr: string) => ({
    markdown: 'Un paragrafo semplice sulla funzione.\n\n:::image{src="assets/example.svg" alt="Grafico" caption="Fig"}\n:::',
    figures: [{ key: 'example', caption: 'Fig', alt: 'Grafico', plot: plot(expr) }], summary: 'riassunto',
  });

  test('two sections with the same figure key keep their own drawing and references', async () => {
    const [s1, s2] = [newId(), newId()];
    seedOutline([['c1', [s1, s2]]]);
    fake.next(answer(draft('x^2')), answer(draft('x^3')));
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
    fake.next(answer(draft('x^2')), answer(draft('x^3')), answer(draft('x^4')));
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

  test('assets and the revision are committed together: a failing commit leaves no asset row and no file', async () => {
    const s1 = newId();
    seedOutline([['c1', [s1]]]);
    fake.next(answer(draft('x^2')));
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
    fake.next(answer(draft('x^2')));
    const t = startTask('section.draft', { nodeId: s1, force: true });
    const first = await sectionDraft(ctx, t);
    const again = await sectionDraft(ctx, t);
    assert.equal(again.reused, true);
    assert.equal(again.revId, first.revId);
    assert.equal(fake.calls.length, 1);
  });
});

describe('7, 8, 9. revising keeps citations, is checkpointed and supersedes', () => {
  test('citation markers of the base revision are sent to the model and come back as citations', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Prima frase.\n\nSeconda frase.', { citations: { '0': ['n1'], '1': ['n2', 'n3'] } });
    fake.next(answer({ markdown: 'Prima frase corretta. [[n1]]\n\nSeconda frase. [[n2,n3]]' }));
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
    fake.next(answer({ markdown: 'Testo uno.' }), answer({ markdown: 'Testo due.' }));
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

describe('12, 13. topic map: labels, fingerprint, mutex, exam classification only', () => {
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

  test('a new theory source rebuilds the map and re-classifies exam questions only; unchanged sources do nothing', async () => {
    seedResource(ctx, { projectId: P, id: 'theory1', role: 'theory' });
    insertIndex('theory1');
    const exam = q({ kind: 'exam', origin: 'authentic', exam_group: 'G1', statement: 'Limite?' });
    const quiz = q({ kind: 'exercise', origin: 'authentic', statement: 'Quiz?' });
    fake.next(answer(topics()), answer({ items: [{ id: exam, topics: ['limiti'], difficulty: 'medio' }] }));
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.deepEqual(json(row(exam).topic_ids, []), [`${P.slice(0, 8)}-limiti`]);
    assert.equal(row(quiz).topic_ids, '[]', 'exercise collections are not classified');
    assert.ok(!fake.calls[1].prompt.includes(quiz));
    const stored = ctx.db.get<{ topic_fingerprint: string }>('SELECT topic_fingerprint FROM projects')!.topic_fingerprint;
    assert.ok(stored);

    // Unchanged: no model call at all.
    await topicsMap(ctx, startTask('topics.map', {}));
    assert.equal(fake.calls.length, 2);

    // A second theory source: topics are rebuilt (two sources in the prompt) and the exam is classified again.
    seedResource(ctx, { projectId: P, id: 'theory2', role: 'theory', filename: 'altro.pdf' });
    insertIndex('theory2');
    fake.next(answer({ topics: [...topics().topics, { key: 'serie', name: 'Serie', aliases: [], description: '', prerequisites: [], sources: [{ resource: 'R2', pageFrom: 1, pageTo: 2 }] }] }), answer({ items: [{ id: exam, topics: ['serie'], difficulty: 'facile' }] }));
    const r = await topicsMap(ctx, startTask('topics.map', {}));
    assert.match(fake.calls[2].prompt, /R2 altro\.pdf/);
    assert.equal(r.topics, 2);
    assert.deepEqual(json(row(exam).topic_ids, []), [`${P.slice(0, 8)}-serie`]);
    assert.notEqual(ctx.db.get<{ topic_fingerprint: string }>('SELECT topic_fingerprint FROM projects')!.topic_fingerprint, stored);
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
  test('regenerating before accepting reopens the issues of the replaced proposal; accepting the replacement fixes the right ones', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    ctx.db.insert('review_issues', { id: 'iA', project_id: P, node_id: 's1', source: 'review', severity: 'blocker', category: 'math', message: 'A', suggestion: 'a', status: 'open', resolution: '', created_at: now() });
    fake.next(answer({ markdown: 'Testo uno.' }), answer({ markdown: 'Testo due.' }), answer({ markdown: 'Testo tre.' }));
    const first = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['iA'] }));
    const issue = () => ({ ...ctx.db.get<Record<string, any>>(`SELECT status, resolution FROM review_issues WHERE id = 'iA'`)! });
    assert.deepEqual(issue(), { status: 'proposed', resolution: `Proposal ${first.revId}` });

    // Regenerate the same section without the issue: the first proposal is superseded.
    const second = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', instruction: 'più breve' }));
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', first.revId!)!.status, 'superseded');
    assert.deepEqual(issue(), { status: 'open', resolution: '' });
    assert.ok(events('issue.updated').some((e) => e.issueIds.includes('iA')));

    // The issue can be sent to the AI again and the replacement fixes it when accepted.
    const third = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['iA'] }));
    assert.equal(issue().status, 'proposed');
    const head = ctx.db.get<{ id: string }>(`SELECT id FROM content_revisions WHERE node_id = 's1' AND status = 'current'`)!.id;
    acceptProposal(ctx, P, 's1', third.revId!, head);
    assert.deepEqual(issue(), { status: 'fixed', resolution: `Fixed by accepting proposal ${third.revId}` });
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM content_revisions WHERE id = ?', second.revId!)!.status, 'superseded');
  });

  test('a replacement that applies directly also reopens, and rejecting reopens too', () => {
    seedOutline([['c1', ['s1']]]);
    const head = seedRevision('s1', 'Testo.');
    ctx.db.insert('review_issues', { id: 'iB', project_id: P, node_id: 's1', source: 'review', severity: 'major', category: 'x', message: 'B', status: 'proposed', resolution: 'Proposal p-old', created_at: now() });
    const p1 = seedRevision('s1', 'Proposta', { status: 'proposal', parent: head });
    ctx.db.run(`UPDATE review_issues SET resolution = ? WHERE id = 'iB'`, `Proposal ${p1}`);
    rejectProposal(ctx, P, 's1', p1);
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'iB'`)!.status, 'open');
    ctx.db.run(`UPDATE review_issues SET status = 'proposed', resolution = ? WHERE id = 'iB'`, `Proposal ${p1}`);
    ctx.db.run(`UPDATE content_revisions SET status = 'proposal' WHERE id = ?`, p1);
    const out = insertProposal(ctx, P, 's1', 'Nuovo', head, 'ai', 'm');
    assert.equal(out.applied, true);
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'iB'`)!.status, 'open');
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
  });
});

describe('r11. chapter-level review findings do not accumulate', () => {
  test('a second review replaces the open chapter-level finding; resolved history stays; a clean review leaves none open', async () => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Testo.');
    const finding = { sectionId: 'unknown', severity: 'major', category: 'coverage', quote: '', message: 'Manca un obiettivo', suggestion: 'Aggiungilo' };
    const task = () => startTask('chapter.review', { chapterId: 'c1', force: true });
    fake.next(answer({ issues: [finding] }), answer({ issues: [finding] }), answer({ issues: [] }));
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
