import { evalExprAtX } from './safeMathExpr.ts';
import { compileExpr } from './expr.ts';
import { axisSamples, type AxisScale } from './plot.ts';

const SAMPLES = 400;
const READER_CHARS = /^[0-9x+\-*/().^ \t]+$/;

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && (v[0] as number) < (v[1] as number);
}

/**
 * The trace types the reader draws (`TRACE_TYPES` in the reader's plotlySanitize.ts) and the data each needs.
 * "scattergl" is read as "scatter", and a trace with no type is a scatter.
 */
const DATA_KEYS: Record<string, string[]> = { scatter: ['y'], bar: ['y'], histogram: ['x', 'y'], box: ['x', 'y'], pie: ['values'] };

const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/**
 * A plotly graph, read back from its arrays. Only a function curve (a scatter drawn as lines or markers) gets the sampled-curve
 * checks that `sampleFunctionGraph` applies. Other supported traces pass when they hold the data their type needs.
 */
function checkPlotlyGraph(cfg: Record<string, unknown>): { ok: boolean; detail: string } {
  const data = cfg.data;
  if (!Array.isArray(data) || data.length === 0) return { ok: false, detail: 'config.data must hold at least one curve' };
  const layout = (cfg.layout && typeof cfg.layout === 'object' ? cfg.layout : {}) as { xaxis?: { range?: unknown; type?: unknown }; yaxis?: { range?: unknown; type?: unknown } };
  const xLog = layout.xaxis?.type === 'log';
  const yLog = layout.yaxis?.type === 'log';
  // On a log axis Plotly reads the range as exponents, so the visible range in data units is 10^range.
  const viewRange = isRange(layout.yaxis?.range) ? layout.yaxis.range : null;
  const view: [number, number] | null = viewRange && yLog ? [10 ** viewRange[0], 10 ** viewRange[1]] : viewRange;
  const xViewRange = isRange(layout.xaxis?.range) ? layout.xaxis.range : null;
  const xView: [number, number] | null = xViewRange && xLog ? [10 ** xViewRange[0], 10 ** xViewRange[1]] : xViewRange;
  const problems: string[] = [];
  let curves = 0;
  for (const [i, raw] of data.entries()) {
    const name = `data[${i}]`;
    const t = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
    if (!t) { problems.push(`${name}: not a trace object`); continue; }
    const authored = typeof t.type === 'string' ? t.type : 'scatter';
    const type = authored === 'scattergl' ? 'scatter' : authored;
    const keys = DATA_KEYS[type];
    if (!keys) { problems.push(`${name}: trace type "${authored}" is not supported by the reader`); continue; }
    if (!keys.some((k) => nonEmpty(t[k]))) { problems.push(`${name}: a ${authored} trace needs a non-empty ${keys.join(' or ')} array`); continue; }
    const mode = typeof t.mode === 'string' ? t.mode : 'lines+markers';
    if (type !== 'scatter' || !/lines|markers/.test(mode)) continue;
    // A function curve: its y values must be mostly numbers, and some must fall in the visible range.
    curves++;
    // A point a log axis cannot show (zero or negative on that axis) is as good as undefined.
    const ys = t.y as unknown[];
    // Without an x array Plotly uses 0, 1, 2, ... as the coordinates. (A scatter needs a y array, so y is never implicit here.)
    const xsOf: unknown[] = Array.isArray(t.x) ? t.x : ys.map((_, k) => k);
    const finite = ys.filter((y, k): y is number => typeof y === 'number' && Number.isFinite(y) && (!yLog || y > 0) && (!xLog || (typeof xsOf[k] === 'number' && xsOf[k] > 0)));
    if (finite.length < ys.length * 0.5) problems.push(`${name}: undefined on most of the domain${xLog || yLog ? ' (a log axis shows only positive values)' : ''}`);
    else if (view || xView) {
      // A point is on screen when it is inside both ranges. An x that is not a number (a category) has no x range to be outside of.
      const shown = (y: unknown, k: number, inX: boolean) => {
        const x = xsOf[k];
        return typeof y === 'number' && Number.isFinite(y) && (!yLog || y > 0) && (!xLog || (typeof x === 'number' && x > 0))
          && (!view || (y >= view[0] && y <= view[1])) && (!inX || !xView || typeof x !== 'number' || (x >= xView[0] && x <= xView[1]));
      };
      if (view && !ys.some((y, k) => shown(y, k, false))) problems.push(`${name}: never enters the visible range [${view[0]}, ${view[1]}]`);
      else if (xView && !ys.some((y, k) => shown(y, k, true))) problems.push(`${name}: never enters the visible x range [${xView[0]}, ${xView[1]}]`);
    }
  }
  if (problems.length) return { ok: false, detail: problems.join('; ') };
  return { ok: true, detail: curves ? `Checked ${data.length} trace(s), ${curves} curve(s) all defined and visible.` : `Checked ${data.length} trace(s): the data is there.` };
}

