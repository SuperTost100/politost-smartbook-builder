import type { Outline, OutlineChapter, OutlineSection, Project, Topic } from '@smartbuilder/domain';
import { bookOptionsSchema } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json } from '../db/db.ts';
import { TaskError } from '../queue/queue.ts';

export function loadProject(ctx: AppContext, projectId: string): Project {
  const r = ctx.db.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!r) throw new TaskError('The book no longer exists.', 'fatal');
  return {
    id: r.id as string, slug: r.slug as string, title: r.title as string, subject: r.subject as string,
    authors: json(r.authors, []), language: r.language as string, audience: r.audience as string, goals: r.goals as string,
    options: bookOptionsSchema.parse(json(r.options, {})), stage: r.stage as Project['stage'], outlineRevId: (r.outline_rev_id as string) ?? null,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string, archivedAt: (r.archived_at as string) ?? null,
  };
}

/** The approved outline (or the newest one when allowUnapproved). */
export function loadOutline(ctx: AppContext, projectId: string, allowUnapproved = false): { revId: string; outline: Outline } | null {
  const p = ctx.db.get<{ outline_rev_id: string | null }>('SELECT outline_rev_id FROM projects WHERE id = ?', projectId);
  let row = p?.outline_rev_id ? ctx.db.get<{ id: string; outline: string }>('SELECT id, outline FROM outline_revisions WHERE id = ?', p.outline_rev_id) : undefined;
  if (!row && allowUnapproved) row = ctx.db.get('SELECT id, outline FROM outline_revisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', projectId);
  return row ? { revId: row.id, outline: json(row.outline, { chapters: [], exclusions: [], notation: '' }) } : null;
}

export function findSection(outline: Outline, nodeId: string): { chapter: OutlineChapter; section: OutlineSection; chapterIndex: number; sectionIndex: number } | null {
  for (const [ci, chapter] of outline.chapters.entries()) {
    for (const [si, section] of chapter.sections.entries()) if (section.id === nodeId) return { chapter, section, chapterIndex: ci, sectionIndex: si };
  }
  return null;
}

export function loadTopics(ctx: AppContext, projectId: string): Topic[] {
  return ctx.db.all('SELECT * FROM topics WHERE project_id = ? ORDER BY rowid', projectId).map((t) => ({
    id: t.id as string, projectId, name: t.name as string, aliases: json(t.aliases, []), description: t.description as string,
    prerequisites: json(t.prerequisites, []), sources: json(t.sources, []), examSessions: Number(t.exam_sessions), priority: t.priority as Topic['priority'],
  }));
}

/** Current text of a content node, or null. */
export function headRevision(ctx: AppContext, projectId: string, nodeId: string): { id: string; markdown: string; origin: string } | null {
  return ctx.db.get<{ id: string; markdown: string; origin: string }>(
    `SELECT id, markdown, origin FROM content_revisions WHERE project_id = ? AND node_id = ? AND status = 'current' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    projectId, nodeId) ?? null;
}

/** Formula keys defined in a source-dialect text. */
export function formulaKeys(markdown: string): string[] {
  return [...markdown.matchAll(/:::formula\{[^}]*key="([^"]+)"[^}]*label="([^"]*)"/g)].map((m) => m[1]);
}

export function formulaKeyLabels(markdown: string): { key: string; label: string }[] {
  return [...markdown.matchAll(/:::formula\{([^}]*)\}/g)].map((m) => ({
    key: /key="([^"]+)"/.exec(m[1])?.[1] ?? '', label: /label="([^"]*)"/.exec(m[1])?.[1] ?? '',
  })).filter((x) => x.key);
}

/**
 * Strips [[n1,n2]] citation markers and returns citations keyed by block index
 * (indices match splitBlocks on the returned markdown).
 */
export function extractCitations(markdown: string, splitBlocks: (md: string) => { text: string }[]): { markdown: string; citations: Record<string, string[]> } {
  const marked = splitBlocks(markdown);
  const citations: Record<string, string[]> = {};
  const clean: string[] = [];
  marked.forEach((b) => {
    const ids = [...b.text.matchAll(/\[\[([^\]]+)\]\]/g)].flatMap((m) => m[1].split(/[,\s]+/).filter(Boolean));
    const text = b.text.replace(/\s*\[\[[^\]]+\]\]/g, '').replace(/[ \t]+$/gm, '');
    if (!text.trim()) return;
    if (ids.length) citations[String(clean.length)] = [...new Set(ids)];
    clean.push(text);
  });
  return { markdown: clean.join('\n\n'), citations };
}

export function chapterPlanText(chapter: OutlineChapter, current?: string) {
  return chapter.sections.map((s) => `${s.id === current ? '►' : '-'} ${s.title} [${s.id}]: ${s.objectives.join('; ')}`).join('\n');
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}\n[…]`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x';
