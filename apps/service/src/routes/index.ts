import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

export async function registerRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/health', async () => ({ ok: true as const, version: ctx.config.version, dataDir: ctx.config.dataDir }));
}
