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

test('migration 5 adds the course program and alignment report tables, which go with the project', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sbm-')), 'db.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m);
  raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (4)');
  raw.exec(`INSERT INTO projects (id, slug, title, subject, created_at, updated_at) VALUES ('p', 'p', 'P', 'S', 'now', 'now')`);
  raw.close();

  const db = new Db(file);
  assert.equal(db.get<{ version: number }>('SELECT version FROM schema_version')!.version, MIGRATIONS.length);
  db.run(`INSERT INTO course_programs (project_id, text, updated_at) VALUES ('p', 'Programma', 'now')`);
  const program = db.get<Record<string, unknown>>(`SELECT * FROM course_programs WHERE project_id = 'p'`)!;
  assert.deepEqual([program.items, program.exam_format, program.status, program.url, program.parsed_at], ['[]', '{}', 'idle', null, null]);
  db.run(`INSERT INTO alignment_reports (id, project_id, outline_rev_id, created_at) VALUES ('r', 'p', 'rev', 'now')`);
  const report = db.get<Record<string, unknown>>(`SELECT * FROM alignment_reports WHERE id = 'r'`)!;
  assert.deepEqual([report.coverage, report.findings, report.applied, report.applied_at], ['[]', '[]', '[]', null]);
  db.run(`DELETE FROM projects WHERE id = 'p'`);
  assert.equal(db.get(`SELECT 1 FROM course_programs`), undefined);
  assert.equal(db.get(`SELECT 1 FROM alignment_reports`), undefined);
  db.close();
});

test('migration 6 adds what a model call cost to the usage table and keeps the rows from before', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sbm-')), 'db.sqlite');
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m);
  raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (5)');
  raw.exec(`INSERT INTO usage (provider, model, role, input_tokens, output_tokens, ms, ok, created_at) VALUES ('codex', 'm', 'checker', 100, 5, 7, 1, 'then')`);
  raw.close();

  const db = new Db(file);
  const old = db.get<Record<string, unknown>>('SELECT * FROM usage')!;
  assert.deepEqual([old.input_tokens, old.cached_input_tokens, old.cache_creation_tokens, old.error_kind, old.attempt, old.fallback], [100, null, null, null, null, null]);
  db.run(`INSERT INTO usage (provider, model, role, ms, ok, cached_input_tokens, cache_creation_tokens, error_kind, attempt, fallback, created_at) VALUES ('claude', 'm', 'writer', 9, 0, 40, 10, 'quota', 2, 1, 'now')`);
  const fresh = db.get<Record<string, unknown>>(`SELECT * FROM usage WHERE role = 'writer'`)!;
  assert.deepEqual([fresh.cached_input_tokens, fresh.cache_creation_tokens, fresh.error_kind, fresh.attempt, fresh.fallback], [40, 10, 'quota', 2, 1]);
  db.close();
});
