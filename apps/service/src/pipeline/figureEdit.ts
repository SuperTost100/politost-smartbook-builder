// Figure tasks an author starts from the manuscript: redraw a drawn figure with an instruction, and draw a new figure from a
// description. Both call the illustrator, which can take about a minute, so they run in the queue like any other model work
// and show up in the Run panel. The text changes last, in one new revision of whatever the head is by then.
import { splitBlocks } from '@smartbuilder/content/blocks';
import type { RunSummary } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId } from '../db/db.ts';
import { drawingSpec, redrawDrawing } from '../figures/drawing/edit.ts';
import { announce, copyAsset, discardAsset, imageBlock, insertAfterBlock, showsFigure, swapSrc } from '../figures/author.ts';
import { buildFigures, cleanCaption, commitFigures, discardUnstored, type FigureRequest } from '../figures/materialize.ts';
import { currentHead, rewriteHead } from '../repo/content.ts';
import { getAsset } from '../repo/assets.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { loadProject } from './util.ts';

const OPEN = `('running', 'pausing', 'paused', 'waiting', 'cancelling')`;

/** The run of a redraw that is still working on this figure. */
export function activeRedraw(ctx: AppContext, projectId: string, assetId: string): string | null {
  return ctx.db.get<{ id: string }>(
    `SELECT r.id FROM runs r JOIN tasks t ON t.run_id = r.id
     WHERE r.project_id = ? AND r.kind = 'figure' AND r.status IN ${OPEN} AND t.kind = 'figure.redraw' AND json_extract(t.input, '$.assetId') = ?
       AND t.state NOT IN ('succeeded', 'failed', 'cancelled', 'skipped') LIMIT 1`, projectId, assetId)?.id ?? null;
}

/** Starts a redraw of one drawn figure. A second request for the same figure joins the run that is already working on it. */
export function startRedraw(ctx: AppContext, projectId: string, o: { nodeId: string; assetId: string; caption: string; instruction: string }): RunSummary {
  const running = activeRedraw(ctx, projectId, o.assetId);
  if (running) return ctx.queue.runSummary(running)!;
  const runId = ctx.queue.createRun(projectId, 'figure', [{
    kind: 'figure.redraw', key: `redraw:${o.assetId}:${Date.now().toString(36)}`, label: `Redraw ${o.caption ? `"${o.caption.slice(0, 60)}"` : 'a figure'}`,
    input: { nodeId: o.nodeId, assetId: o.assetId, instruction: o.instruction }, pool: 'illustrator', maxAttempts: 2,
  }]);
  return ctx.queue.runSummary(runId)!;
}

/** Starts the drawing of a new figure that goes in after block `afterBlock`. `anchor` is that block's text, to find it again if the text moved. */
export function startDraw(ctx: AppContext, projectId: string, o: { nodeId: string; afterBlock: number; anchor: string; description: string; caption: string }): RunSummary {
  const runId = ctx.queue.createRun(projectId, 'figure', [{
    kind: 'figure.draw', key: `draw:${newId()}`, label: `Draw ${o.caption ? `"${o.caption.slice(0, 60)}"` : 'a figure'}`,
    input: { ...o }, pool: 'illustrator', maxAttempts: 2,
  }]);
  return ctx.queue.runSummary(runId)!;
}

/** Task `figure.redraw`: the redraw is made on a copy of the figure, and the text is pointed at the copy once it exists. */
export async function figureRedraw(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const { nodeId, assetId, instruction } = t.task.input as { nodeId: string; assetId: string; instruction: string };
  const old = getAsset(ctx, assetId);
  if (!drawingSpec(old)) throw new TaskError('This figure was not drawn from source code, so it cannot be redrawn.', 'input');
  if (!showsFigure(currentHead(ctx, projectId, nodeId)?.markdown ?? '', old.filename)) return { skipped: 'the figure is not in the text any more' };

  t.progress(`Redrawing: ${old.caption || old.filename}`);
  const copy = copyAsset(ctx, old);
  let drawn: Awaited<ReturnType<typeof redrawDrawing>>;
  try {
    drawn = await redrawDrawing(ctx, copy.id, instruction, { signal: t.signal });
  } catch (err) {
    discardAsset(ctx, copy);
    throw err;
  }
  if (!drawn.ok) {
    discardAsset(ctx, copy);
    throw new TaskError(drawn.error, 'input', 'The figure is unchanged. Change the instruction and try again.');
  }
  // The head is read now: the author may have saved text meanwhile, and that text keeps what they wrote.
  const rev = rewriteHead(ctx, projectId, nodeId, (md) => swapSrc(md, old.filename, copy.filename), { origin: 'ai' });
  if (!rev) {
    discardAsset(ctx, copy);
    return { skipped: 'the figure left the text while it was being redrawn' };
  }
  announce(ctx, projectId, nodeId, rev);
  return { assetId: copy.id, revId: rev.id, look: drawn.look };
}

/** Task `figure.draw`: the illustrator draws the figure through the same path as the writer's drawings, and the block goes in after the author's block. */
export async function figureDraw(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const { nodeId, afterBlock, anchor, description, caption } = t.task.input as { nodeId: string; afterBlock: number; anchor: string; description: string; caption: string };
  const project = loadProject(ctx, projectId);
  const key = `figure-${newId().slice(0, 6)}`;
  const clean = cleanCaption(caption);
  const alt = clean || description.replace(/\s+/g, ' ').slice(0, 140);
  const request: FigureRequest = {
    key, kind: 'drawing', caption: clean, alt, plot: null, structure: null, photo: null, levels: null, orbitals: null, cell: null, periodic: null,
    drawing: { shows: description, family: 'other' },
  };
  const built = await buildFigures(ctx, {
    projectId, nodeId, language: project.language, figures: [request], photos: false, keepOwn: true,
    runId: t.task.runId, taskId: t.task.id, signal: t.signal, progress: (m) => t.progress(m),
  });
  const asset = built.assets[0];
  if (!asset) throw new TaskError(built.notes[0] ?? 'The illustrator could not draw this figure.', 'input', 'Describe the figure again, with the parts and labels you want.');

  let stored: string[] = [];
  let rev: ReturnType<typeof rewriteHead> = null;
  try {
    rev = rewriteHead(ctx, projectId, nodeId, (md) => {
      // The block goes after the one the author chose, found again by its text in case the section was saved meanwhile.
      const blocks = splitBlocks(md);
      let at = -1;
      blocks.forEach((b, i) => { if (b.text === anchor && (at < 0 || Math.abs(i - afterBlock) < Math.abs(at - afterBlock))) at = i; });
      const text = insertAfterBlock(md, at >= 0 ? at : afterBlock, imageBlock(asset.row.filename as string, alt, clean));
      const out = commitFigures(ctx, { projectId, nodeId, built, markdown: text, replace: false, replaced: [] });
      stored = out.stored;
      return out.markdown;
    }, { origin: 'ai' });
  } finally {
    discardUnstored(built, rev ? stored : []);
  }
  if (!rev) throw new TaskError('The section has no text to put the figure in.', 'input');
  announce(ctx, projectId, nodeId, rev);
  ctx.events.emit('asset.updated', { nodeId, assetIds: stored }, { projectId });
  return { assetId: asset.id, revId: rev.id };
}
