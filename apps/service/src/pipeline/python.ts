// Runs model-written Python examples in Pyodide inside a locked-down child process.
//
// The code comes from a model that read course material, so it is untrusted (prompt injection can reach it). A worker thread
// or a module blacklist is not a boundary: Python can reach the host through JavaScript. The boundary here is a separate
// Node process under the permission model:
//   --permission with only --allow-fs-read=<pyodide package dir>   no other file reads, no writes
//   (no --allow-child-process / --allow-worker / --allow-addons / --allow-wasi / --allow-inspector)
//   --disallow-code-generation-from-strings                         eval and `Function(...)` from Python's JS proxies fail
//   --max-old-space-size=512, an empty environment, an empty temporary folder as cwd, and a SIGKILL timeout.
// Inside, Pyodide gets `jsglobals: {}`, so `import js` exposes nothing (not process, not globalThis, not fetch).
//
// NOT restricted: network. Node 24's permission model has no network switch (that arrives in later Node versions). The
// child has no handle to the network layer unless Python escapes the JS proxies, which the flags above block, and even then
// it would find no secrets: it can read nothing but the Pyodide package, has no environment and no write access.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PythonResult { ok: boolean; stdout: string; error?: string; version: string }

/** Directory of the installed pyodide package (pyodide.mjs, pyodide.asm.wasm, python_stdlib.zip, lock file). */
export function pyodideDir(): string {
  return dirname(fileURLToPath(import.meta.resolve('pyodide')));
}

const MAX_OUTPUT = 64 * 1024;

// Emscripten's NODEFS asks for fs constants through process.binding, which the permission model refuses; hand it the public ones.
const CHILD = `
import { constants } from 'node:fs';
process.binding = (name) => { if (name === 'constants') return { fs: constants }; throw new Error('not available'); };
const dir = process.argv[1];
const input = JSON.parse(await new Promise((resolve) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); }));
let out = '';
const add = (s) => { if (out.length < ${MAX_OUTPUT}) out += s + '\\n'; };
const reply = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
try {
  const { loadPyodide } = await import(dir + '/pyodide.mjs');
  const py = await loadPyodide({ indexURL: dir, jsglobals: {}, stdout: add, stderr: add });
  try {
    py.runPython(input.code);
    reply({ ok: true, stdout: out, version: py.version });
  } catch (e) {
    reply({ ok: false, stdout: out, error: String((e && e.message) || e).slice(-1500), version: py.version });
  }
} catch (e) {
  reply({ ok: false, stdout: '', error: 'Pyodide could not start: ' + String((e && e.message) || e).slice(0, 500), version: 'unavailable' });
}
process.exit(0);
`;

export function runPython(code: string, timeoutMs: number): Promise<PythonResult> {
  return new Promise<PythonResult>((resolve) => {
    let dir: string;
    try {
      dir = pyodideDir();
    } catch (err) {
      return resolve({ ok: false, stdout: '', error: `Pyodide is not installed (${(err as Error).message})`, version: 'unavailable' });
    }
    const cwd = mkdtempSync(join(tmpdir(), 'sb-py-'));
    const env: Record<string, string> = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(process.execPath, [
      '--permission', `--allow-fs-read=${dir}`,
      '--max-old-space-size=512', '--disallow-code-generation-from-strings',
      '--input-type=module', '-e', CHILD, dir,
    ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: PythonResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      rmSync(cwd, { recursive: true, force: true });
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, stdout: '', error: `Timed out after ${timeoutMs / 1000} s`, version: '?' }), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (stdout.length > 4 * MAX_OUTPUT) finish({ ok: false, stdout: '', error: 'The program printed too much.', version: '?' });
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 4000) stderr += d; });
    child.on('error', (e) => finish({ ok: false, stdout: '', error: e.message, version: '?' }));
    child.on('close', () => {
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        finish(JSON.parse(line) as PythonResult);
      } catch {
        const why = stderr.match(/The cause of the fatal error was:\s*\n?(.*)/)?.[1] ?? stderr.trim().split('\n').slice(-3).join(' ');
        finish({ ok: false, stdout: '', error: `Python stopped unexpectedly${why ? `: ${why.slice(0, 300)}` : ''}`, version: '?' });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ code }));
  });
}
