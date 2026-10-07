import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import type { Asset } from '@smartbuilder/domain';
import { paths, resolveDataPath, toDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { badInput, notFound } from './errors.ts';
import type { Rec } from './util.ts';

const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function mapAsset(r: Rec): Asset {
  return {
    id: r.id, projectId: r.project_id, nodeId: r.node_id ?? null, filename: r.filename, mime: r.mime, origin: r.origin,
    spec: json(r.spec, null), caption: r.caption, alt: r.alt, checks: json(r.checks, []), createdAt: r.created_at,
  };
}

/** A name that is safe as a file name inside the package: no folders, ASCII letters, digits, dot, dash, underscore. */
export function safeFilename(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const ext = extname(base).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = base.slice(0, base.length - extname(base).length).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return `${stem || 'figure'}${ext}`;
}

/**
 * Rejects SVG that could run code or load anything from outside the file: scripts, event-handler attributes,
 * javascript: URLs, links to anything but "#fragment", foreignObject, and embedded documents.
 */
export function assertSafeSvg(svg: string): void {
  const reject = (why: string) => badInput(`This SVG was refused because it ${why}.`, 'Export a plain drawing without scripts or external links and upload it again.');
  if (!/<svg[\s>]/i.test(svg)) throw badInput('This file is not a valid SVG image.', 'Export the drawing as SVG again.');
  if (/<script/i.test(svg)) throw reject('contains a script');
  if (/<foreignObject/i.test(svg)) throw reject('contains a foreignObject element');
  if (/<(iframe|embed|object|link|meta|audio|video)[\s/>]/i.test(svg)) throw reject('embeds other content');
  if (/<!ENTITY/i.test(svg)) throw reject('declares custom entities');
  if (/javascript\s*:/i.test(svg)) throw reject('contains a javascript: link');
  const tags = svg.match(/<[a-zA-Z][^\s>/]*(?:"[^"]*"|'[^']*'|[^'">])*>/g) ?? [];
  for (const tag of tags) {
    const attrs = [...tag.matchAll(/([^\s=/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)];
    for (const m of attrs) {
      const name = m[1].toLowerCase();
      const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (name.startsWith('on')) throw reject('contains an event-handler attribute');
      if ((name === 'href' || name.endsWith(':href')) && !value.startsWith('#')) throw reject('links to something outside the file');
      if (/url\(\s*['"]?(?!#)/i.test(value) || /@import/i.test(value)) throw reject('loads something from outside the file');
    }
  }
  // Style elements are plain text between tags.
  for (const m of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (/@import|url\(\s*['"]?(?!#)/i.test(m[1])) throw reject('loads something from outside the file');
  }
}

export function assetPath(ctx: AppContext, r: { path: string; project_id: string }): string {
  return resolveDataPath(ctx.config, r.path);
}

export function listAssets(ctx: AppContext, projectId: string): Asset[] {
  return ctx.db.all<Rec>('SELECT * FROM assets WHERE project_id = ? ORDER BY rowid', projectId).map(mapAsset);
}

export function getAsset(ctx: AppContext, id: string): Asset {
  const r = ctx.db.get<Rec>('SELECT * FROM assets WHERE id = ?', id);
  if (!r) throw notFound('This figure');
  return mapAsset(r);
}

/** Absolute file path and mime of an asset, for serving. */
export function assetFile(ctx: AppContext, id: string): { path: string; mime: string; filename: string } {
  const r = ctx.db.get<Rec>('SELECT * FROM assets WHERE id = ?', id);
  if (!r) throw notFound('This figure');
  const path = assetPath(ctx, r as { path: string; project_id: string });
  if (!existsSync(path)) throw notFound('The file of this figure');
  return { path, mime: r.mime, filename: r.filename };
}

export interface NewAsset {
  filename: string;
  bytes: Uint8Array;
  origin: Asset['origin'];
  nodeId?: string | null;
  spec?: unknown;
  caption?: string;
  alt?: string;
  checks?: Asset['checks'];
}

/** Stores bytes under the project's assets folder. The file name is sanitized and made unique in the project. */
export function storeAsset(ctx: AppContext, projectId: string, input: NewAsset): Asset {
  const filename0 = safeFilename(input.filename);
  const ext = extname(filename0).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw badInput('Figures must be SVG, PNG, JPEG, WebP or GIF.', 'Convert the file and upload it again.');
  if (ext === '.svg') assertSafeSvg(Buffer.from(input.bytes).toString('utf8'));
  else if (!input.bytes.length) throw badInput('The file is empty.');

  const taken = new Set(ctx.db.all<Rec>('SELECT filename FROM assets WHERE project_id = ?', projectId).map((r) => r.filename as string));
  let filename = filename0;
  for (let n = 2; taken.has(filename); n++) filename = `${filename0.slice(0, filename0.length - ext.length)}-${n}${ext}`;

  const id = newId();
  const dir = paths.assets(ctx.config, projectId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}${ext}`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, input.bytes);
  renameSync(tmp, path);
  try {
    ctx.db.insert('assets', {
      id, project_id: projectId, node_id: input.nodeId ?? null, filename, mime, path: toDataPath(ctx.config, path), origin: input.origin, spec: input.spec ?? null,
      caption: input.caption ?? '', alt: input.alt ?? '', checks: input.checks ?? [], created_at: now(),
    });
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
  ctx.events.emit('asset.updated', { assetId: id, nodeId: input.nodeId ?? null }, { projectId });
  return getAsset(ctx, id);
}

export function updateAsset(ctx: AppContext, id: string, patch: Partial<Pick<Asset, 'caption' | 'alt' | 'nodeId'>>): Asset {
  const cur = getAsset(ctx, id);
  const values: Record<string, unknown> = {};
  if (patch.caption !== undefined) values.caption = patch.caption;
  if (patch.alt !== undefined) values.alt = patch.alt;
  if (patch.nodeId !== undefined) values.node_id = patch.nodeId;
  ctx.db.update('assets', id, values);
  ctx.events.emit('asset.updated', { assetId: id, nodeId: patch.nodeId !== undefined ? patch.nodeId : cur.nodeId }, { projectId: cur.projectId });
  return getAsset(ctx, id);
}

export function deleteAsset(ctx: AppContext, id: string): void {
  const r = ctx.db.get<Rec>('SELECT * FROM assets WHERE id = ?', id);
  if (!r) return;
  ctx.db.run('DELETE FROM assets WHERE id = ?', id);
  rmSync(assetPath(ctx, r as { path: string; project_id: string }), { force: true });
  ctx.events.emit('asset.updated', { assetId: id, nodeId: r.node_id ?? null, deleted: true }, { projectId: r.project_id });
}

export function readAssetBytes(ctx: AppContext, projectId: string): { filename: string; bytes: Uint8Array; caption: string; alt: string }[] {
  const out: { filename: string; bytes: Uint8Array; caption: string; alt: string }[] = [];
  for (const r of ctx.db.all<Rec>('SELECT * FROM assets WHERE project_id = ? ORDER BY rowid', projectId)) {
    const p = assetPath(ctx, r as { path: string; project_id: string });
    if (existsSync(p)) out.push({ filename: r.filename, bytes: readFileSync(p), caption: r.caption ?? '', alt: r.alt ?? '' });
  }
  return out;
}
