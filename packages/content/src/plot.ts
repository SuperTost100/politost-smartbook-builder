import { z } from 'zod';
import { compileExpr } from './expr.ts';
import { INK_MARKER } from './ink.ts';

/** An axis is linear unless it is logarithmic: then ticks, samples and positions follow the exponent. */
export type AxisScale = 'linear' | 'log';

/** Declarative function plot rendered to SVG deterministically. */
export interface PlotSpec { title?: string; xRange: [number, number]; yRange: [number, number]; xScale?: AxisScale; yScale?: AxisScale; xLabel?: string; yLabel?: string;
  functions: { expr: string; label?: string; domain?: [number, number]; style?: 'solid' | 'dashed' }[];
  points?: { x: number; y: number; label?: string; open?: boolean }[];
  asymptotes?: { kind: 'vertical' | 'horizontal'; value: number; label?: string }[];
  annotations?: { x: number; y: number; text: string }[]; }

const num = z.number().finite();
const range = z.tuple([num, num]).refine(([a, b]) => a < b, { message: 'must be [min, max] with min < max' });
const text = z.string().max(200);

const plotSpecSchema = z.object({
  title: text.optional(),
  xRange: range,
  yRange: range,
  xScale: z.enum(['linear', 'log']).optional(),
  yScale: z.enum(['linear', 'log']).optional(),
  xLabel: text.optional(),
  yLabel: text.optional(),
  functions: z
    .array(
      z.object({
        expr: z.string().min(1).max(400),
        label: text.optional(),
        domain: range.optional(),
        style: z.enum(['solid', 'dashed']).optional(),
      }),
    )
    .max(8),
  points: z.array(z.object({ x: num, y: num, label: text.optional(), open: z.boolean().optional() })).max(100).optional(),
  asymptotes: z.array(z.object({ kind: z.enum(['vertical', 'horizontal']), value: num, label: text.optional() })).max(20).optional(),
  annotations: z.array(z.object({ x: num, y: num, text })).max(30).optional(),
});

export function validatePlotSpec(spec: unknown): { ok: true; spec: PlotSpec } | { ok: false; errors: string[] } {
  const parsed = plotSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(spec)'}: ${i.message}`) };
  }
  const value = parsed.data as PlotSpec;
  const errors: string[] = [];
  for (const [axis, scale, [lo, hi]] of [['xRange', value.xScale, value.xRange], ['yRange', value.yScale, value.yRange]] as const) {
    if (scale === 'log' && lo <= 0) errors.push(`${axis}: must be positive on a log axis, got [${lo}, ${hi}]; use a range such as [1, 1000] or set the scale to "linear"`);
  }
  if (!value.functions.length && !value.points?.length) errors.push('functions: at least one function or point is required');
  value.functions.forEach((f, i) => {
    const c = compileExpr(f.expr, ['x']);
    if (!c.ok) errors.push(`functions.${i}.expr: ${c.error}`);
  });
  return errors.length ? { ok: false, errors } : { ok: true, spec: value };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const W = 640;
const H = 400;
const M = { left: 58, right: 24, top: 38, bottom: 52 };
const X0 = M.left;
const X1 = W - M.right;
const Y0 = M.top;
const Y1 = H - M.bottom;
const COLORS = ['#C2410C', '#1D4ED8', '#15803D'];
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const SAMPLES = 800;

interface Box { x0: number; y0: number; x1: number; y1: number }
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inPlot = (b: Box) => b.x0 >= X0 + 2 && b.x1 <= X1 - 2 && b.y0 >= Y0 + 2 && b.y1 <= Y1 - 2;
/** Rough width of a label in the sans-serif font; enough to keep labels apart and inside the plot. */
const textWidth = (s: string, size: number) => s.length * size * 0.56;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function f2(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function ticks(min: number, max: number, target: number): { values: number[]; step: number } {
  const step = niceStep(max - min, target);
  const values: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  for (let i = first; i * step <= max + step * 1e-9; i++) values.push(Number((i * step).toPrecision(12)));
  return { values, step };
}

function fmtTick(v: number, step: number): string {
  if (Math.abs(v) < step * 1e-9) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-4) return v.toExponential(1).replace('e+', 'e');
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(decimals, 8)).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m));
}

/** The value an axis maps a number through before it is laid out: the number itself, or its exponent. */
const axisTransform = (scale: AxisScale | undefined) => (scale === 'log' ? Math.log10 : (v: number) => v);

