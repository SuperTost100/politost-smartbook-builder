import { onOutlineApproved } from '../pipeline/runs.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bookOptionsSchema, outlineSchema, projectInputSchema, type BookOptions } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import {
  approveOutline, archiveProject, createProject, deleteProject, getProjectSummary, getTopic, latestOutlineRevision,
  listOutlineHistory, listProjects, listTopics, saveOutline, updateProject, updateTopic,
} from '../repo/index.ts';
import { idParam, parse, projectOf } from './util.ts';

const fields = projectInputSchema.shape;
const optionsPatch = z.object(Object.fromEntries(
  Object.entries(bookOptionsSchema.shape).map(([k, v]) => [k, (v as z.ZodDefault<z.ZodType>).removeDefault().optional()]),
)) as unknown as z.ZodType<Partial<BookOptions>>;

// Defaults are removed so a patch only touches the fields it names.
const projectPatchSchema = z.object({
  title: fields.title.optional(),
  subject: fields.subject.optional(),
  slug: fields.slug.optional(),
  authors: fields.authors.removeDefault().optional(),
  language: fields.language.removeDefault().optional(),
  audience: fields.audience.removeDefault().optional(),
  goals: fields.goals.removeDefault().optional(),
  options: optionsPatch.optional(),
});

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/projects', async () => listProjects(ctx));

  app.post('/api/projects', async (req, reply) => {
    const project = createProject(ctx, parse(projectInputSchema, req.body));
    return reply.status(201).send(project);
  });

  app.get('/api/projects/:id', async (req) => getProjectSummary(ctx, idParam(req, 'id')));

  app.patch('/api/projects/:id', async (req) => updateProject(ctx, projectOf(ctx, req), parse(projectPatchSchema, req.body)));

  app.post('/api/projects/:id/archive', async (req) => archiveProject(ctx, idParam(req, 'id')));

  app.delete('/api/projects/:id', async (req) => {
    const { remoteNotebookKept } = deleteProject(ctx, idParam(req, 'id'));
    return { ok: true as const, remoteNotebookKept };
  });

  // ---------- topics ----------

  app.get('/api/projects/:id/topics', async (req) => listTopics(ctx, projectOf(ctx, req)));

  app.patch('/api/topics/:tid', async (req) => {
    const patch = parse(z.object({ name: z.string().min(1).max(200).optional(), priority: z.enum(['low', 'normal', 'high']).optional(), description: z.string().max(4000).optional() }), req.body);
    return updateTopic(ctx, getTopic(ctx, idParam(req, 'tid')).id, patch);
  });

  // ---------- outline ----------

  app.get('/api/projects/:id/outline', async (req) => {
    const id = projectOf(ctx, req);
    return { current: latestOutlineRevision(ctx, id), history: listOutlineHistory(ctx, id) };
  });

  app.put('/api/projects/:id/outline', async (req) => {
    const id = projectOf(ctx, req);
    const body = parse(z.object({ outline: outlineSchema, baseRevId: z.string().nullable().default(null) }), req.body);
    const rev = saveOutline(ctx, id, { outline: body.outline, baseRevId: body.baseRevId, origin: 'human' });
    ctx.events.emit('outline.created', { revId: rev.id, origin: 'human' }, { projectId: id });
    return rev;
  });

  app.post('/api/projects/:id/outline/approve', async (req) => {
    const id = projectOf(ctx, req);
    const { revId } = parse(z.object({ revId: z.string().min(1) }), req.body);
    const approved = approveOutline(ctx, id, revId);
    onOutlineApproved(ctx, id);
    return approved;
  });

}
