import { parse } from 'mathjs';
import { evalExprAtX } from './safeMathExpr.ts';
import { compileExpr } from './expr.ts';
import { axisSamples, type AxisScale } from './plot.ts';
import { GRAPH_PALETTE } from './graphFormat.ts';

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

/** Fewest points of an unbroken run that count as a branch drawn on purpose on part of the x grid. */
const MIN_BRANCH_POINTS = 20;

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
    // Without an x array Plotly counts up by 1 from x0, or from 0. The reader keeps x0 and drops dx, so the step is always 1. (A scatter needs a y array, so y is never implicit here.)
    const x0 = typeof t.x0 === 'number' && Number.isFinite(t.x0) ? t.x0 : 0;
    const xsOf: unknown[] = Array.isArray(t.x) ? t.x : ys.map((_, k) => x0 + k);
    const defined = ys.map((y, k) => typeof y === 'number' && Number.isFinite(y) && (!yLog || y > 0) && (!xLog || (typeof xsOf[k] === 'number' && xsOf[k] > 0)));
    const finite = defined.filter(Boolean);
    // A branch drawn on part of the x grid the traces share (|x| drawn as y = x for x ≥ 0) is undefined on the rest by design,
    // and its points form one unbroken run. Points scattered through the trace, or a run too short to draw, still fail.
    const [first, last] = [defined.indexOf(true), defined.lastIndexOf(true)];
    const branch = first >= 0 && last - first + 1 >= MIN_BRANCH_POINTS && defined.slice(first, last + 1).every(Boolean);
    if (finite.length < ys.length * 0.5 && !branch) problems.push(`${name}: undefined on most of the domain${xLog || yLog ? ' (a log axis shows only positive values)' : ''}`);
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

/**
 * True when f jumps between a and b (a step, a pole, a hole) rather than climbing steeply. The bracket is halved 50 times
 * around its steeper half: a continuous curve's gap shrinks with the bracket, a jump keeps at least a quarter of it.
 */
export function jumpsBetween(f: (x: number) => number, a: number, b: number, fa: number, fb: number): boolean {
  let lo = a;
  let hi = b;
  let flo = fa;
  let fhi = fb;
  const gap = Math.abs(fb - fa);
  for (let k = 0; k < 50; k++) {
    const m = (lo + hi) / 2;
    const fm = f(m);
    if (!Number.isFinite(fm)) return true;
    if (Math.abs(fm - flo) >= Math.abs(fhi - fm)) { hi = m; fhi = fm; } else { lo = m; flo = fm; }
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(a), Math.abs(b))) break;
  }
  return Math.abs(fhi - flo) > 0.25 * gap;
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
 * One trace of a graph spec. `source` is the formula or worked example of the section the trace comes from, copied as the
 * section writes it. Each kind uses its own fields: `fn` and an optional `domain` (y = f(x), on part of the x axis),
 * `xt`, `yt` and `tRange` (a parametric curve), `points` (single values, `open` for a hole), `value` (a vertical line at
 * x = value), `bars` (a few values of distinct cases).
 */
export interface GraphTrace {
  kind: 'function' | 'parametric' | 'points' | 'vline' | 'bars';
  label: string;
  source?: string;
  fn?: string;
  domain?: [number, number];
  xt?: string;
  yt?: string;
  tRange?: [number, number];
  points?: { x: number; y: number; open?: boolean }[];
  value?: number;
  bars?: { category: string; value: number }[];
}

export interface GraphSpec extends Omit<FunctionGraphSpec, 'functions'> {
  traces: GraphTrace[];
}

export type SampledGraph = { payload: { id: string; title: string; type: 'plotly'; config: { data: unknown[]; layout: Record<string, unknown> } }; ok: boolean; detail: string };

/** A graph of functions only: the spec the builder used before typed traces, still used by tests and plots. */
export function sampleFunctionGraph(spec: FunctionGraphSpec, samples = 400): SampledGraph {
  const { functions, ...rest } = spec;
  return sampleGraph({ ...rest, traces: functions.map((f) => ({ kind: 'function', fn: f.expr, label: f.label })) }, samples);
}

/**
 * The reader's "function" graphs only understand x, digits and + - * / ^, so curves with sin, exp or log would be
 * empty. We sample the traces here instead and ship a "plotly" graph with plain arrays, which the reader renders
 * after its sanitizer. Discontinuities become nulls so the line breaks instead of drawing a vertical jump. Every trace
 * kind becomes a scatter (lines or markers) or a bar trace, the only parts of Plotly the reader keeps.
 */
