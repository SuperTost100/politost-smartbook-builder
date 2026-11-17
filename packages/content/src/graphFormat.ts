import { langOf } from './lint.ts';

/**
 * Formats a graph payload in code, so it reads right in the reader without asking a model. The reader shows Plotly text as
 * plain text (no LaTeX, and its sanitiser strips every `<…>` span), drops `line.dash`, `fill`, `tickformat`,
 * `exponentformat` and `separators`, and keeps `tickvals` and `ticktext`. So every text a student sees gets Unicode maths
 * and the book's decimal separator, repeated colours are reassigned, and axes that would show SI suffixes or a log axis
 * get explicit ticks in the book's number format. Data, ranges and tickvals are never changed, and formatting a formatted
 * payload changes nothing.
 */
export interface GraphFormatOptions {
  /** The book's language code: an Italian book writes 1,5 for 1.5 in labels. */
  language?: string;
}

/**
 * Trace colours for both reader themes: each has a contrast of at least 3:1 against the light page (#fbf8f2) and the dark
 * page (#312a25), so a line stays visible in either.
 */
export const GRAPH_PALETTE = ['#EA580C', '#3B82F6', '#16A34A', '#8B5CF6', '#DB2777', '#0891B2', '#D97706'] as const;

const SUP: Record<string, string> = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ',
  s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', α: 'ᵅ', β: 'ᵝ', γ: 'ᵞ', δ: 'ᵟ', θ: 'ᶿ', φ: 'ᵠ', χ: 'ᵡ',
};
const SUB: Record<string, string> = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  β: 'ᵦ', γ: 'ᵧ', ρ: 'ᵨ', φ: 'ᵩ', χ: 'ᵪ',
};
/** Characters already written as a superscript or subscript: they count as the end of an operand. */
const SCRIPTS = new Set([...Object.values(SUP), ...Object.values(SUB), '′', '″']);

const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
/** Function names a minus may stand before, as in "−cos x". */
const FUNCTIONS = /^(?:sin|cos|tan|cot|log|ln|exp|arcsin|arccos|arctan|sinh|cosh|tanh|sen|tg)$/;

/** The text between the bracket at `open` and its partner, or null when it is not closed. */
function balanced(s: string, open: number): { inner: string; end: number } | null {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const close = pairs[s[open]!];
  if (!close) return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === s[open]) depth++;
    else if (s[i] === close && --depth === 0) return { inner: s.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

/** The script form of a text, or null when a character has none. A digit before a letter is a product: 2*t is ²ᵗ. */
function toScript(text: string, map: Record<string, string>): string | null {
  const t = text.replace(/\s+/g, '').replace(/(\d)[*·](?=\p{L})/gu, '$1');
  if (!t) return null;
  let out = '';
  for (const c of t) {
    const m = map[c];
    if (!m) return null;
    out += m;
  }
  return out;
}

/** `name(…)` to a bracket pair: floor(x) is ⌊x⌋. Only a name that is not the end of a longer word. */
function wrapCalls(s: string, name: string, open: string, close: string): string {
  let out = '';
  let i = 0;
  for (let k = s.indexOf(`${name}(`); k >= 0; k = s.indexOf(`${name}(`, i)) {
    const b = isLetter(s[k - 1]) ? null : balanced(s, k + name.length);
    if (!b) { out += s.slice(i, k + name.length); i = k + name.length; continue; }
    out += `${s.slice(i, k)}${open}${b.inner}${close}`;
    i = b.end;
  }
  return out + s.slice(i);
}

/** x^2 → x², e^(2t) → e²ᵗ, x^{-1} → x⁻¹. An exponent with no superscript form stays, except e^(…), which becomes exp(…). */
function superscripts(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const k = s.indexOf('^', i);
    if (k < 0) break;
    out += s.slice(i, k);
    let exp: string | null = null;
    let end = k + 1;
    const next = s[k + 1];
    const group = next === '(' || next === '{' ? balanced(s, k + 1) : null;
    if (group) {
      exp = group.inner;
      end = group.end;
    } else {
      const m = /^[+−-]?(?:\d+(?:[.,]\d+)?|[A-Za-zα-ω](?![\p{L}\d]))/u.exec(s.slice(k + 1));
      if (m) { exp = m[0]; end = k + 1 + m[0].length; }
    }
    const script = exp === null ? null : toScript(exp, SUP);
    if (script !== null) {
      out += script;
      i = end;
    } else if (group && next === '(' && out.endsWith('e') && !isLetter(out.at(-2)) && !isDigit(out.at(-2))) {
      // e^(−0,25·Δχ²) has no superscript form; exp(…) reads the same and is plain text.
      out = `${out.slice(0, -1)}exp(${group.inner})`;
      i = end;
    } else {
      out += '^';
      i = k + 1;
    }
  }
  return out + s.slice(i);
}

