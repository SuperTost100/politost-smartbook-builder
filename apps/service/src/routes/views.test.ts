import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { newId, now } from '../db/db.ts';
import { projectBody, startApp, type TestApp } from './testkit.ts';

let t: TestApp;
beforeEach(async () => { t = await startApp(); });
afterEach(async () => { await t.close(); });

test('preview numbers other chapters\' sections the way the compiler does, introductions included', async () => {
  const p = (await t.req('POST', '/api/projects', projectBody('numbering'))).body;
  const outline = { chapters: [
    { id: 'c1', slug: 'uno', title: 'Uno', sections: [{ id: 's1', title: 'Prima' }] },
    { id: 'c2', slug: 'due', title: 'Due', sections: [{ id: 's2', title: 'Seconda' }] },
  ] };
  const rev = (await t.req('PUT', `/api/projects/${p.id}/outline`, { outline, baseRevId: null })).body;
  await t.req('POST', `/api/projects/${p.id}/outline/approve`, { revId: rev.id });
  const put = (node: string, markdown: string, kind = 'section') =>
    t.ctx.db.insert('content_revisions', { id: newId(), project_id: p.id, node_id: node, kind, markdown, origin: 'human', status: 'current', citations: {}, created_at: now() });
  put('c1', 'Introduzione al capitolo uno.', 'chapter-intro');
  put('s1', 'Testo della prima sezione.');
  put('s2', 'Come visto in [la prima sezione](ref:section/s1).');

  const preview = (await t.req('GET', `/api/projects/${p.id}/chapters/c2/preview`)).body;
  // The introduction is p1 of chapter 1, so the first section is p2.
  assert.match(preview.markdown, /\(ref:chapter\/1#p2\)/);
  assert.doesNotMatch(preview.markdown, /ref:chapter\/1#p1/);
});
