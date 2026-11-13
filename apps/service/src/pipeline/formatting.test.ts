// Formatting of model-written text: the lint findings stored with a draft describe the stored text, and a fix settles
// formatting findings in code, so no formatting finding goes to a model.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { formatModelText, lintQuestionText, lintSection } from '@smartbuilder/content';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, patchAnswer, seedProject, usageOf, written } from '../llm/testkit.ts';
import type { TaskContext } from '../queue/queue.ts';
import type { AppContext } from '../context.ts';
import { chapterIntro, commitAiRevision, sectionDraft } from './draft.ts';
import { questionRevise } from './practice.ts';
import { sectionRevise } from './review.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';

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

function seedOutline() {
  const outline = {
    chapters: [{
      id: 'c1', slug: 'cap-1', title: 'Capitolo 1', objectives: [], prerequisites: [],
      sections: [{ id: 's1', title: 'Sezione 1.1', objectives: [], topicIds: [], depth: 'standard', subsections: [] }],
    }],
    exclusions: [], notation: '',
  };
  const id = newId();
  ctx.db.insert('outline_revisions', { id, project_id: P, outline, origin: 'human', note: '', created_at: now(), approved_at: now() });
  ctx.db.run('UPDATE projects SET outline_rev_id = ? WHERE id = ?', id, P);
}

function startTask(kind: string, input: Record<string, unknown>): TaskContext {
  const runId = newId();
  ctx.db.insert('runs', { id: runId, project_id: P, kind: 'generate', status: 'running', snapshot: {}, created_at: now() });
  const id = newId();
  const key = `${kind}:${id}`;
  ctx.db.insert('tasks', { id, run_id: runId, project_id: P, kind, label: kind, key, input, state: 'running', pool: 'local', attempts: 1, max_attempts: 3, created_at: now() });
  return {
    task: { id, runId, projectId: P, kind, key, label: kind, input, attempts: 1 }, signal: new AbortController().signal, deps: {},
    enqueue: (specs) => ctx.queue.addTasks(runId, P, specs), progress: () => undefined, setProvider: () => undefined,
  };
}

const head = (nodeId: string) => ctx.db.get<{ id: string; markdown: string; origin: string }>(`SELECT id, markdown, origin FROM content_revisions WHERE node_id = ? AND status = 'current'`, nodeId)!;
const revisions = (nodeId: string) => ctx.db.all<{ id: string }>('SELECT id FROM content_revisions WHERE node_id = ?', nodeId).length;
const seedHead = (nodeId: string, markdown: string, origin = 'ai') => {
  const id = newId();
  ctx.db.insert('content_revisions', { id, project_id: P, node_id: nodeId, kind: 'section', markdown, origin, model: null, parent_rev_id: null, status: 'current', citations: {}, created_at: now() });
  return id;
};
const addIssue = (o: { nodeId?: string | null; questionId?: string | null; revId?: string | null; source?: string; severity?: string; category: string; quote?: string; message?: string }) => {
  const id = newId();
  ctx.db.insert('review_issues', {
    id, project_id: P, node_id: o.nodeId ?? null, question_id: o.questionId ?? null, rev_id: o.revId ?? null, source: o.source ?? 'lint', severity: o.severity ?? 'minor', category: o.category,
    quote: o.quote ?? '', message: o.message ?? `Message of ${o.category}`, suggestion: '', status: 'open', resolution: '', created_at: now(),
  });
  return id;
};
const issue = (id: string) => ctx.db.get<{ status: string; resolution: string; category: string }>('SELECT status, resolution, category FROM review_issues WHERE id = ?', id)!;
const lintIssues = (nodeId: string) => ctx.db.all<{ category: string }>(`SELECT category FROM review_issues WHERE node_id = ? AND source = 'lint' AND status = 'open' ORDER BY rowid`, nodeId).map((r) => r.category);

