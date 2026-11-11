// Turns the raw SVG of a drawing engine into the SVG that is stored in the book, and draws it to PNG.
//
// What the stored SVG looks like:
//   - transparent: no background rectangle, and the engine's default black ink is replaced by INK, the ink of the
//     existing drawers, so the figure is dark ink on whatever the page is (see `isInkDrawing`)
//   - a tight viewBox with a small margin, width and height in user units (1 unit is 1 CSS pixel in the reader)
//   - no scripts, no external references, no embedded raster images, no <text>: every glyph is a path, so the figure
//     looks the same on every device and in every rasteriser
//   - under the 2 MB limit of the reader format
import { Resvg } from '@resvg/resvg-js';
import { assertSafeSvg } from '../../repo/assets.ts';

/** The ink of the existing figure drawers (`diagram.ts`, `plot.ts`). */
export const INK = '#111827';

/** Attribute on the root of a transparent, dark-ink drawing. A reader that shows figures through <img> can sniff it. */
export const INK_MARKER = 'data-sb-ink="dark"';

/** The reader refuses files above this size. */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;
/** The most a drawing may be taller than wide, and wider than tall. A timing diagram is wide, so that side is looser. */
const MAX_TALL = 3;
const MAX_WIDE = 10;

/** Size above which a figure is reported as large, because it slows the reader down. */
export const LARGE_SVG_BYTES = 300 * 1024;

const MARGIN = 4;

/** True for an SVG made by this module: transparent, dark ink, a marker on the root. The reader-side dark mode fix relies on this. */
export function isInkDrawing(svg: string): boolean {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  return /\sdata-sb-ink\s*=\s*["']dark["']/.test(root);
}

export interface NormaliseOptions {
  /** Multiplies every stroke width. Typst draws thinner lines than the existing figures (1 pt against 2 px). */
  strokeScale?: number;
  /** Accessible name, written as the <title> of the figure. */
  title?: string;
}

export type NormaliseResult = { ok: true; svg: string; width: number; height: number; warnings: string[] } | { ok: false; error: string };

const num = (n: number) => String(Math.round(n * 100) / 100);
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Black in the ways engines write it. */
const BLACK = /^(?:#000000|#000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i;

export function normaliseSvg(raw: string, opts: NormaliseOptions = {}): NormaliseResult {
  let body = raw.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const open = body.match(/^<svg\b[^>]*>/i);
  if (!open || !/<\/svg>\s*$/i.test(body)) return { ok: false, error: 'The renderer did not return an SVG image.' };
  body = body.slice(open[0].length).replace(/<\/svg>\s*$/i, '');

  const rejected = rejectReason(body);
  if (rejected) return { ok: false, error: rejected };

  // Ink: attribute values only, so text content and ids are never touched.
  body = body.replace(/\b(fill|stroke|stop-color|color)="([^"]*)"/g, (m, name: string, value: string) => (BLACK.test(value.trim()) ? `${name}="${INK}"` : m));
  body = body.replace(/\bstyle="([^"]*)"/g, (_m, style: string) => `style="${style.replace(/(fill|stroke|color)\s*:\s*(#000000|#000|black)\b/gi, `$1:${INK}`)}"`);
  const scale = opts.strokeScale ?? 1;
  if (scale !== 1) body = body.replace(/\bstroke-width="([0-9.]+)"/g, (_m, w: string) => `stroke-width="${num(Number(w) * scale)}"`);
  // schemdraw writes "stroke-dasharray:-" for a solid line, which is not a valid value.
  body = body.replace(/stroke-dasharray:-;?/g, '');
  // Engines write 6 to 15 decimals. Three are enough at this scale and cut the file by a third on path-heavy figures.
  body = body.replace(/(\d\.\d{3})\d+/g, '$1');
  // Typst writes CSS classes and tool data for its own viewer. None of it is used without the stylesheet.
  body = body.replace(/\s(?:class|data-tid|data-hint|data-width|data-height)="[^"]*"/g, '').replace(/\sxmlns:h5="[^"]*"/g, '');

  const viewBox = open[0].match(/viewBox="([^"]*)"/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const probe = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox?.join(' ') ?? '0 0 1000 1000'}">${body}</svg>`;
  let box: { x: number; y: number; width: number; height: number } | undefined;
  try {
    box = new Resvg(probe).getBBox();
  } catch (e) {
    return { ok: false, error: `The renderer returned an SVG that could not be read (${(e as Error).message}).` };
  }
  if (!box || !(box.width > 0) || !(box.height > 0)) return { ok: false, error: 'The drawing is empty. Draw at least one visible element.' };
  const x = box.x - MARGIN;
  const y = box.y - MARGIN;
  const width = box.width + 2 * MARGIN;
  const height = box.height + 2 * MARGIN;
  // A figure this far from a page's shape cannot be read in a book, and a strip a few units wide would rasterise to millions of rows.
  if (height > MAX_TALL * width || width > MAX_WIDE * height) {
    return { ok: false, error: `The drawing is ${Math.round(width)} by ${Math.round(height)} units, too ${height > width ? 'tall and narrow' : 'wide and flat'} for a book page. Keep the height under ${MAX_TALL} times the width and the width under ${MAX_WIDE} times the height.` };
  }
  const title = opts.title ? `<title>${xmlEscape(opts.title)}</title>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${num(x)} ${num(y)} ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}" role="img" ${INK_MARKER}>${title}${body}</svg>\n`;

  const bytes = Buffer.byteLength(svg);
  if (bytes > MAX_SVG_BYTES) return { ok: false, error: `The drawing is ${Math.round(bytes / 1024)} KB, above the 2 MB limit of the book format. Use fewer points, shorter curves or fewer labels.` };
  try {
    assertSafeSvg(svg);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const warnings = bytes > LARGE_SVG_BYTES ? [`The drawing is ${Math.round(bytes / 1024)} KB. It is allowed, but a plot with fewer points loads faster.`] : [];
  return { ok: true, svg, width, height, warnings };
}

/** Things that must not be in a stored drawing even when `assertSafeSvg` would let them through. */
function rejectReason(body: string): string | null {
  if (/<(?:text|tspan)[\s>]/i.test(body)) return 'The drawing contains <text>, which depends on the fonts of the device. Use the engine in a way that draws text as outlines.';
  if (/<image[\s>]/i.test(body)) return 'The drawing embeds an image. Drawings must be made of lines and shapes only.';
  if (/data:image\//i.test(body)) return 'The drawing embeds an image as data. Drawings must be made of lines and shapes only.';
  return null;
}

/** Draws an SVG to PNG for a vision model. White background, because models see a transparent PNG as black. */
export function svgToPng(svg: string, width = 1000): Buffer {
  // The size is bounded here too, because this function also takes SVG that did not pass through normaliseSvg.
  const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const w = Number(root.match(/\swidth="([\d.]+)"/)?.[1]);
  const h = Number(root.match(/\sheight="([\d.]+)"/)?.[1]);
  const fitTo = w > 0 && h > MAX_TALL * w ? { mode: 'height' as const, value: width * MAX_TALL } : { mode: 'width' as const, value: width };
  const r = new Resvg(svg, { fitTo, background: '#ffffff', font: { loadSystemFonts: false } });
  return Buffer.from(r.render().asPng());
}
