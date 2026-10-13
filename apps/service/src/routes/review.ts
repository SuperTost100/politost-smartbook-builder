// Issues, validation and exports.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sameQuote, type CompiledBook } from '@smartbuilder/content';
import type { ExportRow, ReportFile, ValidationReport } from '@smartbuilder/domain';
import { newId, now } from '../db/db.ts';
import { loadOutline } from '../pipeline/util.ts';
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

/**
 * The file ids of a compiled book, resolved to the section, introduction or question they come from. Files that are not
 * written by anyone (the package, a chapter's generated exam page) have no target.
 */
function locateFiles(ctx: AppContext, projectId: string, files: string[]): Record<string, ReportFile> {
  const chapters = loadOutline(ctx, projectId)?.outline.chapters ?? [];
  const out: Record<string, ReportFile> = {};
  for (const file of new Set(files)) {
    if (file.startsWith('question:')) {
      const id = file.slice('question:'.length);
      const q = ctx.db.get<{ kind: string; number: string | null; chapter_id: string | null }>('SELECT kind, number, chapter_id FROM questions WHERE id = ? AND project_id = ?', id, projectId);
      if (!q) continue;
      const kind = q.kind === 'exam' ? 'exam' as const : 'exercise' as const;
      const chapter = chapters.find((c) => c.id === q.chapter_id);
      out[file] = { label: `${kind === 'exam' ? 'Exam question' : 'Exercise'}${q.number ? ` ${q.number}` : ''}${chapter ? ` · ${chapter.title}` : ''}`, target: { questionId: id, kind } };
      continue;
    }
    const chapter = chapters.find((c) => c.id === file);
    if (chapter) { out[file] = { label: `Introduction · ${chapter.title}`, target: { nodeId: file } }; continue; }
    const section = chapters.flatMap((c) => c.sections).find((s) => s.id === file);
    if (section) out[file] = { label: section.title, target: { nodeId: file } };
  }
  return out;
}

/** How to fix validator findings whose message only names the rule. */
const FIX_HINTS: Record<string, string> = {
  'exercise-fence': 'Exercises cannot hold blocks such as figures. Describe what the block showed in one or two sentences of text and keep the sentence that introduced it consistent with that, or remove both.',
};

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
    const report = buildReport(deps.compileBook(loadBookInput(ctx, projectId)));
    return { ...report, files: locateFiles(ctx, projectId, [...report.errors, ...report.warnings, ...report.lint].map((f) => f.file)) };
  });

  // Errors and warnings of the validation, sent to the same AI fix as "Fix selected issues": each finding becomes an open
  // lint issue on its section or question (reusing one already open for the same rule and passage), and the run fixes them.
  app.post('/api/projects/:id/validate/fix', async (req) => {
    const projectId = projectOf(ctx, req);
    const findings = deps.compileBook(loadBookInput(ctx, projectId)).findings.filter((f) => f.severity !== 'minor');
    const files = locateFiles(ctx, projectId, findings.map((f) => f.file));
    const issueIds: string[] = [];
    ctx.db.tx(() => {
      for (const f of findings) {
        const target = files[f.file]?.target;
        if (!target) continue;
        const questionId = 'questionId' in target ? target.questionId : null;
        const nodeId = questionId ? ctx.db.get<{ chapter_id: string | null }>('SELECT chapter_id FROM questions WHERE id = ?', questionId)?.chapter_id ?? null : (target as { nodeId: string }).nodeId;
        const open = ctx.db.all<{ id: string; category: string; quote: string }>(
          `SELECT id, category, quote FROM review_issues WHERE project_id = ? AND source = 'lint' AND status = 'open' AND ${questionId ? 'question_id = ?' : 'node_id = ? AND question_id IS NULL'}`, projectId, questionId ?? nodeId);
        const same = open.find((i) => (i.category === f.rule || i.category === `compile:${f.rule}`) && (!f.quote || sameQuote(i.quote, f.quote)));
        if (same) { if (!issueIds.includes(same.id)) issueIds.push(same.id); continue; }
        const id = newId();
        ctx.db.insert('review_issues', {
          id, project_id: projectId, node_id: nodeId, question_id: questionId, rev_id: null, source: 'lint', severity: f.severity,
          category: `compile:${f.rule}`, quote: f.quote ?? '', message: f.message, suggestion: FIX_HINTS[f.rule] ?? '', status: 'open', resolution: '', created_at: now(),
        });
        issueIds.push(id);
      }
    });
    if (!issueIds.length) throw new HttpError(409, 'nothing_to_fix', 'Validation found nothing the AI can fix.', 'The remaining findings are in generated files; fix the section or question they come from.');
    return deps.startRun(ctx, projectId, 'regenerate', { issueIds });
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
