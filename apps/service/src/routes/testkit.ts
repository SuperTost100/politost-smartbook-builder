// Helpers for route tests: a server on a temp data dir, fake collaborators, multipart bodies.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { CompiledBook, LintFinding } from '@smartbuilder/content';
import type { RunSummary } from '@smartbuilder/domain';
import { paths, type Config } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { buildServer } from '../server.ts';
import { overrideDeps, type RouteDeps } from './deps.ts';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  /** JSON request with the CSRF header. */
  req(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Record<string, any>; raw: string }>;
  close(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'smartbuilder-test-'));
  const config: Config = { dataDir: dir, host: '127.0.0.1', port: 0, lan: false, dev: false, webDist: join(dir, 'no-web'), version: 'test' };
  const ctx = createContext(config);
  const app = await buildServer(ctx);
  return {
    app, ctx, dir,
    async req(method, url, body, headers = {}) {
      const res = await app.inject({
        method: method as 'GET', url, headers: { 'x-smartbuilder': '1', ...headers },
        ...(body === undefined ? {} : Buffer.isBuffer(body) ? { payload: body } : { payload: JSON.stringify(body), headers: { 'x-smartbuilder': '1', 'content-type': 'application/json', ...headers } }),
      });
      let parsed: unknown = res.body;
      try { parsed = JSON.parse(res.body); } catch { /* not JSON */ }
      return { status: res.statusCode, body: parsed as any, headers: res.headers, raw: res.body };
    },
    async close() {
      await app.close();
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const projectBody = (slug = 'analisi-1') => ({ title: 'Analisi 1', subject: 'Analisi matematica', slug, authors: ['Ada'], language: 'it' });

export const sampleOutline = {
  chapters: [{ id: 'c1', slug: 'limiti', title: 'Limiti', sections: [{ id: 's1', title: 'Definizione' }, { id: 's2', title: 'Teoremi' }] }],
};

/** Project with an approved one-chapter outline. Returns ids. */
export async function projectWithOutline(t: TestApp, slug = 'analisi-1') {
  const p = (await t.req('POST', '/api/projects', projectBody(slug))).body;
  const rev = (await t.req('PUT', `/api/projects/${p.id}/outline`, { outline: sampleOutline, baseRevId: null })).body;
  await t.req('POST', `/api/projects/${p.id}/outline/approve`, { revId: rev.id });
  return { projectId: p.id as string, outlineRevId: rev.id as string };
}

export function fakeRun(projectId: string, kind: RunSummary['kind']): RunSummary {
  return { id: newId(), projectId, kind, status: 'running', createdAt: now(), finishedAt: null, counts: {}, waiting: null };
}

export const cleanBook = (findings: LintFinding[] = []): CompiledBook => ({ files: { 'manifest.json': '{}' }, formulaNumbers: {}, sectionNumbers: {}, findings });

export interface Calls { startRun: { projectId: string; kind: string; scope: unknown }[] }

/** Fake collaborators. Returns the call log and a restore function. */
export function installFakes(patch: Partial<RouteDeps> = {}): { calls: Calls; restore: () => void } {
  const calls: Calls = { startRun: [] };
  const restore = overrideDeps({
    startRun: (_ctx, projectId, kind, scope) => { calls.startRun.push({ projectId, kind, scope }); return fakeRun(projectId, kind); },
    storeResource: async (ctx, projectId, input) => {
      if (!('bytes' in input)) throw new Error('url not faked');
      const id = newId();
      const sha = createHash('sha256').update(input.bytes).digest('hex');
      const dir = paths.resources(ctx.config, projectId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${sha}.pdf`);
      writeFileSync(path, input.bytes);
      ctx.db.insert('resources', { id, project_id: projectId, kind: 'pdf', role: input.role, filename: input.filename, sha256: sha, size: input.bytes.length, path, created_at: now() });
      return id;
    },
    compileChapter: (chapter) => ({ markdown: chapter.sections.map((s) => `## ${s.title}\n\n${s.markdown}`).join('\n\n'), formulaNumbers: {}, sectionNumbers: {}, findings: [] }),
    lintSection: () => [],
    compileBook: () => cleanBook(),
    packPtsb: () => new Uint8Array([80, 75, 3, 4, 1, 2, 3]),
    readBackPtsb: () => ({ ok: true, errors: [], warnings: [] }),
    shutdown: () => {},
    ...patch,
  });
  return { calls, restore };
}

/** Minimal multipart/form-data body. */
export function multipart(fields: Record<string, string>, files: { name: string; filename: string; type: string; data: Buffer | string }[]) {
  const boundary = '----smartbuilder-test-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
