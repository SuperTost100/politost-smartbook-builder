import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { deps, overrideDeps, type RouteDeps } from './deps.ts';
import { registerEventRoutes } from './events.ts';
import { registerManuscriptRoutes } from './manuscript.ts';
import { registerMaterialRoutes } from './material.ts';
import { registerProjectRoutes } from './projects.ts';
import { registerResourceRoutes } from './resources.ts';
import { registerReviewRoutes } from './review.ts';
import { registerRunRoutes } from './runs.ts';
import { registerSystemRoutes } from './system.ts';

export { deps, overrideDeps, type RouteDeps };

/** Registers every route of the HTTP contract (packages/domain/src/api.ts). Collaborators can be replaced with overrideDeps. */
export async function registerRoutes(app: FastifyInstance, ctx: AppContext, override?: Partial<RouteDeps>) {
  if (override) Object.assign(deps, override);
  registerSystemRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerResourceRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerManuscriptRoutes(app, ctx);
  registerMaterialRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerEventRoutes(app, ctx);
}
