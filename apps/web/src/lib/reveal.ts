interface Span { top: number; bottom: number }

/**
 * How far to scroll down (negative: up) so that `box` sits inside `band`, the part of the window that nothing covers.
 * Nothing when it is already there. A box taller than the band keeps its top in view.
 */
export function revealDelta(box: Span, band: Span): number {
  if (box.top < band.top) return box.top - band.top;
  if (box.bottom > band.bottom) return Math.min(box.bottom - band.bottom, box.top - band.top);
  return 0;
}

/**
 * Scrolls the page just enough to show `el` below the sticky header and above the toast stack, when the toasts cover it.
 * Used where a new item appears that a toast also announces (a new export).
 */
export function revealClear(el: HTMLElement) {
  const gap = 8;
  const box = el.getBoundingClientRect();
  const header = document.querySelector('.sh-bar')?.getBoundingClientRect();
  let bottom = window.innerHeight;
  const toasts = document.querySelector('.ui-toasts');
  if (toasts && toasts.childElementCount > 0) {
    const t = toasts.getBoundingClientRect();
    if (t.left < box.right && t.right > box.left) bottom = Math.min(bottom, t.top);
  }
  const delta = revealDelta(box, { top: (header?.bottom ?? 0) + gap, bottom: bottom - gap });
  if (delta) window.scrollBy({ top: delta, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
