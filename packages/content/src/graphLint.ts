import { parse } from 'mathjs';
import type { MathNode } from 'mathjs';
import { compileExpr } from './expr.ts';

/**
 * Checks of a plotly graph from its data alone, with no model call: what the existing check (does it draw?) lets through.
 * They run at generation, on an author's edit and at export, so they also cover graphs drawn before they existed.
 * The thresholds and the label parser were tuned on the 74 graphs of the four audited books (issue #128).
 */
export interface GraphLintFinding {
  code: string;
  /** A blocking finding keeps a generated or edited graph out of the book until it is redrawn or the author accepts it. */
  severity: 'block' | 'warn';
  /** The trace's name, when the finding is about one trace. */
  trace?: string;
  detail: string;
}

// needs-parametric, placeholder and axis-scale are warnings: on correct textbook graphs they misfire (an isochore on a P-T
// plane, "Seno" with "Coseno", an axis titled "ln k"), and they were never the only rule to catch a bad graph (issue #128).
const BLOCKING = new Set(['duplicate', 'joined-jump', 'invisible', 'label-mismatch', 'point-as-curve', 'all-constant', 'empty']);

type Trace = Record<string, unknown>;
type Point = [unknown, unknown];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const axisTitle = (a: unknown): string => {
  const t = (a as { title?: unknown } | undefined)?.title;
  if (typeof t === 'string') return t;
  const text = (t as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
};
const median = (a: number[]) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const nameOf = (t: Trace) => (typeof t.name === 'string' ? t.name : '');

/** The points of a trace. Without an x array Plotly counts up by 1 from x0, or from 0 (the reader keeps x0 and drops dx). */
function points(t: Trace): Point[] {
  const ys = Array.isArray(t.y) ? (t.y as unknown[]) : [];
  const x0 = isNum(t.x0) ? t.x0 : 0;
  const xs = Array.isArray(t.x) ? (t.x as unknown[]) : ys.map((_, k) => x0 + k);
  return ys.map((y, k) => [xs[k], y]);
}
const finitePoints = (pts: Point[]) => pts.filter((p): p is [number, number] => isNum(p[0]) && isNum(p[1]));

// ---------- formulas written in a label ----------

// Every superscript and subscript formatGraphText writes reads back here (ᵧ also stands for y, as some labels write it).
const SUP: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+', '⁼': '=', '⁽': '(', '⁾': ')',
  'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ⁿ': 'n', 'ᵒ': 'o',
  'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z', 'ᵅ': 'α', 'ᵝ': 'β', 'ᵞ': 'γ', 'ᵟ': 'δ', 'ᶿ': 'θ', 'ᵠ': 'φ', 'ᵡ': 'χ',
};
const SUB: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j',
  'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o', 'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u', 'ᵥ': 'v', 'ₓ': 'x', 'ᵧ': 'y',
};
const SUP_RUN = new RegExp(`[${Object.keys(SUP).join('')}]+`, 'g');
const SUB_CHAR = new RegExp(`[${Object.keys(SUB).join('')}]`, 'g');
const CONSTANTS = new Set(['e', 'pi']);

