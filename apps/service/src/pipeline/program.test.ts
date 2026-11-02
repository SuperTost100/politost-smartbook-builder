// Course program: reading it, planning with it, writing to the exam format, checking a book against it and aligning the book.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES, examFormatSchema, outlineSchema, type AlignmentFinding, type Outline, type ProgramItem } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { ExtractError } from '../extract/errors.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from '../llm/testkit.ts';
import type { TaskContext } from '../queue/queue.ts';
import { getProgram, getReport, insertReport, reportInputs, saveProgramInput, saveProgramItems } from '../repo/index.ts';
import { alignApply, restoreRemoved, alignCheck, applyBlocker, bookDigest, checkBlocker, guideFindings, validateAlignment } from './align.ts';
import { commitAiRevision, sectionDraft } from './draft.ts';
import { chapterExamStats } from './exam.ts';
import { outlinePlan } from './plan.ts';
import { assignKeys, programDeps, programFingerprint, programParse, referencedProgramKeys, reserveNewKeys } from './program.ts';
import { alignSchema } from './prompts.ts';
import { chapterReview, sectionRevise } from './review.ts';
import { generateSpecs, startRun } from './runs.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';
const answer = (obj: unknown) => () => ({ structured: obj as never, text: JSON.stringify(obj), usage: usageOf(10, 10) });
const topicId = (key: string) => `${P.slice(0, 8)}-${key}`;
const fetchGuide = programDeps.fetchGuide;

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  ctx = kit.ctx;
  ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(ctx, P);
  // Runs are only planned here; the queue does not execute them.
  (ctx.queue as unknown as { wake(): void }).wake = () => undefined;
});
afterEach(() => {
  programDeps.fetchGuide = fetchGuide;
  setFunnel(null);
  kit.cleanup();
});

// ---------- fixtures ----------

const item = (key: string, o: Partial<ProgramItem> = {}): ProgramItem => ({ key, title: `Voce ${key}`, details: '', proofs: [], ...o });
const examFormat = (o: Record<string, unknown> = {}) => examFormatSchema.parse({ written: true, oral: false, proofs: 'some', summary: '', ...o });
const seedProgram = (items: ProgramItem[], fmt: Record<string, unknown> = {}) => saveProgramItems(ctx, P, { items, examFormat: examFormat(fmt) });

function section(id: string, o: Record<string, unknown> = {}) {
  return { id, title: `Titolo ${id}`, objectives: [`Obiettivo ${id}`], topicIds: [], depth: 'standard', subsections: [], programItems: [], role: 'content', ...o };
}
/** Approved outline: chapters of [chapterId, sections]. A section is an id or an object with fields. */
function seedOutline(chapters: [string, (string | ReturnType<typeof section>)[]][], extra: Partial<Outline> = {}) {
  const outline = outlineSchema.parse({
    chapters: chapters.map(([id, sections], i) => ({ id, slug: `cap-${i + 1}`, title: `Capitolo ${i + 1}`, objectives: [], prerequisites: [], sections: sections.map((s) => (typeof s === 'string' ? section(s) : s)) })),
    exclusions: [], notation: '', ...extra,
  });
  const revId = newId();
  ctx.db.insert('outline_revisions', { id: revId, project_id: P, outline, origin: 'human', note: '', created_at: now(), approved_at: now() });
  ctx.db.run('UPDATE projects SET outline_rev_id = ? WHERE id = ?', revId, P);
  return { revId, outline };
}
function seedRevision(nodeId: string, markdown: string) {
  const id = newId();
  ctx.db.insert('content_revisions', { id, project_id: P, node_id: nodeId, kind: 'section', markdown, origin: 'human', model: null, parent_rev_id: null, status: 'current', citations: {}, created_at: now() });
  return id;
}
function seedTopic(key: string, name = key) {
  ctx.db.insert('topics', { id: topicId(key), project_id: P, name, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'normal' });
  return topicId(key);
}
let questionNo = 0;
function seedExam(group: string, topics: string[], o: Record<string, unknown> = {}) {
  ctx.db.insert('questions', {
    id: newId(), project_id: P, kind: 'exam', origin: 'authentic', exam_group: group, exam_date: null, number: String(++questionNo), statement: `Testo ${group} ${questionNo}`, hint: '', solution: '',
    difficulty: 'medio', topic_ids: topics.map(topicId), status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(), ...o,
  });
}
function startTask(kind: string, input: Record<string, unknown>, runKind = 'generate'): TaskContext {
  const runId = newId();
  ctx.db.insert('runs', { id: runId, project_id: P, kind: runKind, status: 'running', snapshot: {}, created_at: now() });
  const id = newId();
  const key = `${kind}:${id}`;
  ctx.db.insert('tasks', { id, run_id: runId, project_id: P, kind, label: kind, key, input, state: 'running', pool: 'local', attempts: 1, max_attempts: 3, created_at: now() });
  return {
    task: { id, runId, projectId: P, kind, key, label: kind, input, attempts: 1 }, signal: new AbortController().signal, deps: {},
    enqueue: (specs) => ctx.queue.addTasks(runId, P, specs), progress: () => undefined, setProvider: () => undefined,
  };
}
const taskKeys = (runId: string) => ctx.db.all<{ key: string }>('SELECT key FROM tasks WHERE run_id = ? ORDER BY rowid', runId).map((r) => r.key);
const issues = (where = '1=1') => ctx.db.all<Record<string, any>>(`SELECT * FROM review_issues WHERE ${where} ORDER BY rowid`);
const head = (nodeId: string) => ctx.db.get<Record<string, any>>(`SELECT * FROM content_revisions WHERE node_id = ? AND status = 'current' ORDER BY rowid DESC`, nodeId);
const outlineRevisions = () => ctx.db.all<Record<string, any>>('SELECT * FROM outline_revisions WHERE project_id = ? ORDER BY rowid', P);
const approved = (): Outline => outlineSchema.parse(json(ctx.db.get<{ outline: string }>('SELECT outline FROM outline_revisions WHERE id = (SELECT outline_rev_id FROM projects WHERE id = ?)', P)!.outline, {}));

// ---------- reading the program ----------

const GUIDE = `## Programma

Limiti e continuità: Limiti di funzioni e successioni; continuità. Teoremi sui limiti: unicità del limite, permanenza del segno e limitatezza locale, teoremi di confronto. (Circa 24 ore)
Derivate: significato geometrico e fisico. Regole di derivazione. Teorema di Fermat.

## Criteri, regole e procedure per l'esame

Modalita di esame: Test informatizzato in laboratorio; Prova scritta (in aula); Prova orale facoltativa;`;

