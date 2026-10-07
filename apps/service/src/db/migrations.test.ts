import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from './db.ts';
import { MIGRATIONS } from './migrations.ts';

test('migration 3 backfills imported_at and reopens issues stranded on a superseded proposal', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sbm-')), 'db.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS.slice(0, 2)) raw.exec(m);
  raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (2)');
  raw.exec(`INSERT INTO projects (id, slug, title, subject, created_at, updated_at) VALUES ('p', 'p', 'P', 'S', 'now', 'now')`);
  const q = raw.prepare(`INSERT INTO questions (id, project_id, kind, origin, checks, created_at, updated_at) VALUES (?, 'p', 'exam', ?, ?, 'c', 'u')`);
  q.run('imported', 'authentic', JSON.stringify([{ method: 'lint', ok: true, detail: 'imported' }]));
  q.run('raw', 'authentic', '[]');
  q.run('generated', 'generated', JSON.stringify([{ method: 'lint', ok: true, detail: 'imported' }]));
  const rev = raw.prepare(`INSERT INTO content_revisions (id, project_id, node_id, kind, markdown, origin, status, created_at) VALUES (?, 'p', 's1', 'section', 'x', 'ai', ?, 'now')`);
  rev.run('live', 'proposal');
  rev.run('old', 'superseded');
  const issue = raw.prepare(`INSERT INTO review_issues (id, project_id, node_id, source, severity, category, message, status, resolution, created_at) VALUES (?, 'p', 's1', 'review', 'major', 'x', 'm', ?, ?, 'now')`);
  issue.run('stranded', 'proposed', 'Proposal old');
  issue.run('waiting', 'proposed', 'Proposal live');
  issue.run('done', 'fixed', 'Fixed by accepting proposal old');
  raw.close();

  const db = new Db(file);
  const imported = Object.fromEntries(db.all<{ id: string; imported_at: string | null; edited_at: string | null }>('SELECT id, imported_at, edited_at FROM questions').map((r) => [r.id, r]));
  assert.equal(imported.imported.imported_at, 'u');
  assert.equal(imported.raw.imported_at, null);
  assert.equal(imported.generated.imported_at, null);
  assert.equal(imported.imported.edited_at, null);
  const issues = Object.fromEntries(db.all<{ id: string; status: string; resolution: string }>('SELECT id, status, resolution FROM review_issues').map((r) => [r.id, [r.status, r.resolution]]));
  assert.deepEqual(issues, { stranded: ['open', ''], waiting: ['proposed', 'Proposal live'], done: ['fixed', 'Fixed by accepting proposal old'] });
  db.close();
});
