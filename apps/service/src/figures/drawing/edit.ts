// What a screen for a drawn figure needs, without routes or UI: render source an author edited, and redraw with an instruction.
// Both replace the figure's file in place (the asset keeps its id, its file name and its place in the text) and update the
// stored spec. A failure changes nothing and returns the error to show.
import { renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { DRAWING_FAMILIES, type Asset } from '@smartbuilder/domain';
import type { AppContext } from '../../context.ts';
import { getAsset, assetFile } from '../../repo/assets.ts';
import { badInput } from '../../repo/errors.ts';
import { loadProject } from '../../pipeline/util.ts';
import { illustrate, type LookOutcome } from './illustrator.ts';
import { renderDrawing } from './index.ts';

const specSchema = z.object({
  kind: z.literal('drawing'),
  engine: z.enum(['typst', 'schemdraw']),
  source: z.string(),
  shows: z.string(),
  family: z.enum(DRAWING_FAMILIES),
  symbols: z.enum(['american', 'european']),
});
export type DrawingSpec = z.infer<typeof specSchema>;

export type EditResult =
  | { ok: true; asset: Asset; /** A redraw: what the look turn did, and the model that drew it. */ look?: LookOutcome; model?: string }
  | { ok: false; error: string };

/** The drawing spec of an asset the illustrator made, or null for any other figure. */
export function drawingSpec(asset: Asset): DrawingSpec | null {
  const spec = asset.origin === 'generated-svg' ? specSchema.safeParse(asset.spec) : null;
  return spec?.success ? spec.data : null;
}

function drawnAsset(ctx: AppContext, assetId: string): { asset: Asset; spec: DrawingSpec } {
  const asset = getAsset(ctx, assetId);
  const spec = asset.origin === 'generated-svg' ? specSchema.safeParse(asset.spec) : null;
  if (!spec?.success) throw badInput('This figure was not drawn from source code, so it cannot be edited or redrawn.');
  return { asset, spec: spec.data };
}

/** Writes the new drawing over the figure's file and stores the spec that made it. */
function replaceDrawing(ctx: AppContext, asset: Asset, spec: DrawingSpec, svg: string, detail: string): Asset {
  const { path } = assetFile(ctx, asset.id);
  writeFileSync(`${path}.tmp`, svg);
  renameSync(`${path}.tmp`, path);
  ctx.db.update('assets', asset.id, { spec, checks: [{ method: 'lint', ok: true, detail }] });
  ctx.events.emit('asset.updated', { assetId: asset.id, nodeId: asset.nodeId }, { projectId: asset.projectId });
  return getAsset(ctx, asset.id);
}

/** Compiles source an author edited and, when it compiles, replaces the figure's file. Otherwise returns the compile error and changes nothing. */
export async function renderEditedDrawing(ctx: AppContext, assetId: string, source: string): Promise<EditResult> {
  const { asset, spec } = drawnAsset(ctx, assetId);
  const r = await renderDrawing({ engine: spec.engine, source, symbols: spec.symbols, title: asset.caption });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, asset: replaceDrawing(ctx, asset, { ...spec, source }, r.svg, `Source edited by the author, compiled in ${spec.engine}.`) };
}

/**
 * Asks the illustrator for a new drawing: it gets the current source, what the figure shows and the author's one-line
 * instruction, and the same compile, repair and look loop runs. When no drawing compiles, the figure stays as it is.
 */
export async function redrawDrawing(ctx: AppContext, assetId: string, instruction: string, o: { signal?: AbortSignal; runId?: string | null; taskId?: string | null } = {}): Promise<EditResult> {
  const { asset, spec } = drawnAsset(ctx, assetId);
  const clean = instruction.trim();
  if (!clean) throw badInput('Say what the drawing should change.');
  const drawn = await illustrate(ctx, {
    projectId: asset.projectId, signal: o.signal, runId: o.runId, taskId: o.taskId, language: loadProject(ctx, asset.projectId).language, symbols: spec.symbols,
    caption: asset.caption, shows: spec.shows, family: spec.family, engine: spec.engine, redraw: { source: spec.source, instruction: clean },
  });
  if (!drawn.ok) return { ok: false, error: drawn.reason };
  const detail = `Redrawn by the illustrator in ${spec.engine} at the author's request (look turn: ${drawn.look}).`;
  return { ok: true, asset: replaceDrawing(ctx, asset, { ...spec, source: drawn.source }, drawn.svg, detail), look: drawn.look, model: drawn.model };
}
