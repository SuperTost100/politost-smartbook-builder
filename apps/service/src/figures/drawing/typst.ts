// The Typst engine: compiles model-written Typst (CeTZ, zap, fletcher, lilaq, finite) to SVG in a sandboxed child process.
//
// Offline: packages come from `.figure-packages/typst` (see scripts/fetch-figure-packages.mjs). Only the packages marked
// `allowed` there can be imported. The compiler would download any other package from packages.typst.org, so:
//   1. imports are checked before compiling, with the line and column of the offending import (`checkImports`)
//   2. the child gets HOME and the cache variables pointing into the render's own temp folder, and a proxy that refuses
//      every connection, so a download that slips past the check (for example an import path built with `+`) fails with
//      "failed to download package" instead of fetching and running code, and anything it did fetch is deleted with the folder.
// The Node compiler ignores TYPST_PACKAGE_PATH. It looks for packages in the platform's user data folder, so each
// render gets a temp HOME whose data folder holds a link to `.figure-packages/typst` (`linkPackages`).
// Node 24 cannot block the network for a child, so this is a mitigation, not a boundary. See sandbox.ts.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGURE_PACKAGES_DIR, TYPST_PACKAGES } from '../../../../../scripts/fetch-figure-packages.mjs';
import { runSandboxed } from './sandbox.ts';
import type { CircuitSymbols, DrawingFailure } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, 'child', 'typst-child.mjs');

/** Packages a model may import, by name. */
export const TYPST_ALLOWED: Record<string, string> = Object.fromEntries(TYPST_PACKAGES.filter((p) => p.allowed).map((p) => [p.name, p.version]));
const allowedList = () => Object.entries(TYPST_ALLOWED).map(([n, v]) => `@preview/${n}:${v}`).join(', ');

/**
 * Defaults for every figure, in one line so that the model's line numbers shift by exactly one.
 * Transparent page that fits the content, 12 pt text (the existing figures use 11 to 13 px), dark ink, and the
 * text face of the embedded New Computer Modern, which is also the math face. Typst ships no sans-serif.
 */
const PREAMBLE = '#set page(width: auto, height: auto, margin: 6pt, fill: none); #set text(font: "New Computer Modern", size: 12pt, fill: rgb("#111827")); #set par(leading: 0.45em)\n';
const PREAMBLE_LINES = 1;

/**
 * The zap shim: the same package with its defaults changed, so `symbols` and the line weight reach the model's
 * `#circuit(...)` unchanged. zap draws 0.8 pt parts and 0.6 pt wires, thinner than CeTZ's 1 pt, so both are raised to 1.1 pt.
 */
const zapVersion = TYPST_ALLOWED.zap;
const cetzVersion = TYPST_ALLOWED.cetz;
const ZAP_SHIM = (variant: string) => `#import "@preview/zap:${zapVersion}": *
#import "@preview/cetz:${cetzVersion}": draw as _cetz-draw
#let _zap-circuit = circuit
#let circuit(drawing, ..params) = _zap-circuit({
  _cetz-draw.set-ctx(ctx => { ctx.style.zap.variant = "${variant}"; ctx.style.zap.stroke = 1.1pt; ctx.style.zap.wire.stroke = 1.1pt; ctx })
  drawing
}, ..params)
`;
const ZAP_SHIM_FILE = '/_zap.typ';

export interface ImportProblem { line: number; column: number; message: string }

