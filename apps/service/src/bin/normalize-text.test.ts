import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { AppContext } from '../context.ts';
import { makeCtx, seedProject } from '../llm/testkit.ts';
import { currentHead, listIssues, listRevisions, replaceLintIssues, saveHuman } from '../repo/index.ts';
import { insertProposal } from '../repo/index.ts';
import { normalizeText } from './normalize-text.ts';

let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
beforeEach(() => { kit = makeCtx(); ctx = kit.ctx; seedProject(ctx, 'p1'); });
afterEach(() => kit.cleanup());

/** A section whose current text a model wrote. */
const aiText = (nodeId: string, markdown: string) => insertProposal(ctx, 'p1', nodeId, markdown, null, 'ai', 'm').revision;

const MIXED = 'Introduzione con $x$.\n\nStudiamo ora $f$ e $$ g(x) = x^3 $$ poi basta.';

test('mixed display math is repaired as a new current revision; clean sections and the second run change nothing', () => {
  const a = aiText('s1', MIXED);
  ctx.db.update('content_revisions', a.id, { citations: { '0': ['n1'], '1': ['n2'] } });
  const clean = aiText('s2', 'Solo $x$ qui.');
  replaceLintIssues(ctx, 'p1', 's1', a.id, [{ rule: 'math-mixed', severity: 'minor', message: 'mixed', quote: 'g(x)' }]);

  const first = normalizeText(ctx, 'p1');
  assert.deepEqual({ ...first, changed: undefined }, { sections: 1, questions: 0, handEdited: 0, changed: undefined });
  assert.deepEqual(first.changed, ['s1']);
  const head = currentHead(ctx, 'p1', 's1')!;
  assert.equal(head.markdown, 'Introduzione con $x$.\n\nStudiamo ora $f$ e\n\n$$\ng(x) = x^3\n$$\n\npoi basta.');
  assert.equal(head.origin, 'repair');
  assert.equal(head.model, null);
  assert.equal(head.parentRevId, a.id);
  assert.deepEqual(head.citations, { '0': ['n1'], '1': ['n2'] });
  assert.deepEqual(listRevisions(ctx, 'p1', 's1').map((r) => r.status), ['current', 'superseded']);
  assert.equal(listIssues(ctx, 'p1', { nodeId: 's1' }).filter((i) => i.category === 'math-mixed').length, 0);
  assert.equal(currentHead(ctx, 'p1', 's2')!.id, clean.id);

  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 0, questions: 0, handEdited: 0, changed: [] });
  assert.equal(listRevisions(ctx, 'p1', 's1').length, 2);
});

test('question text is repaired without losing its verified status', () => {
  ctx.db.insert('questions', {
    id: 'q1', project_id: 'p1', kind: 'exam', origin: 'authentic', resource_id: null, page_from: null, page_to: null, exam_group: null, exam_date: null,
    number: null, statement: MIXED, hint: '', solution: 'Vale $$x=1$$. Dunque $x$ è uno.', difficulty: 'medium', topic_ids: [], chapter_id: null, status: 'verified',
    checks: [{ method: 'model', ok: true, detail: 'ok' }], rev: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
  });
  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 0, questions: 1, handEdited: 0, changed: ['Question q1'] });
  const q = ctx.db.get<{ status: string; checks: string; solution: string; rev: number }>('SELECT status, checks, solution, rev FROM questions WHERE id = ?', 'q1')!;
  assert.equal(q.status, 'verified');
  assert.equal(JSON.parse(q.checks).length, 1);
  assert.equal(q.solution, 'Vale\n\n$$\nx=1.\n$$\n\nDunque $x$ è uno.');
  assert.equal(q.rev, 2);
  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 0, questions: 0, handEdited: 0, changed: [] });
});

test('generator markup left in an introduction is removed', () => {
  aiText('c1', 'Le successioni monotone limitate.</markdown>\n</invoke>');
  assert.equal(normalizeText(ctx, 'p1').sections, 1);
  assert.equal(currentHead(ctx, 'p1', 'c1')!.markdown, 'Le successioni monotone limitate.');
});

test('an unknown project is an error', () => {
  assert.throws(() => normalizeText(ctx, 'nope'));
});