/** What the writer sent for revision d2a8b8fe and 7ee9e029 of the live book, in the form that went wrong: display math inside a sentence, a blank line inside $$ and #### headings. */
const RAW = [
  '### Tecniche di calcolo',
  '#### Non esistenza',
  "Esempi classici: il campo di forze generato da una carica nell'origine, $$\\mathbf{F}(\\mathbf{x})=\\frac{\\mathbf{x}}{\\|\\mathbf{x}\\|^3},$$ definito su $\\mathbb{R}^3\\setminus\\{\\mathbf{0}\\}$ a valori in $\\mathbb{R}^3$.",
  '$$\n\n\\lim_{t\\to 0} f(t)=\\ell\n$$',
  '#### Esistenza',
  'Il limite vale $\\ell$.',
].join('\n\n');

describe('the lint findings stored with a draft are about the stored text', () => {
  test('a writer answer with $$ inside a sentence, a blank line in $$ and #### headings is stored clean and leaves no formatting issue', async () => {
    seedOutline();
    assert.deepEqual(lintSection(RAW, { sectionId: 's1', language: 'it' }).map((f) => f.rule).sort(), ['heading-level', 'heading-level', 'math-blank-line', 'math-mixed']);
    fake.next(written({ markdown: RAW }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    const stored = head('s1').markdown;
    assert.equal(r.status, 'current');
    assert.doesNotMatch(stored, /^####/m);
    assert.ok(stored.includes("nell'origine,\n\n$$\n\\mathbf{F}(\\mathbf{x})=\\frac{\\mathbf{x}}{\\|\\mathbf{x}\\|^3},\n$$\n\ndefinito su"), 'the formula in the sentence has blocks of its own');
    assert.ok(stored.includes('$$\n\\lim_{t\\to 0} f(t)=\\ell\n$$'), 'no blank line inside the $$ block');
    const found = lintSection(stored, { sectionId: 's1', language: 'it' }).map((f) => f.rule).sort();
    assert.deepEqual(found, []);
    assert.deepEqual(lintIssues('s1'), found, 'the issues are the findings of the stored text');
    assert.equal(r.findings, 0);
  });

  test('a chapter introduction is stored formatted and its issues are the findings of the stored text', async () => {
    seedOutline();
    fake.next(() => ({ structured: { markdown: 'Il capitolo.\n\n#### Perché serve\n\nVale $a$ e $$ b = 1 $$ sempre.' } as never, text: '{}', usage: usageOf(1, 1) }));
    const r = await chapterIntro(ctx, startTask('chapter.intro', { chapterId: 'c1' }));
    const stored = head('c1').markdown;
    assert.equal(stored, 'Il capitolo.\n\n### Perché serve\n\nVale $a$ e\n\n$$\nb = 1\n$$\n\nsempre.');
    assert.deepEqual(lintIssues('c1'), []);
    assert.ok(r.revId);
  });

  test('commitAiRevision formats by default and leaves the text alone for the author\'s own text (figures, research)', () => {
    seedOutline();
    const base = { projectId: P, nodeId: 's1', kind: 'section' as const, baseRevId: null, model: 'm' };
    const raw = '#### Titolo\n\nVale $a$ e $$ b $$ sempre.';
    const kept = commitAiRevision(ctx, { ...base, markdown: raw, format: false });
    assert.equal(head('s1').markdown, raw);
    commitAiRevision(ctx, { ...base, baseRevId: kept.revId, markdown: raw });
    assert.equal(head('s1').markdown, formatModelText(raw));
  });
});

describe('a fix settles formatting findings in code', () => {
  const messy = '### Uno\n\n#### Due\n\nVale $a$ e $$ b = 1 $$ sempre.\n\n$$\n\nc\n$$';

  test('a fix of the heading note alone leaves the math the author typed, and its note, as they are', async () => {
    seedOutline();
    const text = '#### Selezionare\n\nAltro $a$ e $$ b+2 $$ fine.';
    const rev = seedHead('s1', text);
    const level = addIssue({ nodeId: 's1', revId: rev, category: 'heading-level' });
    const mixed = addIssue({ nodeId: 's1', revId: rev, category: 'math-mixed', message: 'Display math ($$) and inline math ($) in the same block; separate them with a blank line.', quote: 'Altro $a$ e $$ b+2 $$ fine.' });
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [level] }));
    assert.equal(fake.calls.length, 0);
    assert.equal(head('s1').markdown, '### Selezionare\n\nAltro $a$ e $$ b+2 $$ fine.');
    assert.equal(issue(level).status, 'fixed');
    const open = ctx.db.all<{ category: string; resolution: string }>(`SELECT category, resolution FROM review_issues WHERE node_id = 's1' AND status = 'open'`);
    assert.deepEqual(open.map((i) => i.category), ['math-mixed'], 'the note that was not chosen is still open');
    assert.equal(open[0].resolution, '', 'and nothing says the formatter tried it');
    assert.equal(ctx.db.get('SELECT 1 FROM review_issues WHERE id = ?', mixed) !== undefined || open.length === 1, true);
  });

  test('with an unclosed $$ in the section, a fix of the heading note does not move any other text', async () => {
    seedOutline();
    const rest = 'Testo $a$ con $$ x = 1 mai chiuso.\n\nSecondo paragrafo con $b$.\n\nTerzo $$ y $$ fine.';
    const rev = seedHead('s1', `#### Titolo isolato\n\n${rest}`);
    const level = addIssue({ nodeId: 's1', revId: rev, category: 'heading-level' });
    const mixed = addIssue({ nodeId: 's1', revId: rev, category: 'math-mixed' });
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [level, mixed] }));
    assert.equal(fake.calls.length, 0);
    assert.equal(head('s1').markdown, `### Titolo isolato\n\n${rest}`, 'only the heading changed');
  });

  test('issues of math-mixed, heading-level and math-blank-line are closed with no model call, and the text is formatted', async () => {
    seedOutline();
    const rev = seedHead('s1', messy);
    const ids = ['heading-level', 'math-mixed', 'math-blank-line'].map((category) => addIssue({ nodeId: 's1', revId: rev, category }));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: ids }));
    assert.equal(fake.calls.length, 0, 'the fake model has no scripted step, so any call would have thrown');
    assert.equal(r.status, 'current');
    assert.equal(r.resolved, 3);
    assert.equal(head('s1').markdown, formatModelText(messy));
    assert.equal(head('s1').origin, 'repair');
    for (const id of ids) {
      assert.equal(issue(id).status, 'fixed');
      assert.match(issue(id).resolution, /^Fixed by the formatter in revision /);
    }
    assert.deepEqual(lintIssues('s1'), []);
  });

  test('an issue about text that already has it right is closed and says so, and no revision is made', async () => {
    seedOutline();
    const clean = '### Uno\n\nVale $a$ e $b$.';
    const rev = seedHead('s1', clean);
    const id = addIssue({ nodeId: 's1', revId: rev, category: 'math-mixed', quote: 'Vale $$ b $$ e $a$' });
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [id] }));
    assert.equal(fake.calls.length, 0);
    assert.equal(r.skipped, 'the formatter changed nothing');
    assert.equal(revisions('s1'), 1);
    assert.equal(issue(id).status, 'fixed');
    assert.equal(issue(id).resolution, 'The text already has it right, so nothing was changed.');
  });

  test('an issue the formatter cannot settle stays open with a plain reason and is not sent to a model', async () => {
    seedOutline();
    // The formatter leaves ::: blocks alone, and the lint still reports a heading inside one.
    const text = ':::hint\n#### Dentro\nUn suggerimento.\n:::\n\nTesto.';
    const rev = seedHead('s1', text);
    const finding = lintSection(text, { sectionId: 's1', language: 'it' }).find((f) => f.rule === 'heading-level')!;
    const id = addIssue({ nodeId: 's1', revId: rev, category: 'heading-level', quote: finding.quote, message: finding.message });
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [id] }));
    assert.equal(fake.calls.length, 0);
    assert.equal(r.skipped, 'the formatter changed nothing');
    assert.equal(issue(id).status, 'open');
    assert.equal(issue(id).resolution, `The formatter could not fix this, so it stays open for you to edit by hand: ${finding.message}`);
    assert.equal(head('s1').markdown, text);
  });

  test('the blocker for a compiler heading is not a formatting issue: it goes to the model', async () => {
    seedOutline();
    const rev = seedHead('s1', '## p3 | Titolo\n\nTesto.');
    const id = addIssue({ nodeId: 's1', revId: rev, category: 'heading-level', severity: 'blocker', quote: '## p3 | Titolo', message: 'Paragraph headings (## pN | ...) are added by the compiler; remove it.' });
    fake.next(patchAnswer({ changes: [{ block: 0, text: '' }] }), () => ({ structured: { changes: [], issues: [{ index: 1, fixed: true, reason: '' }] } as never, text: '{}', usage: usageOf(1, 1) }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [id] }));
    assert.match(fake.calls[0].prompt, /Paragraph headings/);
  });

  test('a run with other findings sends only those to the model, on the formatted text', async () => {
    seedOutline();
    const text = '### Uno\n\nIl valore è 5 ohm.\n\nVale $a$ e $$ b $$ sempre.';
    const rev = seedHead('s1', text);
    const mixed = addIssue({ nodeId: 's1', revId: rev, category: 'math-mixed', message: 'Display math ($$) and inline math ($) in the same block' });
    const wrong = addIssue({ nodeId: 's1', revId: rev, source: 'review', severity: 'major', category: 'accuracy', quote: 'Il valore è 5 ohm.', message: 'The value is 6 ohm.' });
    fake.next(patchAnswer({ changes: [{ block: 1, text: 'Il valore è 6 ohm.' }] }), () => ({ structured: { changes: [{ block: 1, verdict: 'good', reason: '' }], issues: [{ index: 1, fixed: true, reason: '' }] } as never, text: '{}', usage: usageOf(1, 1) }));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [mixed, wrong] }));
    assert.equal(r.status, 'current');
    const call = fake.calls[0];
    assert.match(call.prompt, /The value is 6 ohm\./);
    assert.doesNotMatch(call.prompt, /Display math/, 'the formatting finding is not in the prompt');
    assert.match(call.prompt, /\[B2\]\nVale \$a\$ e\n\n\[B3\]\n\$\$\nb\n\$\$\n\n\[B4\]\nsempre\./, 'the model gets the formatted text');
    assert.equal(issue(mixed).status, 'fixed');
    assert.match(issue(mixed).resolution, /formatter/);
    assert.equal(issue(wrong).status, 'fixed');
    assert.equal(head('s1').markdown, '### Uno\n\nIl valore è 6 ohm.\n\nVale $a$ e\n\n$$\nb\n$$\n\nsempre.');
  });

  test('an issue whose quoted line the formatter rewrote keeps its row too', async () => {
    seedOutline();
    // The heading has the wrong level and a placeholder: the formatter changes the line the placeholder issue quotes.
    const text = '#### Valore [?]\n\nTesto.';
    const rev = seedHead('s1', text);
    const findings = lintSection(text, { sectionId: 's1', language: 'it' });
    const placeholder = findings.find((f) => f.rule === 'placeholder')!;
    const other = addIssue({ nodeId: 's1', revId: rev, severity: placeholder.severity, category: 'placeholder', quote: placeholder.quote, message: placeholder.message });
    const level = addIssue({ nodeId: 's1', revId: rev, category: 'heading-level', message: 'Only "###" headings are allowed inside a section (found level 4).' });
    fake.next(patchAnswer({ changes: [{ block: 0, text: '### Valore 5' }] }), () => ({ structured: { changes: [{ block: 0, verdict: 'good', reason: '' }], issues: [{ index: 1, fixed: true, reason: '' }] } as never, text: '{}', usage: usageOf(1, 1) }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [other, level] }));
    assert.equal(issue(level).status, 'fixed');
    // The guards refuse a renamed heading, so the placeholder stays open. What matters here is that the answer lands on its own row.
    const row = ctx.db.get<{ status: string; resolution: string; quote: string }>('SELECT status, resolution, quote FROM review_issues WHERE id = ?', other);
    assert.ok(row, 'the row the fix was asked about still exists');
    assert.equal(row.status, 'open');
    assert.match(row.resolution, /The AI fix was not applied/);
    assert.equal(row.quote, '### Valore [?]', 'and it quotes the line as it is now');
    assert.equal(ctx.db.all(`SELECT 1 FROM review_issues WHERE node_id = 's1' AND category = 'placeholder'`).length, 1, 'no second row for it');
  });

  test('with two such lines, the kept row follows its own line', async () => {
    seedOutline();
    const text = '#### Valore [?]\n\n#### Altro [?]\n\nTesto.';
    const rev = seedHead('s1', text);
    const placeholders = lintSection(text, { sectionId: 's1', language: 'it' }).filter((f) => f.rule === 'placeholder');
    assert.equal(placeholders.length, 2);
    // The fix is asked about the second heading's placeholder only. The first one's row is not part of the fix.
    const [first, second] = placeholders.map((f) => addIssue({ nodeId: 's1', revId: rev, severity: f.severity, category: 'placeholder', quote: f.quote, message: f.message }));
    const level = addIssue({ nodeId: 's1', revId: rev, category: 'heading-level', message: 'Only "###" headings are allowed inside a section (found level 4).' });
    fake.next(patchAnswer({ changes: [{ block: 1, text: '### Altro 5' }] }), () => ({ structured: { changes: [{ block: 1, verdict: 'good', reason: '' }], issues: [{ index: 1, fixed: true, reason: '' }] } as never, text: '{}', usage: usageOf(1, 1) }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [second, level] }));
    const row = ctx.db.get<{ status: string; resolution: string; quote: string }>('SELECT status, resolution, quote FROM review_issues WHERE id = ?', second);
    assert.ok(row, 'the row the fix was asked about still exists');
    assert.equal(row.quote, '### Altro [?]', 'and it is the row of its own heading');
    assert.match(row.resolution, /The AI fix was not applied/);
    assert.equal(ctx.db.get('SELECT 1 FROM review_issues WHERE id = ?', first), undefined, 'the other placeholder was not kept, so it got a fresh row');
    assert.deepEqual(ctx.db.all<{ quote: string }>(`SELECT quote FROM review_issues WHERE node_id = 's1' AND category = 'placeholder' ORDER BY quote`).map((r) => r.quote), ['### Altro [?]', '### Valore [?]']);
  });

  test('when the formatter splits a quoted line, the kept row follows the part that holds its finding', async () => {
    seedOutline();
    const text = 'Vale $a$ e $$ b [?] $$ sempre.\n\nSegue $c$ e $$ d [?] $$ sempre.';
    const rev = seedHead('s1', text);
    const placeholders = lintSection(text, { sectionId: 's1', language: 'it' }).filter((f) => f.rule === 'placeholder');
    assert.equal(placeholders.length, 2);
    const [first] = placeholders.map((f) => addIssue({ nodeId: 's1', revId: rev, severity: f.severity, category: 'placeholder', quote: f.quote, message: f.message }));
    const mixed = addIssue({ nodeId: 's1', revId: rev, category: 'math-mixed', message: 'Display math ($$) and inline math ($) in the same block' });
    fake.next(patchAnswer({ changes: [] }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [first, mixed] }));
    const row = ctx.db.get<{ quote: string }>('SELECT quote FROM review_issues WHERE id = ?', first);
    assert.ok(row, 'the row the fix was asked about still exists');
    assert.match(row.quote, /b \[\?\]/, 'and it is the row of its own formula');
    assert.equal(ctx.db.all(`SELECT 1 FROM review_issues WHERE node_id = 's1' AND category = 'placeholder'`).length, 2);
  });

  test('another lint issue in the same fix keeps its row, so the fix can close it and a proposal can mark it', async () => {
    seedOutline();
    const text = '### Uno\n\nIl valore è [?] ohm.\n\nVale $a$ e $$ b $$ sempre.';
    const rev = seedHead('s1', text);
    const findings = lintSection(text, { sectionId: 's1', language: 'it' });
    const placeholder = findings.find((f) => f.rule === 'placeholder')!;
    const other = addIssue({ nodeId: 's1', revId: rev, severity: placeholder.severity, category: 'placeholder', quote: placeholder.quote, message: placeholder.message });
    const mixed = addIssue({ nodeId: 's1', revId: rev, category: 'math-mixed', message: 'Display math ($$) and inline math ($) in the same block' });
    fake.next(patchAnswer({ changes: [{ block: 1, text: 'Il valore è 5 ohm.' }] }), () => ({ structured: { changes: [{ block: 1, verdict: 'good', reason: '' }], issues: [{ index: 1, fixed: true, reason: '' }] } as never, text: '{}', usage: usageOf(1, 1) }));
    const r = await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [other, mixed] }));
    assert.equal(r.status, 'current');
    assert.equal(issue(mixed).status, 'fixed');
    assert.equal(issue(other).status, 'fixed', 'the issue the model fixed is still the same row');
    assert.match(issue(other).resolution, /Fixed by AI in revision/);
    assert.equal(ctx.db.all(`SELECT 1 FROM review_issues WHERE node_id = 's1' AND category = 'placeholder'`).length, 1, 'no second row for it');
  });

  test('the fix model\'s own result is formatted before the guards compare it', async () => {
    seedOutline();
    const rev = seedHead('s1', 'Testo.\n\nIl valore è 5 ohm.');
    const wrong = addIssue({ nodeId: 's1', revId: rev, source: 'review', severity: 'major', category: 'accuracy', quote: 'Il valore è 5 ohm.', message: 'The value is 6 ohm.' });
    fake.next(patchAnswer({ changes: [{ block: 1, text: '#### Calcolo\n\nIl valore è 6 ohm.\n\n$$\n\nx = 6\n$$' }] }), () => ({ structured: { changes: [{ block: 1, verdict: 'good', reason: '' }], issues: [{ index: 1, fixed: true, reason: '' }] } as never, text: '{}', usage: usageOf(1, 1) }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [wrong] }));
    assert.equal(head('s1').markdown, 'Testo.\n\n### Calcolo\n\nIl valore è 6 ohm.\n\n$$\nx = 6\n$$');
  });

  test('a fix does not format the author\'s blocks it did not change', async () => {
    seedOutline();
    const rev = seedHead('s1', '#### Titolo dell\'autrice\n\nIl valore è 5 ohm.', 'human');
    const wrong = addIssue({ nodeId: 's1', revId: rev, source: 'review', severity: 'major', category: 'accuracy', quote: 'Il valore è 5 ohm.', message: 'The value is 6 ohm.' });
    fake.next(patchAnswer({ changes: [{ block: 1, text: 'Il valore è 6 ohm.' }] }), () => ({ structured: { changes: [{ block: 1, verdict: 'good', reason: '' }], issues: [{ index: 1, fixed: true, reason: '' }] } as never, text: '{}', usage: usageOf(1, 1) }));
    await sectionRevise(ctx, startTask('section.revise', { nodeId: 's1', issueIds: [wrong] }));
    assert.equal(head('s1').markdown, '#### Titolo dell\'autrice\n\nIl valore è 6 ohm.');
  });
});