/**
 * a_x → aₓ, F_s,MAX → Fₛ,MAX, CO_2 → CO₂, x_{12} → x₁₂. Digits always have a subscript form. Letters are a subscript only
 * after a one-letter symbol (a word with an underscore is not maths) and only up to three of them: a longer subscript is a
 * word, written better as text.
 */
function subscripts(s: string): string {
  return s.replace(/_(\{[^{}]*\}|\d+|[A-Za-zα-ω]+)/gu, (whole, sub: string, at: number) => {
    const before = s.slice(0, at);
    if (sub.startsWith('{')) return toScript(sub.slice(1, -1), SUB) ?? whole;
    if (/^\d+$/.test(sub)) return isLetter(before.at(-1)) || before.endsWith(')') ? toScript(sub, SUB)! : whole;
    // One symbol: a letter not preceded by another, or preceded by Δ, ∂ or ∇ (ΔT_eb).
    const symbol = /(?:^|[^\p{L}\d])[Δ∂∇]?\p{L}$/u.test(before) || /^[Δ∂∇]?\p{L}$/u.test(before);
    if (!symbol || sub.length > 3) return whole;
    return toScript(sub, SUB) ?? whole;
  });
}

const ELEMENTS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo '
  + 'Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra '
  + 'Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr').split(' '));
const MOLECULES = new Set(['H2', 'N2', 'O2', 'O3', 'F2', 'Cl2', 'Br2', 'I2']);

/**
 * Chemical formulas written with plain digits: H2O → H₂O, CH3COOH → CH₃COOH. A word counts only when it parses as element
 * symbols with counts and names at least two elements (or is a common molecule such as O2), so T1, E8 or C1 stay.
 */
function chemistry(s: string): string {
  return s.replace(/(?<![\p{L}\d_])[A-Z][A-Za-z\d]*\d[A-Za-z\d]*(?![\p{L}\d])/gu, (word) => {
    const parts = [...word.matchAll(/([A-Z][a-z]?)(\d*)/g)];
    if (parts.map((p) => p[0]).join('') !== word || !parts.every((p) => ELEMENTS.has(p[1]!))) return word;
    if (parts.length < 2 && !MOLECULES.has(word)) return word;
    return parts.map((p) => p[1]! + (p[2] ? toScript(p[2], SUB)! : '')).join('');
  });
}

/** Whether the character at i ends an operand: a digit, a closing bracket, a script, or a one-letter symbol. */
function operandEndsAt(s: string, i: number): boolean {
  const c = s[i];
  if (c === undefined) return false;
  if (isDigit(c) || c === ')' || c === ']' || c === '|' || c === '⌋' || c === '⌉' || SCRIPTS.has(c) || c === '̄') return true;
  return isLetter(c) && !isLetter(s[i - 1]);
}

/** Whether an operand starts at i: a digit, an opening bracket, √, π, a symbol of one or two letters, or a function name. */
function operandStartsAt(s: string, i: number): boolean {
  const c = s[i];
  if (c === undefined) return false;
  if (isDigit(c) || '([|√π∞⌊⌈'.includes(c)) return true;
  if (!isLetter(c)) return false;
  const word = /^\p{L}+/u.exec(s.slice(i))![0];
  return word.length <= 2 || FUNCTIONS.test(word);
}

