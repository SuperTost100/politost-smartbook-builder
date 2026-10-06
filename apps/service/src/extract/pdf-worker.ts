// Runs inside a worker_thread: all CPU-bound mupdf work lives here so the API event loop stays free.
// Keep this file free of non-erasable TypeScript syntax (enums, parameter properties).
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { classifyPage, cleanText, repairAccents } from './quality.ts';
import { locateSpan } from './match.ts';
import type { WorkerJob, ExtractedPdf, RenderedPage, OutlineFlat } from './pdf-types.ts';

mupdf.setLog(null);

const { job, flag } = workerData as { job: WorkerJob; flag: Int32Array };
const cancelled = () => Atomics.load(flag, 0) !== 0;

function openPdf(file: string): mupdf.Document {
  const doc = mupdf.Document.openDocument(readFileSync(file), 'application/pdf');
  if (doc.needsPassword()) throw new Error('This PDF is password protected. Remove the password and upload it again.');
  return doc;
}

function flattenOutline(doc: mupdf.Document): OutlineFlat[] {
  const out: OutlineFlat[] = [];
  let items: ReturnType<mupdf.Document['loadOutline']> = null;
  try { items = doc.loadOutline(); } catch { items = null; }
  const total = doc.countPages();
  const walk = (list: NonNullable<typeof items>, level: number) => {
    for (const it of list) {
      let page = typeof it.page === 'number' ? it.page : -1;
      if (page < 0 && it.uri) {
        try { page = doc.resolveLink(it.uri); } catch { page = -1; }
      }
      const title = (it.title ?? '').replace(/\s+/g, ' ').trim();
      if (title && page >= 0 && page < total) out.push({ title, level, page });
      if (it.down?.length) walk(it.down, level + 1);
    }
  };
  if (items) walk(items, 1);
  return out;
}

function extract(file: string): ExtractedPdf {
  const doc = openPdf(file);
  const n = doc.countPages();
  const pages: ExtractedPdf['pages'] = [];
  for (let i = 0; i < n; i++) {
    if (cancelled()) throw new Error('cancelled');
    let raw = '';
    let label = '';
    try {
      const page = doc.loadPage(i);
      label = (page.getLabel() ?? '').trim();
      raw = page.toStructuredText('').asText();
      page.destroy();
    } catch {
      raw = '';
    }
    const text = cleanText(raw);
    const { quality, signals } = classifyPage(text);
    pages.push({ idx: i, label: label || String(i + 1), text: repairAccents(text), quality, score: Number(signals.score.toFixed(2)) });
  }
  return { pages, outline: flattenOutline(doc) };
}

interface CharBox { quad: mupdf.Quad }

function render(file: string, idx: number, scale: number, highlight: string | undefined): RenderedPage {
  const doc = openPdf(file);
  if (idx < 0 || idx >= doc.countPages()) throw new Error(`Page ${idx} is outside the document (${doc.countPages()} pages).`);
  const page = doc.loadPage(idx);
  const matrix = mupdf.Matrix.scale(scale, scale);
  let rects: mupdf.Rect[] = [];

  if (highlight) {
    // Build the page text from the char stream so offsets map straight to quads.
    const st = page.toStructuredText('');
    let text = '';
    const boxes: (CharBox | null)[] = [];
    st.walk({
      beginLine() {},
      onChar(c, _origin, _font, _size, quad) {
        for (let k = 0; k < c.length; k++) { text += c[k]; boxes.push(k === 0 ? { quad } : null); }
      },
      endLine() { text += '\n'; boxes.push(null); },
    });
    const hit = locateSpan(text, highlight);
    if (hit) rects = lineRects(boxes, hit.start, hit.end);
  }

  const bounds = page.getBounds();
  const device0 = mupdf.Rect.transform(bounds, matrix);
  const bbox: mupdf.Rect = [Math.floor(device0[0]), Math.floor(device0[1]), Math.ceil(device0[2]), Math.ceil(device0[3])];
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
  pixmap.clear(255);
  const dev = new mupdf.DrawDevice(matrix, pixmap);
  page.run(dev, mupdf.Matrix.identity);
  if (rects.length) {
    const path = new mupdf.Path();
    for (const r of rects) path.rect(r[0], r[1], r[2], r[3]);
    // Multiply keeps dark text dark; orange 232,93,38 at 35 % tints the paper.
    dev.beginGroup(bounds, mupdf.ColorSpace.DeviceRGB, true, false, 'Multiply', 1);
    dev.fillPath(path, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [232 / 255, 93 / 255, 38 / 255], 0.35);
    dev.endGroup();
  }
  dev.close();
  const png = pixmap.asPNG();
  return { png: new Uint8Array(png), width: pixmap.getWidth(), height: pixmap.getHeight(), highlighted: rects.length > 0 };
}

/** One rectangle per text line covering the matched characters. */
function lineRects(boxes: (CharBox | null)[], start: number, end: number): mupdf.Rect[] {
  const rects: mupdf.Rect[] = [];
  let cur: mupdf.Rect | null = null;
  const flush = () => { if (cur) rects.push(cur); cur = null; };
  for (let i = start; i < Math.min(end, boxes.length); i++) {
    const b = boxes[i];
    if (!b) { if (i < boxes.length && boxes[i] === null && cur === null) continue; continue; }
    const q = b.quad;
    const x0 = Math.min(q[0], q[2], q[4], q[6]), x1 = Math.max(q[0], q[2], q[4], q[6]);
    const y0 = Math.min(q[1], q[3], q[5], q[7]), y1 = Math.max(q[1], q[3], q[5], q[7]);
    if (cur) {
      const midNew = (y0 + y1) / 2;
      const sameLine = midNew > cur[1] && midNew < cur[3] && x0 < cur[2] + 40;
      if (!sameLine) flush();
    }
    cur = cur ? [Math.min(cur[0], x0), Math.min(cur[1], y0), Math.max(cur[2], x1), Math.max(cur[3], y1)] : [x0, y0, x1, y1];
  }
  flush();
  return rects;
}

try {
  if (job.op === 'extract') parentPort!.postMessage({ ok: true, value: extract(job.file) });
  else parentPort!.postMessage({ ok: true, value: render(job.file, job.idx, job.scale, job.highlight) });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
