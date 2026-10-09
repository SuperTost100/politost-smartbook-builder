import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentRevision, SectionView } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import {
  acceptProposal, findNode, getRevision, listRevisions, rejectProposal, restoreRevision, saveHuman,
} from '../repo/index.ts';
import { HttpError } from '../server.ts';
import { deps } from './deps.ts';
import { idParam, parse, projectOf } from './util.ts';
import { buildManuscript, buildSectionView, previewChapter, relint, requireOutline } from './views.ts';

function nodeOf(ctx: AppContext, projectId: string, nodeId: string) {
  const node = findNode(requireOutline(ctx, projectId), nodeId);
  if (!node) throw new HttpError(404, 'not_found', 'This section is not in the outline.', 'Reload the page.');
  return node;
}

function changed(ctx: AppContext, projectId: string, nodeId: string, rev: ContentRevision) {
  ctx.events.emit('content.saved', { nodeId, revId: rev.id, origin: rev.origin, status: rev.status }, { projectId });
}

export function registerManuscriptRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/projects/:id/manuscript', async (req) => buildManuscript(ctx, projectOf(ctx, req)));

  app.get('/api/projects/:id/sections/:nodeId', async (req) => buildSectionView(ctx, projectOf(ctx, req), idParam(req, 'nodeId')));

  app.put('/api/projects/:id/sections/:nodeId', async (req): Promise<SectionView> => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const body = parse(z.object({ markdown: z.string().max(2_000_000), baseRevId: z.string().nullable().default(null) }), req.body);
    const node = nodeOf(ctx, projectId, nodeId);
    const rev = saveHuman(ctx, projectId, nodeId, body.markdown, body.baseRevId, node.kind);
    relint(ctx, projectId, nodeId);
    changed(ctx, projectId, nodeId, rev);
    return buildSectionView(ctx, projectId, nodeId);
  });

  app.get('/api/projects/:id/sections/:nodeId/history', async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    nodeOf(ctx, projectId, nodeId);
    return listRevisions(ctx, projectId, nodeId);
  });

  app.post('/api/projects/:id/sections/:nodeId/restore', async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const { revId } = parse(z.object({ revId: z.string().min(1) }), req.body);
    nodeOf(ctx, projectId, nodeId);
    const rev = restoreRevision(ctx, projectId, nodeId, revId);
    relint(ctx, projectId, nodeId);
    changed(ctx, projectId, nodeId, rev);
    return buildSectionView(ctx, projectId, nodeId);
  });

  app.post('/api/projects/:id/sections/:nodeId/regenerate', async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const body = parse(z.object({ instruction: z.string().max(4000).optional(), selection: z.string().max(20000).optional() }), req.body);
    nodeOf(ctx, projectId, nodeId);
    return deps.startRun(ctx, projectId, 'regenerate', { nodeIds: [nodeId], instruction: body.instruction, selection: body.selection });
  });

  app.post('/api/projects/:id/sections/:nodeId/research', async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    nodeOf(ctx, projectId, nodeId);
    return deps.startRun(ctx, projectId, 'research', { nodeIds: [nodeId] });
  });

  app.post('/api/projects/:id/sections/:nodeId/proposal', async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    // headRevId: the head the author compared the proposal with. Required to accept; a reject does not look at it.
    const body = parse(z.object({ action: z.enum(['accept', 'reject']), revId: z.string().min(1), headRevId: z.string().nullable().optional() }), req.body);
    if (body.action === 'accept' && body.headRevId === undefined) {
      throw new HttpError(400, 'invalid', '"headRevId": the text this proposal was compared with is required.', 'Reload the page and try again.', 'headRevId');
    }
    nodeOf(ctx, projectId, nodeId);
    getRevision(ctx, projectId, body.revId);
    if (body.action === 'accept') {
      const rev = acceptProposal(ctx, projectId, nodeId, body.revId, body.headRevId ?? null);
      relint(ctx, projectId, nodeId);
      changed(ctx, projectId, nodeId, rev);
      ctx.events.emit('proposal.decided', { nodeId, revId: rev.id, action: 'accept' }, { projectId });
    } else {
      const rev = rejectProposal(ctx, projectId, nodeId, body.revId);
      ctx.events.emit('proposal.decided', { nodeId, revId: rev.id, action: 'reject' }, { projectId });
    }
    return buildSectionView(ctx, projectId, nodeId);
  });

  app.get('/api/projects/:id/chapters/:chapterId/preview', async (req) => previewChapter(ctx, projectOf(ctx, req), idParam(req, 'chapterId')));
}
