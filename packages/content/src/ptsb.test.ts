import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPtsb, readPtsbManifest } from '@politost/content-core';
import { strFromU8, unzipSync } from 'fflate';
import { compileBook } from './compile.ts';
import { fixtureBook } from './fixtures.ts';
import { packPtsb, readBackPtsb } from './ptsb.ts';

const CREATED = '2026-03-04T05:06:07.000Z';

test('compile -> pack -> readBack round trip is ok', () => {
  const book = compileBook(fixtureBook());
  assert.deepEqual(book.findings.filter((f) => f.severity === 'blocker'), []);
  const bytes = packPtsb(book, { createdAt: CREATED });
  const back = readBackPtsb(bytes, book);
  assert.deepEqual(back, { ok: true, errors: [], warnings: [] });
});

test('ptsb.json manifest', () => {
  const bytes = packPtsb(compileBook(fixtureBook()), { createdAt: CREATED });
  assert.deepEqual(readPtsbManifest(bytes), {
    formatVersion: 1, packageType: 'smartbook', encrypted: false, access: 'public', createdAt: CREATED, producer: 'politost-smart-builder/0.1.0',
  });
  const entries = unzipSync(bytes);
  assert.ok('ptsb.json' in entries && 'smartbook.json' in entries && 'assets/fig-vel.svg' in entries);
  assert.ok(strFromU8(entries['chapters/01-cinematica.md']).startsWith('---\nchapter: 1'));
});

test('content-core reads the package: chapters, exercises, lab, graphs, assets', () => {
  const bundle = readPtsb(packPtsb(compileBook(fixtureBook()), { createdAt: CREATED }));
  assert.equal(bundle.config.id, 'fisica-demo');
  assert.deepEqual(Object.keys(bundle.chapterFiles).sort(), ['01-cinematica.md', '02-dinamica.md']);
  assert.equal(bundle.ide.length, 1);
  assert.equal(bundle.grafici.length, 1);
  assert.deepEqual(Object.keys(bundle.assets), ['assets/fig-vel.svg']);
  assert.deepEqual(bundle.warnings, []);
});

test('packing is deterministic for a given createdAt', () => {
  const book = compileBook(fixtureBook());
  assert.deepEqual(packPtsb(book, { createdAt: CREATED }), packPtsb(book, { createdAt: CREATED }));
});

test('readBackPtsb reports differences against the compiled book', () => {
  const book = compileBook(fixtureBook());
  const bytes = packPtsb(book, { createdAt: CREATED });

  const changed = { ...book, files: { ...book.files, 'chapters/02-dinamica.md': `${book.files['chapters/02-dinamica.md'] as string}\nExtra.\n` } };
  const r1 = readBackPtsb(bytes, changed);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /02-dinamica\.md/.test(e)));

  const extraAsset = { ...book, files: { ...book.files, 'assets/altro.png': new Uint8Array([1, 2, 3]) } };
  assert.ok(readBackPtsb(bytes, extraAsset).errors.some((e) => /asset names differ/.test(e)));

  const missingChapter = { ...book, files: { ...book.files } };
  missingChapter.files['chapters/03-nuovo.md'] = '---\nchapter: 3\ntitle: N\n---\n\n## p1 | A\n\nB\n';
  assert.ok(readBackPtsb(bytes, missingChapter).errors.some((e) => /chapter files differ/.test(e)));
});

test('readBackPtsb fails cleanly on an invalid package', () => {
  const book = compileBook(fixtureBook());
  const r = readBackPtsb(new Uint8Array([1, 2, 3, 4]), book);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /readPtsb failed/);

  // A book with a reader-level error (unpaired bold) packs but does not read back.
  const input = fixtureBook();
  input.chapters[1].sections[0].markdown += '\n\nUn **grassetto aperto.';
  const bad = compileBook(input);
  assert.ok(bad.findings.some((f) => f.severity === 'blocker' && f.rule === 'content-core'), 'content-core error is a blocker');
  const rb = readBackPtsb(packPtsb(bad), bad);
  assert.equal(rb.ok, false);
});
