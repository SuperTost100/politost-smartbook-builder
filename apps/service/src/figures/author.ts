// What the figure dialog and "Add figure" do to the text and the asset files. Every change is a new revision of the section
// (the head the author saw is checked), and a changed picture is a new asset next to the old one, so History still shows the
// drawing a revision was written with. Nothing here calls a model: the routes and the figure tasks do.
import { copyFileSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { joinBlocks, splitBlocks } from '@smartbuilder/content/blocks';
import type { Asset, ContentRevision } from '@smartbuilder/domain';
import type { FigureDetails, FigureKindName } from '@smartbuilder/domain';
import { paths, toDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { rewriteHead } from '../repo/content.ts';
import { assertSafeSvg, assetPath, getAsset, mapAsset, storeAsset } from '../repo/assets.ts';
import { badInput, conflict, notFound } from '../repo/errors.ts';
import type { Rec } from '../repo/util.ts';
import { relint } from '../routes/views.ts';
import { IMAGE_ATTRS } from './materialize.ts';
import { drawingSpec } from './drawing/edit.ts';

/** The most an uploaded figure may weigh. */
export const FIGURE_UPLOAD_MAX = 2 * 1024 * 1024;
const UPLOAD_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

const attr = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim();

/** True when the text has an image block that points at assets/<filename>. */
export const showsFigure = (markdown: string, filename: string) => markdown.includes(`src="assets/${filename}"`);

/** The asset a section's current text shows. 404 when the asset is another project's or the text does not show it. */
export function figureOfSection(ctx: AppContext, projectId: string, assetId: string, head: ContentRevision | null): Asset {
  const asset = getAsset(ctx, assetId);
  if (asset.projectId !== projectId || !head || !showsFigure(head.markdown, asset.filename)) throw notFound('This figure');
  return asset;
}

/**
 * The asset a write names. A figure of this project that the text does not show any more is one a change has replaced (a render,
 * a save, a redraw each give the figure a new asset), so the dialog that names it is out of date: 409 like a stale head, and
 * nothing runs on the older version. An asset that is not in this project is a 404 as for a read.
 */
export function figureToChange(ctx: AppContext, projectId: string, assetId: string, head: ContentRevision | null, nodeId: string): Asset {
  const asset = getAsset(ctx, assetId);
  if (asset.projectId === projectId && head && !showsFigure(head.markdown, asset.filename)) throw conflict('This figure changed since you opened it.', undefined, nodeId);
  return figureOfSection(ctx, projectId, assetId, head);
}

export function figureKind(asset: Asset): FigureKindName {
  if (drawingSpec(asset)) return 'drawing';
  if (asset.origin === 'stock') return 'photo';
  if (asset.origin === 'plot' || asset.origin === 'structure' || asset.origin === 'diagram') return asset.origin;
  return 'image';
}

/** The alt text of the block that shows `filename`, or '' when the block has none. */
export function blockAlt(markdown: string, filename: string): string {
  for (const m of markdown.matchAll(new RegExp(`:::image\\{(${IMAGE_ATTRS})\\}`, 'g'))) {
    if (m[1].includes(`src="assets/${filename}"`)) return /\balt="([^"]*)"/.exec(m[1])?.[1] ?? '';
  }
  return '';
}

/** `head` is the section text the figure was read from. The compiler uses the asset's alt text and falls back to the block's, so the dialog shows the same. */
export function figureDetails(asset: Asset, head: ContentRevision, redrawRunId: string | null): FigureDetails {
  const d = drawingSpec(asset);
  const headRevId = head.id;
  return {
    assetId: asset.id, filename: asset.filename, kind: figureKind(asset), caption: asset.caption, alt: asset.alt.trim() ? asset.alt : blockAlt(head.markdown, asset.filename), createdAt: asset.createdAt,
    drawing: d ? { shows: d.shows, engine: d.engine, source: d.source, family: d.family } : null, headRevId, redrawRunId,
  };
}

/**
 * A second asset row with its own file for the same picture. The author's change is made on the copy and the text then points
 * at it, so the old asset keeps serving the revisions that name it. Returns the new asset.
 */
