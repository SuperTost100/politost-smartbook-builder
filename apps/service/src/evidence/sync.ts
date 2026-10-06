// One NotebookLM notebook per project (more when one fills up). Each resource is uploaded once per sha256.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TaskError } from '../queue/queue.ts';
import { paths } from '../config.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { addFileSource, createNotebook, deleteSource, isSourceLimit, listSources, nlmFailure, NlmCallError, notebookCapacity, usageRetryAfter } from './nlm.ts';

interface ResourceRow { id: string; kind: string; filename: string; sha256: string; path: string }
interface NotebookRow { id: string; remote_id: string; title: string }
interface SourceRow { resource_id: string; notebook_id: string; remote_source_id: string | null; sha256: string; status: string }

const locks = new Map<string, Promise<unknown>>();

/** Runs fn after earlier calls with the same key finish. Concurrent tasks for one project must not upload the same file twice. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  const cleanup = () => {
    if (locks.get(key) === next) locks.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

/** Notebooks seen to be full this process, in addition to the count-based check. */
const fullRemote = new Set<string>();

export function resetSyncState() {
  fullRemote.clear();
}

export const sourceTitle = (r: { filename: string; sha256: string }) => `${r.filename} [${r.sha256.slice(0, 8)}]`;

/** Ensures the project's notebook exists and every included resource is uploaded once (sha-tracked). */
export function syncNotebook(ctx: AppContext, projectId: string, signal?: AbortSignal): Promise<{ notebookId: string; uploaded: number; skipped: number }> {
  return withLock(projectId, () => syncLocked(ctx, projectId, signal));
}

async function syncLocked(ctx: AppContext, projectId: string, signal?: AbortSignal) {
  const project = ctx.db.get<{ title: string }>('SELECT title FROM projects WHERE id = ?', projectId);
  if (!project) throw new TaskError(`Unknown project ${projectId}`, 'input');
  const resources = ctx.db.all<ResourceRow>(
    `SELECT id, kind, filename, sha256, path FROM resources WHERE project_id = ? AND included = 1 AND status = 'ready' ORDER BY created_at, id`,
    projectId,
  );

  let uploaded = 0;
  let skipped = 0;
  for (const r of resources) {
    signal?.throwIfAborted();
    const row = ctx.db.get<SourceRow>('SELECT * FROM notebook_sources WHERE resource_id = ?', r.id);
    if (row && row.sha256 === r.sha256 && row.status === 'ready' && row.remote_source_id) {
      skipped++;
      continue;
    }
    const title = sourceTitle(r);

    // A previous attempt may have died after the remote call. Look for the source before uploading again.
    if (row && row.sha256 === r.sha256 && row.status === 'uploading') {
      const nb = ctx.db.get<NotebookRow>('SELECT * FROM notebooks WHERE id = ?', row.notebook_id);
      const found = nb ? await findRemote(nb.remote_id, title, r.filename, ctx, signal) : null;
      if (found) {
        ctx.db.run(`UPDATE notebook_sources SET status = 'ready', remote_source_id = ? WHERE resource_id = ?`, found, r.id);
        skipped++;
        continue;
      }
    }

    const staleRemote = row && row.sha256 !== r.sha256 ? row.remote_source_id : null;
    await uploadResource(ctx, project.title, projectId, r, title, signal);
    uploaded++;
    if (staleRemote) await deleteSource(staleRemote, signal).catch(() => undefined);
  }

  const first = ctx.db.get<NotebookRow>('SELECT * FROM notebooks WHERE project_id = ? ORDER BY created_at, id LIMIT 1', projectId)
    ?? (await createProjectNotebook(ctx, project.title, projectId, signal));
  return { notebookId: first.remote_id, uploaded, skipped };
}

/** Matches by the exact "<filename> [sha8]" title. Falls back to an unclaimed source still carrying the bare filename (died before the rename) and renames nothing: the title is fixed on the next full sync. */
async function findRemote(remoteNotebook: string, title: string, filename: string, ctx: AppContext, signal?: AbortSignal): Promise<string | null> {
  const sources = await listSources(remoteNotebook, signal).catch((err) => {
    if (err instanceof NlmCallError) throw nlmFailure(err.text);
    throw err;
  });
  const exact = sources.find((s) => s.title === title);
  if (exact) return exact.id;
  const claimed = new Set(ctx.db.all<{ remote_source_id: string }>('SELECT remote_source_id FROM notebook_sources WHERE remote_source_id IS NOT NULL').map((x) => x.remote_source_id));
  const bare = sources.filter((s) => s.title === filename && !claimed.has(s.id));
  return bare.length === 1 ? bare[0].id : null;
}

