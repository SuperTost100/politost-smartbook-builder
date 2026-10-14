// Turns the figures a model asked for into asset files: plots and structures are drawn here, photos come from the stock
// services. Used by drafting and by fixes, which can both add figures.
import { renderPlotSvg, validatePlotSpec } from '@smartbuilder/content';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Molecule } from 'openchemlib';
import { z } from 'zod';
import { paths, toDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { findStockPhoto } from './stock.ts';
import { renderStructureSvg, validateStructureSpec } from './structure.ts';

export const figureSchema = z.object({
  key: z.string().describe('kebab-case, used as file name'),
  kind: z.enum(['plot', 'structure', 'photo']),
  caption: z.string(),
  alt: z.string(),
  plot: z.object({
    xRange: z.tuple([z.number(), z.number()]),
    yRange: z.tuple([z.number(), z.number()]),
    xLabel: z.string().nullable(),
    yLabel: z.string().nullable(),
    functions: z.array(z.object({ expr: z.string(), label: z.string().nullable(), domain: z.tuple([z.number(), z.number()]).nullable(), style: z.enum(['solid', 'dashed']).nullable() })),
    points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().nullable(), open: z.boolean().nullable() })).nullable(),
    asymptotes: z.array(z.object({ kind: z.enum(['vertical', 'horizontal']), value: z.number(), label: z.string().nullable() })).nullable(),
  }).nullable().describe('for kind "plot", else null'),
  structure: z.object({
    smiles: z.string(),
    style: z.enum(['lewis', 'skeletal']),
    lonePairs: z.boolean(),
  }).nullable().describe('for kind "structure", else null'),
  photo: z.object({
    query: z.string().describe('2-5 English words for a stock photo search'),
    mustShow: z.string().describe('what the photo must show, precisely'),
  }).nullable().describe('for kind "photo", else null'),
});
export type FigureRequest = z.infer<typeof figureSchema>;

export interface BuiltAsset { id: string; file: string; row: Record<string, unknown> }
export interface BuiltFigures {
  assets: BuiltAsset[];
  /** Name the model wrote in src (without extension) -> stored file name. */
  renames: Map<string, string>;
  notes: string[];
}

const cleanKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
const stem = (name: string) => name.replace(/\.[a-z0-9]+$/i, '');

/** Molecular formula of a SMILES string, e.g. "H2O"; empty when it does not parse. */
export function molecularFormula(smiles: string): string {
  try {
    return Molecule.fromSmiles(smiles).getMolecularFormula().formula;
  } catch {
    return '';
  }
}

function asPlotSpec(p: NonNullable<FigureRequest['plot']>) {
  return {
    xRange: p.xRange, yRange: p.yRange, xLabel: p.xLabel ?? undefined, yLabel: p.yLabel ?? undefined,
    functions: p.functions.map((f) => ({ expr: f.expr, label: f.label ?? undefined, domain: f.domain ?? undefined, style: f.style ?? undefined })),
    points: (p.points ?? []).map((pt) => ({ x: pt.x, y: pt.y, label: pt.label ?? undefined, open: pt.open ?? undefined })),
    asymptotes: (p.asymptotes ?? []).map((a) => ({ kind: a.kind, value: a.value, label: a.label ?? undefined })),
  };
}

/** Draws or fetches every requested figure and writes its file. Figures that fail are left out, with a note. */
export async function buildFigures(ctx: AppContext, o: {
  projectId: string; nodeId: string; language: string; figures: FigureRequest[]; photos: boolean;
  runId?: string; taskId?: string; signal?: AbortSignal; progress?: (message: string) => void;
}): Promise<BuiltFigures> {
  const out: BuiltFigures = { assets: [], renames: new Map(), notes: [] };
  const dir = paths.assets(ctx.config, o.projectId);
  mkdirSync(dir, { recursive: true });
  const prefix = o.nodeId.slice(0, 8);
  let photos = 0;
  for (const fig of o.figures) {
    const key = cleanKey(fig.key);
    if (!key || out.renames.has(key)) continue;
    let made: { bytes: Buffer | string; ext: string; mime: string; origin: string; spec: unknown; caption: string; alt: string; check: string } | null = null;
    if (fig.kind === 'plot' && fig.plot) {
      const v = validatePlotSpec(asPlotSpec(fig.plot));
      if (!v.ok) { out.notes.push(`${key}: ${v.errors.join('; ')}`); continue; }
      made = { bytes: renderPlotSvg(v.spec), ext: '.svg', mime: 'image/svg+xml', origin: 'plot', spec: v.spec, caption: fig.caption, alt: fig.alt, check: 'Plot rendered from a validated spec.' };
    } else if (fig.kind === 'structure' && fig.structure) {
      const v = validateStructureSpec(fig.structure);
      if (!v.ok) { out.notes.push(`${key}: ${v.errors.join('; ')}`); continue; }
      const formula = molecularFormula(v.spec.smiles);
      // The formula in the alt text lets the reviewer compare the drawn species with the caption.
      const alt = formula && !fig.alt.includes(formula) ? `${fig.alt} (${formula})` : fig.alt;
      made = { bytes: renderStructureSvg(v.spec), ext: '.svg', mime: 'image/svg+xml', origin: 'structure', spec: v.spec, caption: fig.caption, alt, check: `Drawn from SMILES ${v.spec.smiles}${formula ? ` (${formula})` : ''}.` };
    } else if (fig.kind === 'photo' && fig.photo) {
      if (!o.photos) { out.notes.push(`${key}: no stock photo service is set up`); continue; }
      if (photos >= 1) { out.notes.push(`${key}: only one photo per section`); continue; }
      photos++;
      o.progress?.(`Looking for a photo: ${fig.photo.mustShow}`);
      let found: Awaited<ReturnType<typeof findStockPhoto>>;
      try {
        found = await findStockPhoto(ctx, { query: fig.photo.query, mustShow: fig.photo.mustShow, language: o.language, projectId: o.projectId, runId: o.runId, taskId: o.taskId, signal: o.signal });
      } catch (err) {
        // A photo is optional: when the picker cannot run, the section goes on without it.
        if (o.signal?.aborted) throw err;
        found = { ok: false, reason: `the photo could not be checked (${err instanceof Error ? err.message : String(err)})` };
      }
      if (!found.ok) { out.notes.push(`${key}: ${found.reason}`); continue; }
      const p = found.photo;
      const caption = `${fig.caption.trim().replace(/[.;:,]?$/, '.')} ${p.credit}`;
      made = {
        bytes: p.bytes, ext: p.ext, mime: p.mime, origin: 'stock', caption, alt: fig.alt,
        spec: { provider: p.provider, id: p.id, pageUrl: p.pageUrl, author: p.author, query: fig.photo.query, mustShow: fig.photo.mustShow },
        check: `Picked by the vision model: ${p.check}`,
      };
    } else {
      out.notes.push(`${key}: the ${fig.kind} figure has no ${fig.kind} spec`);
      continue;
    }
    const id = newId();
    const file = join(dir, `${id}${made.ext}`);
    writeFileSync(`${file}.tmp`, made.bytes);
    renameSync(`${file}.tmp`, file);
    const stored = `${prefix}-${key}${made.ext}`;
    out.renames.set(key, stored);
    if (fig.key !== key) out.renames.set(stem(fig.key), stored);
    out.assets.push({
      id, file,
      row: {
        id, project_id: o.projectId, node_id: o.nodeId, filename: stored, mime: made.mime, path: toDataPath(ctx.config, file), origin: made.origin, spec: made.spec,
        caption: made.caption, alt: made.alt, checks: [{ method: 'lint', ok: true, detail: made.check }], created_at: now(),
      },
    });
  }
  return out;
}

