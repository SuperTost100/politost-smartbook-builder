// The schemdraw engine: runs model-written Python that draws with schemdraw 0.23 in the Pyodide the service already
// ships, inside the sandbox of sandbox.ts. Used for logic gates, timing diagrams, Karnaugh maps and as a second option
// for analog circuits.
//
// Offline: schemdraw and its text helpers (ziamath, ziafont, latex2mathml, all pure Python) are wheels from
// `.figure-packages/python`, unpacked into Pyodide's in-memory file system by the child. No micropip, no network.
// Text: `svgconfig.text = 'path'` makes schemdraw draw every label with ziamath, which turns glyphs into SVG paths, so
// the figure needs no system font. Math in `$...$` is typeset with the bundled STIX Two Math, other text with DejaVu Sans.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGURE_PACKAGES_DIR, PYTHON_WHEELS } from '../../../../../scripts/fetch-figure-packages.mjs';
import { pyodideDir } from '../../pipeline/python.ts';
import { runSandboxed } from './sandbox.ts';
import type { CircuitSymbols, DrawingFailure } from './types.ts';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'child', 'python-child.mjs');

/**
 * Defaults for every figure: the SVG backend, text as paths, 12 px labels and 2 px lines like the existing drawers.
 * `symbols` picks the resistor and source style (schemdraw's default is the American zigzag, `STYLE_IEC` is the rectangle).
 * The model's code runs under the file name "<drawing>", so error lines match its own source exactly.
 */
function prelude(symbols: CircuitSymbols): string {
  return `import json, traceback
import schemdraw
import schemdraw.elements as __sb_elm
schemdraw.use('svg')
schemdraw.svgconfig.text = 'path'
schemdraw.config(fontsize=12, lw=2)
${symbols === 'european' ? '__sb_elm.style(__sb_elm.STYLE_IEC)' : ''}

def __sb_render(source):
    g = {'__name__': '__main__'}
    try:
        exec(compile(source, '<drawing>', 'exec'), g)
        d = g.get('d')
        if not isinstance(d, schemdraw.Drawing):
            found = [v for v in g.values() if isinstance(v, schemdraw.Drawing)]
            d = found[-1] if found else None
        if d is None:
            return json.dumps({'ok': False, 'message': 'The code did not create a schemdraw.Drawing. Bind it to the name d: with schemdraw.Drawing(show=False) as d:'})
        return json.dumps({'ok': True, 'svg': d.get_imagedata('svg').decode()})
    except SyntaxError as e:
        return json.dumps({'ok': False, 'line': e.lineno, 'column': e.offset, 'message': 'SyntaxError: ' + str(e.msg)})
    except BaseException as e:
        frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == '<drawing>']
        where = frames[-1] if frames else None
        return json.dumps({'ok': False, 'line': where.lineno if where else None, 'message': ''.join(traceback.format_exception_only(type(e), e)).strip()})
`;
}

export type SchemdrawRaw = { ok: true; svg: string } | DrawingFailure;

export async function compileSchemdraw(source: string, o: { symbols: CircuitSymbols; timeoutMs: number; scratch: string }): Promise<SchemdrawRaw> {
  const dir = pyodideDir();
  const wheels = join(FIGURE_PACKAGES_DIR, 'python');
  const r = await runSandboxed({
    script: CHILD,
    args: [dir, wheels],
    input: { wheels: PYTHON_WHEELS.map((w) => w.file), prelude: prelude(o.symbols), source },
    readPaths: [dir, wheels],
    cwd: o.scratch,
    timeoutMs: o.timeoutMs,
    maxRssBytes: 1024 * 2 ** 20,
  });
  if (r.kind !== 'ok') return { ok: false, kind: r.kind, error: r.message };
  const out = r.output as { ok: boolean; json?: string; error?: string };
  if (!out.ok || !out.json) return { ok: false, kind: 'crash', error: out.error ?? 'Pyodide returned nothing.' };
  const res = JSON.parse(out.json) as { ok: boolean; svg?: string; line?: number | null; column?: number | null; message?: string };
  if (res.ok && res.svg) return { ok: true, svg: res.svg };
  const line = res.line ?? undefined;
  const text = line ? (source.split('\n')[line - 1] ?? '').trim().slice(0, 160) : '';
  const where = line ? `error at line ${line}${res.column ? `, column ${res.column}` : ''}: ` : 'error: ';
  return { ok: false, kind: 'compile', error: `${where}${res.message ?? 'The code failed.'}${line ? `\n  ${line} | ${text}` : ''}`, line, column: res.column ?? undefined };
}