/** A hyphen used as a minus becomes −: x^3-x, = -x, (x-0.5). A hyphen inside a word (sovra-esponenziale) stays. */
function minus(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '-' || s[i - 1] === '-' || s[i + 1] === '-') { out += s[i]; continue; }
    let l = i - 1;
    while (s[l] === ' ') l--;
    let r = i + 1;
    while (s[r] === ' ') r++;
    const right = operandStartsAt(s, r);
    const binary = operandEndsAt(s, l) && right;
    const unary = right && r === i + 1 && (l < 0 || /[\s(=,;:[{]/.test(s[i - 1]!));
    out += binary || unary ? '−' : '-';
  }
  return out;
}

/** 2*x → 2x, y*(y-1) → y·(y-1). Only between two operands, so an asterisk in prose stays. */
function products(s: string): string {
  return s.replace(/\s*\*\s*/g, (m, at: number) => {
    const l = at - 1;
    const r = at + m.length;
    if (!operandEndsAt(s, l) || !operandStartsAt(s, r)) return m;
    // A number before a one-letter symbol is written by juxtaposition, as in a book: 2x, 0,5x².
    const oneLetter = isLetter(s[r]) && !isLetter(s[r + 1]);
    return isDigit(s[l]) && oneLetter ? '' : '·';
  });
}

/** A number after one of these words is a reference to the book (esempio 7.2), not a decimal. */
const REFERENCE = /(?:esempi[oa]?|esercizi[oa]?|sezione|capitolo|paragrafo|par\.|cap\.|fig\.|figura|tabella|tab\.|eq\.|equazione|formula|teorema|definizione|osservazione|es\.|example|exercise|section|chapter|figure|table)\s*$/i;

/** Decimal points become commas in an Italian book: 1.5 → 1,5, and a pair (1.5, 2) → (1,5; 2) so the comma stays readable. */
function decimalCommas(s: string): string {
  const pairs = s.replace(/([([])(\s*[−-]?\d+(?:\.\d+)?(?:\s*,\s*[−-]?\d+(?:\.\d+)?)+\s*)([)\]])/g, (m, open: string, inner: string, close: string, at: number) =>
    inner.includes('.') && !REFERENCE.test(s.slice(0, at)) ? `${open}${inner.split(/\s*,\s*/).join('; ')}${close}` : m);
  return pairs.replace(/(?<![\p{L}\d.,_^])(\d+)\.(\d+)(?!\d|[.,]\d)/gu, (m, a: string, b: string, at: number) => (REFERENCE.test(pairs.slice(0, at)) ? m : `${a},${b}`));
}

/**
 * The reader strips every `<…>` span, so "ΔH < 0, ΔS > 0" would lose "< 0, ΔS >". HTML the label meant goes first
 * (<sup>2</sup> becomes ², <br> a space, other tags are dropped as the reader drops them); then, when a `<` is still followed
 * by a `>`, the signs become words. A lone < or > survives the reader and stays.
 */
function angleBrackets(s: string, it: boolean): string {
  let t = s
    .replace(/<sup>([^<>]*)<\/sup>/gi, (m, x: string) => toScript(x, SUP) ?? `^(${x})`)
    .replace(/<sub>([^<>]*)<\/sub>/gi, (m, x: string) => toScript(x, SUB) ?? `_{${x}}`)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:b|i|u|em|strong|span|small|big|font|a|p|div|sup|sub)(?:\s[^<>]*)?\/?>/gi, '');
  if (!/<[^>]*>/.test(t)) return t;
  const [lt, gt] = it ? ['minore di', 'maggiore di'] : ['less than', 'greater than'];
  t = t.replace(/\s*<\s*/g, ` ${lt} `).replace(/\s*>\s*/g, ` ${gt} `);
  return t.trim();
}

/**
 * Formats one text a student sees: a label, a title, an axis title, a point's text, a tick text. Nested notation (e^(x^2),
 * floor(floor(x))) needs a pass per level, so passes repeat until the text stops changing.
 */