describe('program.parse', () => {
  const parsed = (items: { key: string; title: string; details?: string; proofs?: string[] }[], fmt: Record<string, unknown> = {}) => ({
    items: items.map((i) => ({ details: '', proofs: [], ...i })),
    examFormat: { written: true, oral: true, proofs: 'some', summary: 'Test, prova scritta e orale facoltativa.', ...fmt },
  });

  test('joins the pasted text with the fetched guide, asks the planner once, and stores items and exam format', async () => {
    programDeps.fetchGuide = async (url) => { assert.equal(url, 'https://didattica.example/guide'); return 'Pagina della guida: orale facoltativo.'; };
    saveProgramInput(ctx, P, { text: GUIDE, url: 'https://didattica.example/guide' });
    fake.next(answer(parsed([{ key: 'limiti', title: 'Limiti di funzioni e successioni' }, { key: 'fermat', title: 'Teorema di Fermat', proofs: ['Teorema di Fermat'] }])));
    const r = await programParse(ctx, startTask('program.parse', {}, 'program'));
    assert.equal(r.items, 2);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].selection.model, ctx.settings().routes.planner.primary.model);
    assert.match(fake.calls[0].prompt, /Teoremi sui limiti: unicità del limite/);
    assert.match(fake.calls[0].prompt, /Pagina della guida: orale facoltativo\./);
    const p = getProgram(ctx, P)!;
    assert.equal(p.status, 'ready');
    assert.equal(p.error, null);
    assert.ok(p.parsedAt);
    assert.match(p.sourceText, /Circa 24 ore/);
    assert.match(p.sourceText, /orale facoltativo/);
    assert.deepEqual(p.items.map((i) => [i.key, i.proofs]), [['limiti', []], ['fermat', ['Teorema di Fermat']]]);
    assert.deepEqual(p.examFormat, { written: true, oral: true, proofs: 'some', summary: 'Test, prova scritta e orale facoltativa.' });
  });

  test('assignKeys keeps the key of an item whose title did not change and never repeats a key', () => {
    const before = [item('limiti', { title: 'Limiti di funzioni' }), item('derivate', { title: 'Derivate' })];
    const out = assignKeys([
      { key: 'x', title: 'Derivate', details: '', proofs: [] }, // same title: keeps "derivate"
      { key: 'derivate', title: 'Derivate seconde', details: '', proofs: [] }, // new item, its suggested key is taken
      { key: 'limiti', title: 'Limiti di funzioni e successioni', details: '', proofs: [] }, // title changed: the old key is not reused for it
      { key: 'Serie numeriche!', title: 'Serie', details: '', proofs: [] },
      { key: 'serie-numeriche', title: 'serie', details: '', proofs: [] },
    ], before);
    assert.deepEqual(out.map((i) => i.key), ['derivate', 'derivate-2', 'limiti-2', 'serie-numeriche', 'serie-numeriche-2']);
    assert.equal(new Set(out.map((i) => i.key)).size, out.length);
  });

  test('assignKeys and reserveNewKeys never hand out a key an outline still names', () => {
    // The program was removed and read again: "limiti" is no longer in it, but a section still names it.
    const out = assignKeys([{ key: 'limiti', title: 'Limiti', details: '', proofs: [] }], [], new Set(['limiti']));
    assert.deepEqual(out.map((i) => i.key), ['limiti-2']);
    const saved = reserveNewKeys([item('derivate'), item('limiti'), item('serie')], [item('derivate')], new Set(['derivate', 'limiti', 'limiti-2']));
    assert.deepEqual(saved.map((i) => i.key), ['derivate', 'limiti-3', 'serie'], 'an existing item keeps its key; a new one avoids every named key');
    const { revId } = seedOutline([['c1', [section('s1', { programItems: ['limiti', 'fermat'] })]]]);
    const o = json<Outline>(ctx.db.get<{ outline: string }>('SELECT outline FROM outline_revisions WHERE id = ?', revId)!.outline, {} as Outline);
    ctx.db.run('UPDATE outline_revisions SET outline = ? WHERE id = ?', JSON.stringify({ ...o, programExclusions: [{ item: 'serie', reason: 'Analisi 2' }] }), revId);
    assert.deepEqual([...referencedProgramKeys(ctx, P)].sort(), ['fermat', 'limiti', 'serie']);
  });

  test('a program removed while it is read stays removed', async () => {
    saveProgramInput(ctx, P, { text: GUIDE, url: 'https://didattica.example/guide' });
    programDeps.fetchGuide = async () => { ctx.db.run('DELETE FROM course_programs WHERE project_id = ?', P); return 'Pagina.'; };
    fake.next(answer(parsed([{ key: 'limiti', title: 'Limiti' }])));
    const r = await programParse(ctx, startTask('program.parse', {}, 'program'));
    assert.deepEqual(r, { skipped: 'program removed while it was read' });
    assert.equal(getProgram(ctx, P), null);
  });

  test('a second reading keeps the keys the outline refers to', async () => {
    seedProgram([item('limiti', { title: 'Limiti di funzioni' }), item('derivate', { title: 'Derivate' })]);
    ctx.db.run(`UPDATE course_programs SET text = ? WHERE project_id = ?`, GUIDE, P);
    fake.next(answer(parsed([{ key: 'derivate-di-funzioni', title: 'Derivate' }, { key: 'limiti', title: 'Limiti e continuità' }, { key: 'limiti-di-funzioni', title: 'Limiti di funzioni' }])));
    await programParse(ctx, startTask('program.parse', {}, 'program'));
    assert.deepEqual(getProgram(ctx, P)!.items.map((i) => [i.key, i.title]), [['derivate', 'Derivate'], ['limiti-2', 'Limiti e continuità'], ['limiti', 'Limiti di funzioni']]);
  });

  test('a failed fetch, an empty answer or an empty program leave a failed status with the reason', async () => {
    saveProgramInput(ctx, P, { text: '', url: 'https://didattica.example/guide' });
    programDeps.fetchGuide = async () => { throw new ExtractError('The page answered with status 404.', 400, 'url_status', 'Open it in a browser to check it is public.'); };
    await assert.rejects(programParse(ctx, startTask('program.parse', {}, 'program')), (e: any) => e.kind === 'input' && /404/.test(e.message));
    assert.deepEqual([getProgram(ctx, P)!.status, getProgram(ctx, P)!.error], ['failed', 'The page answered with status 404.']);

    saveProgramInput(ctx, P, { text: GUIDE, url: null });
    assert.equal(getProgram(ctx, P)!.status, 'parsing');
    fake.next(answer(parsed([])));
    await assert.rejects(programParse(ctx, startTask('program.parse', {}, 'program')), (e: any) => e.kind === 'input' && /No program items/.test(e.message));
    assert.equal(getProgram(ctx, P)!.status, 'failed');

    saveProgramInput(ctx, P, { text: '   ', url: null });
    await assert.rejects(programParse(ctx, startTask('program.parse', {}, 'program')), /empty/);
    assert.equal(fake.calls.length, 1, 'no model call without text');
  });

  test('startRun plans one program.parse task on the planner pool and joins an active run', () => {
    const run = startRun(ctx, P, 'program');
    assert.equal(run.kind, 'program');
    assert.deepEqual(taskKeys(run.id), ['program']);
    assert.equal(ctx.db.get<{ kind: string; pool: string }>('SELECT kind, pool FROM tasks WHERE run_id = ?', run.id)!.pool, 'planner');
    assert.equal(startRun(ctx, P, 'program').id, run.id);
  });
});

// ---------- planning ----------

