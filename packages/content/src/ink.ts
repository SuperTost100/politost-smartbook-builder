// The ink of the figure drawers and the marker that tells a reader a figure is "transparent, dark ink".
// A figure is shown through <img>, so the page theme cannot reach its colours. A reader that sees the marker
// lights the picture up in dark mode (see docs/ARCHITECTURE.md, "Dark mode").

/** The ink of every drawn figure (plots, chemistry diagrams, structures, drawings). */
export const INK = '#111827';

/** Attribute on the root of a transparent, dark-ink figure. */
export const INK_MARKER = 'data-sb-ink="dark"';

/** True for an SVG with the marker on its root element. */
export function isInkDrawing(svg: string): boolean {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  return /\sdata-sb-ink\s*=\s*["']dark["']/.test(root);
}