/** The plain-text maths of a label in mathjs syntax: "x²" becomes "x^(2)", "ln" becomes "log", "0,5" becomes "0.5", "⌊x⌋" becomes "floor(x)". */
export function normaliseLabelFormula(s: string): string {
  let t = s.normalize('NFC')
    .replace(/[−–]/g, '-').replace(/[·×⋅]/g, '*').replace(/π/g, 'pi').replace(/√\s*\(/g, 'sqrt(').replace(/√\s*([a-zA-Z0-9.]+)/g, 'sqrt($1)')
    .replace(/⌊([^⌊⌋]*)⌋/g, 'floor($1)').replace(/⌈([^⌈⌉]*)⌉/g, 'ceil($1)')
    .replace(/log₁₀/g, 'log10').replace(/\bln\b/g, 'log').replace(/\barctan\b/g, 'atan').replace(/\|([^|]+)\|/g, 'abs($1)')
    .replace(/(\d),(\d)/g, '$1.$2');
  t = t.replace(SUP_RUN, (m) => `^(${[...m].map((c) => SUP[c]).join('')})`);
  t = t.replace(SUB_CHAR, (c) => SUB[c]!);
  return t.trim();
}

/** The symbols of an expression that are neither functions nor e and pi, or null when it does not parse. */
function freeSymbols(src: string): Set<string> | null {
  let node: MathNode;
  try { node = parse(src); } catch { return null; }
  const out = new Set<string>();
  node.traverse((n, path, parent) => {
    if (n.type === 'SymbolNode' && !(parent?.type === 'FunctionNode' && path === 'fn')) {
      const name = (n as unknown as { name: string }).name;
      if (!CONSTANTS.has(name)) out.add(name);
    }
  });
  return out;
}

/** The first symbol of an axis title: "Volume V (L)" is V, "Tempo, t (s)" is t. */
function axisVar(title: string): string | null {
  // A subscript reads as its letter, as in a label (normaliseLabelFormula): an axis "aₓ" is the symbol ax of "y = aₓ²".
  const m = /(?:^|[\s,(])([A-Za-zΔθλ](?:[_0-9a-z]{0,3})?)\s*(?:\(|\[|$|,)/u.exec(title.replace(SUB_CHAR, (c) => SUB[c]!).trim());
  return m ? m[1]! : null;
}

/**
 * The parts of a label that may state a formula: a parenthesised aside holding "=" ("Isocora (V = 2)") is a part of its own,
 * and the rest is split at ";", ":", ", ", " con " and " per ". Parentheses without "=" stay, so "y = 2(x+1)" is one formula.
 * An aside that lists several values ("(k = 0,80; A = 2,0; d = 0,10)") gives the parameters of the curve, not the curve.
 */
function labelSegments(name: string): string[] {
  const asides: string[] = [];
  let rest = name;
  for (let m = /\(([^()]*=[^()]*)\)/.exec(rest); m; m = /\(([^()]*=[^()]*)\)/.exec(rest)) {
    if (!/;/.test(m[1]!) && (m[1]!.match(/=/g) ?? []).length === 1) asides.push(m[1]!);
    rest = `${rest.slice(0, m.index)}; ${rest.slice(m.index + m[0].length)}`;
  }
  return [...rest.split(/[;:]|,\s(?=[^\d])|\scon\s|\sper\s/), ...asides];
}

type Claim =
  | { kind: 'fn'; evaluate: (x: number) => number; src: string; alt?: (x: number) => number }
  | { kind: 'const' | 'vline' | 'ray'; value: number; src: string }
  | { kind: 'circle'; value: number; centre: [number, number]; src: string };

/** The centre a label states for a circle: "centro (1, 1)", "center (0,5; 2)", "C(1, -2)". */
function statedCentre(name: string): [number, number] | null {
  const m = /(?:centro|centre|center|\bC)\s*(?:in\s*)?\(\s*(-?\d+(?:[.,]\d+)?)\s*[;,]\s*(-?\d+(?:[.,]\d+)?)\s*\)/i.exec(name.replace(/[−–]/g, '-'));
  return m ? [Number(m[1]!.replace(',', '.')), Number(m[2]!.replace(',', '.'))] : null;
}

/**
 * What a label states about its trace, from its "lhs = rhs" segments whose right side is maths: y = f(x), y constant,
 * x constant, a circle of radius r around a centre the label states, or a ray at angle θ. Prose, parameters ("con K = 60,9")
 * and labels that define several functions are not claims about the curve. A bare "log" is read both ways, natural and
 * decimal, because chemistry and physics write log for log10 ("pH = −log(c)").
 */
export function labelClaims(name: string, xTitle: string, yTitle: string): Claim[] {
  const claims: Claim[] = [];
  const xv = axisVar(xTitle) ?? 'x';
  const lower = name.toLowerCase();
  if ((name.match(/[a-zA-Z]\([^)]*\)\s*=/g) ?? []).length > 1) return claims;
  const circle = /circonferenza|cerchio|circle/.test(lower);
  const centre = statedCentre(name);
  const ray = /semiretta|ray/.test(lower);
  for (const seg of labelSegments(name)) {
    const parts = seg.split('=');
    if (parts.length < 2) continue;
    const lhs = normaliseLabelFormula(parts[0]!).replace(/\s+/g, ' ').trim();
    const lhsSym = lhs.split(' ').at(-1) ?? '';
    // "minimo in x = 0" or "sezione y = 0" name a place, not the curve.
    if (lhs !== lhsSym && !circle && !ray) continue;
    for (const raw of parts.slice(1)) {
      // A trailing unit, bare ("… 2 V") or in parentheses ("… 50*x (N)"), is not part of the formula.
      const toRhs = (text: string) => normaliseLabelFormula(text).replace(/\s*→.*$/, '').replace(/\s+\([^()=]*\)$/, '').replace(/\s+(g|kg|m|s|K|J|W|Pa|L|N|V|atm|mol)$/, '').trim();
      const rhs = toRhs(raw);
      if (!rhs || /[a-zA-Z]{4,}/.test(rhs.replace(/sqrt|log10|log|atan|exp|sin|cos|tan|abs|floor|ceil|cbrt/g, ''))) continue;
      const free = freeSymbols(rhs);
      if (!free) continue;
      const src = seg.trim();
      // "ln" is natural; a "log" the label wrote itself may be either, so its decimal reading is built before "ln" becomes "log".
      const decimal = raw.replace(/\blog\b(?![1₁])/g, 'log10');
      if (free.size === 0) {
        const c = compileExpr(rhs, []);
        if (!c.ok) continue;
        const value = c.evaluate({});
        if (!isNum(value)) continue;
        if (circle && lhsSym === 'r') {
          // Without a stated centre the data cannot be checked: a circle off the x axis is as right as one on it.
          if (centre) claims.push({ kind: 'circle', value, centre, src });
        } else if (ray && /^(θ|theta)$/.test(lhsSym)) claims.push({ kind: 'ray', value, src });
        else if (lhsSym === xv) claims.push({ kind: 'vline', value, src });
        // The left side must name the plotted quantity: y, a function f(...) of a variable, or the y axis symbol. A value at
        // one point such as an initial condition "y(1) = 3" says nothing about the rest of the curve.
        else if (/^[a-zA-Z]{1,2}_?[a-z0-9]?(\(.*[a-zA-Z].*\))?$/.test(lhsSym) && (lhsSym === 'y' || lhsSym.includes('(') || lhsSym === axisVar(yTitle) || lhsSym.startsWith('f'))) claims.push({ kind: 'const', value, src });
      } else if (free.size === 1) {
        const v = [...free][0]!;
        if (v !== xv && v !== 'x') continue;
        const c = compileExpr(rhs, [v]);
        const d = decimal !== raw ? compileExpr(toRhs(decimal), [v]) : null;
        if (c.ok) claims.push({ kind: 'fn', evaluate: (x) => c.evaluate({ [v]: x }), src, ...(d?.ok ? { alt: (x: number) => d.evaluate({ [v]: x }) } : {}) });
      }
    }
  }
  return claims;
}

/** Where the data contradicts a claim, or null when at most 2% of the points do. A claim with two readings fails only when both do. */
function checkClaim(claim: Claim, pts: Point[]): string | null {
  const bad = checkReading(claim, pts);
  if (bad && claim.kind === 'fn' && claim.alt && !checkReading({ kind: 'fn', evaluate: claim.alt, src: claim.src }, pts)) return null;
  return bad;
}

function checkReading(claim: Claim, pts: Point[]): string | null {
  const fin = finitePoints(pts);
  if (fin.length < 2) return null;
  const scale = Math.max(1e-9, ...fin.map(([, y]) => Math.abs(y)));
  let bad = 0;
  let worst = '';
  const miss = (text: string) => { bad++; worst ||= text; };
  for (const [x, y] of fin) {
    if (claim.kind === 'vline') {
      if (Math.abs(x - claim.value) > 1e-6 * Math.max(1, Math.abs(claim.value))) miss(`x=${x} but the label says ${claim.src}`);
    } else if (claim.kind === 'circle') {
      const r = Math.hypot(x - claim.centre[0], y - claim.centre[1]);
      if (Math.abs(r - claim.value) > 1e-3 * claim.value) miss(`point (${x}, ${y}) is at distance ${r.toPrecision(4)}, the label says ${claim.src}`);
    } else if (claim.kind === 'ray') {
      const th = Math.atan2(y, x);
      // atan2 gives (−π, π]: a label's 3π/2 is the same direction as −π/2.
      const turn = 2 * Math.PI;
      const off = Math.abs((((th - claim.value) % turn) + turn + Math.PI) % turn - Math.PI);
      if (Math.hypot(x, y) > 1e-9 && off > 1e-3) miss(`point (${x}, ${y}) has angle ${th.toPrecision(4)}, the label says ${claim.src}`);
    } else {
      const e = claim.kind === 'fn' ? claim.evaluate(x) : claim.value;
      if (!isNum(e)) continue;
      if (Math.abs(y - e) > 1e-4 * Math.max(Math.abs(e), scale * 1e-3, 1e-9)) miss(`at x=${x} the data is ${y}, the label's ${claim.src} gives ${Number(e.toPrecision(6))}`);
    }
  }
  return bad > fin.length * 0.02 ? worst : null;
}

// ---------- the checks ----------

const PRIMITIVES: [string, (x: number) => number][] = [
  ['x', (x) => x], ['x²', (x) => x * x], ['x³', (x) => x ** 3], ['sin x', Math.sin], ['cos x', Math.cos], ['eˣ', Math.exp], ['|x|', Math.abs],
];

/**
 * Lints a graph payload ({ type: 'plotly', config: { data, layout } }). Other graph types (the reader's own "function"
 * graphs) have no sampled data to read and get no findings.
 */
export function lintGraph(payload: Record<string, unknown>): GraphLintFinding[] {
  if (payload.type !== 'plotly') return [];
  const out: GraphLintFinding[] = [];
  const add = (code: string, trace: string | undefined, detail: string) => out.push({ code, severity: BLOCKING.has(code) ? 'block' : 'warn', ...(trace === undefined ? {} : { trace }), detail });
  const cfg = (payload.config && typeof payload.config === 'object' ? payload.config : {}) as { data?: unknown; layout?: unknown };
  const data = (Array.isArray(cfg.data) ? cfg.data : []).filter((t): t is Trace => !!t && typeof t === 'object' && !Array.isArray(t));
  const layout = (cfg.layout && typeof cfg.layout === 'object' ? cfg.layout : {}) as { xaxis?: { type?: unknown; range?: unknown }; yaxis?: { type?: unknown; range?: unknown } };
  const xT = axisTitle(layout.xaxis);
  const yT = axisTitle(layout.yaxis);
  const xLog = layout.xaxis?.type === 'log';
  const yLog = layout.yaxis?.type === 'log';
  const ty = (v: number) => (yLog ? Math.log10(v) : v);
  if (!data.length) { add('empty', undefined, 'the graph has no traces'); return out; }

  // The visible y range: the layout's (as exponents on a log axis), else the data's.
  const allY = data.flatMap((t) => points(t).map(([, y]) => y).filter(isNum));
  const range = layout.yaxis?.range;
  let yr: number[] = Array.isArray(range) && range.length === 2 && range.every(isNum) ? range : [Math.min(...allY), Math.max(...allY)];
  if (yLog && Array.isArray(range)) yr = yr.map((v) => 10 ** v);
  const yspan = Math.max(1e-12, ty(yr[1]!) - ty(yr[0]!));

  const lineTraces = data.filter((t) => (t.type ?? 'scatter') === 'scatter' && /lines/.test(typeof t.mode === 'string' ? t.mode : 'lines+markers'));

  // A trace with the same points as an earlier one hides it.
  for (let i = 0; i < data.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = points(data[i]!);
      const b = points(data[j]!);
      if (a.length !== b.length || a.length < 2) continue;
      const scale = Math.max(1e-12, ...a.map(([, y]) => (isNum(y) ? Math.abs(y) : 0)));
      const same = a.every(([x, y], k) => x === b[k]![0] && ((y === null && b[k]![1] === null) || (isNum(y) && isNum(b[k]![1]) && Math.abs(y - (b[k]![1] as number)) <= 1e-6 * scale)));
      if (same) add('duplicate', nameOf(data[i]!), `same data as "${nameOf(data[j]!)}", so one hides the other`);
    }
  }

  for (const t of lineTraces) {
    const pts = points(t);
    const fin = finitePoints(pts);
    if (fin.length < 2) { add('empty', nameOf(t), 'fewer than two finite points'); continue; }

    // A vertical segment: one step far larger than its neighbours, or a sign flip over half the window, in a y = f(x) trace.
    // The step must also be narrow, under 1% of the trace's x extent: a two-point segment or a hand-drawn heating curve
    // climbs over a wide step on purpose.
    const increasing = fin.every(([x], k) => k === 0 || x > fin[k - 1]![0]);
    const xExtent = fin.at(-1)![0] - fin[0]![0];
    const dy: (number | null)[] = [];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]![1];
      const b = pts[k]![1];
      dy.push(isNum(a) && isNum(b) && (!yLog || (a > 0 && b > 0)) ? Math.abs(ty(b) - ty(a)) : null);
    }
    for (let k = 0; increasing && k < dy.length; k++) {
      const d = dy[k];
      if (d == null) continue;
      const near: number[] = [];
      for (let j = Math.max(0, k - 4); j <= Math.min(dy.length - 1, k + 4); j++) if (j !== k && dy[j] != null) near.push(dy[j]!);
      const a = pts[k]![1] as number;
      const b = pts[k + 1]![1] as number;
      const narrow = Math.abs((pts[k + 1]![0] as number) - (pts[k]![0] as number)) < 0.01 * xExtent;
      const isolated = d > 20 * Math.max(median(near), 1e-12 * yspan);
      const poleFlip = a * b < 0 && d > 0.5 * yspan;
      if (narrow && d > 0.05 * yspan && (isolated || poleFlip)) {
        add('joined-jump', nameOf(t), `vertical segment between x=${String(pts[k]![0])} and x=${String(pts[k + 1]![0])} (Δy=${Number(d.toPrecision(3))}, ${Math.round((100 * d) / yspan)}% of the y range)`);
        break;
      }
    }

    // A trace that looks like a flat line at zero because the axis is sized for the other traces.
    const ys = fin.map(([, y]) => y);
    const own = Math.max(...ys) - Math.min(...ys);
    if (!yLog && lineTraces.length > 1 && own > 1e-9 * yspan && own < 0.02 * yspan && Math.max(...ys.map(Math.abs)) < 0.02 * yspan) {
      add('invisible', nameOf(t), `varies by ${Number(own.toPrecision(3))} on an axis ${Number(yspan.toPrecision(3))} high: it looks like a flat line at zero`);
    }

    for (const c of labelClaims(nameOf(t), xT, yT)) {
      const bad = checkClaim(c, pts);
      if (bad) add('label-mismatch', nameOf(t), bad);
    }
  }

  // Traces on one y axis whose names give different units.
  const unitOf = (n: string) => /\((?:[^()]*\s)?(Pa|m\/s|m|s|J|W|K|°C|V|mmHg|atm|kJ\/mol|kg·m\/s|N|L|mol\/L)\)/.exec(n)?.[1];
  const units = new Set(data.map((t) => unitOf(nameOf(t))).filter(Boolean));
  if (units.size > 1) add('mixed-units', undefined, `one y axis carries ${[...units].join(', ')}`);

  for (const [ax, title, log] of [['x', xT, xLog], ['y', yT, yLog]] as const) {
    if (/logaritm|log scale|log-scale/i.test(title) && !log) add('axis-scale', undefined, `${ax} axis title "${title}" says logarithmic, the axis is linear`);
  }

  // One axis standing for several quantities ("Distanza, forza ... o temperatura", "Velocità / quota").
  const wordy = (p: string) => /[A-Za-zàèéìòù]{5,}/.test(p.replace(/\w+_\w+/g, ''));
  for (const [ax, title] of [['x', xT], ['y', yT]] as const) {
    const slash = title.split(/\s\/\s/);
    if (/\b(oppure|or)\b|,.*\so\s/i.test(title) || (slash.length > 1 && slash.every(wordy))) add('multiplexed-axis', undefined, `${ax} axis "${title}" stands for several quantities`);
  }

  // Shapes a y = f(x) trace cannot draw.
  for (const t of lineTraces) {
    const n = nameOf(t).toLowerCase();
    const xs = points(t).filter(([, y]) => isNum(y)).map(([x]) => x as number);
    const monotone = xs.every((x, k) => k === 0 || x >= xs[k - 1]!);
    if (/^(circonferenza|cerchio|circle|ellisse|ellipse)\b/.test(n) && monotone) add('needs-parametric', nameOf(t), 'a closed curve drawn as y = f(x)');
    if (/isocora|isochor|retta verticale|vertical line/.test(n) && new Set(xs).size > 2) add('needs-parametric', nameOf(t), 'a vertical line drawn as y = f(x)');
    if ((/(valore|value|punto|point|regolarizzat|isolat)[^,]*\b(in|at|a)\s*x\s*=\s*[-\d.]+/.test(n) || /valore regolarizzato|punto isolato/.test(n)) && xs.length > 5) {
      add('point-as-curve', nameOf(t), 'a value at one point drawn as a curve');
    }
  }

  // Every trace a horizontal line: the x axis carries no information.
  const constant = lineTraces.filter((t) => {
    const ys = points(t).map(([, y]) => y).filter(isNum);
    return ys.length > 1 && Math.max(...ys) - Math.min(...ys) <= 1e-9 * Math.max(1, ...ys.map(Math.abs));
  });
  if (lineTraces.length >= 2 && constant.length === lineTraces.length) add('all-constant', undefined, 'every trace is a horizontal line, so the x axis carries no information');

  // Textbook primitives (x, x², sin x, ...) under names that state no formula. One is a fine linear law; two are a made-up graph.
  const hits: { name: string; prim: string }[] = [];
  for (const t of lineTraces) {
    if (/[=()^²³|]|\b(sin|cos|exp|log)\b|\d/.test(nameOf(t))) continue;
    const fin = finitePoints(points(t));
    if (fin.length <= 10) continue;
    const prim = PRIMITIVES.find(([, f]) => [1, 2, 0.5, -1].some((k) => fin.every(([x, y]) => Math.abs(y - k * f(x)) <= 1e-6 * Math.max(1, Math.abs(y)))));
    if (prim) hits.push({ name: nameOf(t), prim: prim[0] });
  }
  if (new Set(hits.map((h) => h.prim)).size >= 2) add('placeholder', undefined, `traces are ${hits.map((h) => `${h.prim} ("${h.name}")`).join(', ')} while their names state no formula`);

  // What the reader shows differently from what the payload says: text it shows as written, and keys it drops.
  const texts: { where: string; trace?: string; text: string }[] = [];
  const title = (v: unknown) => (typeof v === 'string' ? v : typeof (v as { text?: unknown } | undefined)?.text === 'string' ? (v as { text: string }).text : '');
  if (typeof payload.title === 'string') texts.push({ where: 'title', text: payload.title });
  const lay = layout as Record<string, unknown>;
  if (title(lay.title) && title(lay.title) !== payload.title) texts.push({ where: 'title', text: title(lay.title) });
  for (const [where, axis] of [['x axis title', layout.xaxis], ['y axis title', layout.yaxis]] as const) {
    if (title((axis as { title?: unknown } | undefined)?.title)) texts.push({ where, text: title((axis as { title?: unknown }).title) });
    const tt = (axis as { ticktext?: unknown } | undefined)?.ticktext;
    if (Array.isArray(tt)) for (const t of tt) if (typeof t === 'string') texts.push({ where: `${where.slice(0, 6)} tick`, text: t });
  }
  for (const a of Array.isArray(lay.annotations) ? lay.annotations : []) if (typeof (a as { text?: unknown })?.text === 'string') texts.push({ where: 'annotation', text: (a as { text: string }).text });
  for (const t of data) {
    if (nameOf(t)) texts.push({ where: 'label', trace: nameOf(t), text: nameOf(t) });
    for (const x of Array.isArray(t.text) ? t.text : [t.text]) if (typeof x === 'string' && x) texts.push({ where: 'point text', trace: nameOf(t), text: x });
  }
  for (const { where, trace, text } of texts) {
    const raw = RAW_NOTATION.exec(text);
    if (raw) add('raw-notation', trace, `${where} "${text}" shows "${raw[0].trim()}" as written: the reader has no maths in graph text, so write it in Unicode (x², aₓ, √, ·) or in words`);
  }
  for (const t of data) {
    const line = t.line as { dash?: unknown } | undefined;
    if (line && typeof line === 'object' && line.dash !== undefined && line.dash !== 'solid') add('dropped-key', nameOf(t), 'line.dash: the reader draws every line solid');
    if (t.fill !== undefined && t.fill !== 'none') add('dropped-key', nameOf(t), 'fill: the reader draws no filled area, only its outline');
  }
  const dropped = (o: unknown, path: string): void => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (['tickformat', 'exponentformat', 'separators'].includes(k)) add('dropped-key', undefined, `${path}${k}: the reader drops it, so ticks show Plotly's default format (set tickvals and ticktext instead)`);
      else dropped(v, `${path}${k}.`);
    }
  };
  dropped(layout, '');
  for (const [ax, t] of [['x', xT], ['y', yT]] as const) {
    const max = AXIS_TITLE_MAX[ax];
    if ([...t].length > max) add('long-axis-title', undefined, `${ax} axis title "${t}" has ${[...t].length} characters: at phone width (390 px) about ${max} fit`);
  }
  const xv = axisVar(xT);
  if (xv && INDEPENDENT.has(xv)) {
    for (const t of data) {
      const other = otherVariable(nameOf(t), xv);
      if (other) add('axis-variable', nameOf(t), `the label is a function of ${other}, the x axis is ${xv}`);
    }
  }
  return out;
}