describe('outline.plan with a program', () => {
  const plan = (chapters: unknown[], extra: Record<string, unknown> = {}) => answer({ notation: 'n', chapters, exclusions: [], programExclusions: [], ...extra });
  const planned = (title: string, o: Record<string, unknown> = {}) => ({ title, objectives: ['o'], topics: [], depth: 'standard', programItems: [], subsections: [], ...o });
  const chapter = (slug: string, sections: unknown[]) => ({ slug, title: slug, objectives: [], prerequisites: [], sections });
  const lastOutline = () => outlineSchema.parse(json(ctx.db.get<{ outline: string }>('SELECT outline FROM outline_revisions ORDER BY rowid DESC')!.outline, {}));

  beforeEach(() => {
    seedTopic('limiti', 'Limiti');
    seedTopic('serie', 'Serie');
  });

  test('the prompt carries the items and the exam format; unknown keys are dropped; taught items are not exclusions; exam guides only where the exams ask', async () => {
    seedProgram([item('limiti', { title: 'Limiti di funzioni', details: 'unicità del limite', proofs: ['unicità del limite'] }), item('derivate'), item('fermat'), item('serie')], { proofs: 'required', summary: 'Scritto più orale.' });
    // Two of three sessions asked about limits; nothing about series.
    seedExam('Esame del 12 gennaio 2023', ['limiti']);
    seedExam('Esame del 25 gennaio 2023', ['limiti', 'serie'].slice(0, 1));
    seedExam('Esame del 3 giugno 2023', []);
    fake.next(plan(
      [
        chapter('limiti', [planned('Limiti', { topics: ['limiti', 'inventato'], programItems: ['limiti', 'non-esiste', 'limiti'] }), planned('Derivate', { programItems: ['derivate'] })]),
        chapter('serie', [planned('Serie', { topics: ['serie'], programItems: ['serie'] })]),
      ],
      { exclusions: [{ topic: 'inventato', reason: 'x' }, { topic: 'serie', reason: 'non serve' }], programExclusions: [{ item: 'limiti', reason: 'già insegnato' }, { item: 'fermat', reason: 'fuori orario' }, { item: 'fantasma', reason: 'x' }, { item: 'fermat', reason: 'doppio' }] },
    ));
    const r = await outlinePlan(ctx, startTask('outline.plan', {}, 'plan'));
    const prompt = fake.calls[0].prompt;
    assert.match(prompt, /COURSE PROGRAM/);
    assert.match(prompt, /limiti \| Limiti di funzioni \| unicità del limite \| unicità del limite/);
    assert.match(prompt, /proofs of theorems are asked\. Scritto più orale\./);
    assert.match(prompt, /Do not add the final exam-guide section/);
    assert.equal(fake.calls[0].selection.model, ctx.settings().routes.planner.primary.model);

    const o = lastOutline();
    assert.deepEqual(o.chapters[0].sections.map((s) => [s.title, s.programItems, s.role]), [['Limiti', ['limiti'], 'content'], ['Derivate', ['derivate'], 'content'], ['Come viene chiesto all\'esame', [], 'exam-guide']]);
    assert.deepEqual(o.chapters[0].sections[0].topicIds, [topicId('limiti')], 'unknown topics are dropped as before');
    assert.deepEqual(o.chapters[1].sections.map((s) => s.role), ['content'], 'no exam question on its topics: no exam guide');
    assert.deepEqual(o.programExclusions, [{ item: 'fermat', reason: 'fuori orario' }]);
    assert.deepEqual(o.exclusions, [{ topicId: topicId('serie'), reason: 'non serve' }]);
    assert.equal(r.examGuides, 1);
  });

  test('without a program the planning is as before: no program text, no program keys, exam guides still follow the exams', async () => {
    seedExam('Esame del 12 gennaio 2023', ['limiti']);
    fake.next(plan([chapter('limiti', [planned('Limiti', { topics: ['limiti'], programItems: ['limiti'] })])], { programExclusions: [{ item: 'x', reason: 'y' }] }));
    await outlinePlan(ctx, startTask('outline.plan', {}, 'plan'));
    assert.doesNotMatch(fake.calls[0].prompt, /COURSE PROGRAM \(official/);
    assert.match(fake.calls[0].prompt, /There is no course program/);
    const o = lastOutline();
    assert.deepEqual(o.chapters[0].sections.map((s) => [s.programItems, s.role]), [[[], 'content'], [[], 'exam-guide']]);
    assert.deepEqual(o.programExclusions, []);
  });

  test('English books get the English title', async () => {
    ctx.db.run(`UPDATE projects SET language = 'en' WHERE id = ?`, P);
    seedExam('Exam of 12 January 2023', ['limiti']);
    fake.next(plan([chapter('limits', [planned('Limits', { topics: ['limiti'] })])]));
    await outlinePlan(ctx, startTask('outline.plan', {}, 'plan'));
    assert.equal(lastOutline().chapters[0].sections.at(-1)!.title, 'How the exam asks it');
  });
});

// ---------- exam statistics and the exam guide ----------

describe('exam guide', () => {
  beforeEach(() => {
    seedTopic('limiti', 'Limiti');
    seedTopic('serie', 'Serie');
  });

  test('session counts are computed from the classified questions: distinct sessions, only on the chapter\'s topics, only counted sources', () => {
    const { outline } = seedOutline([['c1', [section('s1', { topicIds: [topicId('limiti')] }), section('g1', { role: 'exam-guide', topicIds: [topicId('serie')] })]]]);
    seedExam('Esame A', ['limiti']);
    seedExam('Esame A', ['limiti']);
    seedExam('Esame B', ['serie']);
    seedExam('Esame C', ['limiti', 'serie']);
    seedExam('Esame D', ['limiti'], { resource_id: 'r-gone' });
    ctx.db.run(`INSERT INTO resources (id, project_id, kind, role, filename, sha256, size, path, included, status, created_at) VALUES ('r-gone', ?, 'pdf', 'exams', 'e.pdf', 'aa', 1, '/x', 0, 'ready', 'now')`, P);
    ctx.db.insert('questions', { id: newId(), project_id: P, kind: 'exercise', origin: 'generated', exam_group: null, statement: 's', hint: '', solution: '', difficulty: 'medio', topic_ids: [topicId('limiti')], status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now() });
    const stats = chapterExamStats(ctx, P, outline.chapters[0]);
    // Sessions A, B, C count in the archive (D's source is excluded); A and C asked about limits; the guide's own topics do not count.
    assert.deepEqual([stats.asked, stats.total, stats.questions.length], [2, 3, 3]);
  });

  test('the guide is written from the questions with the computed fact, without an evidence task, and links to the chapter', async () => {
    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ figures: true }), P);
    seedOutline([['c1', [section('s1', { title: 'Limiti notevoli', topicIds: [topicId('limiti')] }), section('g1', { role: 'exam-guide', title: "Come viene chiesto all'esame" })]]]);
    seedExam('Esame del 25 gennaio 2023', ['limiti'], { number: '2', exam_date: '2023-01-25', statement: 'Calcolare il limite $\\lim_{x\\to 0} \\frac{\\sin x}{x}$.' });
    seedExam('Esame del 3 giugno 2023', ['serie'], { number: '1' });
    seedExam('Esame del 5 luglio 2023', ['limiti'], { number: '4', exam_date: '2023-07-05' });
    fake.next(answer({ markdown: 'Il capitolo è uscito in 2 appelli su 3.\n\n### Limiti notevoli\n\nVedi [i limiti](ref:section/s1).', figures: [{ key: 'inutile', kind: 'plot', caption: 'c', alt: 'a', plot: { xRange: [-1, 1], yRange: [-1, 1], xLabel: null, yLabel: null, functions: [{ expr: 'x^2', label: null, domain: null, style: null }], points: null, asymptotes: null }, structure: null, photo: null, levels: null, orbitals: null, cell: null, periodic: null }], noFigureReason: null, summary: 'Guida.' }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 'g1' }));
    assert.equal(r.status, 'current');
    assert.equal(fake.calls.length, 1, 'no evidence call and no repair');
    const { prompt, system } = fake.calls[0];
    assert.match(prompt, /2 of the 3 past exam sessions/);
    assert.match(prompt, /Esame del 25 gennaio 2023 \| 2023-01-25 \| n\. 2 \| Limiti \| Calcolare il limite/);
    assert.doesNotMatch(prompt, /Esame del 3 giugno 2023/, 'a question on other topics is not shown');
    assert.match(prompt, /\[s1\]/);
    assert.match(prompt, /"Esame del 25 gennaio 2023, esercizio 2"/);
    assert.match(system!, /you never invent sessions/);
    assert.equal(ctx.db.get('SELECT 1 FROM assets'), undefined, 'figures are ignored in an exam guide');
    assert.match(head('g1')!.markdown, /ref:section\/s1/);
  });

  test('an exam guide with no question left is skipped instead of invented', async () => {
    seedOutline([['c1', [section('s1', { topicIds: [topicId('limiti')] }), section('g1', { role: 'exam-guide' })]]]);
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 'g1' }));
    assert.match(String(r.skipped), /no exam question/);
    assert.equal(fake.calls.length, 0);
  });

  test('generate specs: no evidence task for a guide, and its draft waits for the other drafts of the chapter', () => {
    seedOutline([['c1', ['s1', 's2', section('g1', { role: 'exam-guide' })]], ['c2', ['s3']]]);
    const specs = generateSpecs(ctx, P);
    const keys = specs.map((s) => s.key);
    assert.ok(!keys.includes('evidence:g1'));
    assert.deepEqual(specs.find((s) => s.key === 'draft:g1')!.deps, ['draft:s1', 'draft:s2']);
    assert.deepEqual(specs.find((s) => s.key === 'intro:c1')!.deps, ['draft:s1', 'draft:s2', 'draft:g1']);
    assert.ok(keys.indexOf('draft:s1') < keys.indexOf('draft:g1') && keys.indexOf('draft:s2') < keys.indexOf('draft:g1'));
    // Scoped: only the drafts asked for in the same call are awaited; written sections are not.
    seedRevision('s1', 'Scritta.');
    const scoped = generateSpecs(ctx, P, undefined, ['s2', 'g1']);
    assert.deepEqual(scoped.map((s) => s.key).slice(0, 3), ['evidence:s2', 'draft:s2', 'draft:g1']);
    assert.deepEqual(scoped.find((s) => s.key === 'draft:g1')!.deps, ['draft:s2']);
    assert.deepEqual(generateSpecs(ctx, P, undefined, ['g1']).find((s) => s.key === 'draft:g1')!.deps, []);
  });
});

describe('AI text commits', () => {
  test('a miscopied section id points at the section it meant; an unknown one loses the link', () => {
    const real = 'f88aee69-291a-4ea8-bf78-0f5718dacdfc';
    seedOutline([['c1', [section('s1'), section(real)]]]);
    const r = commitAiRevision(ctx, { projectId: P, nodeId: 's1', kind: 'section', baseRevId: null, model: 'm',
      markdown: 'Vedi [il rotolamento](ref:section/f88aee69-ba1d-4bd4-a22f-8d3d1dad579c) e [altro](ref:section/4c723236-4f4a-4f4a-4f4a-4f4a4f4a4f4a).' });
    assert.equal(head('s1')!.id, r.revId);
    assert.equal(head('s1')!.markdown, `Vedi [il rotolamento](ref:section/${real}) e altro.`);
  });
});

// ---------- writing to the exam format ----------