/** `n + 1` sample positions from lo to hi: evenly spaced on a linear axis, evenly in the exponent on a log axis. */
export function axisSamples(lo: number, hi: number, n: number, scale: AxisScale | undefined): number[] {
  if (scale !== 'log') return Array.from({ length: n + 1 }, (_, k) => lo + ((hi - lo) * k) / n);
  const a = Math.log10(lo);
  const b = Math.log10(hi);
  return Array.from({ length: n + 1 }, (_, k) => (k === 0 ? lo : k === n ? hi : 10 ** (a + ((b - a) * k) / n)));
}

/** A tick on a log axis at mantissa * 10^exp; `labelled` ticks get a number, the others are light grid lines. */
export interface LogTick { value: number; mantissa: number; exp: number; labelled: boolean }

/** Below this many pixels per decade the minor ticks at 2 to 9 crowd each other, so they are left out. */
const MIN_MINOR_PX = 50;

/**
 * Ticks of a log axis between min and max (both positive). Every power of ten is a labelled tick, thinned to every
 * k-th power when there would be more than `target` labels. Minor ticks at 2 to 9 times a power of ten are added when a
 * decade is at least `MIN_MINOR_PX` wide and no power is skipped. A range that holds fewer than two powers of ten also
 * labels the 2 and 5 positions, so the axis is never a single number.
 */
export function logTicks(min: number, max: number, target: number, pxPerDecade: number): LogTick[] {
  const lo = Math.log10(min);
  const hi = Math.log10(max);
  const e0 = Math.ceil(lo - 1e-9);
  const e1 = Math.floor(hi + 1e-9);
  const every = Math.max(1, Math.ceil((e1 - e0 + 1) / target));
  const sparse = e1 - e0 + 1 < 2;
  const out: LogTick[] = [];
  for (let exp = Math.floor(lo); exp <= Math.ceil(hi); exp++) {
    for (let mantissa = 1; mantissa <= 9; mantissa++) {
      const value = Number((mantissa * 10 ** exp).toPrecision(12));
      if (value < min * (1 - 1e-9) || value > max * (1 + 1e-9)) continue;
      const labelled = (mantissa === 1 && ((exp % every) + every) % every === 0) || (sparse && (mantissa === 2 || mantissa === 5));
      if (labelled || (every === 1 && pxPerDecade >= MIN_MINOR_PX && mantissa > 1)) out.push({ value, mantissa, exp, labelled });
    }
  }
  return out;
}

/** "10" or "2×10" followed by a raised exponent, as SVG text content. A raised tspan works in every renderer, unlike baseline-shift. */
function powerLabel(mantissa: number, exp: number): string {
  return `${mantissa === 1 ? '10' : `${mantissa}×10`}<tspan dy="-4" font-size="8.5">${String(exp).replace('-', '−')}</tspan>`;
}

