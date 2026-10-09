// Prepare: extract sources, recover their indexes, split exams into questions, build the topic map.
import { createHash } from 'node:crypto';
import type { Question } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { extractResource, segmentQuestions } from '../extract/index.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { classifyPrompt, classifySchema, inferIndexPrompt, inferredIndexSchema, topicsPrompt, topicsSchema } from './prompts.ts';
import { COUNTED_QUESTION_SQL, chunk, loadProject, truncate } from './util.ts';
import { questionsChanged } from '../repo/questions.ts';

export async function resourceExtract(ctx: AppContext, t: TaskContext) {
  const resourceId = t.task.input.resourceId as string;
  const r = ctx.db.get<{ status: string; page_count: number }>('SELECT status, page_count FROM resources WHERE id = ?', resourceId);
  if (!r) return { skipped: 'resource deleted' };
  // Already extracted in an earlier attempt or run.
  if (r.status === 'ready' && !t.task.input.force) return { pages: r.page_count, reused: true };
  ctx.db.run(`UPDATE resources SET status = 'extracting', error = NULL WHERE id = ?`, resourceId);
  ctx.events.emit('resource.state', { resourceId, status: 'extracting' }, { projectId: t.task.projectId });
  try {
    const out = await extractResource(ctx, resourceId, t.signal);
    ctx.events.emit('resource.state', { resourceId, status: 'ready', pages: out.pages }, { projectId: t.task.projectId });
    return { pages: out.pages, garbled: out.garbled, indexed: !!out.index };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.db.run(`UPDATE resources SET status = 'failed', error = ? WHERE id = ?`, message, resourceId);
    ctx.events.emit('resource.state', { resourceId, status: 'failed', error: message }, { projectId: t.task.projectId });
    throw new TaskError(message, 'input', 'Replace the file or remove it from the book, then retry.');
  }
}

/** Sources without bookmarks get an inferred index from the first lines of each page. */
export async function resourceIndex(ctx: AppContext, t: TaskContext) {
  const resourceId = t.task.input.resourceId as string;
  const existing = ctx.db.get('SELECT origin FROM source_indexes WHERE resource_id = ?', resourceId);
  if (existing) return { origin: existing.origin, reused: true };
  const res = ctx.db.get<{ filename: string; role: string }>('SELECT filename, role FROM resources WHERE id = ?', resourceId);
  if (!res) return { skipped: true };
  const pages = ctx.db.all<{ idx: number; text: string; transcript: string | null }>('SELECT idx, text, transcript FROM pages WHERE resource_id = ? ORDER BY idx', resourceId);
  if (!pages.length) return { skipped: 'no pages' };
  const entries: { title: string; level: number; page: number }[] = [];
  // ~150 pages per call keeps the prompt small and the call fast.
  for (const group of chunk(pages, 150)) {
    const heads = group.map((p) => `page ${p.idx + 1}: ${firstLines(p.transcript || p.text)}`).join('\n');
    const { data } = await runRole(ctx, {
      role: 'bulk', ...inferIndexPrompt({ filename: res.filename, heads }), schema: inferredIndexSchema,
      projectId: t.task.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    entries.push(...data.entries.map((e) => ({ ...e, page: e.page - 1 })));
  }
  ctx.db.run('INSERT OR REPLACE INTO source_indexes (resource_id, origin, entries) VALUES (?, ?, ?)', resourceId, 'inferred', JSON.stringify(entries));
  return { origin: 'inferred', entries: entries.length };
}

function firstLines(text: string) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 2).slice(0, 2).join(' / ').slice(0, 140);
}

