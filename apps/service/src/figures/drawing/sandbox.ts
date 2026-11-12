// Runs one drawing compile in a child Node process under the permission model.
//
// The source comes from a model that read course material, so it is untrusted. What the flags below give:
//   --permission with --allow-fs-read for the listed folders only and --allow-fs-write for one temporary folder
//   (no --allow-child-process, no --allow-worker, no --allow-wasi, no --allow-inspector)
//   --disallow-code-generation-from-strings, --max-old-space-size, an empty environment except what the caller adds,
//   a wall-clock timeout, a resident-memory cap that is polled while the child runs, and a cap on the reply size.
//
// NOT restricted, same as pipeline/python.ts: network. Node 24's permission model has no network switch.
// Callers add their own mitigation (the Typst renderer allow-lists imports and points the compiler at a dead proxy).
//
// `allowAddons` (needed by the Typst compiler, which is a native addon) gives up the most. The permission model cannot
// confine native code: once an addon is loaded, the file and network flags above no longer limit what the addon does,
// they only limit the JavaScript around it. It is acceptable here because the only native code that runs is the Typst
// compiler, whose own world refuses reads outside the project root and has no write, network or process primitives for
// the source to call (package downloads aside, see typst.ts). The child has an empty environment and no secrets, but it
// does run as the service's user, so a bug in the compiler itself could read what that user can read. Keeping the
// addon in a short-lived child process with a timeout and a memory cap limits the damage to one render.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface SandboxOptions {
  /** Absolute path of a plain .mjs child script. It reads one JSON object from stdin and writes one JSON line to stdout. */
  script: string;
  args?: string[];
  input: unknown;
  readPaths: string[];
  writePaths?: string[];
  allowAddons?: boolean;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Resident memory of the whole child, native allocations included. The V8 heap has its own, lower cap. */
  maxRssBytes: number;
  maxOldSpaceMb?: number;
}

export type SandboxResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'timeout' | 'memory' | 'output' | 'crash'; message: string };

const MAX_REPLY = 16 * 1024 * 1024;
const POLL_MS = 50;

/** The resident size in bytes from the text of /proc/<pid>/status, where the kernel writes it in kB. Unlike statm it does not depend on the page size. */
export function rssFromStatus(status: string): number | null {
  const kb = Number(/^VmRSS:\s*(\d+)\s*kB/m.exec(status)?.[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** Resident set size of a process, or null where this platform has no cheap way to read it. */
export function readRssBytes(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      return rssFromStatus(readFileSync(`/proc/${pid}/status`, 'utf8'));
    } catch {
      return null;
    }
  }
  // shortcut: macOS and Windows have no /proc, so the memory cap is not enforced there, only the timeout and the V8 heap limit. Upgrade by polling `ps -o rss=` (macOS) or `tasklist` (Windows).
  return null;
}

export function runSandboxed(o: SandboxOptions): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...o.env };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const flags = [
      '--permission',
      ...[...o.readPaths, o.script].map((p) => `--allow-fs-read=${p}`),
      ...(o.writePaths ?? []).map((p) => `--allow-fs-write=${p}`),
      ...(o.allowAddons ? ['--allow-addons'] : []),
      `--max-old-space-size=${o.maxOldSpaceMb ?? 512}`,
      '--disallow-code-generation-from-strings',
    ];
    const child = spawn(process.execPath, [...flags, o.script, ...(o.args ?? [])], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.kill('SIGKILL');
      resolve(r);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout', message: `The drawing took longer than ${Math.round(o.timeoutMs / 1000)} s to compile. Simplify it.` }), o.timeoutMs);
    const poll = setInterval(() => {
      const rss = child.pid ? readRssBytes(child.pid) : null;
      if (rss !== null && rss > o.maxRssBytes) finish({ kind: 'memory', message: `The drawing needed more than ${Math.round(o.maxRssBytes / 2 ** 20)} MB of memory to compile. Simplify it, for example with fewer points or smaller loops.` });
    }, POLL_MS);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (stdout.length > MAX_REPLY) finish({ kind: 'output', message: 'The drawing produced too much output.' });
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 4000) stderr += d; });
    child.on('error', (e) => finish({ kind: 'crash', message: e.message }));
    child.on('close', (code, signal) => {
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        finish({ kind: 'ok', output: JSON.parse(line) });
      } catch {
        // A native abort (for example a failed allocation inside the compiler) ends here with no reply.
        const why = stderr.trim().split('\n').find((l) => l.trim()) ?? '';
        finish({ kind: 'crash', message: `The renderer stopped without an answer (${signal ?? `exit code ${code}`})${why ? `: ${why.slice(0, 200)}` : ''}.` });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(o.input));
  });
}