export function sampleGraph(spec: GraphSpec, samples = 400): SampledGraph {
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
  // A value Plotly can show: finite, and positive on a log axis.
  const showable = (v: number, scale: AxisScale) => Number.isFinite(v) && (scale !== 'log' || v > 0);
  const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const r8 = (v: number) => Number(v.toPrecision(8));
  const colors = GRAPH_PALETTE;
  const data = spec.traces.map((t, i) => {
    const color = colors[i % colors.length];
    const line = { type: 'scatter', mode: 'lines', name: t.label };
    if (t.kind === 'function') {
      const fn = compileExpr(t.fn ?? '');
      if (!fn.ok) {
        problems.push(`"${t.fn ?? ''}" is not a valid expression: ${fn.error}`);
        return null;
      }
      const lo = Math.max(x0, t.domain?.[0] ?? x0);
      const hi = Math.min(x1, t.domain?.[1] ?? x1);
      if (!(lo < hi)) {
        problems.push(`"${t.fn}": its domain [${t.domain?.join(', ')}] lies outside the x axis [${x0}, ${x1}].`);
        return null;
      }
      const xs: number[] = [];
      const ys: (number | null)[] = [];
      let finite = 0;
      let visible = 0;
      let prevX: number | null = null;
      let prev: number | null = null;
      const span = ty(y1) - ty(y0);
      // The curve as drawn: on a log y axis the jump test reads the exponent, and a value the axis cannot show is undefined.
      const drawn = (x: number) => {
        const v = fn.evaluate({ x });
        return showable(v, yScale) ? ty(v) : Number.NaN;
      };
      for (const x of axisSamples(lo, hi, samples, xScale)) {
        let y: number | null = fn.evaluate({ x });
        if (Number.isNaN(y) || !showable(y, yScale)) y = null;
        else {
          finite++;
          if (y >= y0 && y <= y1) visible++;
          // A visible step is a jump or a pole only when it survives bisection; a steep continuous curve stays whole.
          if (prev !== null && prevX !== null && Math.abs(ty(y) - ty(prev)) > 0.02 * span && jumpsBetween(drawn, prevX, x, ty(prev), ty(y))) {
            xs.push(r8((prevX + x) / 2));
            ys.push(null);
          }
        }
        prev = y;
        prevX = x;
        xs.push(r8(x));
        ys.push(y === null ? null : r8(y));
      }
      if (finite < samples * 0.5) problems.push(`"${t.fn}" is undefined on most of [${lo}, ${hi}].`);
      if (visible === 0) problems.push(`"${t.fn}" never enters the visible range [${y0}, ${y1}].`);
      return { ...line, x: xs, y: ys, line: { color, width: 2.5 } };
    }
    if (t.kind === 'parametric') {
      const cx = compileExpr(t.xt ?? '', ['t']);
      const cy = compileExpr(t.yt ?? '', ['t']);
      const bad = !cx.ok ? `x(t) "${t.xt ?? ''}": ${cx.error}` : !cy.ok ? `y(t) "${t.yt ?? ''}": ${cy.error}` : !t.tRange || !(t.tRange[0] < t.tRange[1]) ? 'tRange must be [min, max] with min < max' : '';
      if (bad || !cx.ok || !cy.ok || !t.tRange) {
        problems.push(`"${t.label}": ${bad}`);
        return null;
      }
      const [a, b] = t.tRange;
      const xs: (number | null)[] = [];
      const ys: (number | null)[] = [];
      let finite = 0;
      let visible = 0;
      // Each coordinate as drawn, in units of its window, so the jump test of function traces applies to both.
      const tx = xScale === 'log' ? Math.log10 : (v: number) => v;
      const coord = (c: typeof cx, scale: AxisScale, to: (v: number) => number, span: number) => (s: number) => {
        const v = c.ok ? c.evaluate({ t: s }) : Number.NaN;
        return showable(v, scale) ? to(v) / span : Number.NaN;
      };
      const fx = coord(cx, xScale, tx, tx(x1) - tx(x0));
      const fy = coord(cy, yScale, ty, ty(y1) - ty(y0));
      let prev: { s: number; X: number; Y: number } | null = null;
      for (let k = 0; k <= samples; k++) {
        const s = a + ((b - a) * k) / samples;
        const X = cx.evaluate({ t: s });
        const Y = cy.evaluate({ t: s });
        const ok = showable(X, xScale) && showable(Y, yScale);
        if (ok) {
          finite++;
          if (inView(X, Y)) visible++;
          // A pole in t (y = 1/t) breaks the curve as it breaks a function trace.
          const X1 = fx(s); const Y1 = fy(s);
          if (prev && ((Math.abs(X1 - prev.X) > 0.02 && jumpsBetween(fx, prev.s, s, prev.X, X1)) || (Math.abs(Y1 - prev.Y) > 0.02 && jumpsBetween(fy, prev.s, s, prev.Y, Y1)))) {
            xs.push(null);
            ys.push(null);
          }
          prev = { s, X: X1, Y: Y1 };
        } else prev = null;
        xs.push(ok ? r8(X) : null);
        ys.push(ok ? r8(Y) : null);
      }
      if (finite < samples * 0.5) problems.push(`"${t.label}" is undefined for most t in [${a}, ${b}].`);
      else if (visible === 0) problems.push(`"${t.label}" never enters the visible window.`);
      return { ...line, x: xs, y: ys, line: { color, width: 2.5 } };
    }
    if (t.kind === 'points') {
      const pts = (t.points ?? []).filter((p) => showable(p.x, xScale) && showable(p.y, yScale));
      if (!pts.length || pts.length < (t.points ?? []).length) {
        problems.push(`"${t.label}": ${pts.length ? 'some points are not numbers the axes can show' : 'no points'}.`);
        return null;
      }
      if (!pts.some((p) => inView(p.x, p.y))) problems.push(`"${t.label}": no point lies in the visible window.`);
      return { type: 'scatter', mode: 'markers', name: t.label, x: pts.map((p) => p.x), y: pts.map((p) => p.y), marker: { color, size: 9, symbol: pts.map((p) => (p.open ? 'circle-open' : 'circle')) } };
    }
    if (t.kind === 'vline') {
      if (typeof t.value !== 'number' || !showable(t.value, xScale) || t.value < x0 || t.value > x1) {
        problems.push(`"${t.label}": the vertical line needs an x value inside [${x0}, ${x1}].`);
        return null;
      }
      return { ...line, x: [t.value, t.value], y: [y0, y1], line: { color, width: 2.5 } };
    }
    const bars = (t.bars ?? []).filter((b) => b.category.trim() && showable(b.value, yScale));
    if (!bars.length || bars.length < (t.bars ?? []).length) {
      problems.push(`"${t.label}": ${bars.length ? 'some bars have no name or no value the y axis can show' : 'no bars'}.`);
      return null;
    }
    return { type: 'bar', name: t.label, x: bars.map((b) => b.category), y: bars.map((b) => b.value), marker: { color } };
  }).filter(Boolean);
  if (x1 <= x0 || y1 <= y0) problems.push('The domain or range is empty.');
  // The reader keeps an axis "type" and "range" (its sanitiser lists both). Plotly reads the range of a log axis as exponents.
  const axis = (title: string, scale: AxisScale, lo: number, hi: number) => (scale === 'log' ? { title, type: 'log', range: [Math.log10(lo), Math.log10(hi)] } : { title, range: [lo, hi] });
  // Bars sit on a category axis, where Plotly places them at 0, 1, 2, ...: a numeric range would clip them.
  const layout = {
    title: spec.title,
    xaxis: spec.traces.some((t) => t.kind === 'bars') ? { title: spec.xLabel } : axis(spec.xLabel, xScale, x0, x1),
    yaxis: axis(spec.yLabel, yScale, y0, y1),
    showlegend: spec.traces.length > 1,
  };
  const onlyFunctions = spec.traces.every((t) => t.kind === 'function');
  return {
    payload: { id: spec.id, title: spec.title, type: 'plotly', config: { data, layout } },
    ok: problems.length === 0 && data.length > 0,
    detail: problems.length
      ? problems.join(' ')
      : `Sampled ${data.length} ${onlyFunctions ? 'function(s)' : 'trace(s)'}${onlyFunctions ? ` at ${samples + 1} points each` : ''}${xScale === 'log' ? ' (evenly in the exponent of x)' : ''}; all defined and visible.`,
  };
}

