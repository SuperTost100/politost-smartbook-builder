import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { newId, now } from '../db/db.ts';
import { listExports } from '../repo/index.ts';
import { projectWithOutline, startApp, type TestApp } from '../routes/testkit.ts';
import { backportProject } from './backport.ts';
import { MANIFEST, findingKey, nextVersion, planPublish, publishedFindings, sha256, validatePublished, writePublish, type BuilderManifest } from './publish.ts';

let t: TestApp;
let books: string;
beforeEach(async () => {
  t = await startApp();
  books = mkdtempSync(join(tmpdir(), 'smartbuilder-books-'));
  mkdirSync(join(books, 'books'));
});
afterEach(async () => {
  await t.close();
  rmSync(books, { recursive: true, force: true });
});

const write = (projectId: string, node: string, markdown: string) =>
  t.ctx.db.insert('content_revisions', { id: newId(), project_id: projectId, node_id: node, kind: 'section', markdown, origin: 'human', status: 'current', citations: {}, created_at: now() });

const S1 = 'Il limite di una funzione descrive il suo comportamento vicino a un punto.';

/** A one-chapter book with an approved outline and text, ready to publish. */
async function book(slug = 'analisi-1') {
  const { projectId } = await projectWithOutline(t, slug);
  write(projectId, 's1', S1);
  write(projectId, 's2', 'Il teorema della permanenza del segno vale per ogni limite finito e diverso da zero.');
  return { projectId, folder: join(books, 'books', slug) };
}

const publish = (projectId: string, opts: { version?: string; dryRun?: boolean } = {}) => {
  const plan = planPublish(t.ctx, { projectId, booksDir: books, version: opts.version });
  if (!opts.dryRun && !plan.refusals.length && !plan.upToDate) writePublish(t.ctx, plan);
  return plan;
};
const manifestOf = (folder: string) => JSON.parse(readFileSync(join(folder, MANIFEST), 'utf8')) as BuilderManifest;
const versionIn = (folder: string) => JSON.parse(readFileSync(join(folder, 'smartbook.json'), 'utf8')).version;
const chapterOf = (folder: string) => Object.keys(manifestOf(folder).files).find((p) => p.startsWith('chapters/'))!;

test('publish stores the export it writes, names it in a manifest of every file, removes what it no longer has and keeps the cover', async () => {
  const { projectId, folder } = await book();
  mkdirSync(join(folder, 'chapters'), { recursive: true });
  writeFileSync(join(folder, 'chapters', '99-vecchio.md'), 'vecchio');
  writeFileSync(join(folder, 'cover.svg'), '<svg/>');

  const dry = publish(projectId, { dryRun: true });
  assert.deepEqual(dry.refusals, []);
  assert.equal(listExports(t.ctx, projectId).length, 0, 'a dry run stores no export');
  assert.ok(!existsSync(join(folder, 'smartbook.json')));

  const plan = publish(projectId);
  assert.match(plan.notices.join('\n'), /no \.builder\.json/);
  assert.deepEqual(plan.diff.removed, ['chapters/99-vecchio.md']);
  assert.ok(!existsSync(join(folder, 'chapters', '99-vecchio.md')));
  assert.ok(existsSync(join(folder, 'cover.svg')));

  const m = manifestOf(folder);
  const [stored] = listExports(t.ctx, projectId);
  assert.equal(listExports(t.ctx, projectId).length, 1);
  assert.equal(stored.approved, true);
  assert.equal(m.exportId, stored.id);
  assert.equal(m.exportedAt, stored.createdAt);
  assert.equal(m.projectId, projectId);
  assert.equal(m.builderVersion, 'test');
  assert.equal(versionIn(folder), '1.0.0');
  assert.ok('ptsb.json' in m.files && 'smartbook.json' in m.files && !('cover.svg' in m.files));
  for (const [path, hash] of Object.entries(m.files)) assert.equal(sha256(readFileSync(join(folder, path))), hash, path);

  // The same book again changes nothing and stores nothing, in a dry run or not, unless a version is asked for.
  assert.equal(publish(projectId, { dryRun: true }).upToDate, true);
  assert.equal(publish(projectId).upToDate, true);
  assert.equal(listExports(t.ctx, projectId).length, 1);
  assert.equal(publish(projectId, { version: '1.1.0' }).upToDate, false);
  assert.equal(versionIn(folder), '1.1.0');
  assert.equal(manifestOf(folder).exportId, listExports(t.ctx, projectId)[0].id);
});

