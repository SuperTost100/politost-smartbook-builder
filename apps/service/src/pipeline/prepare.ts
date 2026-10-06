// Prepare: extract sources, recover their indexes, split exams into questions, build the topic map.
import type { Question } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { extractResource, segmentQuestions } from '../extract/index.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { classifyPrompt, classifySchema, inferIndexPrompt, inferredIndexSchema, topicsPrompt, topicsSchema } from './prompts.ts';
import { chunk, loadProject, truncate } from './util.ts';

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
  ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM questions WHERE resource_id = ? AND origin = 'authentic'`, resourceId);
    for (const q of rows) {
      // The same session can appear in two yearly files.
      const dup = q.kind === 'exam' && q.examDate && q.number
        ? ctx.db.get(`SELECT id FROM questions WHERE project_id = ? AND kind = 'exam' AND exam_group = ? AND number = ? AND resource_id != ?`, res.project_id, q.examGroup, q.number, resourceId)
        : undefined;
      if (dup) { duplicates++; continue; }
      ctx.db.insert('questions', {
        id: newId(), project_id: res.project_id, kind: q.kind, origin: 'authentic', resource_id: resourceId,
        page_from: q.pageFrom, page_to: q.pageTo, exam_group: q.examGroup, exam_date: q.examDate, number: q.number,
        statement: q.statement, hint: q.hint ?? '', solution: q.solution ?? '', difficulty: q.difficulty ?? 'medio',
        topic_ids: [], chapter_id: null, status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(),
      });
      inserted++;
    }
  });
  return { questions: inserted, duplicates };
}

/** Topic map from all source indexes, then question → topic classification and exam frequency. */
export async function topicsMap(ctx: AppContext, t: TaskContext) {
  const projectId = t.task.projectId;
  const project = loadProject(ctx, projectId);
  const resources = ctx.db.all<{ id: string; filename: string; role: string }>(`SELECT id, filename, role FROM resources WHERE project_id = ? AND included = 1 AND status = 'ready' ORDER BY created_at`, projectId);
  const labels = new Map(resources.map((r, i) => [`R${i + 1}`, r.id]));

  let topicCount = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM topics WHERE project_id = ?', projectId)?.n ?? 0;
  if (!topicCount || t.task.input.force) {
    const indexes = sourceIndexesText(ctx, resources.filter((r) => r.role !== 'exams' && r.role !== 'exercises'));
    if (!indexes.trim()) throw new TaskError('No theory source has a usable index yet.', 'input', 'Add at least one theory source (notes or a textbook), then run Prepare again.');
    const { data } = await runRole(ctx, {
      role: 'writer', ...topicsPrompt({ subject: project.subject, language: project.language, goals: project.goals, indexes }), schema: topicsSchema,
      projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM topics WHERE project_id = ?', projectId);
      for (const tp of data.topics) {
        ctx.db.insert('topics', {
          id: `${projectId.slice(0, 8)}-${tp.key}`.slice(0, 80), project_id: projectId, name: tp.name, aliases: tp.aliases, description: tp.description,
          prerequisites: tp.prerequisites.map((k) => `${projectId.slice(0, 8)}-${k}`.slice(0, 80)),
          sources: tp.sources.filter((s) => labels.has(s.resource)).map((s) => ({ resourceId: labels.get(s.resource), pageFrom: s.pageFrom - 1, pageTo: s.pageTo - 1 })),
          exam_sessions: 0, priority: 'normal',
        });
      }
    });
    topicCount = data.topics.length;
  }

  // Classify questions that have no topics yet, in batches.
  const topics = ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM topics WHERE project_id = ?', projectId);
  const keyOf = (id: string) => id.slice(9);
  const topicList = topics.map((tp) => `${keyOf(tp.id)}: ${tp.name}`).join('\n');
  const pending = ctx.db.all<{ id: string; statement: string; exam_group: string | null }>(`SELECT id, statement, exam_group FROM questions WHERE project_id = ? AND topic_ids = '[]' AND origin = 'authentic'`, projectId);
  let classified = 0;
  for (const group of chunk(pending, 40)) {
    if (t.signal.aborted) break;
    const questions = group.map((q) => `[${q.id}] ${truncate(q.statement.replace(/\s+/g, ' '), 500)}`).join('\n\n');
    const { data } = await runRole(ctx, {
      role: 'bulk', ...classifyPrompt({ topics: topicList, questions }), schema: classifySchema,
      projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    const valid = new Set(topics.map((tp) => keyOf(tp.id)));
    ctx.db.tx(() => {
      for (const item of data.items) {
        const ids = item.topics.filter((k) => valid.has(k)).map((k) => `${projectId.slice(0, 8)}-${k}`.slice(0, 80));
        // Committed per batch, so a retry only classifies what is left.
        ctx.db.run('UPDATE questions SET topic_ids = ?, difficulty = ?, updated_at = ? WHERE id = ? AND project_id = ?', JSON.stringify(ids.length ? ids : ['unmapped']), item.difficulty, now(), item.id, projectId);
        classified++;
      }
    });
    t.progress(`Classified ${classified} of ${pending.length} questions`);
  }
  computePriorities(ctx, projectId);
  ctx.db.run(`UPDATE projects SET stage = 'outline', updated_at = ? WHERE id = ? AND stage IN ('sources', 'mapping')`, now(), projectId);
  return { topics: topicCount, classified };
}

export function sourceIndexesText(ctx: AppContext, resources: { id: string; filename: string }[]) {
  return resources.map((r, i) => {
    const idx = ctx.db.get<{ origin: string; entries: string }>('SELECT origin, entries FROM source_indexes WHERE resource_id = ?', r.id);
    if (!idx) return '';
    const entries = json<{ title: string; level: number; page: number }[]>(idx.entries, []);
    return `R${i + 1} ${r.filename} (${idx.origin})\n${entries.map((e) => `${e.level} | ${e.title} | ${e.page + 1}`).join('\n')}`;
  }).filter(Boolean).join('\n\n');
}

/**
 * Exam frequency = distinct sessions with at least one question on the topic.
 * high: at least half the sessions of the most tested topic; low: never tested and not a prerequisite of a tested topic.
 */
export function computePriorities(ctx: AppContext, projectId: string) {
  const qs = ctx.db.all<{ topic_ids: string; exam_group: string | null }>(`SELECT topic_ids, exam_group FROM questions WHERE project_id = ? AND kind = 'exam' AND exam_group IS NOT NULL`, projectId);
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
      ctx.db.run('UPDATE topics SET exam_sessions = ?, priority = ? WHERE id = ?', n, priority, tp.id);
    }
  });
}

export type { Question };