export function formatGraphText(text: string, opts: GraphFormatOptions = {}): string {
  let out = text;
  for (let pass = 0; pass < 5; pass++) {
    const next = formatOnce(out, opts);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Accepted lint keys ("code:trace name") also under the trace name the formatter gives, so formatting keeps an acceptance. */
export function formatLintKeys(keys: readonly string[], opts: GraphFormatOptions = {}): string[] {
  return [...new Set(keys.flatMap((k) => {
    const at = k.indexOf(':');
    return at < 0 || at === k.length - 1 ? [k] : [k, `${k.slice(0, at)}:${formatGraphText(k.slice(at + 1), opts)}`];
  }))];
}

function formatOnce(text: string, opts: GraphFormatOptions): string {
  if (!text) return text;
  const it = langOf(opts.language) === 'it';
  // A URL is left exactly as written.
  return text.split(/(\bhttps?:\/\/\S+|\bwww\.\S+)/).map((part, k) => {
    if (k % 2) return part;
    let s = part
      .replace(/<=>/g, '⇔').replace(/<->/g, '↔').replace(/->/g, '→').replace(/=>/g, '⇒').replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/!=/g, '≠');
    s = angleBrackets(s, it);
    s = s.replace(/(\S)\*\*(?=\S)/g, '$1^');
    s = wrapCalls(wrapCalls(wrapCalls(s, 'floor', '⌊', '⌋'), 'ceil', '⌈', '⌉'), 'abs', '|', '|');
    s = s.replace(/(?<!\p{L})sqrt\(/gu, '√(');
    s = superscripts(s);
    s = subscripts(s);
    // T1(x) → T₁(x): a one-letter function name with a number is an index.
    s = s.replace(/(?<![\p{L}\d])([A-Za-z])(\d{1,2})(?=\()/gu, (m, f: string, n: string) => f + toScript(n, SUB)!);
    s = chemistry(s);
    s = s.replace(/√\(([A-Za-z]|\d+)\)/g, '√$1');
    s = products(s);
    s = minus(s);
    if (it) s = decimalCommas(s);
    return s;
  }).join('');
}

// ---------- colours ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function traceColor(t: Obj): string | null {
  const line = isObj(t.line) ? t.line.color : undefined;
  const marker = isObj(t.marker) ? t.marker.color : undefined;
  const c = typeof line === 'string' ? line : typeof marker === 'string' ? marker : null;
  return c ? c.trim().toLowerCase() : null;
}

/** Plotly draws a scatter with lines unless its mode leaves them out; Plotly's own default mode includes them. */
const drawsLines = (t: Obj) => (t.type ?? 'scatter') === 'scatter' && (typeof t.mode !== 'string' || t.mode.includes('lines'));
const markersOnly = (t: Obj) => (t.type ?? 'scatter') === 'scatter' && typeof t.mode === 'string' && !t.mode.includes('lines') && t.mode.includes('markers');

function finitePoints(t: Obj): [number, number][] {
  const ys = Array.isArray(t.y) ? t.y : [];
  const xs = Array.isArray(t.x) ? t.x : ys.map((_, k) => (isNum(t.x0) ? t.x0 : 0) + k);
  return ys.map((y, k) => [xs[k], y] as [unknown, unknown]).filter((p): p is [number, number] => isNum(p[0]) && isNum(p[1]));
}

/** The y of a line trace at x, read between its sampled points, or null outside it. */
function yAt(pts: [number, number][], x: number): number | null {
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1]!;
    const [x1, y1] = pts[k]!;
    if ((x - x0) * (x - x1) <= 0) return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return null;
}

/**
 * Whether two traces of one colour are meant as one: one curve drawn in pieces (one ends where the other starts), or
 * points marked on the one line of that colour they lie on (an example on its curve). Anything else in one colour reads as
 * one curve when it is not.
 */
function meantAsOne(a: Obj, b: Obj, lines: Obj[], ySpan: number, xSpan: number): boolean {
  if (drawsLines(a) && drawsLines(b)) {
    const [pa, pb] = [finitePoints(a), finitePoints(b)];
    if (!pa.length || !pb.length) return false;
    const range = (p: [number, number][]) => [Math.min(...p.map((q) => q[0])), Math.max(...p.map((q) => q[0]))];
    const [[a0, a1], [b0, b1]] = [range(pa), range(pb)];
    const touch = 0.02 * xSpan;
    return Math.abs(a1! - b0!) <= touch || Math.abs(b1! - a0!) <= touch;
  }
  const [line, points] = drawsLines(a) && markersOnly(b) ? [a, b] : drawsLines(b) && markersOnly(a) ? [b, a] : [null, null];
  if (!line || !points) return false;
  const tol = 0.02 * ySpan;
  const on = (l: Obj) => {
    const lp = finitePoints(l);
    const pp = finitePoints(points);
    return pp.length > 0 && pp.every(([x, y]) => { const v = yAt(lp, x); return v !== null && Math.abs(v - y) <= tol; });
  };
  return on(line) && lines.filter((l) => l !== line && on(l)).length === 0;
}

/** A colour as r, g, b (0 to 255), from #rgb, #rrggbb, rgb() or rgba(); null for anything else (a name, an array). */
function rgb(c: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join('') : hex[1]!;
    return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)) as [number, number, number];
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c.trim());
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}