test('a folder that already holds the book but has no manifest gets one', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  rmSync(join(folder, MANIFEST));
  assert.equal(publish(projectId).upToDate, false);
  assert.ok(existsSync(join(folder, MANIFEST)));
  assert.equal(versionIn(folder), '1.0.1', 'the books CI wants a higher version for any change to the folder');
});

test('publish refuses a book that "Approve and export" would refuse, and stores nothing', async () => {
  const { projectId, folder } = await book();
  const issue = newId();
  t.ctx.db.insert('review_issues', { id: issue, project_id: projectId, node_id: 's1', source: 'review', severity: 'blocker', category: 'math', message: 'Soluzione errata', created_at: now() });
  const refused = publish(projectId);
  assert.match(refused.refusals.join('\n'), /cannot be approved yet: 1 review problem is still open/);
  assert.ok(refused.files['smartbook.json'], 'the files are still listed');
  assert.equal(listExports(t.ctx, projectId).length, 0);
  assert.ok(!existsSync(folder));
  t.ctx.db.run(`UPDATE review_issues SET status = 'dismissed' WHERE id = ?`, issue);
  assert.deepEqual(publish(projectId).refusals, []);
});

test('publish stops on a hand edit and prints the back-port dry run, even when the manifest was rewritten to match', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  const chapter = chapterOf(folder);
  const original = readFileSync(join(folder, chapter));
  const edited = Buffer.from(`${original}\nUna correzione fatta a mano.\n`);
  writeFileSync(join(folder, chapter), edited);
  writeFileSync(join(folder, 'note.txt'), 'aggiunto a mano');
  const exportsBefore = listExports(t.ctx, projectId).length;

  const refused = publish(projectId);
  assert.deepEqual(refused.handEdited, [`${chapter}#p2`, 'note.txt'], 'listed by section, as the back-port sees them');
  assert.match(refused.refusals.join('\n'), new RegExp(`npm run backport -- --project ${projectId} --from ${folder} --dry-run`));
  assert.equal(listExports(t.ctx, projectId).length, exportsBefore, 'nothing stored');
  assert.equal(readFileSync(join(folder, chapter)).toString(), edited.toString(), 'nothing written');

  // The manifest lives in the books repo, so its hashes prove nothing: the folder is compared with the builder's own export.
  const forged = manifestOf(folder);
  forged.files[chapter] = sha256(edited);
  forged.files['note.txt'] = sha256(Buffer.from('aggiunto a mano'));
  writeFileSync(join(folder, MANIFEST), JSON.stringify(forged));
  assert.deepEqual(publish(projectId).handEdited, [`${chapter}#p2`, 'note.txt']);

  // An export id this builder does not have cannot be checked, so it is refused too.
  writeFileSync(join(folder, MANIFEST), JSON.stringify({ ...forged, exportId: 'sconosciuto' }));
  assert.match(publish(projectId).refusals.join('\n'), /names export sconosciuto, which this builder does not have/);

  writeFileSync(join(folder, MANIFEST), JSON.stringify(forged));
  writeFileSync(join(folder, chapter), original);
  rmSync(join(folder, 'note.txt'));
  assert.deepEqual(publish(projectId).refusals, []);
});

