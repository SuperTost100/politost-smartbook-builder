import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { paths } from './config.ts';
import type { AppContext } from './context.ts';
import { registerRoutes } from './routes/index.ts';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly action?: string, readonly item?: string) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const COOKIE = 'smartbuilder_token';

export function lanToken(ctx: AppContext): string {
  const file = paths.lanToken(ctx.config);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function sameToken(a: string | undefined, b: string) {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 300 * 1024 * 1024, files: 20 } });
  const token = ctx.config.lan ? lanToken(ctx) : null;

  // Access control. Loopback mode: only loopback Host headers (blocks DNS rebinding).
  // LAN mode: every request needs the token cookie, set once by visiting /?token=...
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!token) {
      if (!LOOPBACK_HOSTS.has(host)) return deny(reply, 403, 'host_not_allowed', `Requests for host "${host}" are refused. Start with --lan to allow other devices.`);
    } else {
      const q = (req.query as Record<string, string> | undefined)?.token;
      if (q && sameToken(q, token)) {
        reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 60 * 60 * 24 * 365 });
        return reply.redirect('/');
      }
      if (!sameToken(req.cookies[COOKIE], token)) {
        return deny(reply, 401, 'token_required', 'Open the link printed by the start command to get access.');
      }
    }
    // CSRF: mutations need a custom header, which a cross-site form or image cannot send.
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-smartbuilder'] !== '1') return deny(reply, 403, 'csrf', 'Missing x-smartbuilder header.');
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return deny(reply, 403, 'origin', 'Cross-origin request refused.');
    }
  });

  app.setErrorHandler((err: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, action: err.action, item: err.item } });
    }
    const e = err as { statusCode?: number; validation?: unknown; message?: string; issues?: unknown };
    if (e.issues) return reply.status(400).send({ error: { code: 'invalid', message: 'The request is invalid.', item: JSON.stringify(e.issues).slice(0, 500) } });
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) console.error(err);
    return reply.status(status).send({ error: { code: status >= 500 ? 'internal' : 'bad_request', message: e.message ?? 'Unexpected error' } });
  });

  await registerRoutes(app, ctx);

  if (existsSync(ctx.config.webDist)) {
    await app.register(fastifyStatic, { root: ctx.config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

function deny(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}