/** Finds the first import of a package outside the allow-list. Line and column are 1-based positions in the model's source. */
export function checkImports(source: string): ImportProblem | null {
  // Any double-quoted string that starts with "@namespace/" is a package path (import, include, or a figure label that quotes one).
  for (const m of source.matchAll(/"(@[A-Za-z][\w-]*\/[^"\n]*)"/g)) {
    const spec = m[1];
    const parsed = spec.match(/^@preview\/([A-Za-z0-9_-]+):(\d+\.\d+\.\d+)$/);
    if (parsed && TYPST_ALLOWED[parsed[1]] === parsed[2]) continue;
    const before = source.slice(0, m.index);
    const line = before.split('\n').length;
    const column = (m.index ?? 0) - (before.lastIndexOf('\n') + 1) + 1;
    const name = parsed?.[1];
    const why = name && TYPST_ALLOWED[name] ? `Version ${parsed[2]} is not installed, use ${TYPST_ALLOWED[name]}.` : 'It is not installed.';
    return { line, column, message: `package "${spec}" is not available. ${why} Packages available offline: ${allowedList()}.` };
  }
  return null;
}

interface Diagnostic {
  severity: number;
  message: string;
  package: string;
  path: string;
  hint?: string;
  range: { start: { line: number; character: number } } | null;
}

const lineOf = (source: string, line: number) => (source.split('\n')[line - 1] ?? '').trim().slice(0, 160);

/** The source line of a package file, for errors that happen inside a package. Empty when it cannot be read. */
function packageSourceLine(pkg: string, path: string, line: number): string {
  const m = pkg.match(/^@preview\/([\w-]+):([\d.]+)$/);
  if (!m || path.includes('..')) return '';
  try {
    return readFileSync(join(FIGURE_PACKAGES_DIR, 'typst', 'preview', m[1], m[2], path), 'utf8').split('\n')[line - 1]?.trim().slice(0, 140) ?? '';
  } catch {
    return '';
  }
}

/**
 * Formats compiler diagnostics for a repair turn. An error inside a package (an assertion in zap, a panic in CeTZ)
 * has its position in the package's own file, which means nothing to the model, so the report points at the first
 * stack entry in the model's source ("while calling opamp") and quotes that line.
 * Some errors have no stack entry in the model's source at all: lilaq and fletcher evaluate parts of a diagram when the
 * page is laid out, after the model's code has returned. Then the report names the package line and the call chain,
 * which tells the model which part of the library it hit.
 */
export function describeDiagnostics(diagnostics: Diagnostic[], userSource: string): { message: string; line?: number; column?: number } {
  const isUser = (d: Diagnostic) => d.package === '' && d.path.endsWith('/main.typ') && d.range !== null;
  const errors = diagnostics.filter((d) => d.severity === 1);
  const main = errors[0] ?? diagnostics[0];
  if (!main) return { message: 'Typst could not compile the drawing and gave no reason.' };
  const position = (d: Diagnostic) => ({ line: d.range!.start.line + 1 - PREAMBLE_LINES, column: d.range!.start.character + 1 });
  let text = tidyMessage(main.message);
  if (main.hint) text += `\nhint: ${main.hint}`;
  let where: { line: number; column: number } | undefined;
  if (isUser(main)) {
    where = position(main);
  } else {
    const call = diagnostics.find((d) => d.severity === 4 && isUser(d));
    if (call) where = position(call);
    if (main.package) {
      text = `inside package ${main.package}: ${text}`;
      if (!where && main.range) {
        const code = packageSourceLine(main.package, main.path, main.range.start.line + 1);
        const chain = diagnostics.filter((d) => d.severity === 4).map((d) => d.message.replace(/^while calling /, '')).slice(0, 4);
        text += `\n  none of your lines is in the error trace. Package code (${main.path.replace(/^\//, '')}, line ${main.range.start.line + 1}): ${code || 'not available'}`;
        if (chain.length) text += `\n  call chain, innermost first: ${chain.join(' < ')}`;
      }
    }
  }
  if (!where || where.line < 1) return { message: `error: ${text}` };
  return { message: `error at line ${where.line}, column ${where.column}: ${text}\n  ${where.line} | ${lineOf(userSource, where.line)}`, ...where };
}

