// Runs model-written MATLAB examples with numbl, the interpreter the reader uses, inside a locked-down child process.
//
// Same boundary as python.ts: a separate Node process under the permission model, reading only the numbl and fflate
// packages, no writes, no child processes, workers, addons or inspector, no `eval`, 512 MB, an empty environment and cwd,
// and a SIGKILL timeout. numbl runs without its JIT (optimization '0'), which would need `new Function`, so the reader
// can keep 'unsafe-eval' out of its CSP and this check runs what the student will run. Network is not restricted, as in
// python.ts: Node 24's permission model has no switch for it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATLAB_SHIMS } from './matlabShims.ts';

export interface MatlabResult { ok: boolean; stdout: string; error?: string; figures: number }

const MAX_OUTPUT = 64 * 1024;
const MAIN_FILE = 'laboratorio.m';

/** numbl's library entry and the package folders the child may read. */
function numblPaths(): { lib: string; readable: string[] } {
  const lib = fileURLToPath(import.meta.resolve('numbl'));
  const packageRoot = (file: string, name: string) => file.slice(0, file.lastIndexOf(`${sep}node_modules${sep}${name}${sep}`) + `${sep}node_modules${sep}${name}`.length);
  const fflate = createRequire(lib).resolve('fflate');
  return { lib, readable: [packageRoot(lib, 'numbl'), packageRoot(fflate, 'fflate')] };
}

const CHILD = `
const [lib] = process.argv.slice(1);
const input = JSON.parse(await new Promise((resolve) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); }));
let out = '';
const reply = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// numbl logs which linear algebra backend it picked; that is not the program's output.
console.error = () => {};
try {
  const { executeCode } = await import(lib);
  const plotTypes = new Set(['plot', 'line', 'bar', 'barh']);
  let instructions = [];
  try {
    const r = executeCode(input.code, {
      onOutput: (s) => { if (out.length < ${MAX_OUTPUT}) out += s; },
      onDrawnow: (p) => { instructions = instructions.concat(p); },
      displayResults: true, optimization: '0', implicitCwdPath: null,
    }, input.files, ${JSON.stringify(MAIN_FILE)});
    instructions = instructions.concat(r.plotInstructions);
    const figures = new Set(); let figure = 0;
    for (const i of instructions) {
      if (i.type === 'set_figure_handle') figure = i.handle;
      else if (plotTypes.has(i.type)) figures.add(figure);
      else if (i.type === 'clf' || i.type === 'close') figures.delete(figure);
      else if (i.type === 'close_all') figures.clear();
    }
    reply({ ok: true, stdout: out, figures: figures.size });
  } catch (e) {
    const where = typeof e?.line === 'number' ? (e.file && e.file !== ${JSON.stringify(MAIN_FILE)} ? ' (in ' + e.file + ', line ' + e.line + ')' : ' at line ' + e.line) : '';
    reply({ ok: false, stdout: out, error: (e?.name === 'SyntaxError' ? 'Syntax error' : 'Error') + where + ': ' + String(e?.message ?? e).slice(0, 1500), figures: 0 });
  }
} catch (e) {
  reply({ ok: false, stdout: '', error: 'numbl could not start: ' + String(e?.message ?? e).slice(0, 500), figures: 0 });
}
process.exit(0);
`;

export function runMatlab(code: string, timeoutMs: number): Promise<MatlabResult> {
  return new Promise<MatlabResult>((resolve) => {
    let paths: ReturnType<typeof numblPaths>;
    try {
      paths = numblPaths();
    } catch (err) {
      return resolve({ ok: false, stdout: '', error: `numbl is not installed (${(err as Error).message})`, figures: 0 });
    }
    const cwd = mkdtempSync(join(tmpdir(), 'sb-m-'));
    const env: Record<string, string> = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(process.execPath, [
      '--permission', ...paths.readable.map((p) => `--allow-fs-read=${p}`),
      '--max-old-space-size=512', '--disallow-code-generation-from-strings',
      '--input-type=module', '-e', CHILD, paths.lib,
    ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: MatlabResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      rmSync(cwd, { recursive: true, force: true });
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, stdout: '', error: `Timed out after ${timeoutMs / 1000} s`, figures: 0 }), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (stdout.length > 4 * MAX_OUTPUT) finish({ ok: false, stdout: '', error: 'The program printed too much.', figures: 0 });
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 4000) stderr += d; });
    child.on('error', (e) => finish({ ok: false, stdout: '', error: e.message, figures: 0 }));
    child.on('close', () => {
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        finish(JSON.parse(line) as MatlabResult);
      } catch {
        const why = stderr.trim().split('\n').slice(-3).join(' ');
        finish({ ok: false, stdout: '', error: `MATLAB stopped unexpectedly${why ? `: ${why.slice(0, 300)}` : ''}`, figures: 0 });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ code, files: MATLAB_SHIMS }));
  });
}
