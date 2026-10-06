import { evalExprAtX } from './safeMathExpr.ts';
import { compileExpr } from './expr.ts';

const SAMPLES = 400;
const READER_CHARS = /^[0-9x+\-*/().^ \t]+$/;

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && (v[0] as number) < (v[1] as number);
}

/** Checks for graph payloads: evaluates fn over the domain with the reader's expression rules. */
export function checkFunctionGraph(payload: Record<string, unknown>): { ok: boolean; detail: string } {
  // Accept a whole GraficoConfig ({ type, config }) or just its config.
  const cfg = (payload.config && typeof payload.config === 'object' ? payload.config : payload) as Record<string, unknown>;
  if (payload.type === 'plotly') return { ok: true, detail: 'plotly graph: nothing to evaluate' };
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
    const span = y1 - y0;
    for (let k = 0; k <= samples; k++) {
      const x = x0 + ((x1 - x0) * k) / samples;
      let y: number | null = fn.evaluate({ x });
      if (Number.isNaN(y)) y = null;
      if (y === null || !Number.isFinite(y)) y = null;
      else {
        finite++;
        if (y >= y0 && y <= y1) inView++;
        // A jump larger than the visible range is a discontinuity, not a steep slope.
        if (prev !== null && Math.abs(y - prev) > span) { xs.push(x); ys.push(null); }
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
  const layout = {
    title: spec.title,
    xaxis: { title: spec.xLabel, range: [x0, x1] },
    yaxis: { title: spec.yLabel, range: [y0, y1] },
    showlegend: spec.functions.length > 1,
  };
  return {
    payload: { id: spec.id, title: spec.title, type: 'plotly', config: { data, layout } },
    ok: problems.length === 0 && data.length > 0,
    detail: problems.length ? problems.join(' ') : `Sampled ${data.length} function(s) at ${samples + 1} points each; all defined and visible.`,
  };
}
