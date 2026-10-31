// Course program and alignment with the book.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { examFormatSchema, programInputSchema, programItemSchema } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { applyBlocker, checkBlocker, restoreRemoved } from '../pipeline/align.ts';
import { activeRun } from '../pipeline/runs.ts';
import { deleteProgram, getProgram, getReport, latestReport, saveProgramInput, saveProgramItems, setProgramStatus } from '../repo/index.ts';
import { HttpError } from '../server.ts';
import { deps } from './deps.ts';
import { parse, projectOf } from './util.ts';

const MAX_ITEMS = 400;

/** A running reading would overwrite a new input or the author's edits with items from the old text. */
const readingBlocker = (ctx: AppContext, id: string) => activeRun(ctx, id, 'program')
  ? new HttpError(409, 'program_running', 'The program is being read right now.', 'Wait for the reading to finish, then try again.')
  : null;

export function registerProgramRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/projects/:id/program', async (req) => getProgram(ctx, projectOf(ctx, req)));

  app.put('/api/projects/:id/program', async (req) => {
    const id = projectOf(ctx, req);
    const input = parse(programInputSchema, req.body);
    if (!input.text.trim() && !input.url) throw new HttpError(400, 'invalid', 'There is no program to read.', 'Paste the program text or give the address of the course guide.');
    const reading = readingBlocker(ctx, id);
    if (reading) throw reading;
    saveProgramInput(ctx, id, { text: input.text, url: input.url });
    try {
      const run = deps.startRun(ctx, id, 'program');
      return { program: getProgram(ctx, id)!, run };
    } catch (err) {
      setProgramStatus(ctx, id, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  });

  app.put('/api/projects/:id/program/items', async (req) => {
    const id = projectOf(ctx, req);
    const body = parse(z.object({ items: z.array(programItemSchema).max(MAX_ITEMS), examFormat: examFormatSchema }), req.body);
    const reading = readingBlocker(ctx, id);
    if (reading) throw reading;
    const twice = body.items.find((it, i) => body.items.findIndex((x) => x.key === it.key) !== i);
    if (twice) throw new HttpError(400, 'invalid', `Two program items use the key "${twice.key}".`, 'Give every item its own key.', twice.key);
    return saveProgramItems(ctx, id, body);
  });

  app.delete('/api/projects/:id/program', async (req) => {
    deleteProgram(ctx, projectOf(ctx, req));
    return { ok: true as const };
  });

  app.get('/api/projects/:id/alignment', async (req) => latestReport(ctx, projectOf(ctx, req)));

  app.post('/api/projects/:id/alignment/check', async (req) => {
    const id = projectOf(ctx, req);
    const blocked = checkBlocker(ctx, id);
    if (blocked) throw blocked;
    return deps.startRun(ctx, id, 'align');
  });

  app.post('/api/projects/:id/alignment/apply', async (req) => {
    const id = projectOf(ctx, req);
    const body = parse(z.object({ reportId: z.string().min(1), findings: z.array(z.number().int().min(0)).max(2000).optional() }), req.body);
    const report = getReport(ctx, id, body.reportId);
    const blocked = applyBlocker(ctx, id, report);
    if (blocked) throw blocked;
    const picked = body.findings?.length ? body.findings : report.findings.map((_, i) => i);
    if (picked.some((i) => i >= report.findings.length)) throw new HttpError(400, 'invalid', 'A selected finding is not in the report.', 'Reload the report and select again.');
    // Order problems are only reported: Align book does not reorder.
    if (!picked.some((i) => report.findings[i].kind !== 'order')) throw new HttpError(400, 'nothing_to_apply', 'The selected findings cannot be applied.', 'Order problems are reported only. Fix them in the Outline tab.');
    return deps.startRun(ctx, id, 'align', { align: { reportId: report.id, findings: body.findings ?? [] } });
  });

  app.post('/api/projects/:id/alignment/restore', async (req) => {
    const id = projectOf(ctx, req);
    const body = parse(z.object({ reportId: z.string().min(1), nodeId: z.string().min(1) }), req.body);
    return restoreRemoved(ctx, id, body.reportId, body.nodeId);
  });
}