/**
 * The quote occurs in the section text, ignoring whitespace, `$` and LaTeX spacing and sizing commands. It must hold maths
 * (a digit, `=`, `\`, `^` or `_`): a word such as "Nernst" or "la reazione" occurs in the section but states no formula.
 */
export function sourceQuoted(source: string, section: string): boolean {
  const norm = (s: string) => s.replace(/\\left|\\right/g, '').replace(/\\[,;:! ]|\s+|\$/g, '');
  const q = norm(source);
  return q.length >= 3 && /[\d=\\^_]/.test(q) && norm(section).includes(q);
}

/**
 * Each trace must quote the formula or example of the section it draws, so a curve the section does not state cannot pass.
 * Two traces quoting the same source with different expressions are reported too: one of them is not what the source says.
 */
export function graphSourceCheck(traces: GraphTrace[], section: string): { ok: boolean; detail: string } {
  const problems: string[] = [];
  const notes: string[] = [];
  const seen = new Map<string, { label: string; expr: string }>();
  for (const t of traces) {
    const source = (t.source ?? '').trim();
    if (!sourceQuoted(source, section)) {
      problems.push(source ? `"${t.label}" quotes "${source}", which the section does not contain` : `"${t.label}" quotes no formula or example of the section`);
      continue;
    }
    const expr = t.kind === 'function' ? t.fn ?? '' : t.kind === 'parametric' ? `${t.xt ?? ''}, ${t.yt ?? ''}` : '';
    const key = source.replace(/\s+/g, '');
    const other = seen.get(key);
    if (other && expr && other.expr && other.expr !== expr) notes.push(`"${t.label}" and "${other.label}" quote the same source with different expressions (warning)`);
    if (!other) seen.set(key, { label: t.label, expr });
  }
  if (problems.length) return { ok: false, detail: [...problems, ...notes].join('; ') };
  return { ok: true, detail: [`Every trace quotes the section.`, ...notes].join(' ') };
}