export function copyAsset(ctx: AppContext, asset: Asset, o: { keepDate?: boolean } = {}): Asset {
  const row = ctx.db.get<Rec>('SELECT * FROM assets WHERE id = ?', asset.id);
  if (!row) throw notFound('This figure');
  const id = newId();
  const ext = extname(asset.filename).toLowerCase();
  const dir = paths.assets(ctx.config, asset.projectId);
  const from = assetPath(ctx, row as { path: string; project_id: string });
  const to = join(dir, `${id}${ext}`);
  copyFileSync(from, to);
  const taken = new Set(ctx.db.all<Rec>('SELECT filename FROM assets WHERE project_id = ?', asset.projectId).map((r) => r.filename as string));
  const base = asset.filename.slice(0, asset.filename.length - ext.length).replace(/-r[0-9a-z]{6}$/, '');
  let filename = `${base}-r${id.slice(0, 6)}${ext}`;
  for (let n = 2; taken.has(filename); n++) filename = `${base}-r${id.slice(0, 6)}-${n}${ext}`;
  try {
    ctx.db.insert('assets', {
      id, project_id: asset.projectId, node_id: asset.nodeId, filename, mime: asset.mime, path: toDataPath(ctx.config, to), origin: asset.origin, spec: asset.spec,
      caption: asset.caption, alt: asset.alt, checks: asset.checks, created_at: o.keepDate ? asset.createdAt : now(),
    });
  } catch (err) {
    rmSync(to, { force: true });
    throw err;
  }
  return mapAsset(ctx.db.get<Rec>('SELECT * FROM assets WHERE id = ?', id)!);
}

/** Deletes an asset made by copyAsset (or an upload) that the text never came to use. */
export function discardAsset(ctx: AppContext, asset: Asset) {
  const row = ctx.db.get<Rec>('SELECT path FROM assets WHERE id = ?', asset.id);
  ctx.db.run('DELETE FROM assets WHERE id = ?', asset.id);
  if (row) rmSync(assetPath(ctx, { path: String(row.path), project_id: asset.projectId }), { force: true });
}

export const imageBlock = (filename: string, alt: string, caption: string) =>
  `:::image{src="assets/${filename}" alt="${attr(alt)}"${caption.trim() ? ` caption="${attr(caption)}"` : ''}}\n:::`;

/** Points the image block of `from` at `to`. */
export function swapSrc(markdown: string, from: string, to: string): string {
  return markdown.split(`src="assets/${from}"`).join(`src="assets/${to}"`);
}

/** Sets caption and alt text in the attributes of the block that shows `filename`. */
export function setBlockAttrs(markdown: string, filename: string, v: { caption?: string; alt?: string }): string {
  return markdown.replace(new RegExp(`:::image\\{(${IMAGE_ATTRS})\\}`, 'g'), (all, attrs: string) => {
    if (!attrs.includes(`src="assets/${filename}"`)) return all;
    let next = attrs;
    for (const [name, value] of Object.entries(v)) {
      if (value === undefined) continue;
      const re = new RegExp(`\\s*\\b${name}="[^"]*"`);
      next = next.replace(re, '');
      if (name === 'alt' || value.trim()) next += ` ${name}="${attr(value)}"`;
    }
    return `:::image{${next.trim()}}`;
  });
}

/**
 * Saves a new caption, alt text and/or description of a figure as a new revision. All three live on the asset record, which every
 * revision that names the asset reads (and which wins over the block's attributes), so the change is made on a copy, the block gets
 * the same text, and the text is pointed at the copy: an earlier revision keeps its own caption, alt text and description when it
 * is restored. Returns the new revision, or null when nothing differs or the figure is not in the text.
 * `expectedHeadId` is the head the author saw (409 when it moved).
 */