/** Exams and exercise collections become authentic questions. Duplicate copies of a session are skipped. */
export async function resourceQuestions(ctx: AppContext, t: TaskContext) {
  const resourceId = t.task.input.resourceId as string;
  const res = ctx.db.get<{ role: string; project_id: string }>('SELECT role, project_id FROM resources WHERE id = ?', resourceId);
  if (!res || !['exams', 'exercises', 'mixed'].includes(res.role)) return { skipped: true };
  const existing = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM questions WHERE resource_id = ?', resourceId);
  if (existing && existing.n > 0 && !t.task.input.force) return { questions: existing.n, reused: true };
  const rows = segmentQuestions(ctx, resourceId);
  let inserted = 0;
  let duplicates = 0;
  const insertedIds: string[] = [];
  ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM questions WHERE resource_id = ? AND origin = 'authentic'`, resourceId);
    for (const q of rows) {
      // The same session can appear in two yearly files.
      const dup = q.kind === 'exam' && q.examDate && q.number
        ? ctx.db.get(`SELECT id FROM questions WHERE project_id = ? AND kind = 'exam' AND exam_group = ? AND number = ? AND resource_id != ?`, res.project_id, q.examGroup, q.number, resourceId)
        : undefined;
      if (dup) { duplicates++; continue; }
      const id = newId();
      insertedIds.push(id);
      ctx.db.insert('questions', {
        id, project_id: res.project_id, kind: q.kind, origin: 'authentic', resource_id: resourceId,
        page_from: q.pageFrom, page_to: q.pageTo, exam_group: q.examGroup, exam_date: q.examDate, number: q.number,
        statement: q.statement, hint: q.hint ?? '', solution: q.solution ?? '', difficulty: q.difficulty ?? 'medio',
        topic_ids: [], chapter_id: null, status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(),
      });
      inserted++;
    }
  });
  questionsChanged(ctx, res.project_id, insertedIds);
  return { questions: inserted, duplicates };
}

/** One topic-map task at a time per project: two prepare tasks must not rebuild and classify over each other. */
const topicLocks = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (topicLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  topicLocks.set(key, tail);
  void tail.then(() => { if (topicLocks.get(key) === tail) topicLocks.delete(key); });
  return run;
}

/** Labels R1, R2, ... for the resources shown to the model, assigned once and used for both the prompt and decoding the answer. */
export function labelResources(resources: { id: string }[]) {
  const byLabel = new Map<string, string>();
  const labelOf = new Map<string, string>();
  resources.forEach((r, i) => { byLabel.set(`R${i + 1}`, r.id); labelOf.set(r.id, `R${i + 1}`); });
  return { byLabel, labelOf };
}

/** Changes whenever the sources behind the topic map change: which resources, their role and content, and their index entries. */
export function topicFingerprint(ctx: AppContext, resources: { id: string; role: string; sha256: string }[]): string {
  const parts = resources.map((r) => {
    const idx = ctx.db.get<{ origin: string; entries: string }>('SELECT origin, entries FROM source_indexes WHERE resource_id = ?', r.id);
    return [r.id, r.role, r.sha256, idx ? createHash('sha256').update(`${idx.origin}\n${idx.entries}`).digest('hex') : ''];
  });
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Topic map from the theory source indexes, then question → topic classification and exam frequency. */
export function topicsMap(ctx: AppContext, t: TaskContext) {
  return serialized(t.task.projectId, () => topicsMapLocked(ctx, t));
}

async function topicsMapLocked(ctx: AppContext, t: TaskContext) {
  const projectId = t.task.projectId;
  const project = loadProject(ctx, projectId);
  const resources = ctx.db.all<{ id: string; filename: string; role: string; sha256: string }>(`SELECT id, filename, role, sha256 FROM resources WHERE project_id = ? AND included = 1 AND status = 'ready' ORDER BY created_at`, projectId);
  // The sources that describe the subject (exams and exercise collections do not).
  const theory = resources.filter((r) => r.role !== 'exams' && r.role !== 'exercises');
  const { byLabel, labelOf } = labelResources(theory);
  const fingerprint = topicFingerprint(ctx, theory);
  const stored = ctx.db.get<{ topic_fingerprint: string | null }>('SELECT topic_fingerprint FROM projects WHERE id = ?', projectId)?.topic_fingerprint ?? null;

  let topicCount = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM topics WHERE project_id = ?', projectId)?.n ?? 0;
  // A map made before fingerprints existed is kept as it is (the author may already have an outline on it) unless forced.
  if (stored === null && topicCount && !t.task.input.force) ctx.db.run('UPDATE projects SET topic_fingerprint = ? WHERE id = ?', fingerprint, projectId);
  else if (!topicCount || stored !== fingerprint || t.task.input.force) {
    const indexes = sourceIndexesText(ctx, theory, labelOf);
    if (!indexes.trim()) throw new TaskError('No theory source has a usable index yet.', 'input', 'Add at least one theory source (notes or a textbook), then run Prepare again.');
    const { data } = await runRole(ctx, {
      role: 'editor', ...topicsPrompt({ subject: project.subject, language: project.language, goals: project.goals, indexes }), schema: topicsSchema,
      projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    ctx.db.tx(() => {
      // A priority the author set by hand survives the new map when the topic keeps its key.
      const locked = new Map(ctx.db.all<{ id: string; priority: string }>('SELECT id, priority FROM topics WHERE project_id = ? AND priority_locked = 1', projectId).map((r) => [r.id, r.priority]));
      ctx.db.run('DELETE FROM topics WHERE project_id = ?', projectId);
      for (const tp of data.topics) {
        const id = `${projectId.slice(0, 8)}-${tp.key}`.slice(0, 80);
        ctx.db.insert('topics', {
          id, project_id: projectId, name: tp.name, aliases: tp.aliases, description: tp.description,
          prerequisites: tp.prerequisites.map((k) => `${projectId.slice(0, 8)}-${k}`.slice(0, 80)),
          sources: tp.sources.filter((s) => byLabel.has(s.resource)).map((s) => ({ resourceId: byLabel.get(s.resource), pageFrom: s.pageFrom - 1, pageTo: s.pageTo - 1 })),
          exam_sessions: 0, priority: locked.get(id) ?? 'normal', priority_locked: locked.has(id) ? 1 : 0,
        });
      }
      // New topics: every authentic exam question is classified again against them.
      ctx.db.run(`UPDATE questions SET topic_ids = '[]', updated_at = ? WHERE project_id = ? AND origin = 'authentic' AND kind = 'exam'`, now(), projectId);
      ctx.db.run('UPDATE projects SET topic_fingerprint = ? WHERE id = ?', fingerprint, projectId);
    });
    topicCount = data.topics.length;
  }

  // Classify exam questions that have no topics yet, in batches. (Exercise collections are not used for priorities or practice.)
  const topics = ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM topics WHERE project_id = ?', projectId);
  const keyOf = (id: string) => id.slice(9);
  const topicList = topics.map((tp) => `${keyOf(tp.id)}: ${tp.name}`).join('\n');
  // Only sources that are still in the book count; each question is read with its rev so an edit made while the model works wins.
  const pending = ctx.db.all<{ id: string; statement: string; exam_group: string | null; rev: number }>(
    `SELECT id, statement, exam_group, rev FROM questions WHERE project_id = ? AND topic_ids = '[]' AND origin = 'authentic' AND kind = 'exam' AND ${COUNTED_QUESTION_SQL}`, projectId);
  let classified = 0;
  for (const group of chunk(pending, 20)) {
    if (t.signal.aborted) break;
    const revOf = new Map(group.map((q) => [q.id, Number(q.rev)]));
    const questions = group.map((q) => `[${q.id}] ${truncate(q.statement.replace(/\s+/g, ' '), 1500)}`).join('\n\n');
    const { data } = await runRole(ctx, {
      role: 'bulk', ...classifyPrompt({ topics: topicList, questions }), schema: classifySchema,
      projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    const valid = new Set(topics.map((tp) => keyOf(tp.id)));
    const done: string[] = [];
    ctx.db.tx(() => {
      for (const item of data.items) {
        // Only ids of this batch, and only if the question is still at the revision the model saw.
        const rev = revOf.get(item.id);
        if (rev === undefined) continue;
        const ids = item.topics.filter((k) => valid.has(k)).map((k) => `${projectId.slice(0, 8)}-${k}`.slice(0, 80));
        // Committed per batch, so a retry only classifies what is left.
        const changed = ctx.db.run('UPDATE questions SET topic_ids = ?, difficulty = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND project_id = ? AND rev = ?', JSON.stringify(ids.length ? ids : ['unmapped']), item.difficulty, now(), item.id, projectId, rev).changes;
        if (changed) { classified++; done.push(item.id); }
      }
    });
    questionsChanged(ctx, projectId, done);
    t.progress(`Classified ${classified} of ${pending.length} questions`);
  }
  computePriorities(ctx, projectId);
  ctx.db.run(`UPDATE projects SET stage = 'outline', updated_at = ? WHERE id = ? AND stage IN ('sources', 'mapping')`, now(), projectId);
  return { topics: topicCount, classified };
}

export function sourceIndexesText(ctx: AppContext, resources: { id: string; filename: string }[], labelOf: Map<string, string> = labelResources(resources).labelOf) {
  return resources.map((r) => {
    const idx = ctx.db.get<{ origin: string; entries: string }>('SELECT origin, entries FROM source_indexes WHERE resource_id = ?', r.id);
    if (!idx) return '';
    const entries = json<{ title: string; level: number; page: number }[]>(idx.entries, []);
    return `${labelOf.get(r.id)} ${r.filename} (${idx.origin})\n${entries.map((e) => `${e.level} | ${e.title} | ${e.page + 1}`).join('\n')}`;
  }).filter(Boolean).join('\n\n');
}

/**
 * Exam frequency = distinct sessions with at least one question on the topic.
 * high: at least half the sessions of the most tested topic; low: never tested and not a prerequisite of a tested topic.
 */
export function computePriorities(ctx: AppContext, projectId: string) {
  const qs = ctx.db.all<{ topic_ids: string; exam_group: string | null }>(`SELECT topic_ids, exam_group FROM questions WHERE project_id = ? AND kind = 'exam' AND exam_group IS NOT NULL AND ${COUNTED_QUESTION_SQL}`, projectId);
  const sessions = new Map<string, Set<string>>();
  for (const q of qs) for (const id of json<string[]>(q.topic_ids, [])) {
    if (!sessions.has(id)) sessions.set(id, new Set());
    sessions.get(id)!.add(q.exam_group!);
  }
  const topics = ctx.db.all<{ id: string; prerequisites: string }>('SELECT id, prerequisites FROM topics WHERE project_id = ?', projectId);
  const max = Math.max(0, ...[...sessions.values()].map((s) => s.size));
  const prereqOfTested = new Set<string>();
  for (const tp of topics) if ((sessions.get(tp.id)?.size ?? 0) > 0) for (const p of json<string[]>(tp.prerequisites, [])) prereqOfTested.add(p);
  ctx.db.tx(() => {
    for (const tp of topics) {
      const n = sessions.get(tp.id)?.size ?? 0;
      const priority = max > 0 && n >= Math.max(2, max / 2) ? 'high' : n === 0 && !prereqOfTested.has(tp.id) && max > 0 ? 'low' : 'normal';
      // Exam counts always refresh; the priority only when the author has not set it by hand.
      ctx.db.run('UPDATE topics SET exam_sessions = ?, priority = CASE WHEN priority_locked = 1 THEN priority ELSE ? END WHERE id = ?', n, priority, tp.id);
    }
  });
}

export type { Question };