const FREE_CONSTANTS = ['C', 'C1', 'C2'];

/** Solves the small symmetric system A c = b by Gaussian elimination, or null when it is singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/**
 * Compares the curve an independent checker expects (an expression in x) with a trace's stored points. The expression may
 * use free constants C, C1 and C2 where the section gives no value (an additive constant, a reference level); they are
 * fitted to the data by least squares when the expression is affine in them. A point differs when it is off by more than
 * 1% of the y window. Returns null when there is nothing to compare: no expression, one that does not compile or is not
 * affine in its constants, or fewer than 5 comparable points.
 */
export function compareExpected(expected: string, xs: unknown[], ys: unknown[], yspan: number): { ok: boolean; detail: string; constants: Record<string, number> } | null {
  if (!expected.trim()) return null;
  let names: string[];
  try {
    const used = new Set<string>();
    parse(expected).traverse((n) => { if (n.type === 'SymbolNode') used.add((n as unknown as { name: string }).name); });
    names = FREE_CONSTANTS.filter((c) => used.has(c));
  } catch {
    return null;
  }
  const c = compileExpr(expected, ['x', ...names]);
  if (!c.ok) return null;
  const at = (x: number, values: number[]) => c.evaluate({ x, ...Object.fromEntries(names.map((n, i) => [n, values[i]!])) });
  // A drawn point where the expected curve is undefined is a branch the section does not have: it counts as a difference.
  const pts: [number, number][] = [];
  let undefinedAt: number | null = null;
  let undefinedCount = 0;
  xs.forEach((x, k) => {
    const y = ys[k];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Number.isFinite(at(x, names.map(() => 0)))) pts.push([x, y]);
    else { undefinedCount++; undefinedAt ??= x; }
  });
  if (pts.length < 5) return undefinedCount >= 5 ? { ok: false, detail: `${expected} is undefined at ${undefinedCount} of the ${undefinedCount + pts.length} drawn points, from x=${undefinedAt}`, constants: {} } : null;
  // With constants, y = f0(x) + sum of c_i g_i(x). The basis is read off the expression and checked at c = 2 before fitting.
  let fitted = names.map(() => 0);
  if (names.length) {
    const zero = names.map(() => 0);
    const f0 = pts.map(([x]) => at(x, zero));
    const g = names.map((_, i) => pts.map(([x], k) => at(x, names.map((__, j) => (j === i ? 1 : 0))) - f0[k]!));
    const affine = pts.every(([x], k) => {
      const v = at(x, names.map(() => 2));
      const lin = f0[k]! + 2 * g.reduce((s, gi) => s + gi[k]!, 0);
      return Math.abs(v - lin) <= 1e-6 * Math.max(1, Math.abs(v));
    });
    if (!affine) return null;
    const A = g.map((gi) => g.map((gj) => gi.reduce((s, v, k) => s + v * gj[k]!, 0)));
    const b = g.map((gi) => gi.reduce((s, v, k) => s + v * (pts[k]![1] - f0[k]!), 0));
    const sol = solve(A, b);
    if (!sol) return null;
    fitted = sol;
  }
  let bad = undefinedCount;
  let worst = undefinedAt === null ? '' : `at x=${undefinedAt} the data has a value and ${expected} is undefined`;
  for (const [x, y] of pts) {
    const e = at(x, fitted);
    if (Math.abs(e - y) > 0.01 * yspan + 1e-6 * Math.abs(e)) {
      bad++;
      worst ||= `at x=${x} the data is ${y}, expected ${Number(e.toPrecision(6))}`;
    }
  }
  const constants = names.length ? ` with ${names.map((n, i) => `${n} = ${Number(fitted[i]!.toPrecision(6))}`).join(', ')}` : '';
  const n = pts.length + undefinedCount;
  const values = Object.fromEntries(names.map((name, i) => [name, fitted[i]!]));
  return bad > 0.05 * n
    ? { ok: false, detail: `${bad}/${n} points differ from ${expected}${constants}; ${worst}`, constants: values }
    : { ok: true, detail: `matches ${expected}${constants} at ${n - bad}/${n} points`, constants: values };
}
