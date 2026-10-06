import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES, roleRouteSchema, settingsSchema, type Settings } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { deps } from './deps.ts';
import { parse } from './util.ts';

// Built from the field schemas: settingsSchema.partial() would fill in defaults and overwrite saved values.
const settingsPatchSchema = z.object({
  routes: z.partialRecord(z.enum(ROLES), roleRouteSchema).optional(),
  evidenceMode: settingsSchema.shape.evidenceMode.removeDefault().optional(),
  concurrency: settingsSchema.shape.concurrency.removeDefault().optional(),
});

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/health', async () => ({ ok: true as const, version: ctx.config.version, dataDir: ctx.config.dataDir }));

  app.post('/api/shutdown', async (_req, reply) => {
    reply.raw.once('finish', () => setTimeout(() => deps.shutdown(), 50));
    return { ok: true as const };
  });

  app.get('/api/settings', async () => ctx.settings());

  app.put('/api/settings', async (req) => {
    const patch = parse(settingsPatchSchema, req.body);
    const cur = ctx.settings();
    const next: Partial<Settings> = {};
    if (patch.routes) {
      next.routes = { ...cur.routes, ...patch.routes } as Settings['routes'];
    }
    if (patch.evidenceMode) next.evidenceMode = patch.evidenceMode;
    if (patch.concurrency) next.concurrency = { ...cur.concurrency, ...patch.concurrency };
    return ctx.saveSettings(next);
  });

  app.get('/api/connections', async () => deps.getConnections(ctx));

  app.post('/api/connections/probe', async (req) => {
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
    return deps.probeRole(ctx, role);
  });
}