function tidyMessage(message: string): string {
  if (/failed to download package/.test(message)) {
    return `a package is not available offline (${message.replace(/^failed to download package\s*\(?/, '').replace(/\)$/, '').slice(0, 120)}). Packages available offline: ${allowedList()}.`;
  }
  if (/type content does not have a constructor/.test(message)) {
    return `${message}. Inside a zap circuit, "content" means the Typst type. Import cetz's draw module and write draw.content((x, y), [label]).`;
  }
  return message;
}

export type TypstRaw = { ok: true; svg: string } | DrawingFailure;

/** Source file the compiler sees: the defaults, then the model's source with the zap import pointed at the shim. */
export function buildMainSource(source: string): { main: string; usesZap: boolean } {
  const zapImport = new RegExp(`"@preview/zap:${zapVersion.replace(/\./g, '\\.')}"`, 'g');
  const usesZap = zapImport.test(source);
  return { main: PREAMBLE + source.replace(zapImport, `"${ZAP_SHIM_FILE}"`), usesZap };
}

/** Where the compiler looks for installed packages, for a given HOME (and APPDATA on Windows). */
function dataPackagesDir(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'typst', 'packages');
  if (process.platform === 'win32') return join(home, 'typst', 'packages');
  return join(home, '.local', 'share', 'typst', 'packages');
}

function linkPackages(home: string): void {
  const link = dataPackagesDir(home);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(FIGURE_PACKAGES_DIR, 'typst'), link, 'junction');
}

function compilerReadDir(): string {
  const entry = createRequire(import.meta.url).resolve('@myriaddreamin/typst-ts-node-compiler');
  // The package and its platform build (the native addon) sit side by side in node_modules/@myriaddreamin.
  return dirname(dirname(entry));
}
const compilerEntry = () => createRequire(import.meta.url).resolve('@myriaddreamin/typst-ts-node-compiler');

export async function compileTypst(source: string, o: { symbols: CircuitSymbols; timeoutMs: number }): Promise<TypstRaw> {
  const refused = checkImports(source);
  if (refused) return { ok: false, kind: 'compile', error: `error at line ${refused.line}, column ${refused.column}: ${refused.message}\n  ${refused.line} | ${lineOf(source, refused.line)}`, line: refused.line, column: refused.column };

  const dir = mkdtempSync(join(tmpdir(), 'sb-draw-typst-'));
  try {
    const { main, usesZap } = buildMainSource(source);
    linkPackages(dir);
    writeFileSync(join(dir, 'main.typ'), main);
    if (usesZap) writeFileSync(join(dir, ZAP_SHIM_FILE.slice(1)), ZAP_SHIM(o.symbols === 'american' ? 'ieee' : 'iec'));
    const dead = 'http://127.0.0.1:9';
    const r = await runSandboxed({
      script: CHILD,
      args: [compilerEntry(), dir],
      input: { mainFile: join(dir, 'main.typ') },
      readPaths: [join(FIGURE_PACKAGES_DIR, 'typst'), compilerReadDir(), dir],
      writePaths: [dir],
      allowAddons: true,
      cwd: dir,
      env: {
        HOME: dir, XDG_CACHE_HOME: join(dir, 'cache'), LOCALAPPDATA: dir, APPDATA: dir,
        HTTPS_PROXY: dead, HTTP_PROXY: dead, ALL_PROXY: dead, https_proxy: dead, http_proxy: dead, all_proxy: dead, NO_PROXY: '',
      },
      timeoutMs: o.timeoutMs,
      maxRssBytes: 1024 * 2 ** 20,
    });
    if (r.kind !== 'ok') return { ok: false, kind: r.kind, error: r.message };
    const out = r.output as { ok: boolean; svg?: string; diagnostics?: Diagnostic[] };
    if (out.ok && out.svg) return { ok: true, svg: out.svg };
    const d = describeDiagnostics(out.diagnostics ?? [], source);
    return { ok: false, kind: 'compile', error: d.message, line: d.line, column: d.column };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
