import { rmSync } from 'node:fs';
import { bookOptionsSchema, type BookOptions, type Project, type ProjectInput, type ProjectStage, type ProjectSummary } from '@smartbuilder/domain';
import { paths } from '../config.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { conflict, notFound } from './errors.ts';
import { placeholders, type Rec } from './util.ts';

const ACTIVE_RUN = ['running', 'pausing', 'paused', 'waiting', 'cancelling'];

export function mapProject(r: Rec): Project {
  return {
    id: r.id, slug: r.slug, title: r.title, subject: r.subject, authors: json(r.authors, []), language: r.language,
    audience: r.audience, goals: r.goals, options: bookOptionsSchema.parse(json(r.options, {})), stage: r.stage as ProjectStage,
    outlineRevId: r.outline_rev_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at ?? null,
  };
}

export function findProject(ctx: AppContext, id: string): Project | null {
  const r = ctx.db.get<Rec>('SELECT * FROM projects WHERE id = ?', id);
  return r ? mapProject(r) : null;
}

export function getProject(ctx: AppContext, id: string): Project {
  const p = findProject(ctx, id);
  if (!p) throw notFound('This project');
  return p;
}

function assertSlugFree(ctx: AppContext, slug: string, exceptId?: string) {
  const clash = ctx.db.get<Rec>('SELECT id FROM projects WHERE slug = ? AND id != ?', slug, exceptId ?? '');
  if (clash) throw conflict(`Another project already uses the short name "${slug}".`, 'Choose a different short name.', 'slug');
}

export function createProject(ctx: AppContext, input: ProjectInput): Project {
  return ctx.db.tx(() => {
    assertSlugFree(ctx, input.slug);
    const id = newId();
    const t = now();
    ctx.db.insert('projects', {
      id, slug: input.slug, title: input.title, subject: input.subject, authors: input.authors, language: input.language,
      audience: input.audience, goals: input.goals, options: input.options, stage: 'sources', created_at: t, updated_at: t,
    });
    return getProject(ctx, id);
  });
}

export function listProjects(ctx: AppContext): ProjectSummary[] {
  return ctx.db.all<Rec>('SELECT * FROM projects ORDER BY (archived_at IS NOT NULL), updated_at DESC').map((r) => summarize(ctx, mapProject(r)));
}

export function getProjectSummary(ctx: AppContext, id: string): ProjectSummary {
  return summarize(ctx, getProject(ctx, id));
}

function countSections(ctx: AppContext, p: Project): number {
  const row = p.outlineRevId
    ? ctx.db.get<Rec>('SELECT outline FROM outline_revisions WHERE id = ?', p.outlineRevId)
    : ctx.db.get<Rec>('SELECT outline FROM outline_revisions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1', p.id);
  const outline = json<{ chapters?: { sections?: unknown[] }[] }>(row?.outline, {});
  return (outline.chapters ?? []).reduce((n, c) => n + (c.sections?.length ?? 0), 0);
}

function summarize(ctx: AppContext, p: Project): ProjectSummary {
  const n = (sql: string) => Number(ctx.db.get<Rec>(sql, p.id)?.n ?? 0);
  const run = ctx.db.get<Rec>(`SELECT id FROM runs WHERE project_id = ? AND status IN (${placeholders(ACTIVE_RUN.length)}) ORDER BY rowid DESC LIMIT 1`, p.id, ...ACTIVE_RUN);
  return {
    ...p,
    counts: {
      resources: n('SELECT COUNT(*) AS n FROM resources WHERE project_id = ?'),
      sections: countSections(ctx, p),
      drafted: n(`SELECT COUNT(DISTINCT node_id) AS n FROM content_revisions WHERE project_id = ? AND status = 'current' AND kind = 'section'`),
      questions: n('SELECT COUNT(*) AS n FROM questions WHERE project_id = ?'),
      openIssues: n(`SELECT COUNT(*) AS n FROM review_issues WHERE project_id = ? AND status IN ('open', 'proposed')`),
    },
    activeRun: run ? ctx.queue.runSummary(run.id) : null,
  };
}

export type ProjectPatch = Partial<Omit<ProjectInput, 'options'>> & { options?: Partial<BookOptions> };

/** Options are merged key by key so a patch never resets the toggles it does not mention. */
export function updateProject(ctx: AppContext, id: string, patch: ProjectPatch): Project {
  return ctx.db.tx(() => {
    const cur = getProject(ctx, id);
    if (patch.slug && patch.slug !== cur.slug) assertSlugFree(ctx, patch.slug, id);
    const { options, ...rest } = patch;
    const values: Record<string, unknown> = { updated_at: now() };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) values[k] = v;
    if (options) values.options = bookOptionsSchema.parse({ ...cur.options, ...options });
    ctx.db.update('projects', id, values);
    return getProject(ctx, id);
  });
}

export function setStage(ctx: AppContext, id: string, stage: ProjectStage) {
  ctx.db.update('projects', id, { stage, updated_at: now() });
}

export function touchProject(ctx: AppContext, id: string) {
  ctx.db.update('projects', id, { updated_at: now() });
}

export function archiveProject(ctx: AppContext, id: string): Project {
  getProject(ctx, id);
  ctx.db.update('projects', id, { archived_at: now(), updated_at: now() });
  return getProject(ctx, id);
}

/** Deletes rows and the project folder. The NotebookLM notebook, if any, stays: it lives on Google's side. */
export function deleteProject(ctx: AppContext, id: string): { remoteNotebookKept: boolean } {
  getProject(ctx, id);
  const remoteNotebookKept = !!ctx.db.get('SELECT 1 FROM notebooks WHERE project_id = ?', id);
  for (const run of ctx.db.all<Rec>(`SELECT id FROM runs WHERE project_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`, id)) ctx.queue.cancel(run.id);
  ctx.db.tx(() => {
    // pages_fts is a standalone FTS table, so its rows are not removed by the cascade.
    ctx.db.run('DELETE FROM pages_fts WHERE rowid IN (SELECT p.rowid FROM pages p JOIN resources r ON r.id = p.resource_id WHERE r.project_id = ?)', id);
    ctx.db.run('DELETE FROM usage WHERE project_id = ?', id);
    ctx.db.run('DELETE FROM events WHERE project_id = ?', id);
    ctx.db.run('DELETE FROM projects WHERE id = ?', id);
  });
  rmSync(paths.project(ctx.config, id), { recursive: true, force: true });
  return { remoteNotebookKept };
}
