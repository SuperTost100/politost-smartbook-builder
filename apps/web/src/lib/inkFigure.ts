import { useEffect, useState } from 'react';
import { isInkDrawing } from '@smartbuilder/content';

/**
 * Whether an SVG figure is transparent with dark ink (`data-sb-ink="dark"` on its root), so a dark page has to light it up.
 * A figure is shown through <img>, so its colours cannot see the page theme. The answer comes from the SVG text, read once per URL.
 * Older figures with a white background, photos and uploaded images have no marker and are shown as they are.
 * shortcut: the answer is cached for the life of the page, so a figure redrawn in place shows its new look after a reload.
 */
const cache = new Map<string, Promise<boolean>>();

function readMarker(url: string): Promise<boolean> {
  let known = cache.get(url);
  if (!known) {
    known = fetch(url).then((r) => (r.ok ? r.text() : '')).then(isInkDrawing).catch(() => false);
    cache.set(url, known);
  }
  return known;
}

/** Only an SVG can carry the marker, so a file name that is not .svg costs no request. */
export function useInkFigure(filename: string, url: string | undefined): boolean {
  const [ink, setInk] = useState(false);
  useEffect(() => {
    setInk(false);
    if (!url || !/\.svg$/i.test(filename)) return;
    let live = true;
    void readMarker(url).then((m) => { if (live) setInk(m); });
    return () => { live = false; };
  }, [filename, url]);
  return ink;
}
