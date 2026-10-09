import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockDataDir, paths } from './config.ts';

test('a second service on the same data folder is refused until the first releases it', () => {
  const c = { dataDir: mkdtempSync(join(tmpdir(), 'sb-lock-')) };
  const first = lockDataDir(c);
  assert.ok('release' in first);
  // The test process itself is alive, so another PID asking for the folder finds it held.
  const second = lockDataDir(c, process.pid + 1);
  assert.deepEqual(second, { heldBy: process.pid });
  first.release();
  assert.equal(existsSync(paths.lock(c)), false);
  const third = lockDataDir(c, process.pid + 1);
  assert.ok('release' in third);
});

test('a lock left by a dead process is taken over', () => {
  const c = { dataDir: mkdtempSync(join(tmpdir(), 'sb-lock-')) };
  // PIDs above the kernel's limit never belong to a running process.
  writeFileSync(paths.lock(c), '99999999');
  const lock = lockDataDir(c);
  assert.ok('release' in lock);
  assert.equal(readFileSync(paths.lock(c), 'utf8'), String(process.pid));
});