export function saveFigureDetails(
  ctx: AppContext, projectId: string, nodeId: string, asset: Asset, v: { caption?: string; alt?: string; shows?: string }, expectedHeadId: string,
): ContentRevision | null {
  const drawing = drawingSpec(asset);
  const caption = v.caption !== undefined && v.caption !== asset.caption ? v.caption : undefined;
  // The block can only hold the attribute form (no double quotes, one line), so the asset gets the same text.
  const alt = v.alt !== undefined && attr(v.alt) !== asset.alt ? attr(v.alt) : undefined;
  const shows = v.shows !== undefined && drawing && v.shows !== drawing.shows ? v.shows : undefined;
  if (caption === undefined && alt === undefined && shows === undefined) return null;
  const copy = copyAsset(ctx, asset, { keepDate: true });
  try {
    const values: Record<string, unknown> = {};
    if (caption !== undefined) values.caption = caption;
    if (alt !== undefined) values.alt = alt;
    if (shows !== undefined && drawing) values.spec = { ...drawing, shows };
    ctx.db.update('assets', copy.id, values);
    const rev = writeFigureRevision(ctx, projectId, nodeId, (md) => {
      const swapped = swapSrc(md, asset.filename, copy.filename);
      return caption === undefined && alt === undefined ? swapped : setBlockAttrs(swapped, copy.filename, { caption, alt });
    }, { expectedHeadId });
    if (!rev) discardAsset(ctx, copy);
    return rev;
  } catch (err) {
    discardAsset(ctx, copy);
    throw err;
  }
}

/** The text with a block inserted after block `afterBlock` (counted as the editor counts them; -1 puts it first). */
export function insertAfterBlock(markdown: string, afterBlock: number, block: string): string {
  const blocks = splitBlocks(markdown);
  const at = Math.min(Math.max(afterBlock, -1), blocks.length - 1) + 1;
  blocks.splice(at, 0, { kind: 'image', text: block });
  return joinBlocks(blocks);
}

/** After a revision was written: lint it again and tell the open screens. */
export function announce(ctx: AppContext, projectId: string, nodeId: string, rev: ContentRevision) {
  relint(ctx, projectId, nodeId);
  ctx.events.emit('content.saved', { nodeId, revId: rev.id, origin: rev.origin, status: rev.status }, { projectId });
}

/** Writes a rewrite of the head as a new revision. `expectedHeadId` is the head the author saw (409 when it moved). */
export function writeFigureRevision(
  ctx: AppContext, projectId: string, nodeId: string, fix: (markdown: string) => string,
  o: { expectedHeadId?: string | null; origin?: 'human' | 'ai' } = {},
): ContentRevision | null {
  const rev = rewriteHead(ctx, projectId, nodeId, fix, { origin: o.origin ?? 'human', expectedHeadId: o.expectedHeadId });
  if (rev) announce(ctx, projectId, nodeId, rev);
  return rev;
}

/** The bytes of an upload, checked: one of the four formats, within the size limit, and a plain SVG when it is one. */
export function checkFigureUpload(file: { filename: string; bytes: Buffer }): void {
  const ext = extname(file.filename).toLowerCase();
  if (!UPLOAD_EXTENSIONS.has(ext)) throw badInput('Figures must be PNG, JPEG, SVG or WebP.', 'Convert the file and upload it again.');
  if (!file.bytes.length) throw badInput('The file is empty.');
  const b = file.bytes;
  if (ext === '.svg') { assertSafeSvg(b.toString('utf8')); return; }
  const isPng = b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isWebp = b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  const ok = ext === '.png' ? isPng : ext === '.webp' ? isWebp : isJpeg;
  if (!ok) throw badInput(`This file is not a real ${ext.slice(1).toUpperCase()} image.`, 'Export the image again from the program that made it.');
}

/** Stores a checked upload as an asset of the section. */
export function storeUpload(ctx: AppContext, projectId: string, nodeId: string, file: { filename: string; bytes: Buffer }, v: { caption: string; alt: string }): Asset {
  checkFigureUpload(file);
  return storeAsset(ctx, projectId, { filename: file.filename, bytes: file.bytes, origin: 'imported', nodeId, caption: v.caption, alt: v.alt, checks: [{ method: 'lint', ok: true, detail: 'Uploaded by the author.' }] });
}