describe('the writer gets the program items and the exam format', () => {
  const draftOf = (id: string) => {
    fake.next(answer({ markdown: 'Testo.', figures: [], noFigureReason: 'x', summary: 's' }));
    return sectionDraft(ctx, startTask('section.draft', { nodeId: id }));
  };
  const outlineWith = () => seedOutline([['c1', [section('s1', { programItems: ['fermat', 'limiti'] }), section('s2', { programItems: ['derivate'] })]]]);

  test('proofs required: the complete proof with the marked line, items of this section only', async () => {
    seedProgram([item('limiti', { title: 'Limiti', details: 'unicità del limite' }), item('fermat', { title: 'Teorema di Fermat', proofs: ['Teorema di Fermat'] }), item('derivate', { title: 'Derivate' })], { proofs: 'required', summary: 'Scritto e orale.' });
    outlineWith();
    await draftOf('s1');
    const { prompt } = fake.calls[0];
    assert.match(prompt, /COURSE PROGRAM ITEMS this section teaches/);
    assert.match(prompt, /- Teorema di Fermat \| - \| Teorema di Fermat/);
    assert.match(prompt, /- Limiti \| unicità del limite \| -/);
    assert.doesNotMatch(prompt, /- Derivate \|/);
    assert.match(prompt, /The exam asks for proofs\. For every theorem[\s\S]*\*\*Dimostrazione richiesta all'esame\.\*\*/);
  });

  test('a section with no program item keeps the exam format but gets no scope to stay inside and marks no proof', async () => {
    seedProgram([item('derivate', { title: 'Derivate' })], { proofs: 'required' });
    seedOutline([['c1', [section('s1', { programItems: [] })]]]);
    await draftOf('s1');
    const { prompt } = fake.calls[0];
    assert.doesNotMatch(prompt, /COURSE PROGRAM ITEMS|stay inside what the program lists|none assigned/);
    assert.match(prompt, /EXAM: [\s\S]*teaches no program item of its own[\s\S]*never use the line \*\*Dimostrazione richiesta all'esame\.\*\*/);
    assert.doesNotMatch(prompt, /The exam asks for proofs\./);
  });

  test('written only and no proofs: the weight goes to methods; the proof line is not used', async () => {
    seedProgram([item('derivate', { title: 'Derivate' })], { proofs: 'none', oral: false });
    outlineWith();
    await draftOf('s2');
    assert.match(fake.calls[0].prompt, /asks for no proofs: put the weight on methods and fully worked exercises; keep proofs brief/);
    assert.doesNotMatch(fake.calls[0].prompt, /Dimostrazione richiesta all'esame/);
  });

  test('some proofs: only the listed ones are complete; an English book gets the English line; no program, no program block', async () => {
    seedProgram([item('fermat', { title: 'Teorema di Fermat', proofs: ['Teorema di Fermat'] })], { proofs: 'some' });
    ctx.db.run(`UPDATE projects SET language = 'en' WHERE id = ?`, P);
    outlineWith();
    await draftOf('s1');
    assert.match(fake.calls[0].prompt, /only for the results listed under "proofs asked" below/);
    assert.match(fake.calls[0].prompt, /\*\*Proof asked at the exam\.\*\*/);

    ctx.db.run('DELETE FROM course_programs');
    ctx.db.run(`DELETE FROM content_revisions`);
    await draftOf('s1');
    assert.doesNotMatch(fake.calls[1].prompt, /COURSE PROGRAM ITEMS/);
  });

  test('the reviewer knows the program items of the chapter and is told to flag extra material as minor', async () => {
    seedProgram([item('derivate', { title: 'Derivate', details: 'regole di derivazione' }), item('altro', { title: 'Altro' })]);
    outlineWith();
    seedRevision('s2', 'Le derivate.');
    fake.next(answer({ issues: [] }));
    await chapterReview(ctx, startTask('chapter.review', { chapterId: 'c1' }));
    const { prompt } = fake.calls[0];
    assert.match(prompt, /COURSE PROGRAM ITEMS the chapter's sections teach/);
    assert.match(prompt, /derivate \| Derivate \| regole di derivazione/);
    assert.doesNotMatch(prompt, /altro \| Altro/);
  });
});

// ---------- the alignment check ----------

describe('alignment check', () => {
  const raw = (findings: Partial<Record<string, unknown>>[], coverage: { item: string; nodeIds: string[] }[] = []) => ({
    coverage,
    findings: findings.map((f) => ({ kind: 'missing', item: null, nodeId: null, whole: null, quote: null, message: 'm', chapterId: null, afterSectionId: null, title: null, objectives: [], depth: null, ...f })),
  }) as unknown as import('zod').infer<typeof alignSchema>;

  function book() {
    const { outline, revId } = seedOutline([
      ['c1', [section('s1', { programItems: ['limiti'] }), section('s2', { programItems: ['derivate'] }), section('g1', { role: 'exam-guide' })]],
      ['c2', [section('s3')]],
    ]);
    seedProgram([item('limiti'), item('derivate'), item('serie')]);
    const texts = new Map([['s1', 'Il limite.\n\n**Teorema** (unicità del limite)\n\n**Dimostrazione.** Si procede così.'], ['s2', 'Le derivate.\n\n### Derivate seconde\n\nTesto.']]);
    return { outline, revId, texts };
  }

  test('validateAlignment drops findings that point at nothing and fixes what it can', () => {
    const { outline, texts } = book();
    const env = { program: [item('limiti'), item('derivate'), item('serie')], outline, texts, guides: [{ kind: 'exam-guide', chapterId: 'c2', message: 'g' } as AlignmentFinding] };
    const out = validateAlignment(raw([
      { kind: 'missing', item: 'serie', chapterId: 'c2', afterSectionId: 's3', title: 'Serie numeriche', objectives: ['Studiare la convergenza'], depth: 'deep' },
      { kind: 'missing', item: 'serie', chapterId: 'c2', title: 'Duplicato' },
      { kind: 'missing', item: 'inventato', chapterId: 'c2', title: 'X' },
      { kind: 'missing', item: 'derivate', chapterId: 'c9', title: 'X' },
      { kind: 'missing', item: 'limiti', chapterId: 'c1', afterSectionId: 's3', title: 'Dopo una sezione di un altro capitolo' },
      { kind: 'missing', item: 'derivate', chapterId: 'c1', afterSectionId: 'g1', title: 'Dopo la guida' },
      { kind: 'thin', item: 'limiti', nodeId: 's1' },
      { kind: 'thin', item: 'limiti', nodeId: 's3' }, // not written
      { kind: 'thin', item: 'limiti', nodeId: 'nope' },
      { kind: 'proof', item: 'nope', nodeId: 's1' },
      { kind: 'proof', item: 'limiti', nodeId: 'g1' }, // an exam guide is never a target
      { kind: 'off-program', nodeId: 's1', whole: true },
      { kind: 'off-program', nodeId: 's2', whole: false, quote: '### Derivate seconde' },
      { kind: 'off-program', nodeId: 's2', whole: false, quote: '### Non nel testo' },
      { kind: 'off-program', nodeId: 's2', whole: false, quote: null },
      { kind: 'off-program', nodeId: 'g1', whole: true },
      { kind: 'order', nodeId: 's2' },
      { kind: 'order', nodeId: 'nope' },
      { kind: 'message', message: '' },
    ].map((f) => ({ message: 'Message', ...f }))), env);
    assert.deepEqual(out.findings.map((f) => f.kind === 'missing' ? [f.kind, f.item, f.suggested.chapterId, f.suggested.afterSectionId, f.suggested.depth] : [f.kind, 'nodeId' in f ? f.nodeId : f.chapterId]), [
      ['missing', 'serie', 'c2', 's3', 'deep'],
      ['missing', 'derivate', 'c1', 's2', 'standard'], // after the guide becomes after the last section
      ['thin', 's1'],
      ['off-program', 's1'],
      ['off-program', 's2'],
      ['order', 's2'],
      ['exam-guide', 'c2'],
    ]);
    const s = out.findings[0] as Extract<AlignmentFinding, { kind: 'missing' }>;
    assert.deepEqual(s.suggested, { chapterId: 'c2', afterSectionId: 's3', title: 'Serie numeriche', objectives: ['Studiare la convergenza'], depth: 'deep' });
    // A coverage entry for every item; invented sections are dropped; items the model left out fall back to the outline's own mapping.
    const cov = validateAlignment(raw([], [{ item: 'limiti', nodeIds: ['s1', 'ghost', 'g1'] }, { item: 'serie', nodeIds: [] }]), env).coverage;
    assert.deepEqual(cov, [{ item: 'limiti', nodeIds: ['s1'] }, { item: 'derivate', nodeIds: ['s2'] }, { item: 'serie', nodeIds: [] }]);
  });

  test('the model reads a digest, not the section texts; it returns findings that are stored in one report', async () => {
    const { revId } = book();
    seedRevision('s1', 'Il limite di una funzione.\n\nFRASE-SOLO-NEL-CORPO.\n\n**Teorema** (unicità del limite)\n\n**Dimostrazione.** Si procede così.');
    seedRevision('s2', 'Le derivate.\n\n### Derivate seconde\n\nTesto.');
    const t1 = seedTopic('limiti', 'Limiti');
    ctx.db.run('UPDATE topics SET exam_sessions = 2 WHERE id = ?', t1);
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[0].sections[0].topicIds', json('["${t1}"]')) WHERE id = ?`, revId);
    seedExam('Esame A', ['limiti']);
    seedExam('Esame B', []);
    fake.next(answer(raw([
      { kind: 'missing', item: 'serie', chapterId: 'c2', afterSectionId: 's3', title: 'Serie', objectives: ['Convergenza'], depth: 'standard', message: 'Series are missing.' },
      { kind: 'proof', item: 'limiti', nodeId: 's2', message: 'No proof.' },
      { kind: 'thin', item: 'derivate', nodeId: 'nope', message: 'Bad id.' },
    ], [{ item: 'limiti', nodeIds: ['s1'] }])));
    const r = await alignCheck(ctx, startTask('program.check', {}, 'align'));
    const prompt = fake.calls[0].prompt;
    assert.match(prompt, /\[s1\] Titolo s1 \| standard \| \d+ chars \| proof: yes \| items: limiti \| exams: Limiti 2\/2/);
    assert.match(prompt, /statements: \*\*Teorema\*\* \(unicità del limite\) ; \*\*Dimostrazione\.\*\* Si procede così\./);
    assert.match(prompt, /headings: ### Derivate seconde/);
    assert.match(prompt, /\[s3\] Titolo s3 \| standard \| not written yet/);
    assert.match(prompt, /\[g1\] Titolo g1 \| exam guide/);
    assert.doesNotMatch(prompt, /FRASE-SOLO-NEL-CORPO/);
    assert.equal(fake.calls[0].selection.model, ctx.settings().routes.planner.primary.model);
    assert.deepEqual([r.findings, r.missing, r.proof, r.thin, r.examGuide, r.dropped], [2, 1, 1, 0, 0, 1]);
    const report = getReport(ctx, P, r.reportId);
    assert.equal(report.outlineRevId, revId);
    assert.equal(report.appliedAt, null);
    assert.deepEqual(report.findings.map((f) => f.kind), ['missing', 'proof']);
    assert.deepEqual(report.coverage.find((c) => c.item === 'limiti'), { item: 'limiti', nodeIds: ['s1'] });
  });

  test('exam-guide findings come from the exam questions, only for chapters with written text and no guide yet', () => {
    const { outline } = seedOutline([
      ['c1', [section('s1', { topicIds: [topicId('limiti')] })]],
      ['c2', [section('s2', { topicIds: [topicId('serie')] })]],
      ['c3', [section('s3', { topicIds: [topicId('limiti')] }), section('g3', { role: 'exam-guide' })]],
    ]);
    seedTopic('limiti');
    seedTopic('serie');
    seedExam('A', ['limiti']);
    seedExam('B', ['limiti']);
    seedExam('B', ['serie']);
    seedRevision('s1', 'Scritta.');
    seedRevision('s2', 'Scritta.');
    seedRevision('s3', 'Scritta.');
    const f = guideFindings(ctx, P, outline);
    assert.deepEqual(f.map((x) => x.kind === 'exam-guide' && x.chapterId), ['c1', 'c2']);
    assert.match(f[0].message, /2 of 2 past exam sessions/);
    assert.match(f[1].message, /1 of 2/);
    // A chapter without any written section waits.
    ctx.db.run(`DELETE FROM content_revisions WHERE node_id = 's2'`);
    assert.deepEqual(guideFindings(ctx, P, outline).map((x) => x.kind === 'exam-guide' && x.chapterId), ['c1']);
  });

  test('a book cannot be checked without a program, an approved outline or any text', () => {
    assert.equal(checkBlocker(ctx, P)!.code, 'no_program');
    seedProgram([item('limiti')]);
    assert.equal(checkBlocker(ctx, P)!.code, 'outline_not_approved');
    seedOutline([['c1', ['s1']]]);
    assert.equal(checkBlocker(ctx, P)!.code, 'nothing_written');
    seedRevision('s1', 'Testo.');
    assert.equal(checkBlocker(ctx, P), null);
    assert.match(bookDigest(ctx, P, approved(), 0), /Chapter 1 \[c1\]/);
  });
});

// ---------- Align book ----------

describe('Align book', () => {
  const MARK_IT = "*Questa sezione va oltre il programma del corso: all'esame non viene chiesta.*";
  const reportOf = (outlineRevId: string, findings: AlignmentFinding[]) => insertReport(ctx, { projectId: P, outlineRevId, coverage: [], findings, model: 'm' });
  const apply = (reportId: string, findings: number[] = []) => alignApply(ctx, startTask('program.apply', { reportId, findings }, 'align'));
  const runOf = (t: TaskContext) => t.task.runId;
  const offWhole = (nodeId: string): AlignmentFinding => ({ kind: 'off-program', nodeId, whole: true, message: 'Outside the program.', quote: '' });
  const missing = (o: Partial<Extract<AlignmentFinding, { kind: 'missing' }>['suggested']> = {}): AlignmentFinding => ({
    kind: 'missing', item: 'serie', message: 'Series are missing.', suggested: { chapterId: 'c2', afterSectionId: 's3', title: 'Serie numeriche', objectives: ['Studiare la convergenza'], depth: 'deep', ...o },
  });

  function book(extra: Record<string, unknown> = {}) {
    seedProgram([item('limiti', { title: 'Limiti', details: 'unicità del limite', proofs: ['unicità del limite'] }), item('derivate', { title: 'Derivate' }), item('serie', { title: 'Serie' })]);
    // Chapter 1 has a past exam question on its topics, so it can get an exam guide.
    seedTopic('t-limiti', 'Limiti');
    seedExam('Esame A', ['t-limiti']);
    const seeded = seedOutline([
      ['c1', [section('s1', { programItems: ['limiti'], topicIds: [topicId('t-limiti')] }), section('s2', { title: 'Cenni di topologia' })]],
      ['c2', [section('s3', { programItems: ['derivate'] })]],
    ]);
    seedRevision('s1', 'Limiti.\n\nTesto del limite.');
    seedRevision('s2', 'Topologia.\n\n:::formula{key="k-topo" label="Aperti"}\n$$A$$\n:::');
    seedRevision('s3', 'Derivate. Vedi {{formula:@limite-x}}.');
    if (extra.options) ctx.db.run('UPDATE projects SET options = ? WHERE id = ?', JSON.stringify(extra.options), P);
    return seeded;
  }

  test('delete mode: the section leaves the outline in a new approved revision, the texts stay, new sections and exam guides are queued, thin gets a fix task', async () => {
    const { revId } = book();
    const report = reportOf(revId, [offWhole('s2'), missing(), { kind: 'exam-guide', chapterId: 'c1', message: 'g' }, { kind: 'thin', item: 'limiti', nodeId: 's1', message: 'Limits are too short.' }, { kind: 'order', nodeId: 's1', message: 'later' }]);
    const contentRows = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_revisions')!.n;
    const t = startTask('program.apply', { reportId: report.id, findings: [] }, 'align');
    const r = await alignApply(ctx, t);

    const revs = outlineRevisions();
    assert.equal(revs.length, 2, 'the old revision stays');
    assert.equal(revs[0].id, revId);
    assert.equal(revs[1].origin, 'ai');
    assert.equal(revs[1].note, `align:${report.id}`);
    assert.ok(revs[1].approved_at);
    assert.equal(ctx.db.get<{ id: string }>('SELECT outline_rev_id AS id FROM projects')!.id, revs[1].id);
    const o = approved();
    assert.deepEqual(o.chapters[0].sections.map((s) => [s.title, s.role]), [['Titolo s1', 'content'], ["Come viene chiesto all'esame", 'exam-guide']]);
    assert.deepEqual(o.chapters[1].sections.map((s) => [s.title, s.programItems, s.depth]), [['Titolo s3', ['derivate'], 'standard'], ['Serie numeriche', ['serie'], 'deep']]);
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_revisions')!.n, contentRows, 'no content row is deleted');
    assert.ok(head('s2'), 'the removed section keeps its text');

    const fresh = o.chapters[1].sections[1].id;
    const guide = o.chapters[0].sections[1].id;
    const keys = taskKeys(runOf(t));
    assert.ok(keys.includes(`evidence:${fresh}`) && keys.includes(`draft:${fresh}`), keys.join());
    assert.ok(keys.includes(`draft:${guide}`) && !keys.includes(`evidence:${guide}`));
    assert.ok(keys.some((k) => k.startsWith('fix:s1:')));
    assert.ok(!keys.some((k) => /:s2(:|$)/.test(k)), 'nothing is queued for the removed section');

    const [issue] = issues();
    assert.deepEqual([issue.source, issue.category, issue.severity, issue.node_id, issue.status], ['program', 'program-thin', 'major', 's1', 'open']);
    assert.match(issue.suggestion, /Teach "Limiti" fully, as the course program words it: unicità del limite/);
    const fixTask = ctx.db.get<{ input: string }>(`SELECT input FROM tasks WHERE key LIKE 'fix:s1:%'`)!;
    assert.deepEqual(json<{ issueIds: string[] }>(fixTask.input, { issueIds: [] }).issueIds, [issue.id]);

    const after = getReport(ctx, P, report.id);
    assert.ok(after.appliedAt);
    assert.deepEqual(after.applied, [
      'Removed the section "Cenni di topologia": it is outside the course program and the rest of the book does not need it. Its text is kept, and Put back restores it.',
      'Added the section "Serie numeriche" to chapter "Capitolo 2" for the program item "Serie".',
      'Added the exam guide "Come viene chiesto all\'esame" to the end of chapter "Capitolo 1".',
      'Asked the fixer to teach "Limiti" in more depth in "Titolo s1".',
    ]);
    assert.deepEqual([r.added, r.fixes, r.outlineChanged], [2, 1, true]);
  });

  test('new drafts and the chapter review queued by Align book wait for the fixes in that chapter', async () => {
    const { revId } = book();
    const t = startTask('program.apply', { reportId: reportOf(revId, [missing({ chapterId: 'c1', afterSectionId: 's1', title: 'Nuova' }), { kind: 'thin', item: 'limiti', nodeId: 's1', message: 'Short.' }]).id, findings: [] }, 'align');
    await alignApply(ctx, t);
    const deps = ctx.db.all<{ key: string }>(`SELECT dt.key FROM tasks r JOIN task_deps d ON d.task_id = r.id JOIN tasks dt ON dt.id = d.dep_id WHERE r.run_id = ? AND r.key = 'review:c1'`, runOf(t)).map((x) => x.key);
    assert.ok(deps.some((k) => k.startsWith('draft:')), deps.join());
    assert.ok(deps.some((k) => k.startsWith('fix:s1:')), deps.join());
    const draft = ctx.db.get<{ key: string }>(`SELECT key FROM tasks WHERE run_id = ? AND key LIKE 'draft:%'`, runOf(t))!.key;
    const draftDeps = ctx.db.all<{ key: string }>(`SELECT dt.key FROM tasks r JOIN task_deps d ON d.task_id = r.id JOIN tasks dt ON dt.id = d.dep_id WHERE r.run_id = ? AND r.key = ?`, runOf(t), draft).map((x) => x.key);
    assert.ok(draftDeps.some((k) => k.startsWith('fix:s1:')), draftDeps.join());
  });

  test('new sections in written chapters get evidence, drafts and a chapter review, not a new introduction, practice or graph picks', async () => {
    const { revId } = book();
    const t = startTask('program.apply', { reportId: reportOf(revId, [missing()]).id, findings: [] }, 'align');
    await alignApply(ctx, t);
    const fresh = approved().chapters[1].sections[1].id;
    const keys = taskKeys(runOf(t));
    assert.ok(keys.includes(`evidence:${fresh}`) && keys.includes(`draft:${fresh}`), keys.join());
    assert.ok(!keys.some((k) => /^(intro|practice|enrich):/.test(k)), keys.join());
    const deps = ctx.db.all<{ key: string }>(`SELECT dt.key FROM tasks r JOIN task_deps d ON d.task_id = r.id JOIN tasks dt ON dt.id = d.dep_id WHERE r.run_id = ? AND r.key = 'review:c2'`, runOf(t)).map((x) => x.key);
    assert.deepEqual(deps, [`draft:${fresh}`]);
  });

  test('a new section whose anchor is removed in the same apply goes to the end of the chapter, before the exam guide', async () => {
    const { revId } = book();
    await apply(reportOf(revId, [offWhole('s2'), missing({ chapterId: 'c1', afterSectionId: 's2', title: 'Nuova' }), { kind: 'exam-guide', chapterId: 'c1', message: 'g' }]).id);
    assert.deepEqual(approved().chapters[0].sections.map((s) => s.title), ['Titolo s1', 'Nuova', "Come viene chiesto all'esame"]);
  });

  test('a missing item planned for a written section becomes a fix on that section, not a skip or a second section', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[1].sections[0].programItems', json('["derivate","serie"]')) WHERE id = ?`, revId);
    const t = startTask('program.apply', { reportId: reportOf(revId, [missing()]).id, findings: [] }, 'align');
    const r = await alignApply(ctx, t);
    assert.deepEqual([r.added, r.fixes, r.outlineChanged], [0, 1, false]);
    const [issue] = issues();
    assert.deepEqual([issue.category, issue.node_id], ['program-thin', 's3']);
    assert.match(issue.suggestion, /Teach "Serie" fully/);
    assert.ok(taskKeys(runOf(t)).some((k) => k.startsWith('fix:s3:')));
  });

  test('two missing items with the same message on one written section get one issue each', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[1].sections[0].programItems', json('["derivate","serie","limiti"]')) WHERE id = ?`, revId);
    const second: AlignmentFinding = { ...missing(), item: 'limiti' } as AlignmentFinding;
    await apply(reportOf(revId, [missing(), second]).id);
    assert.deepEqual(issues().map((i) => i.suggestion.match(/Teach "(\w+)"/)?.[1]).sort(), ['Limiti', 'Serie']);
  });

  test('a missing item planned for a section that is not written yet gets that section written, not a second one', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[1].sections[0].programItems', json('["derivate","serie"]')) WHERE id = ?`, revId);
    ctx.db.run(`DELETE FROM content_revisions WHERE node_id = 's3'`);
    const t = startTask('program.apply', { reportId: reportOf(revId, [missing()]).id, findings: [] }, 'align');
    const r = await alignApply(ctx, t);
    assert.equal(r.added, 0);
    assert.deepEqual(approved().chapters[1].sections.map((s) => s.id), ['s3'], 'no second section');
    assert.ok(taskKeys(runOf(t)).includes('draft:s3'));
    assert.match(getReport(ctx, P, (t.task.input as { reportId: string }).reportId).applied[0], /Queued the section "Titolo s3" for writing/);
  });

  test('Put back clears the exclusions of the items the restored section teaches', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[0].sections[1].programItems', json('["serie"]')) WHERE id = ?`, revId);
    const report = reportOf(revId, [offWhole('s2')]);
    await apply(report.id);
    const after = ctx.db.get<{ id: string }>('SELECT outline_rev_id AS id FROM projects')!.id;
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.programExclusions', json('[{"item":"serie","reason":"Analisi 2"}]')) WHERE id = ?`, after);
    restoreRemoved(ctx, P, report.id, 's2');
    assert.deepEqual(approved().programExclusions, []);
    assert.deepEqual(approved().chapters[0].sections[1].programItems, ['serie']);
  });

  test('neighbours removed together come back in their order, whichever is put back first', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[0].sections', json(?)) WHERE id = ?`,
      JSON.stringify(['s1', 'sa', 'sb', 'sc'].map((id) => section(id))), revId);
    const report = reportOf(revId, [offWhole('sb'), offWhole('sa')]);
    await apply(report.id);
    assert.deepEqual(approved().chapters[0].sections.map((s) => s.id).filter((id) => id.startsWith('s')), ['s1', 'sc']);
    restoreRemoved(ctx, P, report.id, 'sb');
    restoreRemoved(ctx, P, report.id, 'sa');
    assert.deepEqual(approved().chapters[0].sections.map((s) => s.id).filter((id) => id.startsWith('s')), ['s1', 'sa', 'sb', 'sc']);
  });

  test('a figures run never picks an exam guide', () => {
    const { revId } = book();
    ctx.db.run(`UPDATE outline_revisions SET outline = json_insert(outline, '$.chapters[0].sections[#]', json(?)) WHERE id = ?`, JSON.stringify(section('g9', { role: 'exam-guide' })), revId);
    seedRevision('g9', 'Guida.');
    const run = startRun(ctx, P, 'figures', { chapterIds: ['c1'] });
    const keys = taskKeys(run.id);
    assert.ok(keys.some((k) => k.startsWith('figures:s1:')), keys.join());
    assert.ok(!keys.some((k) => k.startsWith('figures:g9:')), keys.join());
  });

  test('an exam guide is not added when no exam question is on the chapter any more', async () => {
    const { revId } = book();
    const report = reportOf(revId, [{ kind: 'exam-guide', chapterId: 'c1', message: 'g' }]);
    ctx.db.run(`DELETE FROM questions WHERE project_id = ?`, P);
    await apply(report.id);
    assert.ok(!approved().chapters[0].sections.some((s) => s.role === 'exam-guide'));
    assert.match(getReport(ctx, P, report.id).applied[0], /no past exam question is on its topics any more/);
  });

  test('Put back restores a removed section where it was, with its text, once', async () => {
    const { revId } = book();
    const report = reportOf(revId, [offWhole('s2'), { kind: 'exam-guide', chapterId: 'c1', message: 'g' }]);
    await apply(report.id);
    assert.deepEqual(getReport(ctx, P, report.id).removed.map((r) => [r.nodeId, r.chapterId, r.afterSectionId, r.restoredAt]), [['s2', 'c1', 's1', null]]);
    const after = restoreRemoved(ctx, P, report.id, 's2');
    assert.ok(after.removed[0].restoredAt);
    assert.deepEqual(approved().chapters[0].sections.map((s) => s.id).slice(0, 2), ['s1', 's2']);
    assert.equal(approved().chapters[0].sections.at(-1)!.role, 'exam-guide', 'the exam guide stays last');
    assert.ok(head('s2'));
    assert.throws(() => restoreRemoved(ctx, P, report.id, 's2'), /back in the outline already/);
    assert.throws(() => restoreRemoved(ctx, P, report.id, 's1'), /did not remove/);
  });

  test('mark mode keeps the section and prepends one paragraph as a repair revision; marking twice changes nothing', async () => {
    const { revId } = book({ options: { offProgram: 'mark' } });
    const before = head('s2')!;
    const report = reportOf(revId, [offWhole('s2')]);
    await apply(report.id);
    assert.equal(outlineRevisions().length, 1, 'the outline is unchanged');
    const h = head('s2')!;
    assert.equal(h.markdown, `${MARK_IT}\n\n${before.markdown}`);
    assert.equal(h.origin, 'repair');
    assert.equal(h.parent_rev_id, before.id);
    assert.deepEqual(getReport(ctx, P, report.id).applied, ['Marked "Cenni di topologia" as beyond the program.']);
    assert.equal(ctx.db.get('SELECT 1 FROM tasks WHERE kind = ?', 'section.revise'), undefined);

    const again = reportOf(revId, [offWhole('s2')]);
    await apply(again.id);
    assert.equal(head('s2')!.id, h.id);
    assert.match(getReport(ctx, P, again.id).applied[0], /already marked/);
  });

  test('English books get the English note', async () => {
    const { revId } = book({ options: { offProgram: 'mark' } });
    ctx.db.run(`UPDATE projects SET language = 'en' WHERE id = ?`, P);
    await apply(reportOf(revId, [offWhole('s2')]).id);
    assert.ok(head('s2')!.markdown.startsWith('*This section goes beyond the course program: it is not asked at the exam.*\n\n'));
  });

  test('delete removes a section that others link to or take formulas from, rewriting those references as plain text', async () => {
    const { revId } = book();
    // s3 uses the formula k-topo that s2 defines, and links to s2.
    ctx.db.run(`UPDATE content_revisions SET markdown = 'Derivate. Vedi {{formula:@k-topo}} e [la topologia](ref:section/s2).' WHERE node_id = 's3'`);
    const report = reportOf(revId, [offWhole('s2')]);
    await apply(report.id);
    assert.deepEqual(approved().chapters[0].sections.map((s) => s.id).filter((id) => id.startsWith('s')), ['s1']);
    assert.equal(head('s3')!.markdown, 'Derivate. Vedi aperti e la topologia.');
    assert.equal(head('s3')!.origin, 'repair');
    assert.match(getReport(ctx, P, report.id).applied[0], /Links and formula references to it in 1 other section became plain text/);
  });

  test('the digest tells the checker which sections rely on each section', () => {
    const { outline } = book();
    ctx.db.run(`UPDATE content_revisions SET markdown = 'Derivate. Vedi {{formula:@k-topo}} e [la topologia](ref:section/s2).' WHERE node_id = 's3'`);
    const digest = bookDigest(ctx, P, outlineSchema.parse(outline), 0);
    assert.match(digest, /\[s2\][\s\S]*?used by: Titolo s3 \(link, formula k-topo\)/);
    assert.match(digest, /\[s3\][\s\S]*?used by: -/);
    seedRevision('c1', 'Introduzione: si parte da [la topologia](ref:section/s2).');
    assert.match(bookDigest(ctx, P, outlineSchema.parse(outline), 0), /\[s2\][\s\S]*?used by: Capitolo 1 \(chapter introduction\) \(link\) ; Titolo s3/);
  });

  test('a section removed earlier keeps its text when a section it links to is removed', async () => {
    const { revId } = book();
    // s9 left the outline in an earlier apply; its text still links to s2.
    seedRevision('s9', 'Vedi [la topologia](ref:section/s2).');
    await apply(reportOf(revId, [offWhole('s2')]).id);
    assert.equal(head('s9')!.markdown, 'Vedi [la topologia](ref:section/s2).');
  });

  test('Put back turns links to sections that are still out of the book into plain text', async () => {
    const { revId } = book();
    // s1 links to s2 and uses its formula; both are removed, then only s1 comes back.
    ctx.db.run(`UPDATE content_revisions SET markdown = 'Limiti. Vedi [la topologia](ref:section/s2) e {{formula:@k-topo}}.' WHERE node_id = 's1'`);
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[0].sections', json(?)) WHERE id = ?`, JSON.stringify(['s1', 's2', 'sc'].map((id) => section(id))), revId);
    const report = reportOf(revId, [offWhole('s1'), offWhole('s2')]);
    await apply(report.id);
    restoreRemoved(ctx, P, report.id, 's1');
    assert.equal(head('s1')!.markdown, 'Limiti. Vedi la topologia e aperti.');
  });

  test('Put back also drops links to a section that is out of the book and was never written', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE content_revisions SET markdown = 'Limiti. Vedi [il seguito](ref:section/sx).' WHERE node_id = 's1'`);
    const report = reportOf(revId, [offWhole('s1')]);
    await apply(report.id);
    restoreRemoved(ctx, P, report.id, 's1');
    assert.equal(head('s1')!.markdown, 'Limiti. Vedi il seguito.');
  });

  test('a link to a section whose id starts like another one is not a reference to it', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE content_revisions SET markdown = 'Derivate. Vedi [altro](ref:section/s20).' WHERE node_id = 's3'`);
    await apply(reportOf(revId, [offWhole('s2')]).id);
    assert.equal(head('s3')!.markdown, 'Derivate. Vedi [altro](ref:section/s20).');
  });

  test('a formula key that a section still in the book also defines keeps its references', async () => {
    const { revId } = book();
    ctx.db.run(`UPDATE content_revisions SET markdown = 'Limiti.\n\n:::formula{key="k-topo" label="Aperti"}\n$$B$$\n:::' WHERE node_id = 's1'`);
    ctx.db.run(`UPDATE content_revisions SET markdown = 'Derivate. Vedi {{formula:@k-topo}}.' WHERE node_id = 's3'`);
    await apply(reportOf(revId, [offWhole('s2')]).id);
    assert.equal(head('s3')!.markdown, 'Derivate. Vedi {{formula:@k-topo}}.');
  });

  test('delete still marks a section that exercises refer to, or the only section of its chapter', async () => {
    const { revId } = book();
    ctx.db.insert('questions', { id: 'q-link', project_id: P, kind: 'exercise', origin: 'generated', exam_group: null, exam_date: null, number: null, statement: 'Vedi [qui](ref:section/s2).', hint: '', solution: 'x', difficulty: 'medio', topic_ids: [], status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now() });
    const report = reportOf(revId, [offWhole('s2'), offWhole('s3')]);
    await apply(report.id);
    assert.equal(outlineRevisions().length, 1, 'neither section was removed');
    assert.ok(head('s2')!.markdown.startsWith(MARK_IT));
    const [first, second] = getReport(ctx, P, report.id).applied;
    assert.match(first, /Kept the section "Cenni di topologia" instead of removing it, because exercises of the book refer to it/);
    assert.match(second, /Kept the section "Titolo s3" instead of removing it, because it is the only section of its chapter/);
  });

  test('a passage is an issue whose fix removes it (delete) or adds the note before it (mark); a repeated report reuses the open issue', async () => {
    const { revId } = book();
    const passage: AlignmentFinding = { kind: 'off-program', nodeId: 's1', whole: false, message: 'The second paragraph is outside the program.', quote: 'Testo del limite.' };
    const t = startTask('program.apply', { reportId: reportOf(revId, [passage]).id, findings: [] }, 'align');
    await alignApply(ctx, t);
    const [issue] = issues();
    assert.deepEqual([issue.category, issue.severity, issue.quote, issue.source], ['program-off', 'minor', 'Testo del limite.', 'program']);
    assert.match(issue.suggestion, /^Remove this passage/);
    assert.equal(outlineRevisions().length, 1, 'no outline change');
    assert.ok(taskKeys(t.task.runId).some((k) => k.startsWith('fix:s1:')));

    ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ offProgram: 'mark' }), P);
    ctx.db.run(`UPDATE review_issues SET status = 'fixed'`);
    await apply(reportOf(revId, [passage]).id);
    const marked = issues(`status = 'open'`);
    assert.equal(marked.length, 1);
    assert.match(marked[0].suggestion, /^Add this line as its own paragraph immediately before the passage[\s\S]*Questo passaggio va oltre il programma/);

    await apply(reportOf(revId, [passage]).id);
    assert.equal(issues(`status = 'open'`).length, 1, 'the open issue is reused');
  });

  test('a missing proof becomes a program-proof issue with the marked line in the suggestion', async () => {
    const { revId } = book();
    await apply(reportOf(revId, [{ kind: 'proof', item: 'limiti', nodeId: 's1', message: 'The uniqueness proof is missing.' }]).id);
    const [issue] = issues();
    assert.equal(issue.category, 'program-proof');
    assert.match(issue.suggestion, /complete proof of unicità del limite[\s\S]*\*\*Dimostrazione richiesta all'esame\.\*\*/);
  });

  test('only the chosen findings are applied; order findings are never applied', async () => {
    const { revId } = book();
    const report = reportOf(revId, [offWhole('s2'), missing(), { kind: 'order', nodeId: 's1', message: 'later' }]);
    const r = await apply(report.id, [1, 2, 99]);
    assert.equal(r.added, 1);
    assert.deepEqual(approved().chapters[0].sections.map((s) => s.id), ['s1', 's2'], 'the off-program section was not chosen');
    assert.equal(getReport(ctx, P, report.id).applied.length, 1);
  });

  test('new sections after the same section keep the report order and never follow the exam guide', async () => {
    seedProgram([item('a'), item('b'), item('c')]);
    const { revId } = seedOutline([['c1', ['s1', section('g1', { role: 'exam-guide' })]]]);
    seedRevision('s1', 'Testo.');
    const at = (item: string, title: string, after: string | null): AlignmentFinding => ({ kind: 'missing', item, message: 'm', suggested: { chapterId: 'c1', afterSectionId: after, title, objectives: ['o'], depth: 'standard' } });
    await apply(reportOf(revId, [at('a', 'A', 's1'), at('b', 'B', 's1'), at('c', 'C', null)]).id);
    assert.deepEqual(approved().chapters[0].sections.map((s) => s.title), ['C', 'Titolo s1', 'A', 'B', 'Titolo g1']);
  });

  test('a stale or already applied report is refused with an action', async () => {
    const { revId } = book();
    const report = reportOf(revId, [missing()]);
    assert.equal(applyBlocker(ctx, P, report), null);
    await apply(report.id);
    const done = getReport(ctx, P, report.id);
    const twice = applyBlocker(ctx, P, done)!;
    assert.deepEqual([twice.status, twice.code], [409, 'report_applied']);
    assert.ok(twice.action);
    // The first apply changed the outline, so a report on the old revision is stale.
    const old = reportOf(revId, [missing({ title: 'Altra' })]);
    const stale = applyBlocker(ctx, P, old)!;
    assert.deepEqual([stale.status, stale.code], [409, 'report_stale']);
    assert.match(stale.action ?? '', /Check alignment again/);
    await assert.rejects(apply(old.id), (e: any) => e.kind === 'input' && /changed after/.test(e.message));
    assert.equal(outlineRevisions().length, 2);
    // A retried task after the changes were saved does nothing more.
    assert.deepEqual(await apply(report.id), { reused: true, applied: 1 });
    assert.equal(outlineRevisions().length, 2);
  });

  test('the report keeps the revisions the planner read, so an edit during the call makes it stale', async () => {
    book();
    const read = head('s2')!.id;
    const reply = answer({ coverage: [], findings: [{ kind: 'off-program', item: null, nodeId: 's2', whole: true, quote: null, message: 'Outside.', chapterId: null, afterSectionId: null, title: null, objectives: [], depth: null }] });
    fake.next(() => { seedRevision('s2', 'Riscritta mentre il planner legge.'); return reply(); });
    const r = await alignCheck(ctx, startTask('program.check', {}, 'align'));
    assert.equal(reportInputs(ctx, r.reportId).heads?.s2, read);
    assert.match(applyBlocker(ctx, P, getReport(ctx, P, r.reportId))?.message ?? '', /section the report talks about changed/);
  });

  test('a report that removes a section is stale once any section changes', async () => {
    book();
    const reply = answer({ coverage: [], findings: [{ kind: 'off-program', item: null, nodeId: 's2', whole: true, quote: null, message: 'Outside.', chapterId: null, afterSectionId: null, title: null, objectives: [], depth: null }] });
    fake.next(() => reply());
    const r = await alignCheck(ctx, startTask('program.check', {}, 'align'));
    assert.ok(Object.keys(reportInputs(ctx, r.reportId).heads ?? {}).includes('s3'));
    assert.ok(Object.keys(reportInputs(ctx, r.reportId).heads ?? {}).includes('c1'), 'chapter introductions count too');
    seedRevision('s3', 'Derivate. Ora serve [la topologia](ref:section/s2).');
    assert.match(applyBlocker(ctx, P, getReport(ctx, P, r.reportId))?.message ?? '', /section the report talks about changed/);
  });

  test('a report is stale once the program or a section it names changes', async () => {
    const { revId } = book();
    const inputs = () => ({ program: programFingerprint(getProgram(ctx, P)!), heads: { s2: head('s2')!.id } });
    const report = insertReport(ctx, { projectId: P, outlineRevId: revId, coverage: [], findings: [offWhole('s2')], model: 'm', inputs: inputs() });
    assert.equal(applyBlocker(ctx, P, report), null);
    seedRevision('s1', 'Un altro testo.');
    assert.equal(applyBlocker(ctx, P, report), null, 'a section the report does not name may change');
    seedRevision('s2', 'Topologia riscritta.');
    assert.match(applyBlocker(ctx, P, report)?.message ?? '', /section the report talks about changed/);

    const second = insertReport(ctx, { projectId: P, outlineRevId: revId, coverage: [], findings: [offWhole('s2')], model: 'm', inputs: inputs() });
    assert.equal(applyBlocker(ctx, P, second), null);
    ctx.db.run(`UPDATE course_programs SET status = 'parsing' WHERE project_id = ?`, P);
    assert.equal(applyBlocker(ctx, P, second), null, 'a reading status alone changes nothing');
    seedProgram([item('limiti', { title: 'Limiti' })]);
    assert.match(applyBlocker(ctx, P, second)?.message ?? '', /course program changed/);
  });

  test('findings that no longer fit are skipped with a line, not applied', async () => {
    const { revId } = book();
    const report = reportOf(revId, [missing({ chapterId: 'gone' }), { kind: 'thin', item: 'nope', nodeId: 's1', message: 'm' }, { kind: 'off-program', nodeId: 'gone', whole: true, message: 'm', quote: '' }]);
    const r = await apply(report.id);
    assert.equal(r.outlineChanged, false);
    assert.equal(outlineRevisions().length, 1);
    assert.deepEqual(getReport(ctx, P, report.id).applied, [
      'Skipped an off-program finding: the section is gone.',
      'Skipped the new section for "serie": the chapter is gone.',
      'Skipped a depth fix for "nope": the program item was removed.',
    ]);
  });

  test('startRun plans a check task or an apply task, one align run at a time', () => {
    const check = startRun(ctx, P, 'align');
    assert.deepEqual(ctx.db.all<{ kind: string; pool: string }>('SELECT kind, pool FROM tasks WHERE run_id = ?', check.id).map((r) => [r.kind, r.pool]), [['program.check', 'planner']]);
    assert.throws(() => startRun(ctx, P, 'align', { align: { reportId: 'r', findings: [1] } }), (e: any) => e.status === 409 && e.code === 'align_running');
    ctx.db.run(`UPDATE runs SET status = 'completed' WHERE id = ?`, check.id);
    const apply = startRun(ctx, P, 'align', { align: { reportId: 'r1', findings: [1] } });
    const task = ctx.db.get<{ kind: string; input: string }>('SELECT kind, input FROM tasks WHERE run_id = ?', apply.id)!;
    assert.equal(task.kind, 'program.apply');
    assert.deepEqual(json(task.input, {}), { reportId: 'r1', findings: [1] });
  });
});