/** How far apart two colours look, as the "redmean" weighting of the RGB distance; Infinity when one cannot be read. */
function colorDistance(a: string, b: string): number {
  const [p, q] = [rgb(a), rgb(b)];
  if (!p || !q) return Infinity;
  const r = (p[0] + q[0]) / 2;
  const [dr, dg, db] = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db);
}

function setColor(t: Obj, from: string, to: string) {
  for (const key of ['line', 'marker', 'textfont']) {
    const part = t[key];
    if (isObj(part) && typeof part.color === 'string' && part.color.trim().toLowerCase() === from) part.color = to;
  }
}

/** Gives a palette colour to each trace that repeats the colour of an earlier one without being meant as the same curve. */
function distinctColors(data: Obj[]) {
  const pts = data.flatMap(finitePoints);
  if (!pts.length) return;
  const span = (v: number[]) => Math.max(1e-12, Math.max(...v) - Math.min(...v));
  const ySpan = span(pts.map((p) => p[1]));
  const xSpan = span(pts.map((p) => p[0]));
  const lines = data.filter(drawsLines);
  const alone = (t: Obj) => t.showlegend === false;
  for (let j = 1; j < data.length; j++) {
    const b = data[j]!;
    const color = traceColor(b);
    if (!color) continue;
    const clash = data.slice(0, j).some((a) => traceColor(a) === color && !alone(a) && !alone(b)
      && !(typeof a.legendgroup === 'string' && a.legendgroup === b.legendgroup) && !meantAsOne(a, b, lines, ySpan, xSpan));
    if (!clash) continue;
    // The palette colour farthest from every colour the graph already shows: the first free one could be a shade of the clash.
    const used = data.map(traceColor).filter((c): c is string => !!c && !!rgb(c));
    const free = GRAPH_PALETTE.map((c) => ({ c, d: Math.min(...used.map((u) => colorDistance(c, u))) })).sort((p, q) => q.d - p.d)[0];
    if (!free || free.d <= 0) continue;
    setColor(b, color, free.c);
    // Points marked on this curve, and its other pieces, keep its colour.
    for (const c of data.slice(j + 1)) if (traceColor(c) === color && meantAsOne(b, c, lines, ySpan, xSpan)) setColor(c, color, free.c);
  }
}

// ---------- ticks ----------

const SUP_DIGITS = (n: number) => String(n).replace(/-/g, '−').split('').map((c) => (c === '−' ? '⁻' : SUP[c]!)).join('');