/** Removes an image block (and its closing :::) that points at assets/<filename>. */
export function removeImageBlock(markdown: string, filename: string) {
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return markdown.replace(new RegExp(`:::image\\{[^}]*src="assets/${esc}"[^}]*\\}\\s*\\n:::\\s*\\n?`, 'g'), '').replace(new RegExp(`:::image\\{[^}]*src="assets/${esc}"[^}]*\\}\\s*\\n?`, 'g'), '');
}

/**
 * Points image blocks at the stored file names. A block whose src is neither a built figure nor an existing asset would be
 * a broken reference and is removed.
 */
export function rewriteImageRefs(markdown: string, built: BuiltFigures, existing: Set<string>): string {
  let md = markdown;
  for (const m of [...md.matchAll(/:::image\{[^}]*src="assets\/([^"]+)"/g)]) {
    if (!existing.has(m[1]) && !built.renames.has(stem(m[1]))) md = removeImageBlock(md, m[1]);
  }
  const meta = new Map(built.assets.map((a) => [a.row.filename as string, a.row]));
  return md.replace(/:::image\{([^}]*)\}/g, (all, attrs: string) => {
    const src = /src="assets\/([^"]+)"/.exec(attrs)?.[1];
    if (!src || existing.has(src)) return all;
    const stored = built.renames.get(stem(src));
    if (!stored) return all;
    const row = meta.get(stored)!;
    const q = (s: unknown) => String(s).replace(/"/g, "'");
    return `:::image{src="assets/${stored}" alt="${q(row.alt)}" caption="${q(row.caption)}"}`;
  });
}

/** Asset file names of a project, for rewriteImageRefs. */
export function existingAssetNames(ctx: AppContext, projectId: string): Set<string> {
  return new Set(ctx.db.all<{ filename: string }>('SELECT filename FROM assets WHERE project_id = ?', projectId).map((r) => r.filename));
}

/**
 * Inside the caller's transaction: stores the built figures the final text still uses and returns the text with any
 * renames. With `replace`, an asset of the same name on this node is replaced (its old file path is pushed to
 * `replaced`); otherwise a clash gets a name of its own, so a proposal never changes the figures of the current text.
 */
export function commitFigures(ctx: AppContext, o: { projectId: string; nodeId: string; built: BuiltFigures; markdown: string; replace: boolean; replaced: string[] }): { markdown: string; stored: string[] } {
  let markdown = o.markdown;
  const stored: string[] = [];
  for (const a of o.built.assets) {
    const name = a.row.filename as string;
    if (!markdown.includes(`src="assets/${name}"`)) continue;
    const old = ctx.db.all<{ id: string; path: string }>('SELECT id, path FROM assets WHERE project_id = ? AND node_id = ? AND filename = ?', o.projectId, o.nodeId, name);
    if (o.replace) {
      for (const r of old) { ctx.db.run('DELETE FROM assets WHERE id = ?', r.id); o.replaced.push(r.path); }
    } else if (old.length || ctx.db.get('SELECT 1 FROM assets WHERE project_id = ? AND filename = ?', o.projectId, name)) {
      const own = name.replace(/(\.[a-z]+)$/, `-${a.id.slice(0, 8)}$1`);
      markdown = markdown.split(`src="assets/${name}"`).join(`src="assets/${own}"`);
      a.row.filename = own;
    }
    ctx.db.insert('assets', a.row);
    stored.push(a.id);
  }
  return { markdown, stored };
}

/** Deletes the files of built figures that were not stored. */
export function discardUnstored(built: BuiltFigures, stored: string[]) {
  const keep = new Set(stored);
  for (const a of built.assets) if (!keep.has(a.id)) rmSync(a.file, { force: true });
}
