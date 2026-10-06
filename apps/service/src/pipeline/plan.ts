// Plan: the common index, proposed by the planner model and approved (or edited) by the author.
import { outlineSchema, type Outline } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, WaitForUser, type TaskContext } from '../queue/queue.ts';
import { outlinePrompt, plannedOutlineSchema } from './prompts.ts';
import { sourceIndexesText } from './prepare.ts';
import { loadOutline, loadProject, loadTopics, slugify } from './util.ts';

export async function outlinePlan(ctx: AppContext, t: TaskContext) {
  const projectId = t.task.projectId;
  // A retry after the outline was committed must not plan again.
  if (t.task.input.revId) return { revId: t.task.input.revId };
  const done = ctx.db.get<{ id: string }>(`SELECT id FROM outline_revisions WHERE project_id = ? AND note = ?`, projectId, `run:${t.task.runId}`);
  if (done) return { revId: done.id, reused: true };

  const project = loadProject(ctx, projectId);
  const topics = loadTopics(ctx, projectId);
  if (!topics.length) throw new TaskError('There is no topic map yet.', 'input', 'Run Prepare on the sources first.');
  const sessions = ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT exam_group) AS n FROM questions WHERE project_id = ? AND kind = 'exam'`, projectId)?.n ?? 0;
  const keyOf = (id: string) => id.slice(9);
  const topicText = topics.map((tp) => `${keyOf(tp.id)} | ${tp.name} | ${tp.examSessions} | ${tp.prerequisites.map(keyOf).join(', ') || '-'}`).join('\n');
  const resources = ctx.db.all<{ id: string; filename: string }>(`SELECT id, filename FROM resources WHERE project_id = ? AND included = 1 AND role IN ('theory', 'mixed') ORDER BY created_at`, projectId);

  const { data, route } = await runRole(ctx, {
    role: 'planner',
    ...outlinePrompt({ title: project.title, subject: project.subject, language: project.language, audience: project.audience, goals: project.goals, topics: topicText, indexes: sourceIndexesText(ctx, resources), sessions }),
    schema: plannedOutlineSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });

  const valid = new Set(topics.map((tp) => keyOf(tp.id)));
  const toId = (k: string) => topics.find((tp) => keyOf(tp.id) === k)?.id;
  const usedSlugs = new Set<string>();
  const outline: Outline = outlineSchema.parse({
    notation: data.notation,
    chapters: data.chapters.map((c) => {
      let slug = slugify(c.slug || c.title);
      while (usedSlugs.has(slug)) slug = `${slug}-2`;
      usedSlugs.add(slug);
      return {
        id: newId(), slug, title: c.title, objectives: c.objectives, prerequisites: c.prerequisites,
        sections: c.sections.map((s) => ({
          id: newId(), title: s.title, objectives: s.objectives, depth: s.depth,
          topicIds: s.topics.filter((k) => valid.has(k)).map(toId).filter(Boolean),
          subsections: s.subsections.map((ss) => ({ id: newId(), title: ss.title, objectives: ss.objectives })),
        })),
      };
    }),
    exclusions: data.exclusions.filter((e) => valid.has(e.topic)).map((e) => ({ topicId: toId(e.topic)!, reason: e.reason })),
  });

  const revId = newId();
  ctx.db.insert('outline_revisions', { id: revId, project_id: projectId, outline, origin: 'ai', note: `run:${t.task.runId}`, created_at: now(), approved_at: null });
  ctx.db.run(`UPDATE projects SET stage = 'outline', updated_at = ? WHERE id = ?`, now(), projectId);
  ctx.events.emit('outline.created', { revId, model: route.model }, { projectId, runId: t.task.runId });
  return { revId, chapters: outline.chapters.length, sections: outline.chapters.reduce((n, c) => n + c.sections.length, 0) };
}

/**
 * Gate tasks park the run until the author presses Continue (queue.resolve marks them succeeded).
 * input.check = 'outline' passes immediately once an outline is approved.
 */
export async function gate(ctx: AppContext, t: TaskContext) {
  if (t.task.input.check === 'outline') {
    const o = loadOutline(ctx, t.task.projectId);
    if (o) return { approved: true, revId: o.revId };
    throw new WaitForUser('The outline needs your approval.', 'Open the Outline tab, adjust it if needed, then press Approve outline.');
  }
  throw new WaitForUser(String(t.task.input.reason ?? 'Waiting for your review.'), String(t.task.input.action ?? 'Press Continue when ready.'));
}