describe('a question fix settles formatting findings in code too', () => {
  test('math-mixed issues of a question close with no model call and its text is formatted', async () => {
    const id = newId();
    ctx.db.insert('questions', { id, project_id: P, kind: 'exercise', origin: 'generated', statement: 'Sia $f$ con $$ g(x) = x $$ vera.', hint: '', solution: 'Vale 1.', difficulty: 'medio', topic_ids: [], status: 'verified', checks: [], rev: 1, created_at: now(), updated_at: now() });
    const iss = addIssue({ questionId: id, category: 'compile:math-mixed' });
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iss] }));
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(r, { revised: true });
    const row = ctx.db.get<{ statement: string; status: string }>('SELECT statement, status FROM questions WHERE id = ?', id)!;
    assert.equal(row.statement, 'Sia $f$ con\n\n$$\ng(x) = x\n$$\n\nvera.');
    assert.equal(row.status, 'verified', 'the mathematics did not change, so the check stays');
    assert.equal(lintQuestionText(row.statement, { file: 'statement', language: 'it' }).filter((f) => f.rule === 'math-mixed').length, 0);
    assert.equal(issue(iss).status, 'fixed');
    assert.match(issue(iss).resolution, /formatter/);
  });

  test('a fix whose issue rows are gone calls no model and leaves the question as it is', async () => {
    const id = newId();
    ctx.db.insert('questions', { id, project_id: P, kind: 'exercise', origin: 'generated', statement: 'Sia $f$ con $$ g(x) = x $$ vera.', hint: '', solution: 'Vale 1.', difficulty: 'medio', topic_ids: [], status: 'verified', checks: [], rev: 1, created_at: now(), updated_at: now() });
    const iss = addIssue({ questionId: id, category: 'compile:math-mixed' });
    ctx.db.run('DELETE FROM review_issues WHERE id = ?', iss);
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iss] }));
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(r, { skipped: 'the requested issues are gone' });
    const row = ctx.db.get<{ statement: string; status: string; rev: number }>('SELECT statement, status, rev FROM questions WHERE id = ?', id)!;
    assert.deepEqual([row.statement, row.status, row.rev], ['Sia $f$ con $$ g(x) = x $$ vera.', 'verified', 1]);
  });
});

