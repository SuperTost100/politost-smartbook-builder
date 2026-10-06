import { z } from 'zod';
import { compileExpr } from './expr.ts';

/** Declarative function plot rendered to SVG deterministically. */
export interface PlotSpec { title?: string; xRange: [number, number]; yRange: [number, number]; xLabel?: string; yLabel?: string;
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

export function renderPlotSvg(spec: PlotSpec): string {
  const checked = validatePlotSpec(spec);
  if (!checked.ok) throw new Error(`Invalid plot spec: ${checked.errors.join('; ')}`);
  const s = checked.spec;
  const [xmin, xmax] = s.xRange;
  const [ymin, ymax] = s.yRange;
  const px = (x: number) => X0 + ((x - xmin) / (xmax - xmin)) * (X1 - X0);
  const py = (y: number) => Y1 - ((y - ymin) / (ymax - ymin)) * (Y1 - Y0);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(s.title ?? 'Plot')}" font-family="${FONT}">`);
  out.push(`<title>${esc(s.title ?? 'Plot')}</title>`);
  out.push(`<defs><clipPath id="plot-area"><rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}"/></clipPath></defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="#FFFFFF"/>`);

  // grid + tick labels
  const tx = ticks(xmin, xmax, 8);
  const ty = ticks(ymin, ymax, 6);
  out.push('<g stroke="#E5E7EB" stroke-width="1" shape-rendering="crispEdges">');
  for (const v of tx.values) out.push(`<line x1="${f2(px(v))}" y1="${Y0}" x2="${f2(px(v))}" y2="${Y1}"/>`);
  for (const v of ty.values) out.push(`<line x1="${X0}" y1="${f2(py(v))}" x2="${X1}" y2="${f2(py(v))}"/>`);
  out.push('</g>');
  out.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="none" stroke="#9CA3AF" stroke-width="1" shape-rendering="crispEdges"/>`);

  // axes through zero when visible
  out.push('<g stroke="#374151" stroke-width="1.5" shape-rendering="crispEdges">');
  if (ymin < 0 && ymax > 0) out.push(`<line x1="${X0}" y1="${f2(py(0))}" x2="${X1}" y2="${f2(py(0))}"/>`);
  if (xmin < 0 && xmax > 0) out.push(`<line x1="${f2(px(0))}" y1="${Y0}" x2="${f2(px(0))}" y2="${Y1}"/>`);
  out.push('</g>');

  out.push(`<g font-size="11" fill="#4B5563">`);
  for (const v of tx.values) out.push(`<text x="${f2(px(v))}" y="${Y1 + 16}" text-anchor="middle">${esc(fmtTick(v, tx.step))}</text>`);
  for (const v of ty.values) out.push(`<text x="${X0 - 8}" y="${f2(py(v) + 4)}" text-anchor="end">${esc(fmtTick(v, ty.step))}</text>`);
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
  const yspan = ymax - ymin;
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
    for (let k = 0; k <= SAMPLES; k++) {
      const x = lo + ((hi - lo) * k) / SAMPLES;
      const y = c.evaluate({ x });
      if (!Number.isFinite(y)) {
        flush();
        prevY = null;
        continue;
      }
      if (prevY !== null && Math.abs(y - prevY) > yspan) flush(); // jump across the asymptote
      cur.push(`${f2(px(x))} ${f2(Math.max(-1e5, Math.min(1e5, py(y))))}`);
      prevY = y;
    }
    flush();
    if (!segs.length) return;
    const dash = f.style === 'dashed' ? ' stroke-dasharray="7 5"' : '';
    out.push(`<path d="${segs.join('')}" stroke="${COLORS[i % COLORS.length]}"${dash}/>`);
  });
  out.push('</g>');

  // points
  for (const p of s.points ?? []) {
    if (p.x < xmin || p.x > xmax || p.y < ymin || p.y > ymax) continue;
    const fill = p.open ? '#FFFFFF' : '#111827';
    out.push(`<circle cx="${f2(px(p.x))}" cy="${f2(py(p.y))}" r="4.5" fill="${fill}" stroke="#111827" stroke-width="1.75"/>`);
    if (p.label) out.push(`<text x="${f2(px(p.x) + 8)}" y="${f2(py(p.y) - 8)}" font-size="12" fill="#111827">${esc(p.label)}</text>`);
  }

  // annotations
  for (const a of s.annotations ?? []) {
    if (a.x < xmin || a.x > xmax || a.y < ymin || a.y > ymax) continue;
    out.push(`<text x="${f2(px(a.x))}" y="${f2(py(a.y))}" font-size="12" fill="#111827">${esc(a.text)}</text>`);
  }

  // legend
  const labelled = s.functions.map((f, i) => ({ f, i })).filter(({ f }) => f.label);
  if (labelled.length) {
    let y = Y0 + 14;
    out.push('<g font-size="12" fill="#111827">');
    for (const { f, i } of labelled) {
      const dash = f.style === 'dashed' ? ' stroke-dasharray="5 3"' : '';
      out.push(`<line x1="${X1 - 150}" y1="${y - 4}" x2="${X1 - 128}" y2="${y - 4}" stroke="${COLORS[i % COLORS.length]}" stroke-width="2.25"${dash}/>`);
      out.push(`<text x="${X1 - 122}" y="${y}">${esc(f.label!)}</text>`);
      y += 16;
    }
    out.push('</g>');
  }

  out.push('</svg>');
  return `${out.join('\n')}\n`;
}