test('headings become ### in sections, and a blank line inside $$ goes', () => {
  aiText('s1', '#### Titolo\n\n$$\n\nx=1\n$$');
  assert.equal(normalizeText(ctx, 'p1').sections, 1);
  assert.equal(currentHead(ctx, 'p1', 's1')!.markdown, '### Titolo\n\n$$\nx=1\n$$');
});

test('a section the author wrote or edited and a question the author edited are left alone, and --include-hand-edits changes them', () => {
  const hand = saveHuman(ctx, 'p1', 's1', '#### Titolo dell\'autrice', null);
  ctx.db.insert('questions', {
    id: 'q1', project_id: 'p1', kind: 'exercise', origin: 'adapted', statement: 'Sia $f$ con $$ g = 1 $$ vera.', hint: '', solution: '', difficulty: 'medio', topic_ids: [], status: 'draft', checks: [], rev: 1,
    edited_at: '2026-01-01', created_at: '2026-01-01', updated_at: '2026-01-01',
  });
  const skipped = normalizeText(ctx, 'p1');
  assert.deepEqual(skipped, { sections: 0, questions: 0, handEdited: 2, changed: [] });
  assert.equal(currentHead(ctx, 'p1', 's1')!.id, hand.id);
  const all = normalizeText(ctx, 'p1', { handEdits: true });
  assert.equal(all.sections + all.questions, 2);
  assert.equal(currentHead(ctx, 'p1', 's1')!.markdown, "### Titolo dell'autrice");
});

test('a dry run lists what would change and writes nothing', () => {
  const a = aiText('s1', MIXED);
  ctx.db.insert('questions', {
    id: 'q1', project_id: 'p1', kind: 'exercise', origin: 'generated', statement: MIXED, hint: '', solution: '', difficulty: 'medio', topic_ids: [], status: 'draft', checks: [], rev: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
  });
  const r = normalizeText(ctx, 'p1', { dryRun: true });
  assert.deepEqual(r, { sections: 1, questions: 1, handEdited: 0, changed: ['s1', `Question ${'q1'}`] });
  assert.equal(currentHead(ctx, 'p1', 's1')!.id, a.id);
  assert.equal(listRevisions(ctx, 'p1', 's1').length, 1);
  assert.equal(ctx.db.get<{ rev: number; statement: string }>('SELECT rev, statement FROM questions WHERE id = ?', 'q1')!.statement, MIXED);
});

/** Runs `then` once, right after the first query whose SQL matches `sql` returned, as a save by the running service would. */
function afterFirstQuery(sql: RegExp, then: () => void) {
  const db = ctx.db;
  const all = db.all.bind(db);
  let done = false;
  db.all = ((query: string, ...params: never[]) => {
    const rows = all(query, ...params);
    if (!done && sql.test(query)) { done = true; then(); }
    return rows;
  }) as typeof db.all;
}

test('a section edited by hand after the run listed it is not formatted without --include-hand-edits', () => {
  const a = aiText('s1', '#### Titolo');
  afterFirstQuery(/FROM content_revisions WHERE project_id = \? AND status = 'current'/, () => { saveHuman(ctx, 'p1', 's1', '#### Titolo dell\'autrice', a.id); });
  const r = normalizeText(ctx, 'p1');
  assert.deepEqual(r, { sections: 0, questions: 0, handEdited: 1, changed: [] });
  assert.equal(currentHead(ctx, 'p1', 's1')!.markdown, '#### Titolo dell\'autrice');
});

test('a question edited by hand after the run listed it is not formatted without --include-hand-edits', () => {
  ctx.db.insert('questions', {
    id: 'q1', project_id: 'p1', kind: 'exercise', origin: 'generated', statement: MIXED, hint: '', solution: '', difficulty: 'medio', topic_ids: [], status: 'draft', checks: [], rev: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
  });
  afterFirstQuery(/FROM questions/, () => { ctx.db.run(`UPDATE questions SET edited_at = '2026-01-02' WHERE id = 'q1'`); });
  const r = normalizeText(ctx, 'p1');
  assert.deepEqual(r, { sections: 0, questions: 0, handEdited: 1, changed: [] });
  assert.equal(ctx.db.get<{ statement: string }>('SELECT statement FROM questions WHERE id = ?', 'q1')!.statement, MIXED);
});
