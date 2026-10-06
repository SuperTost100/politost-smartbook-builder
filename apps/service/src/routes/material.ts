// Questions, assets and enrichments.
import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { HttpError } from '../server.ts';
import {
  assetFile, createQuestion, deleteEnrichment, deleteQuestion, getAsset, getEnrichment, getQuestion, listAssets, listEnrichments,
  listQuestions, storeAsset, updateAsset, updateEnrichmentPayload, updateQuestion,
} from '../repo/index.ts';
import { deps } from './deps.ts';
import { idParam, parse, projectOf } from './util.ts';

const checkSchema = z.object({ method: z.enum(['independent-solve', 'numeric', 'symbolic', 'lint']), ok: z.boolean(), detail: z.string(), model: z.string().optional() });

// Fields a client may set. Ids, rev and timestamps are owned by the service.
const questionFields = {
  kind: z.enum(['exercise', 'exam']).optional(),
  origin: z.enum(['authentic', 'adapted', 'generated']).optional(),
  resourceId: z.string().nullable().optional(),
  pageFrom: z.number().int().nullable().optional(),
  pageTo: z.number().int().nullable().optional(),
  examGroup: z.string().max(300).nullable().optional(),
  examDate: z.string().max(40).nullable().optional(),
  number: z.string().max(40).nullable().optional(),
  statement: z.string().max(100_000).optional(),
  hint: z.string().max(100_000).optional(),
  solution: z.string().max(100_000).optional(),
  difficulty: z.enum(['facile', 'medio', 'difficile']).optional(),
  topicIds: z.array(z.string()).optional(),
  chapterId: z.string().nullable().optional(),
  status: z.enum(['draft', 'verified', 'issue']).optional(),
  checks: z.array(checkSchema).optional(),
};

const ASSET_MAX = 10 * 1024 * 1024;

export function registerMaterialRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---------- questions ----------

  app.get('/api/projects/:id/questions', async (req) => {
    const q = parse(z.object({ kind: z.enum(['exercise', 'exam']).optional() }), req.query);
    return listQuestions(ctx, projectOf(ctx, req), q);
  });

  app.post('/api/projects/:id/questions', async (req, reply) => {
    const projectId = projectOf(ctx, req);
    const fields = parse(z.object(questionFields), req.body);
    return reply.status(201).send(createQuestion(ctx, projectId, fields));
  });

  app.patch('/api/questions/:qid', async (req) => {
    const { rev, ...fields } = parse(z.object({ ...questionFields, rev: z.number().int() }), req.body);
    return updateQuestion(ctx, getQuestion(ctx, idParam(req, 'qid')).id, rev, fields);
  });

  app.delete('/api/questions/:qid', async (req) => {
    deleteQuestion(ctx, idParam(req, 'qid'));
    return { ok: true as const };
  });

  app.post('/api/questions/:qid/verify', async (req) => {
    const q = getQuestion(ctx, idParam(req, 'qid'));
    return deps.startRun(ctx, q.projectId, 'review', { questionIds: [q.id] });
  });

  // ---------- assets ----------

  app.get('/api/projects/:id/assets', async (req) => listAssets(ctx, projectOf(ctx, req)));

  app.get('/api/assets/:assetId/file', async (req, reply) => {
    const f = assetFile(ctx, idParam(req, 'assetId'));
    reply.header('content-type', f.mime);
    reply.header('content-length', statSync(f.path).size);
    reply.header('x-content-type-options', 'nosniff');
    // Defence in depth for SVG: even if one slipped through, opened directly it cannot run scripts or load anything.
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    reply.header('cache-control', 'private, max-age=60');
    return reply.send(createReadStream(f.path));
  });

  // multipart/form-data: file, optional nodeId, caption, alt.
  app.post('/api/projects/:id/assets', async (req) => {
    const projectId = projectOf(ctx, req);
    if (!req.isMultipart()) throw new HttpError(400, 'invalid', 'Send the figure as a form upload.');
    let file: { filename: string; bytes: Buffer } | null = null;
    const fields: Record<string, string> = {};
    for await (const part of req.parts({ limits: { fileSize: ASSET_MAX } })) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      const bytes = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, 'too_large', 'This figure is larger than 10 MB.', 'Reduce its size and upload it again.');
      if (!file && part.filename) file = { filename: part.filename, bytes };
    }
    if (!file) throw new HttpError(400, 'no_files', 'No figure was received.', 'Choose an image file.');
    return storeAsset(ctx, projectId, {
      filename: file.filename, bytes: file.bytes, origin: 'imported', nodeId: fields.nodeId || null, caption: fields.caption ?? '', alt: fields.alt ?? '',
    });
  });

  app.patch('/api/assets/:assetId', async (req) => {
    const patch = parse(z.object({ caption: z.string().max(1000).optional(), alt: z.string().max(1000).optional(), nodeId: z.string().nullable().optional() }), req.body);
    return updateAsset(ctx, getAsset(ctx, idParam(req, 'assetId')).id, patch);
  });

  // ---------- enrichments ----------

  app.get('/api/projects/:id/enrichments', async (req) => listEnrichments(ctx, projectOf(ctx, req)));

  app.patch('/api/enrichments/:eid', async (req) => {
    const { payload } = parse(z.object({ payload: z.record(z.string(), z.unknown()) }), req.body);
    return updateEnrichmentPayload(ctx, getEnrichment(ctx, idParam(req, 'eid')).id, payload);
  });

  app.delete('/api/enrichments/:eid', async (req) => {
    deleteEnrichment(ctx, idParam(req, 'eid'));
    return { ok: true as const };
  });
}