describe('formula blocks in a question', () => {
  const BLOCK = ':::formula{key="green-rettangolo" label="Teorema di Green"}\n$$\\oint_{\\partial R} F\\cdot d\\mathbf{r}=\\iint_R g\\,dA$$\n:::';
  const seedQuestion = (solution: string) => {
    const id = newId();
    ctx.db.insert('questions', { id, project_id: P, kind: 'exam', origin: 'generated', statement: 'Calcola il lavoro.', hint: '', solution, difficulty: 'medio', topic_ids: [], status: 'verified', checks: [], rev: 1, created_at: now(), updated_at: now() });
    return id;
  };
  const note = (questionId: string, rule: string, quote: string) => addIssue({ questionId, category: `compile:${rule}`, severity: 'blocker', quote });
  const solutionOf = (id: string) => ctx.db.get<{ solution: string; status: string }>('SELECT solution, status FROM questions WHERE id = ?', id)!;

  test('a formula-malformed note on a question is settled by the formatter with no model call', async () => {
    const id = seedQuestion(`Per il teorema,\n\n${BLOCK}\n\nsi ha $L=2$.`);
    const iss = note(id, 'formula-malformed', ':::formula{key="green-rettangolo" label="Teorema di Green"}');
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [iss] }));
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(r, { revised: true });
    const row = solutionOf(id);
    assert.equal(row.solution, 'Per il teorema,\n\n$$\\oint_{\\partial R} F\\cdot d\\mathbf{r}=\\iint_R g\\,dA$$\n\nsi ha $L=2$.');
    assert.equal(row.status, 'verified', 'the mathematics did not change, so the check stays');
    assert.equal(issue(iss).status, 'fixed');
  });

  test('with a formula-ref-unknown note too, the formatter settles the block and the editor may change the reference', async () => {
    const id = seedQuestion(`${BLOCK}\n\nPer la {{formula:@green-rettangolo}} e per la {{formula:@laplace-seno}} si ha $L=2$.`);
    ctx.db.insert('content_revisions', { id: newId(), project_id: P, node_id: 's1', kind: 'section', markdown: ':::formula{key="laplace-trasformata" label="Trasformata del seno"}\n$$a$$\n:::', origin: 'ai', model: null, parent_rev_id: null, status: 'current', citations: {}, created_at: now() });
    const block = note(id, 'formula-malformed', ':::formula{key="green-rettangolo" label="Teorema di Green"}');
    const ref = note(id, 'formula-ref-unknown', '{{formula:@laplace-seno}}');
    fake.next(() => ({ structured: { statement: 'Calcola il lavoro.', hint: '', solution: '$$\\oint_{\\partial R} F\\cdot d\\mathbf{r}=\\iint_R g\\,dA$$\n\nPer la {{formula:@green-rettangolo}} e per la {{formula:@laplace-trasformata}} si ha $L=2$.' } as never, text: '{}', usage: usageOf(1, 1) }));
    const r = await questionRevise(ctx, startTask('question.revise', { questionId: id, issueIds: [block, ref] }));
    assert.deepEqual(r, { revised: true });
    assert.equal(fake.calls.length, 1, 'only the reference note went to the editor');
    const prompt = String(fake.calls[0].prompt);
    assert.match(prompt, /unknown|exists in the book/);
    assert.doesNotMatch(prompt, /Numbered formula blocks/, 'the formatter note never reaches the model');
    assert.match(prompt, /laplace-trasformata: Trasformata del seno/, 'the editor gets the keys of the book with their labels');
    assert.match(solutionOf(id).solution, /@laplace-trasformata/);
    assert.equal(solutionOf(id).status, 'draft', 'a changed text is verified again');
    assert.equal(issue(block).status, 'fixed');
    assert.equal(issue(ref).status, 'fixed');
  });
});
