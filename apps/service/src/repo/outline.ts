import { outlineSchema, type Outline, type OutlineRevision } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { badInput, conflict, notFound } from './errors.ts';
import { getProject, setStage } from './projects.ts';
import type { Rec } from './util.ts';

export function mapOutlineRevision(r: Rec): OutlineRevision {
  return {
    id: r.id, projectId: r.project_id, outline: outlineSchema.parse(json(r.outline, { chapters: [] })), origin: r.origin,
    createdAt: r.created_at, approvedAt: r.approved_at ?? null, note: r.note,
  };
}

export function latestOutlineRevision(ctx: AppContext, projectId: string): OutlineRevision | null {
  const r = ctx.db.get<Rec>('SELECT * FROM outline_revisions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1', projectId);
  return r ? mapOutlineRevision(r) : null;
}

export function getOutlineRevision(ctx: AppContext, projectId: string, revId: string): OutlineRevision {
  const r = ctx.db.get<Rec>('SELECT * FROM outline_revisions WHERE id = ? AND project_id = ?', revId, projectId);
  if (!r) throw notFound('This outline version');
  return mapOutlineRevision(r);
}

/** The approved revision when there is one, otherwise the latest. */
export function effectiveOutline(ctx: AppContext, projectId: string): { revision: OutlineRevision; approved: boolean } | null {
  const p = getProject(ctx, projectId);
  if (p.outlineRevId) {
    const r = ctx.db.get<Rec>('SELECT * FROM outline_revisions WHERE id = ? AND project_id = ?', p.outlineRevId, projectId);
    if (r) return { revision: mapOutlineRevision(r), approved: true };
  }
  const latest = latestOutlineRevision(ctx, projectId);
  return latest ? { revision: latest, approved: false } : null;
}

export function listOutlineHistory(ctx: AppContext, projectId: string): Pick<OutlineRevision, 'id' | 'createdAt' | 'origin' | 'approvedAt'>[] {
  return ctx.db.all<Rec>('SELECT id, created_at, origin, approved_at FROM outline_revisions WHERE project_id = ? ORDER BY rowid DESC', projectId)
    .map((r) => ({ id: r.id, createdAt: r.created_at, origin: r.origin, approvedAt: r.approved_at ?? null }));
}

/** Ids of chapters and sections must be unique: they are the node ids of the content. */
export function checkOutlineIds(outline: Outline): void {
  const seen = new Set<string>();
  const slugs = new Set<string>();
  for (const c of outline.chapters) {
    if (slugs.has(c.slug)) throw badInput(`Two chapters use the short name "${c.slug}".`, 'Give each chapter its own short name.', c.id);
    slugs.add(c.slug);
    for (const id of [c.id, ...c.sections.map((s) => s.id)]) {
      if (seen.has(id)) throw badInput(`The outline uses the id "${id}" twice.`, 'Reload the outline and try again.', id);
      seen.add(id);
    }
  }
}

/**
 * Saves a new outline revision. Human saves pass the revision they edited as baseRevId; the save fails with 409
 * when a newer revision exists. Pipeline code passes `check: false` for AI outlines.
 */
export function saveOutline(
  ctx: AppContext, projectId: string,
  input: { outline: Outline; baseRevId: string | null; origin?: 'ai' | 'human'; note?: string; check?: boolean },
): OutlineRevision {
  return ctx.db.tx(() => {
    getProject(ctx, projectId);
    checkOutlineIds(input.outline);
    if (input.check !== false) {
      const head = latestOutlineRevision(ctx, projectId);
      if ((head?.id ?? null) !== input.baseRevId) {
        throw conflict('The outline was changed somewhere else since you opened it.', 'Reload to see the latest version, then reapply your edit.');
      }
    }
    const id = newId();
    ctx.db.insert('outline_revisions', { id, project_id: projectId, outline: input.outline, origin: input.origin ?? 'human', note: input.note ?? '', created_at: now() });
    ctx.db.update('projects', projectId, { updated_at: now() });
    return getOutlineRevision(ctx, projectId, id);
  });
}

/** Marks a revision approved, makes it the project's outline and moves the project to drafting. */
export function approveOutline(ctx: AppContext, projectId: string, revId: string): OutlineRevision {
  return ctx.db.tx(() => {
    const p = getProject(ctx, projectId);
    const rev = getOutlineRevision(ctx, projectId, revId);
    if (!rev.outline.chapters.length || !rev.outline.chapters.some((c) => c.sections.length)) {
      throw badInput('The outline has no sections yet.', 'Add at least one chapter with one section before approving.');
    }
    ctx.db.update('outline_revisions', revId, { approved_at: rev.approvedAt ?? now() });
    ctx.db.update('projects', projectId, { outline_rev_id: revId, updated_at: now() });
    if (['sources', 'mapping', 'outline'].includes(p.stage)) setStage(ctx, projectId, 'drafting');
    return getOutlineRevision(ctx, projectId, revId);
  });
}

/** Where a node lives in an outline. Chapters hold the intro node, sections hold the text. */
export interface OutlineNode { kind: 'section' | 'chapter-intro'; chapterId: string; chapterIndex: number; nodeId: string; title: string }

export function findNode(outline: Outline, nodeId: string): OutlineNode | null {
  for (const [i, c] of outline.chapters.entries()) {
    if (c.id === nodeId) return { kind: 'chapter-intro', chapterId: c.id, chapterIndex: i, nodeId, title: c.title };
    const s = c.sections.find((x) => x.id === nodeId);
    if (s) return { kind: 'section', chapterId: c.id, chapterIndex: i, nodeId, title: s.title };
  }
  return null;
}