/** Checks for graph payloads: evaluates fn over the domain with the reader's expression rules. */
export function checkFunctionGraph(payload: Record<string, unknown>): { ok: boolean; detail: string } {
  // Accept a whole GraficoConfig ({ type, config }) or just its config.
  const cfg = (payload.config && typeof payload.config === 'object' ? payload.config : payload) as Record<string, unknown>;
  if (payload.type === 'plotly') return checkPlotlyGraph(cfg);
  if (payload.type !== undefined && payload.type !== 'function') return { ok: false, detail: `unknown graph type "${String(payload.type)}"` };

  const fns = cfg.functions;
  if (!Array.isArray(fns) || fns.length === 0) return { ok: false, detail: 'config.functions must be a non-empty array' };
  if (!isRange(cfg.xDomain)) return { ok: false, detail: 'config.xDomain must be [min, max] with min < max' };
  const [x0, x1] = cfg.xDomain;
  const yDomain = cfg.yDomain === undefined ? null : isRange(cfg.yDomain) ? cfg.yDomain : 'bad';
  if (yDomain === 'bad') return { ok: false, detail: 'config.yDomain must be [min, max] with min < max' };

  const problems: string[] = [];
  const notes: string[] = [];
  for (const [i, f] of fns.entries()) {
    const fn = (f as { fn?: unknown } | null)?.fn;
    const name = `functions[${i}]`;
    if (typeof fn !== 'string' || !fn.trim()) {
      problems.push(`${name}: fn must be a non-empty string`);
      continue;
    }
    if (!READER_CHARS.test(fn.trim())) {
      const bad = [...new Set(fn.replace(/[0-9x+\-*/().^ \t]/g, '').split(''))].join('');
      problems.push(
        `${name} "${fn}": the reader's evaluator only accepts digits, x, + - * / ^ ( ) and "."; found unsupported characters "${bad}" (function names such as sin() and constants such as pi are not available, and the curve would be empty)`,
      );
      continue;
    }
    let finite = 0;
    let inside = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const x = x0 + (k / (SAMPLES - 1)) * (x1 - x0);
      const y = evalExprAtX(fn, x);
      if (Number.isFinite(y)) {
        finite++;
        if (yDomain && y >= yDomain[0] && y <= yDomain[1]) inside++;
      }
    }
    if (finite === 0) {
      problems.push(`${name} "${fn}": does not evaluate to any number in the reader (check parentheses and write products with *, e.g. 2*x instead of 2x)`);
      continue;
    }
    if (finite / SAMPLES < 0.8) problems.push(`${name} "${fn}": only ${finite}/${SAMPLES} samples are finite (need at least 80%)`);
    if (yDomain && inside === 0) problems.push(`${name} "${fn}": no value falls inside yDomain [${yDomain[0]}, ${yDomain[1]}]`);
    notes.push(`${name} "${fn}": ${finite}/${SAMPLES} finite${yDomain ? `, ${inside} inside yDomain` : ''}`);
  }
  if (problems.length) return { ok: false, detail: problems.join('; ') };
  return { ok: true, detail: notes.join('; ') };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Numeric comparison of two expressions in x over sample points (for solution checks). */
export function numericallyEqual(a: string, b: string, opts: { vars?: string[]; domain?: [number, number] } = {}): { ok: boolean; detail: string } {
  const vars = opts.vars?.length ? opts.vars : ['x'];
  const [lo, hi] = opts.domain ?? [-5, 5];
  if (!(lo < hi)) return { ok: false, detail: 'domain must be [min, max] with min < max' };
  const ea = compileExpr(a, vars);
  if (!ea.ok) return { ok: false, detail: `first expression: ${ea.error}` };
  const eb = compileExpr(b, vars);
  if (!eb.ok) return { ok: false, detail: `second expression: ${eb.error}` };

  const rand = mulberry32(0x5eed);
  const POINTS = 40;
  let compared = 0;
  for (let i = 0; i < POINTS; i++) {
    const scope: Record<string, number> = {};
    for (const v of vars) scope[v] = lo + rand() * (hi - lo);
    const ya = ea.evaluate(scope);
    const yb = eb.evaluate(scope);
    const fa = Number.isFinite(ya);
    const fb = Number.isFinite(yb);
    if (!fa && !fb) continue;
    const at = vars.map((v) => `${v}=${Number(scope[v].toPrecision(6))}`).join(', ');
    if (fa !== fb) return { ok: false, detail: `differ at ${at}: ${fa ? ya : 'undefined'} vs ${fb ? yb : 'undefined'}` };
    compared++;
    const tol = 1e-6 * Math.max(Math.abs(ya), Math.abs(yb)) + 1e-12;
    if (Math.abs(ya - yb) > tol) return { ok: false, detail: `differ at ${at}: ${ya} vs ${yb}` };
  }
  if (compared < 5) return { ok: false, detail: `only ${compared} comparable points in [${lo}, ${hi}]; cannot decide` };
  return { ok: true, detail: `equal at ${compared} points in [${lo}, ${hi}] (relative tolerance 1e-6)` };
}

