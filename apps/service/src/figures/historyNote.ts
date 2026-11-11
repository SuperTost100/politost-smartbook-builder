// What a figure action did, in a few words, for the History list. A revision does not store it: the note is read from what differs
// between the revision and its parent, so it also describes revisions made before it existed. A redraw's instruction is the one
// thing that is not in the text or the assets, so it is read from the task that made the revision.
import type { Asset, ContentRevision } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { listAssets } from '../repo/assets.ts';
import { drawingSpec } from './drawing/edit.ts';

const SRC = /:::image\{[^}]*src="assets\/([^"]+)"/g;
const filesOf = (markdown: string): string[] => [...markdown.matchAll(SRC)].map((m) => m[1]);
const quote = (s: string, max: number) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;

const CAPTION_QUOTE = 60;

/** The caption's new text when it fits or when the first words show what changed. A long caption that changed at its end would be cut off before the change, so the note only says it changed. */
function captionNote(was: string, is: string): string {
  const next = is.trim();
  const prev = was.trim();
  let same = 0;
  while (same < prev.length && same < next.length && prev[same] === next[same]) same++;
  return next.length <= CAPTION_QUOTE || same < CAPTION_QUOTE * 2 / 3 ? `caption changed to ${quote(next, CAPTION_QUOTE)}` : 'caption changed';
}

/** One sentence about the figure that changed between a revision and its parent, or null when no single figure changed. */
export function figureNote(before: string, after: string, assets: Map<string, Asset>, o: { origin: string; instruction?: string | null }): string | null {
  const was = filesOf(before);
  const is = filesOf(after);
  const added = is.filter((f) => !was.includes(f));
  const removed = was.filter((f) => !is.includes(f));
  if (added.length > 1 || removed.length > 1 || (!added.length && !removed.length)) return null;
  const now = added[0] ? assets.get(added[0]) : undefined;
  const old = removed[0] ? assets.get(removed[0]) : undefined;
  const label = (a: Asset | undefined) => (a?.caption.trim() ? `Figure ${quote(a.caption.trim(), 40)}` : 'Figure');
  if (!old && now) return `${label(now)} added`;
  if (old && !now) return `${label(old)} removed`;
  if (!old || !now) return null;
  const was1 = drawingSpec(old);
  const is1 = drawingSpec(now);
  if (was1 && !is1) return `${label(old)}: the drawing was replaced with an image`;
  // The caption and the alt text are all a copy of an image can change, so a new image with both unchanged is a replacement.
  if (!was1 && !is1 && now.caption === old.caption && now.alt === old.alt) return `${label(old)}: the image was replaced`;
  const parts: string[] = [];
  if (now.caption !== old.caption) parts.push(captionNote(old.caption, now.caption));
  if (now.alt !== old.alt) parts.push('alt text changed');
  if (was1 && is1) {
    if (is1.shows !== was1.shows) parts.push('description changed');
    if (is1.source !== was1.source) parts.push(o.origin === 'ai' ? `redrawn${o.instruction ? `: ${quote(o.instruction, 80)}` : ''}` : 'source rendered');
  }
  return parts.length ? `${label(old)}: ${parts.join(', ')}` : null;
}

/** The note of each revision of a section that changed one figure, by revision id. */
export function figureNotes(ctx: AppContext, projectId: string, revisions: ContentRevision[]): Map<string, string> {
  const byId = new Map(revisions.map((r) => [r.id, r]));
  const assets = new Map(listAssets(ctx, projectId).map((a) => [a.filename, a]));
  const out = new Map<string, string>();
  for (const r of revisions) {
    const parent = r.parentRevId ? byId.get(r.parentRevId) : undefined;
    // A restore is a copy of an older version, so what differs from the version before it is the other way round from what the author did: History says it was a restore instead.
    if (!parent || r.restoredFromId) continue;
    const task = r.origin === 'ai'
      ? ctx.db.get<{ input: string }>(`SELECT t.input FROM content_revisions c JOIN tasks t ON t.id = c.task_id WHERE c.id = ? AND t.kind = 'figure.redraw'`, r.id)
      : undefined;
    const instruction = task ? (JSON.parse(task.input) as { instruction?: string }).instruction : null;
    const note = figureNote(parent.markdown, r.markdown, assets, { origin: r.origin, instruction });
    if (note) out.set(r.id, note);
  }
  return out;
}
