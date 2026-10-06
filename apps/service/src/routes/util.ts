import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from '../context.ts';
import { HttpError } from '../server.ts';
import { getProject } from '../repo/index.ts';

/** Parses with zod and turns the first problem into a plain-language 400. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue.path.join('.');
  throw new HttpError(400, 'invalid', `${field ? `"${field}": ` : ''}${issue.message}.`, 'Check the value and try again.', field || undefined);
}

export const idParam = (req: FastifyRequest, name: string): string => String((req.params as Record<string, string>)[name]);

/** Project id from the path, checked to exist. */
export function projectOf(ctx: AppContext, req: FastifyRequest, name = 'id'): string {
  const id = idParam(req, name);
  getProject(ctx, id);
  return id;
}

export function intParam(req: FastifyRequest, name: string): number {
  const n = Number(idParam(req, name));
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'invalid', `"${name}" must be a whole number.`);
  return n;
}
