import type { AppContext } from '../context.ts';
import { now } from '../db/db.ts';
import { syncNotebook } from '../evidence/index.ts';
import type { TaskContext } from '../queue/queue.ts';
import { chapterIntro, sectionDraft, sectionEvidence } from './draft.ts';
import { chapterEnrich, enrichGraph, enrichIde } from './enrich.ts';
import { gate, outlinePlan } from './plan.ts';
import { chapterPractice, practiceDone, practiceGenerate, questionImport, questionRevise, questionVerify } from './practice.ts';
import { resourceExtract, resourceIndex, resourceQuestions, topicsMap } from './prepare.ts';
import { chapterReview, sectionRevise } from './review.ts';
import { startRun } from './runs.ts';

/** Registers every task handler with the queue. */
export function registerHandlers(ctx: AppContext) {
  const h = (fn: (ctx: AppContext, t: TaskContext) => Promise<unknown>) => (t: TaskContext) => fn(ctx, t);
  const q = ctx.queue;
  q.register('resource.extract', h(resourceExtract));
  q.register('resource.index', h(resourceIndex));
  q.register('resource.questions', h(resourceQuestions));
  q.register('notebook.sync', h(async (c, t) => syncNotebook(c, t.task.projectId, t.signal)));
  q.register('topics.map', h(topicsMap));
  q.register('outline.plan', h(outlinePlan));
  q.register('outline.autoapprove', h(async (c, t) => {
    const revId = (t.deps.outline as { revId: string }).revId;
    c.db.run('UPDATE outline_revisions SET approved_at = ? WHERE id = ?', now(), revId);
    c.db.run('UPDATE projects SET outline_rev_id = ?, updated_at = ? WHERE id = ?', revId, now(), t.task.projectId);
    const run = startRun(c, t.task.projectId, 'generate');
    return { revId, generateRun: run.id };
  }));
  q.register('gate', h(gate));
  q.register('section.evidence', h(sectionEvidence));
  q.register('section.draft', h(sectionDraft));
  q.register('chapter.intro', h(chapterIntro));
  q.register('chapter.practice', h(chapterPractice));
  q.register('question.import', h(questionImport));
  q.register('practice.generate', h(practiceGenerate));
  q.register('practice.done', h(practiceDone));
  q.register('question.verify', h(questionVerify));
  q.register('question.revise', h(questionRevise));
  q.register('chapter.enrich', h(chapterEnrich));
  q.register('enrich.graph', h(enrichGraph));
  q.register('enrich.ide', h(enrichIde));
  q.register('chapter.review', h(chapterReview));
  q.register('section.revise', h(sectionRevise));
}
