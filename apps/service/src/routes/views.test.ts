import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { newId, now } from '../db/db.ts';
import { compileBook } from '@smartbuilder/content';
import { loadBookInput } from '../repo/index.ts';
import { multipart, projectBody, startApp, type TestApp } from './testkit.ts';

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

test('figures: preview keys are the compiled paths, and the asset record is canonical for caption and alt in preview and export', async () => {
  const p = (await t.req('POST', '/api/projects', projectBody('figures'))).body;
  const outline = { chapters: [{ id: 'c1', slug: 'uno', title: 'Uno', sections: [{ id: 's1', title: 'Prima' }] }] };
  const rev = (await t.req('PUT', `/api/projects/${p.id}/outline`, { outline, baseRevId: null })).body;
  await t.req('POST', `/api/projects/${p.id}/outline/approve`, { revId: rev.id });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  const up = multipart({ caption: 'Vecchia didascalia', alt: 'Vecchio alt' }, [{ name: 'file', filename: 'cerchio.svg', type: 'image/svg+xml', data: svg }]);
  const asset = (await t.req('POST', `/api/projects/${p.id}/assets`, up.payload, up.headers)).body;
  t.ctx.db.insert('content_revisions', {
    id: newId(), project_id: p.id, node_id: 's1', kind: 'section', origin: 'human', status: 'current', citations: {}, created_at: now(),
    markdown: 'Guarda la figura.\n\n:::image{src="assets/cerchio.svg" alt="alt nel testo" caption="didascalia nel testo"}\n:::\n\nFine.',
  });

  const preview = (await t.req('GET', `/api/projects/${p.id}/chapters/c1/preview`)).body;
  assert.equal(preview.assets['assets/cerchio.svg'], `/api/assets/${asset.id}/file`);
  assert.equal(preview.assets['cerchio.svg'], `/api/assets/${asset.id}/file`, 'the bare name stays for older clients');
  assert.match(preview.markdown, /alt="Vecchio alt" caption="Fig\. 1\.1 — Vecchia didascalia"/);

  // The author corrects them in Extras ("Save figure"): preview and export follow.
  await t.req('PATCH', `/api/assets/${asset.id}`, { caption: 'Cerchio di raggio $r$', alt: 'Un cerchio' });
  const after = (await t.req('GET', `/api/projects/${p.id}/chapters/c1/preview`)).body;
  assert.match(after.markdown, /alt="Un cerchio" caption="Fig\. 1\.1 — Cerchio di raggio r"/);
  const input = loadBookInput(t.ctx, p.id);
  assert.deepEqual(input.assets.map((a) => [a.filename, a.caption, a.alt]), [['cerchio.svg', 'Cerchio di raggio $r$', 'Un cerchio']]);
  const chapter = compileBook(input).files['chapters/01-uno.md'] as string;
  assert.match(chapter, /alt="Un cerchio" caption="Fig\. 1\.1 — Cerchio di raggio r"/);
  assert.ok(!chapter.includes('Vecchia'));
});
