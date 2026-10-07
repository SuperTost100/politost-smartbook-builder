import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { parseArgs } from './config.ts';
import { createContext } from './context.ts';

test('settings saved before new roles existed still load, with defaults for the new roles', () => {
  const ctx = createContext(parseArgs(['--data-dir', mkdtempSync(join(tmpdir(), 'sbset-'))]));
  const old = { routes: { bulk: DEFAULT_ROUTES.bulk, vision: DEFAULT_ROUTES.vision, evidence: DEFAULT_ROUTES.evidence, planner: DEFAULT_ROUTES.planner, writer: DEFAULT_ROUTES.writer, reviewer: DEFAULT_ROUTES.reviewer }, evidenceMode: 'notebooklm' };
  ctx.db.run(`INSERT INTO settings (key, value) VALUES ('settings', ?)`, JSON.stringify(old));
  const s = ctx.settings();
  assert.deepEqual(s.routes.checker, DEFAULT_ROUTES.checker);
  const saved = ctx.saveSettings({ routes: { writer: DEFAULT_ROUTES.editor } as never });
  assert.deepEqual(saved.routes.writer, DEFAULT_ROUTES.editor);
  assert.deepEqual(saved.routes.reviewer, DEFAULT_ROUTES.reviewer);
});
