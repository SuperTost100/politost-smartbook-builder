// Issues, validation and exports.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CompiledBook } from '@smartbuilder/content';
import type { ExportRow, ValidationReport } from '@smartbuilder/domain';
import { paths } from '../config.ts';
import type { AppContext } from '../context.ts';
import { HttpError } from '../server.ts';
import {
  countUnresolvedBlockers, getExport, getIssue, getProject, listExports, listIssues, loadBookInput, insertExport, setStage, updateIssue,
} from '../repo/index.ts';
import { deps } from './deps.ts';
import { idParam, parse, projectOf } from './util.ts';

export function buildReport(compiled: CompiledBook): ValidationReport {
  const findings = compiled.findings;
  const blockers = findings.filter((f) => f.severity === 'blocker');
  return {
    ok: blockers.length === 0,
    errors: blockers.map((f) => ({ file: f.file, message: f.message })),
    warnings: findings.filter((f) => f.severity !== 'blocker').map((f) => ({ file: f.file, message: f.message })),
    lint: findings.map((f) => ({ file: f.file, rule: f.rule, message: f.message, ...(f.line !== undefined ? { line: f.line } : {}) })),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function registerReviewRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---------- issues ----------

  app.get('/api/projects/:id/issues', async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'proposed', 'fixed', 'accepted', 'dismissed']).optional(), nodeId: z.string().optional() }), req.query);
    return listIssues(ctx, projectOf(ctx, req), q);
  });

  app.patch('/api/issues/:iid', async (req) => {
    const patch = parse(z.object({ status: z.enum(['open', 'proposed', 'fixed', 'accepted', 'dismissed']), resolution: z.string().max(4000).optional() }), req.body);
    return updateIssue(ctx, getIssue(ctx, idParam(req, 'iid')).id, patch);
  });

  app.post('/api/projects/:id/issues/fix', async (req) => {
    const projectId = projectOf(ctx, req);
    const { issueIds } = parse(z.object({ issueIds: z.array(z.string().min(1)).min(1).max(500) }), req.body);
    for (const id of issueIds) {
      if (getIssue(ctx, id).projectId !== projectId) throw new HttpError(404, 'not_found', 'One of these issues does not belong to this project.', 'Reload the page.', id);
    }
    return deps.startRun(ctx, projectId, 'regenerate', { issueIds });
  });

  // ---------- validation ----------

  app.post('/api/projects/:id/validate', async (req): Promise<ValidationReport> => {
    const projectId = projectOf(ctx, req);
    return buildReport(deps.compileBook(loadBookInput(ctx, projectId)));
  });

  // ---------- exports ----------

  app.get('/api/projects/:id/exports', async (req) => listExports(ctx, projectOf(ctx, req)));

  app.post('/api/projects/:id/exports', async (req): Promise<ExportRow> => {
    const projectId = projectOf(ctx, req);
    const { approved } = parse(z.object({ approved: z.boolean() }), req.body);
    const project = getProject(ctx, projectId);

    const compiled = deps.compileBook(loadBookInput(ctx, projectId, { approvedOnly: approved }));
    const report = buildReport(compiled);

    if (approved) {
      const openBlockers = countUnresolvedBlockers(ctx, projectId);
      if (report.errors.length || openBlockers) {
        const parts = [
          report.errors.length ? plural(report.errors.length, 'check failed', 'checks failed') : '',
          openBlockers ? plural(openBlockers, 'review problem is still open', 'review problems are still open') : '',
        ].filter(Boolean);
        throw new HttpError(
          409, 'export_blocked', `The book cannot be approved yet: ${parts.join(' and ')}.`,
          'Fix or dismiss them on the Review screen, or export a draft to look at the book as it is.',
        );
      }
    }

    const bytes = deps.packPtsb(compiled);
    const back = deps.readBackPtsb(bytes, compiled);
    if (!back.ok) {
      throw new HttpError(500, 'export_unreadable', `The exported file did not pass the read-back check: ${back.errors.slice(0, 3).join('; ')}.`, 'Run validation and fix the problems it lists, then export again.');
    }
    for (const w of back.warnings) report.warnings.push({ file: 'package', message: w });

    const dir = paths.exports(ctx.config, projectId);
    mkdirSync(dir, { recursive: true });
    const suffix = approved ? '' : '-draft';
    const base = `${project.slug}-${stamp()}`;
    let filename = `${base}${suffix}.ptsb`;
    for (let n = 2; existsSync(join(dir, filename)); n++) filename = `${base}-${n}${suffix}.ptsb`;
    const path = join(dir, filename);
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const row = insertExport(ctx, { projectId, filename, path, sha256, size: bytes.byteLength, approved, report });
    if (approved) setStage(ctx, projectId, 'export');
    ctx.events.emit('export.ready', { exportId: row.id, filename, approved }, { projectId });
    return row;
  });

  app.get('/api/exports/:exportId/download', async (req, reply) => {
    const row = getExport(ctx, idParam(req, 'exportId'));
    if (!existsSync(row.path)) throw new HttpError(404, 'file_missing', 'The exported file is no longer on disk.', 'Export the book again.');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', statSync(row.path).size);
    reply.header('content-disposition', `attachment; filename="${row.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    return reply.send(createReadStream(row.path));
  });
}
