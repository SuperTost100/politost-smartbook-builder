import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { RULES_VERSION } from '@smartbuilder/content/rules-version';
import { newId, now } from '../db/db.ts';
import { listExports } from '../repo/index.ts';
import { projectWithOutline, startApp, type TestApp } from '../routes/testkit.ts';
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

/** A one-chapter book with an approved export made through the route, as the "Approve and export" button does. */
async function approvedBook(slug = 'analisi-1') {
  const { projectId } = await projectWithOutline(t, slug);
  write(projectId, 's1', 'Il limite di una funzione descrive il suo comportamento vicino a un punto.');
  write(projectId, 's2', 'Il teorema della permanenza del segno vale per ogni limite finito e diverso da zero.');
  const res = await t.req('POST', `/api/projects/${projectId}/exports`, { approved: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { projectId, folder: join(books, 'books', slug) };
}

const publish = (projectId: string, opts: { version?: string; export?: boolean; dryRun?: boolean } = {}) => {
  const plan = planPublish(t.ctx, { projectId, booksDir: books, ...opts });
  if (!opts.dryRun && !plan.refusals.length && !plan.upToDate) writePublish(plan);
  return plan;
};
const manifestOf = (folder: string) => JSON.parse(readFileSync(join(folder, MANIFEST), 'utf8')) as BuilderManifest;
const versionIn = (folder: string) => JSON.parse(readFileSync(join(folder, 'smartbook.json'), 'utf8')).version;

test('publish writes the export with a manifest of every file, removes what the export no longer has and keeps the cover', async () => {
  const { projectId, folder } = await approvedBook();
  mkdirSync(join(folder, 'chapters'), { recursive: true });
  writeFileSync(join(folder, 'chapters', '99-vecchio.md'), 'vecchio');
  writeFileSync(join(folder, 'cover.svg'), '<svg/>');

  const plan = publish(projectId);
  assert.deepEqual(plan.refusals, []);
  assert.match(plan.notices.join('\n'), /no \.builder\.json/);
  assert.deepEqual(plan.diff.removed, ['chapters/99-vecchio.md']);
  assert.ok(!existsSync(join(folder, 'chapters', '99-vecchio.md')));
  assert.ok(existsSync(join(folder, 'cover.svg')));

  const m = manifestOf(folder);
  const exportRow = listExports(t.ctx, projectId)[0];
  assert.equal(m.exportId, exportRow.id);
  assert.equal(m.exportedAt, exportRow.createdAt);
  assert.equal(m.projectId, projectId);
  assert.equal(m.rulesVersion, RULES_VERSION);
  assert.equal(m.builderVersion, 'test');
  assert.ok('ptsb.json' in m.files && 'smartbook.json' in m.files && Object.keys(m.files).some((p) => p.startsWith('chapters/')));
  assert.ok(!('cover.svg' in m.files));
  for (const [path, hash] of Object.entries(m.files)) assert.equal(sha256(readFileSync(join(folder, path))), hash, path);
  // A second run with the same export changes nothing, not even the version, unless a version is asked for.
  const again = publish(projectId);
  assert.equal(again.upToDate, true);
  assert.equal(versionIn(folder), '1.0.0');
  assert.equal(publish(projectId, { version: '1.1.0' }).upToDate, false);
  assert.equal(versionIn(folder), '1.1.0');
});

test('a folder that already holds the export but has no manifest gets one', async () => {
  const { projectId, folder } = await approvedBook();
  publish(projectId);
  rmSync(join(folder, MANIFEST));
  const p = publish(projectId);
  assert.equal(p.upToDate, false);
  assert.ok(existsSync(join(folder, MANIFEST)));
  assert.equal(versionIn(folder), '1.0.1', 'the books CI wants a higher version for any change to the folder');
});

test('writePublish refuses a folder edited after the plan was made', async () => {
  const { projectId, folder } = await approvedBook();
  publish(projectId);
  write(projectId, 's1', 'Il limite di una funzione in un punto di accumulazione del dominio.');
  const plan = planPublish(t.ctx, { projectId, booksDir: books, export: true });
  assert.deepEqual(plan.refusals, []);
  writeFileSync(join(folder, 'esercizi.md'), 'modificato nel frattempo');
  assert.throws(() => writePublish(plan), /changed after the publish was planned \(added esercizi\.md\)/);
  assert.equal(readFileSync(join(folder, 'esercizi.md'), 'utf8'), 'modificato nel frattempo');
});

test('publish stops on a hand edit and prints the back-port dry run, and goes ahead once the folder matches its manifest', async () => {
  const { projectId, folder } = await approvedBook();
  publish(projectId);
  const chapter = Object.keys(manifestOf(folder).files).find((p) => p.startsWith('chapters/'))!;
  const original = readFileSync(join(folder, chapter));
  writeFileSync(join(folder, chapter), `${original}\nUna correzione fatta a mano.\n`);
  writeFileSync(join(folder, 'assets.txt'), 'aggiunto a mano');
  const exportsBefore = listExports(t.ctx, projectId).length;

  const refused = publish(projectId, { export: true });
  assert.deepEqual(refused.handEdited, [`added assets.txt`, `changed ${chapter}`]);
  assert.match(refused.refusals[0], new RegExp(`npm run backport -- --project ${projectId} --from ${folder} --dry-run`));
  assert.equal(refused.files, null, 'a real run stops before it exports or writes');
  assert.equal(listExports(t.ctx, projectId).length, exportsBefore);
  assert.notEqual(readFileSync(join(folder, chapter)).toString(), original.toString());

  // A dry run reports the same refusal and still lists the files.
  const dry = publish(projectId, { dryRun: true });
  assert.equal(dry.handEdited.length, 2);
  assert.ok(dry.files);

  writeFileSync(join(folder, chapter), original);
  rmSync(join(folder, 'assets.txt'));
  assert.deepEqual(publish(projectId).refusals, []);
});

test('the version is the one after the books folder, or --version', async () => {
  assert.equal(nextVersion(null), '1.0.0');
  assert.equal(nextVersion('1.2.3'), '1.2.4');
  assert.equal(nextVersion('1.2.0-beta.1'), '1.2.0');
  assert.throws(() => nextVersion('1.2'), /not semver/);

  const { projectId, folder } = await approvedBook();
  publish(projectId);
  assert.equal(versionIn(folder), '1.0.0');
  write(projectId, 's1', 'Il limite di una funzione descrive il suo comportamento vicino a un punto, anche se non vi è definita.');
  const p = publish(projectId, { export: true });
  assert.deepEqual(p.refusals, []);
  assert.equal(p.previousVersion, '1.0.0');
  assert.equal(versionIn(folder), '1.0.1');
  // The new export is stored with the version it was published with.
  assert.equal(manifestOf(folder).exportId, listExports(t.ctx, projectId)[0].id);

  write(projectId, 's2', 'Il teorema della permanenza del segno vale per ogni limite finito e non nullo.');
  publish(projectId, { export: true, version: '2.0.0' });
  assert.equal(versionIn(folder), '2.0.0');
  assert.throws(() => planPublish(t.ctx, { projectId, booksDir: books, version: '2.1' }), /not semver/);
});

test('publish refuses an export checked with other rules, and --export makes a new one through the same gate', async () => {
  const { projectId, folder } = await approvedBook();
  const row = listExports(t.ctx, projectId)[0];
  t.ctx.db.run('UPDATE exports SET report = ? WHERE id = ?', JSON.stringify({ ...row.report, rulesVersion: '0000000000000000' }), row.id);

  const stale = publish(projectId);
  assert.match(stale.refusals.join('\n'), /checked with other rules \(0000000000000000; this builder has [0-9a-f]{16}\)/);
  assert.ok(!existsSync(join(folder, MANIFEST)));
  // An export made before rules were versioned has none, which is just as stale.
  t.ctx.db.run('UPDATE exports SET report = ? WHERE id = ?', JSON.stringify({ ...row.report, rulesVersion: undefined }), row.id);
  assert.match(publish(projectId).refusals.join('\n'), /made before rules were versioned/);

  // --export is refused while a review blocker is open; a dry run says so, shows the files and stores nothing.
  const issue = newId();
  t.ctx.db.insert('review_issues', { id: issue, project_id: projectId, node_id: 's1', source: 'review', severity: 'blocker', category: 'math', message: 'Soluzione errata', created_at: now() });
  const dry = publish(projectId, { export: true, dryRun: true });
  assert.match(dry.refusals.join('\n'), /cannot be approved yet: 1 review problem is still open/);
  assert.ok(dry.files);
  assert.equal(listExports(t.ctx, projectId).length, 1);
  assert.match(publish(projectId, { export: true }).refusals.join('\n'), /review problem is still open/);
  assert.equal(listExports(t.ctx, projectId).length, 1);

  t.ctx.db.run(`UPDATE review_issues SET status = 'dismissed' WHERE id = ?`, issue);
  const fresh = publish(projectId, { export: true });
  assert.deepEqual(fresh.refusals, []);
  assert.equal(manifestOf(folder).rulesVersion, RULES_VERSION);
  assert.equal(listExports(t.ctx, projectId)[0].report.rulesVersion, RULES_VERSION);
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
  assert.equal(check.rules, 'unknown');
  assert.deepEqual(check.fresh.map((f) => f.rule), ['literal-escape']);

  const manifest: BuilderManifest = { projectId: 'p', exportId: 'e', exportedAt: '', builderVersion: 'test', rulesVersion: RULES_VERSION, files: {}, findings: publishedFindings({ 'chapters/01-moto.md': readFileSync(join(folder, 'chapters', '01-moto.md')) }).map(findingKey) };
  writeFileSync(join(folder, MANIFEST), JSON.stringify(manifest));
  assert.deepEqual(validatePublished(books), [{ slug: 'fisica-1', rules: 'same', fresh: [] }]);
});