/** Notation the reader would show as typed: a power, a short index, sqrt( or an asterisk product. */
const RAW_NOTATION = /\^|_(?:\{|[\p{L}\d]{1,2}(?![\p{L}\d]))|\bsqrt\(|\S\s*\*\s*\S/u;

// shortcut: a character count stands in for the rendered width. On the reader's renders of the four books at 390 px, a
// y axis title of 50 to 55 characters runs from the bottom of the plot to its top edge and one of 51 with brackets and a
// superscript is cut off, while an x axis title of 51 characters uses five sixths of the width. Upgrade by measuring the
// text in the reader's 12 px font.
const AXIS_TITLE_MAX = { x: 60, y: 50 };

/** Letters that name the independent variable of a curve. */
const INDEPENDENT = new Set(['x', 't']);

/**
 * The one variable a label's formula depends on when it is not the x axis variable: "y′ = y/x + x" on a t axis is x.
 * Only when it is unambiguous: one segment "lhs = rhs" whose right side, less the left side's own symbols, has exactly one
 * free symbol, a letter that names an independent variable, and the label never writes the axis variable.
 */
function otherVariable(name: string, axis: string): string | null {
  const plain = normaliseLabelFormula(name);
  if (new RegExp(`(?<![\\p{L}])${axis}(?![\\p{L}])`, 'u').test(plain)) return null;
  for (const seg of labelSegments(name)) {
    const parts = seg.split('=');
    if (parts.length !== 2) continue;
    const lhs = normaliseLabelFormula(parts[0]!).replace(/′/g, '').trim();
    const own = new Set(lhs.match(/\p{L}+/gu) ?? []);
    const free = freeSymbols(normaliseLabelFormula(parts[1]!).replace(/′/g, ''));
    if (!free) continue;
    const rest = [...free].filter((v) => !own.has(v));
    if (rest.length === 1 && INDEPENDENT.has(rest[0]!) && rest[0] !== axis) return rest[0]!;
  }
  return null;
}

/** The key under which an author accepts a finding. It names the code and the trace, so it survives later edits of other traces. */
export const lintKey = (f: GraphLintFinding) => `${f.code}:${f.trace ?? ''}`;

/**
 * The lint as a check entry: it fails on a blocking finding the author has not accepted. Warnings and accepted findings
 * are listed in the detail and do not fail it. `sampled` is for a graph the builder sampled itself (see sampleFunctionGraph).
 */
export function graphLintCheck(payload: Record<string, unknown>, accepted: readonly string[] = [], opts: { sampled?: boolean } = {}): { method: 'lint'; ok: boolean; detail: string; findings: GraphLintFinding[] } {
  // A graph the builder just sampled had every visible step bisected, so a steep continuous curve there is not a joined jump.
  const findings = lintGraph(payload).filter((f) => !(opts.sampled && f.code === 'joined-jump'));
  const open = findings.filter((f) => f.severity === 'block' && !accepted.includes(lintKey(f)));
  const line = (f: GraphLintFinding) => `${f.code}${f.trace ? ` ("${f.trace}")` : ''}: ${f.detail}${f.severity === 'warn' ? ' (warning)' : accepted.includes(lintKey(f)) ? ' (accepted by the author)' : ''}`;
  return { method: 'lint', ok: open.length === 0, detail: findings.length ? findings.map(line).join('; ') : 'No problems in the data.', findings };
}
