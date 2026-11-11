import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { claudeWebEnv, codexEnv, resetHomeWarnings } from './homes.ts';

let root: string;
let config: Config;
let saved: Record<string, string | undefined>;
const log: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sb-homes-'));
  config = { dataDir: join(root, 'data'), host: '', port: 0, lan: false, dev: false, webDist: '', version: 't' };
  mkdirSync(config.dataDir);
  saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  log.length = 0;
  resetHomeWarnings();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

const login = (dir: string, file: string, body: string) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, file), body);
};

describe('the service\'s own Codex home', () => {
  test('holds a link to the real auth.json, and no AGENTS.md or skills', () => {
    login('codex', 'auth.json', 'real');
    writeFileSync(join(root, 'codex', 'AGENTS.md'), 'owner rules');
    const env = codexEnv(config, (l) => log.push(l));
    assert.deepEqual(env, { CODEX_HOME: join(config.dataDir, 'codex-home') });
    assert.equal(readlinkSync(join(config.dataDir, 'codex-home', 'auth.json')), join(root, 'codex', 'auth.json'));
    assert.equal(existsSync(join(config.dataDir, 'codex-home', 'AGENTS.md')), false);
    assert.equal(log.length, 0);
    assert.deepEqual(codexEnv(config, (l) => log.push(l)), env, 'a second call reuses the home');
  });

  test('a token refresh that replaced the link with a file goes back to the real login', () => {
    login('codex', 'auth.json', 'old token');
    codexEnv(config);
    const link = join(config.dataDir, 'codex-home', 'auth.json');
    rmSync(link);
    writeFileSync(link, 'new token');
    utimesSync(link, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    codexEnv(config);
    assert.equal(readFileSync(join(root, 'codex', 'auth.json'), 'utf8'), 'new token');
    assert.ok(lstatSync(link).isSymbolicLink());
  });

  test('without an auth.json (keyring login) Codex keeps its default home, and the log says so once', () => {
    mkdirSync(join(root, 'codex'));
    assert.equal(codexEnv(config, (l) => log.push(l)), undefined);
    assert.equal(codexEnv(config, (l) => log.push(l)), undefined);
    assert.equal(log.length, 1);
    assert.match(log[0], /keyring/);
    assert.equal(existsSync(join(config.dataDir, 'codex-home')), false);
  });

  test('when the link cannot be made, Codex keeps its default home', () => {
    login('codex', 'auth.json', 'real');
    // A file where the home folder should be: mkdir fails on every platform.
    writeFileSync(join(config.dataDir, 'codex-home'), 'in the way');
    assert.equal(codexEnv(config, (l) => log.push(l)), undefined);
    assert.match(log[0], /could not be set up/);
  });
});

test('Claude web calls get a home with only the credentials', () => {
  login('claude', '.credentials.json', 'cred');
  writeFileSync(join(root, 'claude', 'CLAUDE.md'), 'owner rules');
  symlinkSync(root, join(root, 'claude', 'skills'));
  const env = claudeWebEnv(config, (l) => log.push(l));
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: join(config.dataDir, 'claude-home') });
  assert.equal(readlinkSync(join(config.dataDir, 'claude-home', '.credentials.json')), join(root, 'claude', '.credentials.json'));
  assert.equal(existsSync(join(config.dataDir, 'claude-home', 'CLAUDE.md')), false);
  assert.equal(existsSync(join(config.dataDir, 'claude-home', 'skills')), false);
});