/** A number in the book's format: 100 000 and 0,5 in Italian, 100,000 and 0.5 in English, − for minus. */
function formatNumber(v: number, it: boolean, decimals: number, group = false): string {
  const [int, frac] = Math.abs(v).toFixed(decimals).split('.');
  const grouped = group && int!.length > 3 ? int!.replace(/\B(?=(\d{3})+(?!\d))/g, it ? ' ' : ',') : int!;
  const text = frac && /[1-9]/.test(frac) ? `${grouped}${it ? ',' : '.'}${frac.replace(/0+$/, '')}` : grouped;
  return v < 0 && text !== '0' ? `−${text}` : text;
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw * (1 - 1e-9)) ?? 10) * mag;
}

function decimalsOf(step: number): number {
  for (let d = 0; d < 12; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
  return 12;
}

/** Ticks of a linear axis whose values Plotly would write with SI suffixes (400k, 1µ). */
function linearTicks(lo: number, hi: number, it: boolean): { vals: number[]; text: string[] } | null {
  const m = Math.max(Math.abs(lo), Math.abs(hi));
  if (!(m >= 1e4 || (m > 0 && m < 1e-2)) || !(hi > lo)) return null;
  const step = niceStep(hi - lo, 5);
  const vals: number[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  const count = Math.floor(hi / step + 1e-9) - first;
  // A range far narrower than its magnitude ([1e16, 1e16 + 2]) has no steps that floating point can tell apart.
  if (!Number.isFinite(count) || count < 1 || count > 20) return null;
  for (let i = 0; i <= count; i++) vals.push(Number(((first + i) * step).toPrecision(12)));
  if (new Set(vals).size !== vals.length) return null;
  // Up to a million the digits fit; beyond, and below 0.01, the ticks share a power of ten: 2,5·10⁻⁶.
  // The digits of every tick are grouped, so 5000 and 10 000 on one axis read alike.
  if (m < 1e6 && m >= 1e4) return { vals, text: vals.map((v) => formatNumber(v, it, decimalsOf(step), true)) };
  const e = Math.floor(Math.log10(m));
  const scaled = step / 10 ** e;
  return { vals, text: vals.map((v) => (v === 0 ? '0' : `${formatNumber(v / 10 ** e, it, decimalsOf(Number(scaled.toPrecision(12))))}·10${SUP_DIGITS(e)}`)) };
}

/** Ticks of a log axis from lo to hi (exponents): powers of ten over three decades or more, else 1, 2, 5 times a power. */
function logTicks(lo: number, hi: number, it: boolean): { vals: number[]; text: string[] } | null {
  if (!(hi > lo)) return null;
  const power = (n: number) => (n === 0 ? '1' : n === 1 ? '10' : `10${SUP_DIGITS(n)}`);
  if (hi - lo >= 3) {
    const every = Math.ceil((hi - lo) / 8);
    const ns: number[] = [];
    for (let n = Math.ceil(lo); n <= Math.floor(hi); n++) if (n % every === 0) ns.push(n);
    return { vals: ns.map((n) => Number((10 ** n).toPrecision(12))), text: ns.map(power) };
  }
  const vals: number[] = [];
  for (let n = Math.floor(lo); n <= Math.ceil(hi); n++) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** n).toPrecision(12));
      if (Math.log10(v) >= lo - 1e-9 && Math.log10(v) <= hi + 1e-9) vals.push(v);
    }
  }
  return { vals, text: vals.map((v) => formatNumber(v, it, Math.max(0, -Math.floor(Math.log10(v))))) };
}

/** Sets tickvals and ticktext on an axis that would show SI suffixes or is logarithmic, unless the author set ticks. */
function axisTicks(axis: Obj, values: number[], it: boolean) {
  if (axis.tickvals !== undefined || axis.type === 'category' || axis.type === 'date') return;
  const range = Array.isArray(axis.range) && axis.range.length === 2 && axis.range.every(isNum) ? (axis.range as number[]) : null;
  if (axis.type === 'log') {
    const pos = values.filter((v) => v > 0).map(Math.log10);
    const [lo, hi] = range ?? (pos.length ? [Math.min(...pos), Math.max(...pos)] : [0, 0]);
    const ticks = logTicks(Math.min(lo!, hi!), Math.max(lo!, hi!), it);
    if (ticks && ticks.vals.length >= 2) Object.assign(axis, { tickvals: ticks.vals, ticktext: ticks.text });
    return;
  }
  const [lo, hi] = range ?? (values.length ? [Math.min(...values), Math.max(...values)] : [0, 0]);
  const ticks = linearTicks(Math.min(lo!, hi!), Math.max(lo!, hi!), it);
  if (ticks && ticks.vals.length >= 2) Object.assign(axis, { tickvals: ticks.vals, ticktext: ticks.text });
}