test('a symbolic link in the book folder is refused before anything is read or written', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  const outside = join(books, 'fuori.md');
  writeFileSync(outside, 'non toccare');
  const chapter = chapterOf(folder);
  rmSync(join(folder, chapter));
  symlinkSync(outside, join(folder, chapter));
  assert.throws(() => planPublish(t.ctx, { projectId, booksDir: books }), /is a symbolic link/);
  assert.equal(readFileSync(outside, 'utf8'), 'non toccare');
  // A manifest that is a link, even one pointing nowhere yet, is refused too, and nothing is created at its target.
  rmSync(join(folder, chapter));
  rmSync(join(folder, MANIFEST));
  symlinkSync(join(books, 'manifest-fuori.json'), join(folder, MANIFEST));
  assert.throws(() => planPublish(t.ctx, { projectId, booksDir: books }), /\.builder\.json is a symbolic link/);
  assert.ok(!existsSync(join(books, 'manifest-fuori.json')));
  // So is a book folder that is a dangling link.
  rmSync(folder, { recursive: true });
  symlinkSync(join(books, 'altrove'), folder);
  assert.throws(() => planPublish(t.ctx, { projectId, booksDir: books }), /is a symbolic link/);
  assert.ok(!existsSync(join(books, 'altrove')));
  // And a books folder that leads elsewhere.
  const elsewhere = mkdtempSync(join(tmpdir(), 'smartbuilder-elsewhere-'));
  try {
    rmSync(join(books, 'books'), { recursive: true });
    symlinkSync(elsewhere, join(books, 'books'));
    assert.throws(() => planPublish(t.ctx, { projectId, booksDir: books }), /books is a symbolic link/);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a change made in the builder since the last publish is not a hand edit', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  write(projectId, 's2', 'Il teorema della permanenza del segno, nella sua forma per i limiti.');
  const p = publish(projectId);
  assert.deepEqual(p.refusals, []);
  assert.ok(p.diff.changed.includes(chapterOf(folder)));
});

test('the CONTRIBUTING sequence: a fix made in the books folder, back-ported, then published onto the same branch', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  const chapter = chapterOf(folder);
  const fixed = readFileSync(join(folder, chapter), 'utf8').replace('vicino a un punto', 'in prossimità di un punto');
  assert.notEqual(fixed, readFileSync(join(folder, chapter), 'utf8'));
  writeFileSync(join(folder, chapter), fixed);
  // The contributor also raises the version, as CONTRIBUTING asks of every change.
  writeFileSync(join(folder, 'smartbook.json'), readFileSync(join(folder, 'smartbook.json'), 'utf8').replace('"version": "1.0.0"', '"version": "1.0.1"'));
  assert.deepEqual(publish(projectId, { dryRun: true }).handEdited, [`${chapter}#p1`], 'before the back-port the fix is a hand edit, the version is not');

  const back = backportProject(t.ctx, projectId, folder);
  assert.equal(back.written, true, JSON.stringify(back.units));

  const p = publish(projectId);
  assert.deepEqual(p.refusals, []);
  assert.equal(readFileSync(join(folder, chapter), 'utf8'), fixed, 'the published text is the contributor\'s');
  assert.equal(versionIn(folder), '1.0.2');
  assert.equal(manifestOf(folder).exportId, listExports(t.ctx, projectId)[0].id);
});

test('a fix back-ported next to a section the builder changed since can be published onto the same folder', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  const chapter = chapterOf(folder);
  // The builder edits s2 after the publish; the books fix s1 in the same chapter file.
  write(projectId, 's2', 'Il teorema della permanenza del segno vale per ogni limite finito e non nullo.');
  writeFileSync(join(folder, chapter), readFileSync(join(folder, chapter), 'utf8').replace('vicino a un punto', 'in prossimità di un punto'));
  assert.deepEqual(publish(projectId, { dryRun: true }).handEdited, [`${chapter}#p1`]);
  assert.equal(backportProject(t.ctx, projectId, folder).written, true);
  const p = publish(projectId);
  assert.deepEqual(p.refusals, []);
  const text = readFileSync(join(folder, chapter), 'utf8');
  assert.match(text, /in prossimità di un punto/);
  assert.match(text, /finito e non nullo/);
});

test('a manifest from before exercise and formula numbers were recorded is rewritten, even for the same book', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  const { exercises: _e, formulas: _f, ...legacy } = manifestOf(folder);
  writeFileSync(join(folder, MANIFEST), JSON.stringify(legacy));
  assert.throws(() => backportProject(t.ctx, projectId, folder, { dryRun: true }), /Publish the book again first/);
  assert.equal(publish(projectId).upToDate, false);
  assert.ok(manifestOf(folder).exercises && manifestOf(folder).formulas);
  assert.doesNotThrow(() => backportProject(t.ctx, projectId, folder, { dryRun: true }));
});

