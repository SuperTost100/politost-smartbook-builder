import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { paths, resolveDataPath, toDataPath, type Config } from '../config.ts';
import { createContext, relativizeStoredPaths } from '../context.ts';
import { now } from '../db/db.ts';
import { extractResource, renderPageImage, storeResource } from '../extract/index.ts';
import { makePdf } from '../extract/testkit.ts';
import { assetFile, deleteAsset, getExport, insertExport, storeAsset } from '../repo/index.ts';

const config = (dataDir: string): Config => ({ dataDir, host: '127.0.0.1', port: 0, lan: false, dev: false, webDist: '', version: 'test' });
const SCRIPT = join(import.meta.dirname, 'backup.ts');
const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], { cwd: join(import.meta.dirname, '..', '..'), stdio: 'pipe' });

test('a backup restored into another data directory serves its assets, pages and exports from there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-restore-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  mkdirSync(a);
  const ctxA = createContext(config(a));
  ctxA.db.run(`INSERT INTO projects (id, slug, title, subject, language, created_at, updated_at) VALUES ('p1', 'p1', 'T', 'S', 'it', ?, ?)`, now(), now());
  const resourceId = await storeResource(ctxA, 'p1', { filename: 'a.pdf', bytes: makePdf([['Pagina uno']]), role: 'theory' });
  await extractResource(ctxA, resourceId, new AbortController().signal);
  const asset = storeAsset(ctxA, 'p1', { filename: 'fig.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'), origin: 'imported' });
  mkdirSync(paths.exports(ctxA.config, 'p1'), { recursive: true });
  const exportFile = join(paths.exports(ctxA.config, 'p1'), 'book.ptsb');
  writeFileSync(exportFile, 'zip');
  const exp = insertExport(ctxA, { projectId: 'p1', filename: 'book.ptsb', path: exportFile, sha256: 'x', size: 3, approved: false, report: { ok: true, errors: [], warnings: [], lint: [] } });

  // Stored paths are relative to the data directory.
  for (const t of ['resources', 'assets', 'exports']) assert.ok(!ctxA.db.get<{ path: string }>(`SELECT path FROM ${t}`)!.path.startsWith('/'), t);

  const archive = join(root, 'backup.tar.gz');
  run('backup', archive, '--data-dir', a);
  ctxA.db.close();
  rmSync(a, { recursive: true, force: true });
  run('restore', archive, '--data-dir', b);

  const ctxB = createContext(config(b));
  try {
    const png = await renderPageImage(ctxB, resourceId, 0);
    assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71]);
    const f = assetFile(ctxB, asset.id);
    assert.ok(f.path.startsWith(b), f.path);
    assert.ok(existsSync(f.path));
    assert.ok(getExport(ctxB, exp.id).path.startsWith(b));
    assert.ok(existsSync(getExport(ctxB, exp.id).path));
    deleteAsset(ctxB, asset.id);
    assert.equal(existsSync(f.path), false);
  } finally {
    ctxB.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('absolute paths from before relative storage are converted once; paths outside the data directory stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-rel-'));
  const ctx = createContext(config(dir));
  try {
    ctx.db.run(`INSERT INTO projects (id, slug, title, subject, language, created_at, updated_at) VALUES ('p1', 'p1', 'T', 'S', 'it', ?, ?)`, now(), now());
    const inside = join(dir, 'projects', 'p1', 'resources', 'x.pdf');
    ctx.db.run(`INSERT INTO resources (id, project_id, kind, role, filename, sha256, path, created_at) VALUES ('r1', 'p1', 'pdf', 'theory', 'x.pdf', 's1', ?, ?)`, inside, now());
    ctx.db.run(`INSERT INTO resources (id, project_id, kind, role, filename, sha256, path, created_at) VALUES ('r2', 'p1', 'pdf', 'theory', 'y.pdf', 's2', '/elsewhere/y.pdf', ?)`, now());
    ctx.db.run(`DELETE FROM settings WHERE key = 'paths_relative'`);
    relativizeStoredPaths(ctx.db, ctx.config);
    const paths2 = Object.fromEntries(ctx.db.all<{ id: string; path: string }>('SELECT id, path FROM resources').map((r) => [r.id, r.path]));
    assert.equal(paths2.r1, 'projects/p1/resources/x.pdf');
    assert.equal(paths2.r2, '/elsewhere/y.pdf');
    assert.equal(resolveDataPath(ctx.config, paths2.r1), inside);
    assert.equal(resolveDataPath(ctx.config, paths2.r2), '/elsewhere/y.pdf');
    assert.equal(toDataPath(ctx.config, inside), paths2.r1);
    // Guarded by a settings key: a second pass changes nothing.
    ctx.db.run(`UPDATE resources SET path = ? WHERE id = 'r1'`, inside);
    relativizeStoredPaths(ctx.db, ctx.config);
    assert.equal(ctx.db.get<{ path: string }>(`SELECT path FROM resources WHERE id = 'r1'`)!.path, inside);
  } finally {
    ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
