import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { HttpError } from '../server.ts';
import { getRunSummary, getTask, listRuns, usageForRun } from '../repo/index.ts';
import { deps } from './deps.ts';
import { idParam, parse, projectOf } from './util.ts';

const kindSchema = z.enum(['prepare', 'plan', 'generate', 'review', 'export', 'regenerate', 'research']);
const ids = z.array(z.string().min(1)).max(2000);

export function registerRunRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/projects/:id/runs', async (req) => {
    const projectId = projectOf(ctx, req);
    const body = parse(z.object({ kind: kindSchema, scope: z.object({ chapterIds: ids.optional(), nodeIds: ids.optional(), questionIds: ids.optional() }).optional() }), req.body);
    return deps.startRun(ctx, projectId, body.kind, body.scope);
  });

  app.get('/api/projects/:id/runs', async (req) => listRuns(ctx, projectOf(ctx, req)));

  app.get('/api/runs/:runId', async (req) => {
    const run = getRunSummary(ctx, idParam(req, 'runId'));
    return { ...run, tasks: ctx.queue.tasks(run.id), usage: usageForRun(ctx, run.id) };
  });

  app.post('/api/runs/:runId/pause', async (req) => {
    const run = getRunSummary(ctx, idParam(req, 'runId'));
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new HttpError(409, 'run_finished', 'This run has already finished.', 'Start a new run if you want to continue.');
    ctx.queue.pause(run.id);
    return getRunSummary(ctx, run.id);
  });

  app.post('/api/runs/:runId/resume', async (req) => {
    const run = getRunSummary(ctx, idParam(req, 'runId'));
    if (['completed', 'cancelled'].includes(run.status)) throw new HttpError(409, 'run_finished', 'This run has already finished.', 'Start a new run if you want to continue.');
    ctx.queue.resume(run.id);
    return getRunSummary(ctx, run.id);
  });

  app.post('/api/runs/:runId/cancel', async (req) => {
    const run = getRunSummary(ctx, idParam(req, 'runId'));
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new HttpError(409, 'run_finished', 'This run has already finished.');
    ctx.queue.cancel(run.id);
    return getRunSummary(ctx, run.id);
  });

  app.post('/api/runs/:runId/retry', async (req) => {
    const run = getRunSummary(ctx, idParam(req, 'runId'));
    const { taskIds } = parse(z.object({ taskIds: ids.optional() }), req.body);
    ctx.queue.retry(run.id, taskIds);
    return getRunSummary(ctx, run.id);
  });

  app.post('/api/tasks/:taskId/resolve', async (req) => {
    const task = getTask(ctx, idParam(req, 'taskId'));
    const { decision } = parse(z.object({ decision: z.enum(['continue', 'skip']) }), req.body);
    if (task.state !== 'waiting_for_user') throw new HttpError(409, 'not_waiting', 'This step is not waiting for you any more.', 'Reload to see its current state.');
    ctx.queue.resolve(task.id, decision);
    return getTask(ctx, task.id);
  });
}
