import { existsSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Page, PageQuality, Resource, ResourceKind, ResourceRole, ResourceStatus, SourceIndex, SourceIndexEntry, Topic } from '@smartbuilder/domain';
import { paths } from '../config.ts';
import type { AppContext } from '../context.ts';
import { json } from '../db/db.ts';
import { notFound } from './errors.ts';
import { bool, type Rec } from './util.ts';

// ---------- resources ----------

/** pagesNeedingVision counts garbled and empty pages; pagesTranscribed counts pages that already have a transcript. */
const RESOURCE_SQL = `
  SELECT r.*,
    (SELECT COUNT(*) FROM pages p WHERE p.resource_id = r.id AND p.quality IN ('garbled', 'empty')) AS vision_pages,
    (SELECT COUNT(*) FROM pages p WHERE p.resource_id = r.id AND p.transcript IS NOT NULL) AS transcribed_pages
  FROM resources r`;

export function mapResource(r: Rec): Resource {
  return {
    id: r.id, projectId: r.project_id, kind: r.kind as ResourceKind, role: r.role as ResourceRole, filename: r.filename, url: r.url ?? null,
    sha256: r.sha256, size: Number(r.size), included: bool(r.included), status: r.status as ResourceStatus, error: r.error ?? null,
    pageCount: Number(r.page_count), pagesNeedingVision: Number(r.vision_pages ?? 0), pagesTranscribed: Number(r.transcribed_pages ?? 0),
    createdAt: r.created_at,
  };
}

export function listResources(ctx: AppContext, projectId: string): Resource[] {
  return ctx.db.all<Rec>(`${RESOURCE_SQL} WHERE r.project_id = ? ORDER BY r.created_at, r.rowid`, projectId).map(mapResource);
}

export function findResource(ctx: AppContext, id: string): Resource | null {
  const r = ctx.db.get<Rec>(`${RESOURCE_SQL} WHERE r.id = ?`, id);
  return r ? mapResource(r) : null;
}

export function getResource(ctx: AppContext, id: string): Resource {
  const r = findResource(ctx, id);
  if (!r) throw notFound('This source');
  return r;
}

export function updateResource(ctx: AppContext, id: string, patch: { role?: ResourceRole; included?: boolean }): Resource {
  getResource(ctx, id);
  const values: Record<string, unknown> = {};
  if (patch.role !== undefined) values.role = patch.role;
  if (patch.included !== undefined) values.included = patch.included;
  ctx.db.update('resources', id, values);
  return getResource(ctx, id);
}

/** Deletes the resource with its pages and removes the stored file when no other resource uses it. */
export function deleteResource(ctx: AppContext, id: string): void {
  const row = ctx.db.get<Rec>('SELECT * FROM resources WHERE id = ?', id);
  if (!row) throw notFound('This source');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM pages_fts WHERE rowid IN (SELECT rowid FROM pages WHERE resource_id = ?)', id);
    ctx.db.run('DELETE FROM resources WHERE id = ?', id);
  });
  const shared = ctx.db.get(
    'SELECT 1 FROM resources WHERE (sha256 = ? AND project_id = ?) OR path = ?', row.sha256, row.project_id, row.path ?? '');
  const projectDir = resolve(paths.project(ctx.config, row.project_id)) + sep;
  const file = typeof row.path === 'string' && row.path ? resolve(row.path) : null;
  if (!shared && file && file.startsWith(projectDir) && existsSync(file)) rmSync(file, { force: true });
  rmSync(paths.pageCache(ctx.config, row.project_id, id), { recursive: true, force: true });
}

// ---------- pages ----------

export type PageLight = Pick<Page, 'id' | 'idx' | 'label' | 'quality'>;

export function listPages(ctx: AppContext, resourceId: string): PageLight[] {
  return ctx.db.all<Rec>('SELECT id, idx, label, quality FROM pages WHERE resource_id = ? ORDER BY idx', resourceId)
    .map((r) => ({ id: r.id, idx: Number(r.idx), label: r.label, quality: r.quality as PageQuality }));
}

export function mapPage(r: Rec): Page {
  return {
    id: r.id, resourceId: r.resource_id, idx: Number(r.idx), label: r.label, text: r.text, quality: r.quality as PageQuality,
    transcript: r.transcript ?? null, transcriptModel: r.transcript_model ?? null,
  };
}

export function getPage(ctx: AppContext, resourceId: string, idx: number): Page {
  const r = ctx.db.get<Rec>('SELECT * FROM pages WHERE resource_id = ? AND idx = ?', resourceId, idx);
  if (!r) throw notFound('This page');
  return mapPage(r);
}

// ---------- source index ----------

export function getSourceIndex(ctx: AppContext, resourceId: string): SourceIndex | null {
  const r = ctx.db.get<Rec>('SELECT * FROM source_indexes WHERE resource_id = ?', resourceId);
  if (!r) return null;
  return { resourceId, origin: r.origin, entries: json<SourceIndexEntry[]>(r.entries, []) };
}

export function saveSourceIndex(ctx: AppContext, index: SourceIndex): void {
  ctx.db.run(
    'INSERT INTO source_indexes (resource_id, origin, entries) VALUES (?, ?, ?) ON CONFLICT(resource_id) DO UPDATE SET origin = excluded.origin, entries = excluded.entries',
    index.resourceId, index.origin, JSON.stringify(index.entries));
}

// ---------- topics ----------

export function mapTopic(r: Rec): Topic {
  return {
    id: r.id, projectId: r.project_id, name: r.name, aliases: json(r.aliases, []), description: r.description,
    prerequisites: json(r.prerequisites, []), sources: json(r.sources, []), examSessions: Number(r.exam_sessions), priority: r.priority,
  };
}

export function listTopics(ctx: AppContext, projectId: string): Topic[] {
  return ctx.db.all<Rec>('SELECT * FROM topics WHERE project_id = ? ORDER BY rowid', projectId).map(mapTopic);
}

export function getTopic(ctx: AppContext, id: string): Topic {
  const r = ctx.db.get<Rec>('SELECT * FROM topics WHERE id = ?', id);
  if (!r) throw notFound('This topic');
  return mapTopic(r);
}

export function updateTopic(ctx: AppContext, id: string, patch: Partial<Pick<Topic, 'name' | 'priority' | 'description'>>): Topic {
  getTopic(ctx, id);
  const values: Record<string, unknown> = {};
  for (const k of ['name', 'priority', 'description'] as const) if (patch[k] !== undefined) values[k] = patch[k];
  ctx.db.update('topics', id, values);
  return getTopic(ctx, id);
}

/** Replaces all topics of a project (used by the mapping step). */
export function replaceTopics(ctx: AppContext, projectId: string, topics: Omit<Topic, 'projectId'>[]): void {
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM topics WHERE project_id = ?', projectId);
    for (const t of topics) {
      ctx.db.insert('topics', {
        id: t.id, project_id: projectId, name: t.name, aliases: t.aliases, description: t.description, prerequisites: t.prerequisites,
        sources: t.sources, exam_sessions: t.examSessions, priority: t.priority,
      });
    }
  });
}

