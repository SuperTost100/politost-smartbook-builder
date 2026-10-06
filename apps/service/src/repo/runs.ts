import type { RunSummary, TaskRow } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { notFound } from './errors.ts';
import type { Rec } from './util.ts';

export function listRuns(ctx: AppContext, projectId: string, limit = 50): RunSummary[] {
  return ctx.db.all<Rec>('SELECT id FROM runs WHERE project_id = ? ORDER BY rowid DESC LIMIT ?', projectId, limit)
    .map((r) => ctx.queue.runSummary(r.id)).filter((r): r is RunSummary => !!r);
}

export function getRunSummary(ctx: AppContext, runId: string): RunSummary {
  const r = ctx.queue.runSummary(runId);
  if (!r) throw notFound('This run');
  return r;
}

export function getTask(ctx: AppContext, taskId: string): TaskRow {
  const row = ctx.db.get<Rec>('SELECT run_id FROM tasks WHERE id = ?', taskId);
  const task = row ? ctx.queue.tasks(row.run_id).find((t) => t.id === taskId) : undefined;
  if (!task) throw notFound('This task');
  return task;
}
