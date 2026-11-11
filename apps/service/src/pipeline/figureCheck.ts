// The cheap check that drops decorative figures. It runs on every figure a model proposes, wherever the figure is born
// (the figures pass, drafting, a fix), before any photo is searched or file drawn.
import type { z } from 'zod';
import type { AppContext } from '../context.ts';
import { cleanKey, stem, type FigureRequest } from '../figures/materialize.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { figureCheckPrompt, figureCheckSchema, type FigureSetup } from './prompts.ts';
import { truncate } from './util.ts';

// Lint accepts an indented image block, so leading spaces are allowed here too.
const IMAGE_SRC = /^\s*:::image\{[^}]*src="assets\/([^"]+)"/;

/**
 * Where the figures a writer proposed sit in its text: the text without those image blocks, and for each figure the
 * number of text blocks before its image block. A figure the text does not reference has no place (it is not stored anyway).
 */
export function figurePlaces<F extends FigureRequest>(blocks: string[], figures: F[]): { text: string[]; afterBlock: Map<F, number> } {
  const text: string[] = [];
  const afterBlock = new Map<F, number>();
  for (const b of blocks) {
    const src = IMAGE_SRC.exec(b)?.[1];
    const fig = src ? figures.find((f) => stem(src) === cleanKey(f.key) || stem(src) === stem(f.key)) : undefined;
    if (fig && !afterBlock.has(fig)) afterBlock.set(fig, text.length);
    else if (!src) text.push(b);
  }
  return { text, afterBlock };
}

/**
 * Asks the checker which of the proposed figures earn their place. `afterBlock` is the number of blocks of `blocks`
 * before the figure; a figure without one is not checked. With `soft`, a check that cannot run lets every figure through,
 * which suits a draft or a fix that has already cost a writer call.
 */
export async function dropDecorative<F extends FigureRequest>(ctx: AppContext, t: TaskContext, o: {
  projectId: string; language: string; figures: FigureSetup; proposed: F[]; blocks: string[]; afterBlock: (f: F) => number | undefined; soft?: boolean;
}): Promise<{ kept: F[]; notes: string[] }> {
  const checked = o.proposed.filter((f) => o.afterBlock(f) !== undefined);
  if (!checked.length) return { kept: o.proposed, notes: [] };
  t.progress(`Checking ${checked.length} proposed figure${checked.length === 1 ? '' : 's'}`);
  const items = checked.map((f, i) => {
    // lonePairs only switches lone pairs on; the builder draws the ones the species has, so the check need not judge it.
    const raw = (f as Record<string, unknown>)[f.kind] ?? null;
    const spec = f.kind === 'structure' && raw ? { ...(raw as Record<string, unknown>), lonePairs: undefined } : raw;
    // The paragraph before the figure, with the one before it and the one after it: a figure often sums up several.
    const at = o.afterBlock(f)!;
    const around = [o.blocks[at - 2], o.blocks[at - 1]].filter((b): b is string => !!b).map((b) => truncate(b, 1200)).join('\n\n');
    const next = o.blocks[at];
    return `${i + 1}. kind: ${f.kind}\ncaption: ${f.caption}\nspec: ${truncate(JSON.stringify(spec), 1500)}\npassage: ${around}${next ? `\nafter the figure: ${truncate(next, 800)}` : ''}`;
  }).join('\n\n');
  let verdict: { data: z.infer<typeof figureCheckSchema> };
  try {
    verdict = await runRole(ctx, { role: 'checker', ...figureCheckPrompt({ language: o.language, items, kinds: o.figures.kinds }), schema: figureCheckSchema, projectId: o.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  } catch (err) {
    if (!o.soft || !(err instanceof TaskError) || t.signal.aborted) throw err;
    return { kept: o.proposed, notes: ['the figure check could not run, so the figures were not checked'] };
  }
  const notes: string[] = [];
  const dropped = new Set<F>();
  checked.forEach((f, i) => {
    const v = verdict.data.figures.find((x) => x.index === i + 1);
    if (!v?.keep) { dropped.add(f); notes.push(`${f.key}: dropped by the check (${v?.reason.trim() || 'no verdict'})`); }
  });
  return { kept: o.proposed.filter((f) => !dropped.has(f)), notes };
}