async function createProjectNotebook(ctx: AppContext, projectTitle: string, projectId: string, signal?: AbortSignal): Promise<NotebookRow> {
  const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notebooks WHERE project_id = ?', projectId)?.n ?? 0;
  const title = `${projectTitle} · Smart Builder${n ? ` (${n + 1})` : ''}`;
  const remote = await createNotebook(title, signal).catch(rethrowNlm);
  const row: NotebookRow = { id: newId(), remote_id: remote, title };
  ctx.db.insert('notebooks', { ...row, project_id: projectId, created_at: now() });
  return row;
}

async function pickNotebook(ctx: AppContext, projectTitle: string, projectId: string, resourceId: string, signal?: AbortSignal): Promise<NotebookRow> {
  const capacity = await notebookCapacity();
  const books = ctx.db.all<NotebookRow>('SELECT * FROM notebooks WHERE project_id = ? ORDER BY created_at, id', projectId);
  for (const nb of books) {
    if (fullRemote.has(nb.remote_id)) continue;
    const count = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notebook_sources WHERE notebook_id = ? AND resource_id != ?', nb.id, resourceId)?.n ?? 0;
    if (count < capacity) return nb;
  }
  return createProjectNotebook(ctx, projectTitle, projectId, signal);
}

async function uploadResource(ctx: AppContext, projectTitle: string, projectId: string, r: ResourceRow, title: string, signal?: AbortSignal) {
  const { file, cleanup } = await materialize(ctx, projectId, r);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const nb = await pickNotebook(ctx, projectTitle, projectId, r.id, signal);
      // Recorded before the remote call: a crash leaves 'uploading', which the next sync resolves by listing the notebook.
      ctx.db.run(
        `INSERT INTO notebook_sources (resource_id, notebook_id, remote_source_id, sha256, status) VALUES (?, ?, NULL, ?, 'uploading')
         ON CONFLICT(resource_id) DO UPDATE SET notebook_id = excluded.notebook_id, remote_source_id = NULL, sha256 = excluded.sha256, status = 'uploading'`,
        r.id, nb.id, r.sha256,
      );
      try {
        const sourceId = await addFileSource(nb.remote_id, file, title, signal);
        ctx.db.run(`UPDATE notebook_sources SET status = 'ready', remote_source_id = ? WHERE resource_id = ?`, sourceId, r.id);
        return;
      } catch (err) {
        if (err instanceof NlmCallError) {
          if (isSourceLimit(err.text) && attempt === 0) {
            fullRemote.add(nb.remote_id);
            continue;
          }
          throw nlmFailure(err.text, await usageRetryAfter().catch(() => undefined));
        }
        throw err;
      }
    }
    throw new TaskError('Every NotebookLM notebook for this project is full.', 'temporary');
  } finally {
    await cleanup();
  }
}

function rethrowNlm(err: unknown): never {
  if (err instanceof NlmCallError) throw nlmFailure(err.text);
  throw err;
}

/** The file to upload: the original for pdf/docx/pptx, a Markdown file built from the extracted text for md and url resources. */
async function materialize(ctx: AppContext, projectId: string, r: ResourceRow): Promise<{ file: string; cleanup: () => Promise<void> }> {
  if (r.kind === 'pdf' || r.kind === 'docx' || r.kind === 'pptx') {
    const candidates = [r.path, join(ctx.config.dataDir, r.path), join(paths.project(ctx.config, projectId), r.path), join(paths.resources(ctx.config, projectId), r.filename)];
    const found = candidates.find((c) => existsSync(c));
    if (!found) throw new TaskError(`The stored file for ${r.filename} is missing.`, 'input', 'Remove the source and add it again.');
    return { file: found, cleanup: async () => undefined };
  }
  const pages = ctx.db.all<{ text: string; transcript: string | null }>('SELECT text, transcript FROM pages WHERE resource_id = ? ORDER BY idx', r.id);
  let text = pages.map((p) => (p.transcript?.trim() ? p.transcript : p.text)).join('\n\n').trim();
  if (!text) {
    const meta = json<{ derivedFile?: string }>(ctx.db.get<{ meta: string }>('SELECT meta FROM resources WHERE id = ?', r.id)?.meta, {});
    const stored = [meta.derivedFile ? join(dirname(r.path), meta.derivedFile) : '', r.path, join(ctx.config.dataDir, r.path)].find((c) => c && existsSync(c));
    if (stored) text = readFileSync(stored, 'utf8');
  }
  if (!text) throw new TaskError(`${r.filename} has no text to upload.`, 'input');
  // Written to a file: a whole document does not fit in a command-line argument.
  const dir = paths.tmp(ctx.config);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `nlm-${r.sha256.slice(0, 12)}.md`);
  writeFileSync(file, text);
  return { file, cleanup: () => rm(file, { force: true }) };
}