export interface FunctionGraphSpec {
  id: string;
  title: string;
  functions: { expr: string; label: string }[];
  xDomain: [number, number];
  yDomain: [number, number];
  xLabel: string;
  yLabel: string;
  /** A log axis takes its domain in data units (positive) and is sampled evenly in the exponent. */
  xScale?: AxisScale;
  yScale?: AxisScale;
}

/**
 * The reader's "function" graphs only understand x, digits and + - * / ^, so curves with sin, exp or log would be
 * empty. We sample the functions here instead and ship a "plotly" graph with plain arrays, which the reader renders
 * after its sanitizer. Discontinuities become nulls so the line breaks instead of drawing a vertical jump.
 */
export function sampleFunctionGraph(spec: FunctionGraphSpec, samples = 400): { payload: { id: string; title: string; type: 'plotly'; config: { data: unknown[]; layout: Record<string, unknown> } }; ok: boolean; detail: string } {
  const [x0, x1] = spec.xDomain;
  const [y0, y1] = spec.yDomain;
  const problems: string[] = [];
  // A log axis with a non-positive domain cannot be drawn: report it, and sample the graph on a linear axis so the payload stays coherent.
  const logOk = (scale: AxisScale | undefined, lo: number, hi: number, axis: 'x' | 'y'): AxisScale => {
    if (scale !== 'log') return 'linear';
    if (lo > 0 && hi > lo) return 'log';
    if (hi > lo) problems.push(`The ${axis} domain [${lo}, ${hi}] must be positive on a log axis.`);
    return 'linear';
  };
  const xScale = logOk(spec.xScale, x0, x1, 'x');
  const yScale = logOk(spec.yScale, y0, y1, 'y');
  const ty = yScale === 'log' ? Math.log10 : (v: number) => v;
  const colors = ['#C2410C', '#1D4ED8', '#15803D', '#7C3AED'];
  const data = spec.functions.map((f, i) => {
    const fn = compileExpr(f.expr);
    if (!fn.ok) {
      problems.push(`"${f.expr}" is not a valid expression: ${fn.error}`);
      return null;
    }
    const xs: number[] = [];
    const ys: (number | null)[] = [];
    let finite = 0;
    let inView = 0;
    let prev: number | null = null;
    const span = ty(y1) - ty(y0);
    for (const x of axisSamples(x0, x1, samples, xScale)) {
      let y: number | null = fn.evaluate({ x });
      if (Number.isNaN(y)) y = null;
      // Plotly shows nothing at or below zero on a log axis.
      if (y === null || !Number.isFinite(y) || (yScale === 'log' && y <= 0)) y = null;
      else {
        finite++;
        if (y >= y0 && y <= y1) inView++;
        // A jump larger than the visible range is a discontinuity, not a steep slope.
        if (prev !== null && Math.abs(ty(y) - ty(prev)) > span) { xs.push(x); ys.push(null); }
      }
      prev = y;
      xs.push(Number(x.toPrecision(8)));
      ys.push(y === null ? null : Number(y.toPrecision(8)));
    }
    if (finite < samples * 0.5) problems.push(`"${f.expr}" is undefined on most of [${x0}, ${x1}].`);
    if (inView === 0) problems.push(`"${f.expr}" never enters the visible range [${y0}, ${y1}].`);
    return { type: 'scatter', mode: 'lines', name: f.label, x: xs, y: ys, line: { color: colors[i % colors.length], width: 2.5 } };
  }).filter(Boolean);
  if (x1 <= x0 || y1 <= y0) problems.push('The domain or range is empty.');
  // The reader keeps an axis "type" and "range" (its sanitiser lists both). Plotly reads the range of a log axis as exponents.
  const axis = (title: string, scale: AxisScale, lo: number, hi: number) => (scale === 'log' ? { title, type: 'log', range: [Math.log10(lo), Math.log10(hi)] } : { title, range: [lo, hi] });
  const layout = {
    title: spec.title,
    xaxis: axis(spec.xLabel, xScale, x0, x1),
    yaxis: axis(spec.yLabel, yScale, y0, y1),
    showlegend: spec.functions.length > 1,
  };
  return {
    payload: { id: spec.id, title: spec.title, type: 'plotly', config: { data, layout } },
    ok: problems.length === 0 && data.length > 0,
    detail: problems.length ? problems.join(' ') : `Sampled ${data.length} function(s) at ${samples + 1} points each${xScale === 'log' ? ' (evenly in the exponent of x)' : ''}; all defined and visible.`,
  };
}