// ---------- the fix flow for program issues ----------

describe('fixes for program issues may add material', () => {
  const issue = (id: string, category: string, o: Record<string, unknown> = {}) => ctx.db.insert('review_issues', {
    id, project_id: P, node_id: 's1', source: 'program', severity: category === 'program-off' ? 'minor' : 'major', category, quote: '', message: `Problema ${id}`, suggestion: `Fai ${id}`, status: 'open', resolution: '', created_at: now(), ...o,
  });
  const checkGood = (blocks: number[]) => ({ changes: blocks.map((block) => ({ block, verdict: 'good', reason: '' })), issues: [{ index: 1, fixed: true, reason: '' }] });
  const longAdd = 'Enunciato completo.\n\nDimostrazione richiesta all\'esame: prima si osserva che il limite è unico, poi si procede per assurdo con due valori distinti.\n\nEsempio svolto passo per passo.';

  beforeEach(() => {
    seedOutline([['c1', ['s1']]]);
    seedRevision('s1', 'Prima.\n\nSeconda.');
  });

  test('thin coverage: the writer role gets "[add material]" and the permission to grow; the check does not call the added text harmful', async () => {
    issue('i1', 'program-thin');
    fake.next(answer({ figures: [], changes: [{ block: 1, text: `Seconda.\n\n${longAdd}` }] }), answer(checkGood([1])));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['i1'] }));
    assert.equal(r.status, 'current');
    assert.equal(fake.calls[0].selection.model, ctx.settings().routes.writer.primary.model);
    assert.match(fake.calls[0].prompt, /1\. \[add material\] Problema i1 Suggested fix: Fai i1/);
    assert.match(fake.calls[0].system!, /Problems marked \[add material\] ask for content the section lacks/);
    assert.match(fake.calls[0].system!, /Make the smallest edit that fixes each problem/);
    assert.match(fake.calls[1].prompt, /\[add material\]/);
    assert.match(fake.calls[1].prompt, /Issues marked \[add material\] ask for new material/);
    assert.equal(head('s1')!.markdown, `Prima.\n\nSeconda.\n\n${longAdd}`);
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'i1'`)!.status, 'fixed');
  });

  test('the check sees a long added proof whole, so it never rejects it as cut off', async () => {
    issue('i1', 'program-proof');
    const proof = `Dimostrazione. ${'Passaggio della dimostrazione con tutti i dettagli. '.repeat(80)}Fine della dimostrazione.`;
    fake.next(answer({ figures: [], changes: [{ block: 1, text: `Seconda.\n\n${proof}` }] }), answer(checkGood([1])));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['i1'] }));
    assert.ok(proof.length > 3000);
    assert.ok(fake.calls[1].prompt.includes('Fine della dimostrazione.'), 'the end of the new text reaches the check');
    assert.match(fake.calls[1].prompt, /it is not in the book, so never judge a block unfinished because of it/);
  });

  test('other fixes stay minimal: no permission to grow, editor role', async () => {
    ctx.db.run(`DELETE FROM content_revisions`);
    seedRevision('s1', 'Prima, un paragrafo abbastanza lungo perché toglierne uno corto non sia più di un quinto del testo.\n\nSeconda.');
    issue('i2', 'program-off', { quote: 'Seconda.' });
    fake.next(answer({ figures: [], changes: [{ block: 1, text: '' }] }), answer(checkGood([1])));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['i2'] }));
    assert.equal(fake.calls[0].selection.model, ctx.settings().routes.editor.primary.model);
    assert.doesNotMatch(fake.calls[0].system!, /\[add material\]/);
    assert.doesNotMatch(fake.calls[0].prompt, /\[add material\]/);
    assert.doesNotMatch(fake.calls[1].prompt, /ask for new material/);
    assert.equal(head('s1')!.markdown, 'Prima, un paragrafo abbastanza lungo perché toglierne uno corto non sia più di un quinto del testo.');
  });

  test('the guards still apply: added material that drops a heading is reverted and the issue stays open', async () => {
    ctx.db.run(`DELETE FROM content_revisions`);
    seedRevision('s1', 'Prima.\n\n### Sottosezione\n\nSeconda.');
    issue('i3', 'program-proof');
    fake.next(answer({ figures: [], changes: [{ block: 1, text: 'Titolo diverso senza il livello giusto.' }] }));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ['i3'] }));
    assert.equal(r.skipped, 'no change survived the checks');
    assert.equal(head('s1')!.markdown, 'Prima.\n\n### Sottosezione\n\nSeconda.');
    assert.equal(ctx.db.get<{ status: string }>(`SELECT status FROM review_issues WHERE id = 'i3'`)!.status, 'open');
  });
});
