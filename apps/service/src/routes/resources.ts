import { extname, basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Resource, ResourceRole } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { HttpError } from '../server.ts';
import {
  deleteResource, getPage, getResource, getSourceIndex, listPages, listResources, updateResource,
} from '../repo/index.ts';
import { computePriorities } from '../pipeline/prepare.ts';
import { deps } from './deps.ts';
import { idParam, intParam, parse, projectOf } from './util.ts';

const roleSchema = z.enum(['theory', 'exercises', 'exams', 'mixed']);
const SUPPORTED = new Set(['.pdf', '.docx', '.pptx', '.md', '.markdown']);

export function registerResourceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/projects/:id/resources', async (req) => listResources(ctx, projectOf(ctx, req)));

  // multipart/form-data: file (repeatable) and role. Fields may come before or after the files.
  app.post('/api/projects/:id/resources', async (req) => {
    const projectId = projectOf(ctx, req);
    if (!req.isMultipart()) throw new HttpError(400, 'invalid', 'Send the files as a form upload.', 'Choose files with the upload button.');
    let roleRaw: string | undefined;
    const files: { filename: string; bytes: Buffer }[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'role') roleRaw = String(part.value);
        continue;
      }
      const bytes = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, 'too_large', `"${part.filename}" is too large.`, 'Split the file or reduce its size and try again.');
      if (part.filename) files.push({ filename: basename(part.filename.replace(/\\/g, '/')), bytes });
    }
    const role: ResourceRole = parse(roleSchema, roleRaw ?? 'mixed');
    if (!files.length) throw new HttpError(400, 'no_files', 'No file was received.', 'Choose at least one file.');
    for (const f of files) {
      if (!SUPPORTED.has(extname(f.filename).toLowerCase())) {
        throw new HttpError(400, 'unsupported_type', `"${f.filename}" is not a supported file type.`, 'Use PDF, Word (.docx), PowerPoint (.pptx) or Markdown (.md) files.', f.filename);
      }
      if (!f.bytes.length) throw new HttpError(400, 'empty_file', `"${f.filename}" is empty.`, 'Check the file and upload it again.', f.filename);
    }
    const stored: Resource[] = [];
    for (const f of files) {
      const id = await deps.storeResource(ctx, projectId, { filename: f.filename, bytes: f.bytes, role });
      stored.push(getResource(ctx, id));
    }
    deps.startRun(ctx, projectId, 'prepare');
    return stored;
  });

  app.post('/api/projects/:id/resources/url', async (req) => {
    const projectId = projectOf(ctx, req);
    const body = parse(z.object({
      url: z.url().refine((u) => /^https?:\/\//i.test(u), 'Only http and https links are supported'),
      role: roleSchema.default('mixed'),
    }), req.body);
    const id = await deps.storeResource(ctx, projectId, { url: body.url, role: body.role });
    deps.startRun(ctx, projectId, 'prepare');
    return getResource(ctx, id);
  });

  app.patch('/api/resources/:rid', async (req) => {
    const patch = parse(z.object({ role: roleSchema.optional(), included: z.boolean().optional() }), req.body);
    const before = getResource(ctx, idParam(req, 'rid'));
    const r = updateResource(ctx, before.id, patch);
    // Exam frequency counts only included sources with a role that holds questions: recompute (local SQL only, no model call).
    if (r.included !== before.included || r.role !== before.role) computePriorities(ctx, r.projectId);
    ctx.events.emit('resource.state', { resourceId: r.id, included: r.included, role: r.role }, { projectId: r.projectId });
    return r;
  });

  app.delete('/api/resources/:rid', async (req) => {
    const r = getResource(ctx, idParam(req, 'rid'));
    deleteResource(ctx, r.id);
    computePriorities(ctx, r.projectId);
    ctx.events.emit('resource.state', { resourceId: r.id, deleted: true }, { projectId: r.projectId });
    return { ok: true as const };
  });

  // ---------- pages ----------

  app.get('/api/resources/:rid/pages', async (req) => listPages(ctx, getResource(ctx, idParam(req, 'rid')).id));

  app.get('/api/resources/:rid/pages/:idx', async (req) => getPage(ctx, getResource(ctx, idParam(req, 'rid')).id, intParam(req, 'idx')));

  app.get('/api/resources/:rid/pages/:idx/image', async (req, reply) => {
    const rid = getResource(ctx, idParam(req, 'rid')).id;
    const idx = intParam(req, 'idx');
    getPage(ctx, rid, idx);
    const q = parse(z.object({ scale: z.coerce.number().min(0.25).max(4).optional(), highlight: z.string().max(1000).optional() }), req.query);
    const png = await deps.renderPageImage(ctx, rid, idx, { scale: q.scale, highlight: q.highlight || undefined });
    reply.header('content-type', 'image/png');
    reply.header('cache-control', q.highlight ? 'private, no-cache' : 'private, max-age=3600');
    return reply.send(png);
  });

  app.post('/api/resources/:rid/pages/:idx/transcribe', async (req) => {
    const rid = getResource(ctx, idParam(req, 'rid')).id;
    const idx = intParam(req, 'idx');
    getPage(ctx, rid, idx);
    return deps.transcribePage(ctx, rid, idx);
  });

  app.get('/api/resources/:rid/index', async (req, reply) => {
    const index = getSourceIndex(ctx, getResource(ctx, idParam(req, 'rid')).id);
    return reply.type('application/json').send(JSON.stringify(index));
  });
}
