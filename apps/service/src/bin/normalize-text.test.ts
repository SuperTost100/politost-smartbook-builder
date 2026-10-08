import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { AppContext } from '../context.ts';
import { makeCtx, seedProject } from '../llm/testkit.ts';
import { currentHead, listIssues, listRevisions, replaceLintIssues, saveHuman } from '../repo/index.ts';
import { normalizeText } from './normalize-text.ts';

let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
beforeEach(() => { kit = makeCtx(); ctx = kit.ctx; seedProject(ctx, 'p1'); });
afterEach(() => kit.cleanup());

const MIXED = 'Introduzione con $x$.\n\nStudiamo ora $f$ e $$ g(x) = x^3 $$ poi basta.';

test('mixed display math is repaired as a new current revision; clean sections and the second run change nothing', () => {
  const a = saveHuman(ctx, 'p1', 's1', MIXED, null);
  ctx.db.update('content_revisions', a.id, { citations: { '0': ['n1'], '1': ['n2'] } });
  const clean = saveHuman(ctx, 'p1', 's2', 'Solo $x$ qui.', null);
  replaceLintIssues(ctx, 'p1', 's1', a.id, [{ rule: 'math-mixed', severity: 'minor', message: 'mixed', quote: 'g(x)' }]);

  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 1, questions: 0 });
  const head = currentHead(ctx, 'p1', 's1')!;
  assert.equal(head.markdown, 'Introduzione con $x$.\n\nStudiamo ora $f$ e\n\n$$\ng(x) = x^3\n$$\n\npoi basta.');
  assert.equal(head.origin, 'repair');
  assert.equal(head.model, null);
  assert.equal(head.parentRevId, a.id);
  assert.deepEqual(head.citations, { '0': ['n1'], '1': ['n2'] });
  assert.deepEqual(listRevisions(ctx, 'p1', 's1').map((r) => r.status), ['current', 'superseded']);
  assert.equal(listIssues(ctx, 'p1', { nodeId: 's1' }).filter((i) => i.category === 'math-mixed').length, 0);
  assert.equal(currentHead(ctx, 'p1', 's2')!.id, clean.id);

  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 0, questions: 0 });
  assert.equal(listRevisions(ctx, 'p1', 's1').length, 2);
});

test('question text is repaired without losing its verified status', () => {
  ctx.db.insert('questions', {
    id: 'q1', project_id: 'p1', kind: 'exam', origin: 'authentic', resource_id: null, page_from: null, page_to: null, exam_group: null, exam_date: null,
    number: null, statement: MIXED, hint: '', solution: 'Vale $$x=1$$. Dunque $x$ è uno.', difficulty: 'medium', topic_ids: [], chapter_id: null, status: 'verified',
    checks: [{ method: 'model', ok: true, detail: 'ok' }], rev: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
  });
  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 0, questions: 1 });
  const q = ctx.db.get<{ status: string; checks: string; solution: string; rev: number }>('SELECT status, checks, solution, rev FROM questions WHERE id = ?', 'q1')!;
  assert.equal(q.status, 'verified');
  assert.equal(JSON.parse(q.checks).length, 1);
  assert.equal(q.solution, 'Vale\n\n$$\nx=1.\n$$\n\nDunque $x$ è uno.');
  assert.equal(q.rev, 2);
  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 0, questions: 0 });
});

test('generator markup left in an introduction is removed', () => {
  saveHuman(ctx, 'p1', 'c1', 'Le successioni monotone limitate.</markdown>\n</invoke>', null);
  assert.deepEqual(normalizeText(ctx, 'p1'), { sections: 1, questions: 0 });
  assert.equal(currentHead(ctx, 'p1', 'c1')!.markdown, 'Le successioni monotone limitate.');
});

test('an unknown project is an error', () => {
  assert.throws(() => normalizeText(ctx, 'nope'));
});