// ---------- the payload ----------

function formatTitle(holder: Obj, key: string, f: (s: string) => string) {
  const t = holder[key];
  if (typeof t === 'string') holder[key] = f(t);
  else if (isObj(t) && typeof t.text === 'string') t.text = f(t.text);
}

/**
 * Formats a graph payload ({ type: 'plotly', config: { data, layout } }, or the reader's own 'function' graph, whose labels
 * are formatted the same way). Returns a new object; the input is not changed.
 */
export function formatGraphPayload<T extends Record<string, unknown>>(payload: T, opts: GraphFormatOptions = {}): T {
  const out = structuredClone(payload) as Obj;
  const it = langOf(opts.language) === 'it';
  const f = (s: string) => formatGraphText(s, opts);
  formatTitle(out, 'title', f);
  const config = isObj(out.config) ? out.config : null;
  if (!config) return out as T;
  if (out.type === 'function') {
    if (Array.isArray(config.functions)) for (const fn of config.functions) if (isObj(fn) && typeof fn.label === 'string') fn.label = f(fn.label);
    for (const key of ['xLabel', 'yLabel']) if (typeof config[key] === 'string') config[key] = f(config[key] as string);
    return out as T;
  }
  const data = (Array.isArray(config.data) ? config.data : []).filter(isObj);
  const layout = isObj(config.layout) ? config.layout : null;
  for (const t of data) {
    if (typeof t.name === 'string') t.name = f(t.name);
    if (typeof t.text === 'string') t.text = f(t.text);
    else if (Array.isArray(t.text)) t.text = t.text.map((x) => (typeof x === 'string' ? f(x) : x));
  }
  distinctColors(data);
  if (layout) {
    formatTitle(layout, 'title', f);
    if (Array.isArray(layout.annotations)) for (const a of layout.annotations) if (isObj(a) && typeof a.text === 'string') a.text = f(a.text);
    for (const [key, coord] of [['xaxis', 'x'], ['yaxis', 'y']] as const) {
      const axis = layout[key];
      if (!isObj(axis)) continue;
      formatTitle(axis, 'title', f);
      if (Array.isArray(axis.ticktext)) axis.ticktext = axis.ticktext.map((x) => (typeof x === 'string' ? f(x) : x));
      // Bars stand on categories, whatever their values: the x axis of a bar chart is not a number line.
      if (coord === 'x' && data.some((t) => t.type === 'bar' && t.orientation !== 'h')) continue;
      if (coord === 'y' && data.some((t) => t.type === 'bar' && t.orientation === 'h')) continue;
      const values = data.flatMap((t) => (Array.isArray(t[coord]) ? (t[coord] as unknown[]) : [])).filter(isNum);
      axisTicks(axis, values, it);
    }
  }
  return out as T;
}

/** The changes formatGraphPayload makes, one line each: the path, the old value and the new one. */
export function graphPayloadDiff(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  const show = (v: unknown) => {
    const s = JSON.stringify(v) ?? 'undefined';
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
  };
  const walk = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (isObj(a) && isObj(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path ? `${path}.${key}` : key);
      return;
    }
    // A text array (point texts, tick texts) is compared item by item; a number array (data, tickvals) is shown whole.
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.some((x) => isObj(x) || typeof x === 'string')) {
      a.forEach((x, k) => {
        const name = isObj(x) && typeof x.name === 'string' ? ` "${x.name}"` : '';
        walk(x, b[k], `${path}[${k}]${name}`);
      });
      return;
    }
    out.push(`${path}: ${show(a)} → ${show(b)}`);
  };
  walk(before, after, '');
  return out;
}
