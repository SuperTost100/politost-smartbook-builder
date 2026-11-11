// Drawn figures, the half without a model: turns drawing source code into a clean SVG, or into an error that a model can repair from.
//
//   const r = await renderDrawing({ engine: 'typst', source, symbols: 'european', title: 'Inverting amplifier' });
//   if (r.ok) store(r.svg);                        // transparent, dark ink, no <text>, tight viewBox, under 2 MB
//   else retry(r.error);                           // r.kind says why, r.line and r.column point into `source`
//   const png = rasterizeDrawing(r.svg, 1000);     // for a vision model, white background
//
// Engines
//   'typst'      Typst 0.14 through @myriaddreamin/typst-ts-node-compiler. The source is ordinary Typst without the page and
//                text setup, which the wrapper adds as its first line (so line numbers in errors are the model's own).
//                Packages it may import, offline and pinned: see TYPST_ALLOWED. Anything else fails before compiling.
//                CeTZ for general drawing, zap for circuits, fletcher for block diagrams and state machines, lilaq for
//                plots, finite for automata, cetz-plot as a second plot library. Wavy is not offered: it embeds an inner SVG
//                whose text is a font name, so timing diagrams go through schemdraw.
//   'schemdraw'  Python source that creates `with schemdraw.Drawing(show=False) as d:` and draws into it. Runs in Pyodide.
//                Logic gates, timing diagrams (logic.TimingDiagram), Karnaugh maps (logic.Kmap), analog circuits, flow charts.
//
// `symbols` ('american' zigzag resistor, 'european' rectangle, default 'american', like the book option) is applied by the wrapper in both
// engines, so the model does not write it. It changes circuit parts only.
//
// What the caller can rely on in `r.svg`
//   - no <text>, <image>, <script>, external reference or font dependence, and it passed `assertSafeSvg`
//   - no background: the ink is `INK` (#111827) and the page behind it shows through. `isInkDrawing(svg)` is true. The reader
//     shows it on a light plate in both themes, so dark ink stays readable (see docs/ARCHITECTURE.md, "Dark mode")
//   - 12 px text and 1.5 to 2 px lines at its natural width, which is the weight of the existing figure drawers
//   - `r.warnings` lists soft limits, for example a file above 300 KB
//
// Failure kinds: 'compile' is the model's fault and `error` is written for the next repair turn (position, message, the
// offending line). 'timeout', 'memory', 'output' and 'crash' mean the drawing was too heavy or the engine died, so the
// same advice applies: simplify. 'setup' means `npm run figure-packages` has not run, which a model cannot fix.
//
// Each render is a new child process under Node's permission model (see sandbox.ts for what that does and does not give).
// A render takes about 0.2 s for Typst and 2 s for schemdraw, most of it Pyodide starting. At most MAX_PARALLEL_RENDERS run at once; the others wait.
// The model half is illustrator.ts, which calls this.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderSlots } from '../../llm/slots.ts';
import { missingFigurePackages } from '../../../../../scripts/fetch-figure-packages.mjs';
import { compileSchemdraw } from './schemdraw.ts';
import { INK, MAX_SVG_BYTES, isInkDrawing, normaliseSvg, svgToPng } from './svg.ts';
import { compileTypst } from './typst.ts';
import type { CircuitSymbols, DrawingEngine, DrawingFailure, DrawingRequest, DrawingResult } from './types.ts';

export type { CircuitSymbols, DrawingEngine, DrawingFailure, DrawingFailureKind, DrawingRequest, DrawingResult, DrawingSuccess } from './types.ts';
export { TYPST_ALLOWED } from './typst.ts';
export { INK, MAX_SVG_BYTES, isInkDrawing };

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Renders running at once, across every caller. Each one is a child process that uses a CPU core (schemdraw for about
 * 2 s), and sections drafted at the same time, fixes and the figures pass all draw. The wait for a slot is not part of a
 * render's timeout.
 */
export const MAX_PARALLEL_RENDERS = 2;
const renderSlots = new ProviderSlots(() => MAX_PARALLEL_RENDERS);

/** Typst draws 1 pt lines where the existing drawers use 2 px, so strokes are scaled once here. */
const TYPST_STROKE_SCALE = 1.6;

/** Whether the pinned packages are installed. A false result lists what is missing; `npm run figure-packages` fixes it. */
export function drawingPackagesStatus(): { ready: boolean; missing: string[] } {
  const missing = missingFigurePackages();
  return { ready: missing.length === 0, missing };
}

export async function renderDrawing(req: DrawingRequest): Promise<DrawingResult> {
  const release = await renderSlots.acquire('render');
  try {
    return await renderNow(req);
  } finally {
    release();
  }
}

async function renderNow(req: DrawingRequest): Promise<DrawingResult> {
  const started = Date.now();
  const status = drawingPackagesStatus();
  if (!status.ready) return { ok: false, kind: 'setup', error: `The figure packages are not installed (${status.missing.length} missing). Run "npm run figure-packages" once, with a network connection.` };
  if (!req.source.trim()) return { ok: false, kind: 'compile', error: 'The drawing source is empty.' };
  const symbols: CircuitSymbols = req.symbols ?? 'american';
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let raw: { ok: true; svg: string } | DrawingFailure;
  if (req.engine === 'typst') {
    raw = await compileTypst(req.source, { symbols, timeoutMs });
  } else {
    const scratch = mkdtempSync(join(tmpdir(), 'sb-draw-py-'));
    try {
      raw = await compileSchemdraw(req.source, { symbols, timeoutMs, scratch });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (!raw.ok) return raw;
  const n = normaliseSvg(raw.svg, { strokeScale: req.engine === 'typst' ? TYPST_STROKE_SCALE : 1, title: req.title });
  if (!n.ok) return { ok: false, kind: 'compile', error: n.error };
  return { ok: true, svg: n.svg, width: n.width, height: n.height, engine: req.engine satisfies DrawingEngine, warnings: n.warnings, renderMs: Date.now() - started };
}

/** PNG of a stored drawing for a vision model: about 1000 px wide, white background. Synchronous, about 30 ms. */
export function rasterizeDrawing(svg: string, width = 1000): Buffer {
  return svgToPng(svg, width);
}
