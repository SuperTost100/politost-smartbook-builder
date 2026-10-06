import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPython } from './python.ts';

test('a normal example runs and returns its output (Pyodide found from the package directory)', async () => {
  const r = await runPython('import math\nprint(1)\nprint(round(math.pi, 3))', 30_000);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stdout.trim(), '1\n3.142');
  assert.match(r.version, /^0\.\d+/);
});

test('a Python error is reported, with the output printed before it', async () => {
  const r = await runPython('print("before")\n1/0', 30_000);
  assert.equal(r.ok, false);
  assert.match(r.stdout, /before/);
  assert.match(r.error ?? '', /ZeroDivisionError/);
});

test('re-importing js after removing the blacklist entry gives nothing: no process, no host files', async () => {
  const r = await runPython(`import sys
sys.modules.pop('js', None)
import js
print(js.process.getBuiltinModule('fs').readFileSync('/etc/hostname', 'utf8'))`, 30_000);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.stdout, /\w/);
  assert.match(r.error ?? '', /AttributeError|process/);
});

test('the host home directory and system files are not readable', async () => {
  const home = process.env.HOME ?? '/root';
  const r = await runPython(`import os
for p in ['/etc/passwd', '/etc/hostname', ${JSON.stringify(home)}]:
    try:
        print(p, open(p).read()[:20] if os.path.isfile(p) else os.listdir(p)[:3])
    except Exception as e:
        print(p, 'blocked', type(e).__name__)`, 30_000);
  assert.equal(r.ok, true, r.error);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, /blocked/);
});

test('JavaScript escapes through proxies are refused (Function constructor, run_js)', async () => {
  const f = await runPython(`import pyodide_js
G = pyodide_js.loadPackage.constructor('return process')()
print(G.version)`, 30_000);
  assert.equal(f.ok, false);
  assert.match(f.error ?? '', /EvalError|Code generation/);
  assert.doesNotMatch(f.stdout, /v\d+\./);
  const g = await runPython(`from pyodide.code import run_js
print(run_js('process.version'))`, 30_000);
  assert.equal(g.ok, false);
  assert.match(g.error ?? '', /ImportError|EvalError/);
  assert.doesNotMatch(g.stdout, /v\d+\./);
});

test('os.system and subprocess cannot start programs', async () => {
  const a = await runPython(`import os
print(os.system('echo escaped > /tmp/sb-escaped.txt'))`, 30_000);
  assert.equal(a.ok, false);
  assert.match(a.error ?? '', /restricted|child-process|fatal/i);
  const b = await runPython(`import subprocess
print(subprocess.run(['echo', 'escaped'], capture_output=True))`, 30_000);
  assert.equal(b.ok, false);
  assert.match(b.error ?? '', /Error|restricted/);
  assert.doesNotMatch(b.error ?? '', /could not start|stopped unexpectedly: \/usr/);
  assert.doesNotMatch(b.stdout, /escaped/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync('/tmp/sb-escaped.txt'), false);
});

test('an infinite loop is killed by the timeout', async () => {
  const started = Date.now();
  const r = await runPython('while True:\n    pass', 4000);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Timed out/);
  assert.ok(Date.now() - started < 8000);
});