test('the version is the one after the books folder, or --version', async () => {
  assert.equal(nextVersion(null), '1.0.0');
  assert.equal(nextVersion('1.2.3'), '1.2.4');
  assert.equal(nextVersion('1.2.0-beta.1'), '1.2.0');
  assert.throws(() => nextVersion('1.2'), /not semver/);

  const { projectId, folder } = await book();
  publish(projectId);
  write(projectId, 's1', `${S1} Anche dove la funzione non è definita.`);
  const p = publish(projectId);
  assert.equal(p.previousVersion, '1.0.0');
  assert.equal(versionIn(folder), '1.0.1');
  // The export is compiled with the version it is published with, so the stored package and the folder agree.
  assert.match(p.prepared.compiled.files['smartbook.json'] as string, /"version": "1\.0\.1"/);

  write(projectId, 's2', 'Il teorema della permanenza del segno vale per ogni limite non nullo.');
  publish(projectId, { version: '2.0.0' });
  assert.equal(versionIn(folder), '2.0.0');
  assert.throws(() => planPublish(t.ctx, { projectId, booksDir: books, version: '2.1' }), /not semver/);
});

test('writePublish refuses a folder that changed after the plan was made', async () => {
  const { projectId, folder } = await book();
  publish(projectId);
  write(projectId, 's1', 'Il limite di una funzione in un punto di accumulazione del dominio.');
  const plan = planPublish(t.ctx, { projectId, booksDir: books });
  assert.deepEqual(plan.refusals, []);
  writeFileSync(join(folder, 'esercizi.md'), 'modificato nel frattempo');
  assert.throws(() => writePublish(t.ctx, plan), /changed after the publish was planned \(added esercizi\.md\)/);
  assert.equal(readFileSync(join(folder, 'esercizi.md'), 'utf8'), 'modificato nel frattempo');
  // Another publish that wrote the folder in between makes the plan stale too.
  rmSync(join(folder, 'esercizi.md'));
  const first = planPublish(t.ctx, { projectId, booksDir: books });
  write(projectId, 's2', 'Il teorema della permanenza del segno, nella sua forma per i limiti.');
  writePublish(t.ctx, planPublish(t.ctx, { projectId, booksDir: books }));
  assert.throws(() => writePublish(t.ctx, first), /changed after the publish was planned/);
});

test('validate-all lists only the findings a book did not have when it was published', () => {
  const folder = join(books, 'books', 'fisica-1');
  mkdirSync(join(folder, 'chapters'), { recursive: true });
  writeFileSync(join(folder, 'ptsb.json'), JSON.stringify({ producer: 'politost-smart-builder/0.5.1-alpha' }));
  writeFileSync(join(folder, 'chapters', '01-moto.md'), '---\nchapter: 1\ntitle: Moto\n---\n\n## p1 | Velocità\n\nLa velocità media è il rapporto tra spazio e tempo.\\nIl resto segue.\n');
  // A folder the builder did not make is not read.
  mkdirSync(join(books, 'books', 'esempio'));

  const [check] = validatePublished(books);
  assert.equal(check.slug, 'fisica-1');
  assert.equal(check.manifest, false);
  assert.deepEqual(check.fresh.map((f) => f.rule), ['literal-escape']);

  const manifest: BuilderManifest = { projectId: 'p', exportId: 'e', exportedAt: '', builderVersion: 'test', files: {}, exercises: {}, formulas: {}, findings: publishedFindings({ 'chapters/01-moto.md': readFileSync(join(folder, 'chapters', '01-moto.md')) }).map(findingKey) };
  writeFileSync(join(folder, MANIFEST), JSON.stringify(manifest));
  assert.deepEqual(validatePublished(books), [{ slug: 'fisica-1', manifest: true, fresh: [] }]);
});