export function renderPlotSvg(spec: PlotSpec): string {
  const checked = validatePlotSpec(spec);
  if (!checked.ok) throw new Error(`Invalid plot spec: ${checked.errors.join('; ')}`);
  const s = checked.spec;
  const [xmin, xmax] = s.xRange;
  const [ymin, ymax] = s.yRange;
  // Every position goes through these, so points, asymptotes, labels and curves share one transform on a log axis.
  const tx = axisTransform(s.xScale);
  const ty = axisTransform(s.yScale);
  const px = (x: number) => X0 + ((tx(x) - tx(xmin)) / (tx(xmax) - tx(xmin))) * (X1 - X0);
  const py = (y: number) => Y1 - ((ty(y) - ty(ymin)) / (ty(ymax) - ty(ymin))) * (Y1 - Y0);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(s.title ?? 'Plot')}" font-family="${FONT}" ${INK_MARKER}>`);
  out.push(`<title>${esc(s.title ?? 'Plot')}</title>`);
  out.push(`<defs><clipPath id="plot-area"><rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}"/></clipPath></defs>`);

  // grid + tick labels: a tick is a position, its label as SVG text, and whether it is a major (labelled) line
  const axisTicks = (scale: AxisScale | undefined, min: number, max: number, target: number, length: number) => {
    if (scale === 'log') {
      return logTicks(min, max, target, length / (Math.log10(max) - Math.log10(min)))
        .map((t) => ({ value: t.value, label: t.labelled ? powerLabel(t.mantissa, t.exp) : null }));
    }
    const t = ticks(min, max, target);
    return t.values.map((value) => ({ value, label: esc(fmtTick(value, t.step)) }));
  };
  const xTicks = axisTicks(s.xScale, xmin, xmax, 8, X1 - X0);
  const yTicks = axisTicks(s.yScale, ymin, ymax, 6, Y1 - Y0);
  for (const [stroke, major] of [['#E5E7EB', false], ['#D1D5DB', true]] as const) {
    out.push(`<g stroke="${stroke}" stroke-width="1" shape-rendering="crispEdges">`);
    for (const t of xTicks) if ((t.label !== null) === major) out.push(`<line x1="${f2(px(t.value))}" y1="${Y0}" x2="${f2(px(t.value))}" y2="${Y1}"/>`);
    for (const t of yTicks) if ((t.label !== null) === major) out.push(`<line x1="${X0}" y1="${f2(py(t.value))}" x2="${X1}" y2="${f2(py(t.value))}"/>`);
    out.push('</g>');
  }
  out.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="none" stroke="#9CA3AF" stroke-width="1" shape-rendering="crispEdges"/>`);

  // axes through zero when visible
  out.push('<g stroke="#374151" stroke-width="1.5" shape-rendering="crispEdges">');
  if (ymin < 0 && ymax > 0) out.push(`<line x1="${X0}" y1="${f2(py(0))}" x2="${X1}" y2="${f2(py(0))}"/>`);
  if (xmin < 0 && xmax > 0) out.push(`<line x1="${f2(px(0))}" y1="${Y0}" x2="${f2(px(0))}" y2="${Y1}"/>`);
  out.push('</g>');

  out.push(`<g font-size="11" fill="#4B5563">`);
  for (const t of xTicks) if (t.label !== null) out.push(`<text x="${f2(px(t.value))}" y="${Y1 + 16}" text-anchor="middle">${t.label}</text>`);
  for (const t of yTicks) if (t.label !== null) out.push(`<text x="${X0 - 8}" y="${f2(py(t.value) + 4)}" text-anchor="end">${t.label}</text>`);
  out.push('</g>');

  // labels
  if (s.title) out.push(`<text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="600" fill="#111827">${esc(s.title)}</text>`);
  if (s.xLabel) out.push(`<text x="${(X0 + X1) / 2}" y="${H - 12}" text-anchor="middle" font-size="13" fill="#111827">${esc(s.xLabel)}</text>`);
  if (s.yLabel) out.push(`<text transform="translate(16 ${(Y0 + Y1) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="#111827">${esc(s.yLabel)}</text>`);

  // asymptotes
  out.push('<g clip-path="url(#plot-area)" stroke="#6B7280" stroke-width="1.25" stroke-dasharray="6 4" fill="none">');
  for (const a of s.asymptotes ?? []) {
    if (a.kind === 'vertical') {
      if (a.value < xmin || a.value > xmax) continue;
      out.push(`<line x1="${f2(px(a.value))}" y1="${Y0}" x2="${f2(px(a.value))}" y2="${Y1}"/>`);
    } else {
      if (a.value < ymin || a.value > ymax) continue;
      out.push(`<line x1="${X0}" y1="${f2(py(a.value))}" x2="${X1}" y2="${f2(py(a.value))}"/>`);
    }
  }
  out.push('</g>');
  for (const a of s.asymptotes ?? []) {
    if (!a.label) continue;
    if (a.kind === 'vertical' && a.value >= xmin && a.value <= xmax) {
      out.push(`<text x="${f2(px(a.value) + 4)}" y="${Y0 + 12}" font-size="11" fill="#4B5563">${esc(a.label)}</text>`);
    } else if (a.kind === 'horizontal' && a.value >= ymin && a.value <= ymax) {
      out.push(`<text x="${X1 - 4}" y="${f2(py(a.value) - 5)}" text-anchor="end" font-size="11" fill="#4B5563">${esc(a.label)}</text>`);
    }
  }

  // curves
  const yspan = ty(ymax) - ty(ymin);
  const drawn: [number, number][] = [];
  out.push('<g clip-path="url(#plot-area)" fill="none" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round">');
  s.functions.forEach((f, i) => {
    const c = compileExpr(f.expr, ['x']);
    if (!c.ok) return;
    const lo = Math.max(xmin, f.domain?.[0] ?? xmin);
    const hi = Math.min(xmax, f.domain?.[1] ?? xmax);
    if (!(lo <= hi)) return;
    const segs: string[] = [];
    let cur: string[] = [];
    let prevY: number | null = null;
    const flush = () => {
      if (cur.length > 1) segs.push(`M${cur.join('L')}`);
      cur = [];
    };
    for (const x of axisSamples(lo, hi, SAMPLES, s.xScale)) {
      const y = c.evaluate({ x });
      if (!Number.isFinite(y) || (s.yScale === 'log' && y <= 0)) {
        flush();
        prevY = null;
        continue;
      }
      if (prevY !== null && Math.abs(ty(y) - ty(prevY)) > yspan) flush(); // jump across the asymptote
      cur.push(`${f2(px(x))} ${f2(Math.max(-1e5, Math.min(1e5, py(y))))}`);
      drawn.push([px(x), py(y)]);
      prevY = y;
    }
    flush();
    if (!segs.length) return;
    const dash = f.style === 'dashed' ? ' stroke-dasharray="7 5"' : '';
    out.push(`<path d="${segs.join('')}" stroke="${COLORS[i % COLORS.length]}"${dash}/>`);
  });
  out.push('</g>');

  // legend box: in the corner the curves cross least, so it hides as little as possible
  const labelled = s.functions.map((f, i) => ({ f, i })).filter(({ f }) => f.label);
  let legend: Box | null = null;
  if (labelled.length) {
    const w = Math.min(X1 - X0 - 12, Math.max(...labelled.map(({ f }) => textWidth(f.label!, 12))) + 40);
    const h = labelled.length * 16 + 8;
    const corners: Box[] = [
      { x0: X1 - 6 - w, y0: Y0 + 6, x1: X1 - 6, y1: Y0 + 6 + h },
      { x0: X0 + 6, y0: Y0 + 6, x1: X0 + 6 + w, y1: Y0 + 6 + h },
      { x0: X1 - 6 - w, y0: Y1 - 6 - h, x1: X1 - 6, y1: Y1 - 6 },
      { x0: X0 + 6, y0: Y1 - 6 - h, x1: X0 + 6 + w, y1: Y1 - 6 },
    ];
    const crossings = (b: Box) => drawn.filter(([x, y]) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1).length;
    legend = corners.reduce((best, b) => (crossings(b) < crossings(best) ? b : best));
  }

  // points; each label goes beside its point where it stays inside the plot and clear of the other labels and points
  const visible = (s.points ?? []).filter((p) => p.x >= xmin && p.x <= xmax && p.y >= ymin && p.y <= ymax);
  const taken: Box[] = visible.map((p) => ({ x0: px(p.x) - 5, y0: py(p.y) - 5, x1: px(p.x) + 5, y1: py(p.y) + 5 }));
  if (legend) taken.push(legend);
  for (const p of visible) {
    const cx = px(p.x);
    const cy = py(p.y);
    const fill = p.open ? '#FFFFFF' : '#111827';
    out.push(`<circle cx="${f2(cx)}" cy="${f2(cy)}" r="4.5" fill="${fill}" stroke="#111827" stroke-width="1.75"/>`);
    if (!p.label) continue;
    const w = textWidth(p.label, 12);
    const spots = [[cx + 8, cy - 8], [cx - 8 - w, cy - 8], [cx + 8, cy + 18], [cx - 8 - w, cy + 18]].map(([x, y]) => ({ x0: x, y0: y - 11, x1: x + w, y1: y + 3 }));
    const box = spots.find((b) => inPlot(b) && !taken.some((t) => overlaps(b, t))) ?? spots.find(inPlot) ?? spots[0];
    taken.push(box);
    out.push(`<text x="${f2(box.x0)}" y="${f2(box.y1 - 3)}" font-size="12" fill="#111827">${esc(p.label)}</text>`);
  }

  // annotations
  for (const a of s.annotations ?? []) {
    if (a.x < xmin || a.x > xmax || a.y < ymin || a.y > ymax) continue;
    out.push(`<text x="${f2(px(a.x))}" y="${f2(py(a.y))}" font-size="12" fill="#111827">${esc(a.text)}</text>`);
  }

  // legend
  if (legend) {
    let y = legend.y0 + 17;
    out.push('<g font-size="12" fill="#111827">');
    out.push(`<rect x="${f2(legend.x0)}" y="${f2(legend.y0)}" width="${f2(legend.x1 - legend.x0)}" height="${f2(legend.y1 - legend.y0)}" fill="#FFFFFF" fill-opacity="0.92" stroke="#D1D5DB"/>`);
    for (const { f, i } of labelled) {
      const dash = f.style === 'dashed' ? ' stroke-dasharray="5 3"' : '';
      out.push(`<line x1="${f2(legend.x0 + 8)}" y1="${y - 4}" x2="${f2(legend.x0 + 30)}" y2="${y - 4}" stroke="${COLORS[i % COLORS.length]}" stroke-width="2.25"${dash}/>`);
      out.push(`<text x="${f2(legend.x0 + 36)}" y="${y}">${esc(f.label!)}</text>`);
      y += 16;
    }
    out.push('</g>');
  }

  out.push('</svg>');
  return `${out.join('\n')}\n`;
}
