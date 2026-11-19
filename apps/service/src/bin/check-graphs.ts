// The independent graph check over a project: npm run check-graphs -- --project <id> [--stale] [--write] [--data-dir <dir>]
// One checker call per graph (the checker route), on the graph as stored, so graphs drawn before specs were kept are checked
// too. Without --write it prints each verdict and changes nothing but the usage log. --write stores the check with the graph,
// with the section revision it read, and a graph that fails becomes an issue (left out of the export, listed for Fix).
// --stale checks only the graphs whose section changed since their last check (the graph-stale findings of the export).
// Safe while the service runs: the database is in WAL mode and each graph is written in one short transaction.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QuestionCheck } from '@smartbuilder/domain';
import { parseArgs, paths } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import { independentGraphCheck, openCheckIssue } from '../pipeline/enrich.ts';
import { headRevision } from '../pipeline/util.ts';
import { getProject, listEnrichments } from '../repo/index.ts';
import type { GraphSpec } from '@smartbuilder/content';

export interface GraphCheckResult {
  enrichmentId: string;
  graphId: string;
  title: string;
  /** pass or fail: the checker's verdict. skipped: no check ran, and `detail` says why. */
  verdict: 'pass' | 'fail' | 'skipped';
  detail: string;
  /** With --write: the check was stored with the graph. */
  written: boolean;
}

/** Runs the independent check on the graphs of a project, one after the other. */
export async function checkGraphs(ctx: AppContext, projectId: string, opts: { write?: boolean; stale?: boolean; signal?: AbortSignal } = {}): Promise<GraphCheckResult[]> {
  const project = getProject(ctx, projectId);
  const out: GraphCheckResult[] = [];
  for (const e of listEnrichments(ctx, projectId).filter((x) => x.kind === 'graph')) {
    const graphId = typeof e.payload.id === 'string' ? e.payload.id : e.id;
    const title = typeof e.payload.title === 'string' ? e.payload.title : graphId;
    const result = { enrichmentId: e.id, graphId, title, written: false };
    const head = headRevision(ctx, projectId, e.nodeId);
    if (!head) {
      out.push({ ...result, verdict: 'skipped', detail: 'Its section has no text.' });
      continue;
    }
    if (opts.stale && (!e.checkedRevisionId || e.checkedRevisionId === head.id)) continue;
    const check = await independentGraphCheck(ctx, { projectId, signal: opts.signal }, { language: project.language, section: head.markdown, payload: e.payload, spec: e.spec as GraphSpec | null });
    const row = { ...result, verdict: check.ok ? 'pass' as const : 'fail' as const, detail: check.detail };
    if (opts.write) row.written = recordCheck(ctx, e.id, e.payload, check, head.id);
    if (opts.write && !row.written) row.detail += '\nNot written: the graph changed while it was checked.';
    out.push(row);
  }
  return out;
}

/**
 * Stores the check with the graph, in place of an earlier independent check, with the section revision the checker read. A
 * graph that fails becomes an issue and gets a verification issue, unless one about it is still open; a graph that passes every
 * check closes that issue, when no other graph of the section has its title and the section is still the text checked. Nothing is written when the graph changed while the checker ran.
 */
function recordCheck(ctx: AppContext, id: string, payload: Record<string, unknown>, check: QuestionCheck, revisionId: string): boolean {
  const written = ctx.db.tx(() => {
    const cur = ctx.db.get<{ project_id: string; node_id: string; payload: string; checks: string }>('SELECT project_id, node_id, payload, checks FROM enrichments WHERE id = ?', id);
    if (!cur || JSON.stringify(JSON.parse(cur.payload)) !== JSON.stringify(payload)) return null;
    const checks = [...(JSON.parse(cur.checks) as QuestionCheck[]).filter((c) => c.method !== 'independent'), check];
    const verified = checks.every((c) => c.ok);
    ctx.db.update('enrichments', id, { checks, status: verified ? 'verified' : 'issue', checked_rev_id: revisionId });
    const match = `project_id = ? AND node_id = ? AND source = 'verification' AND category = 'graph' AND quote = ? AND status = 'open'`;
    const keys = [cur.project_id, cur.node_id, String(payload.title ?? '')];
    // The issue names its graph by title only, and the check must have read the section as it is now.
    const sameTitle = ctx.db.all<{ payload: string }>(`SELECT payload FROM enrichments WHERE project_id = ? AND node_id = ? AND kind = 'graph' AND id != ?`, cur.project_id, cur.node_id, id)
      .some((r) => String(JSON.parse(r.payload).title ?? '') === keys[2]);
    if (verified && !sameTitle && headRevision(ctx, cur.project_id, cur.node_id)?.id === revisionId) ctx.db.run(`UPDATE review_issues SET status = 'fixed', resolution = 'The graph passes its checks now.' WHERE ${match}`, ...keys);
    else if (!check.ok && !ctx.db.get(`SELECT 1 FROM review_issues WHERE ${match}`, ...keys)) openCheckIssue(ctx, cur.project_id, cur.node_id, 'graph', payload, [check]);
    return cur;
  });
  if (written) ctx.events.emit('enrichment.updated', { enrichmentId: id, nodeId: written.node_id, kind: 'graph' }, { projectId: written.project_id });
  return !!written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--project');
  const projectId = i >= 0 ? args[i + 1] : undefined;
  if (!projectId || projectId.startsWith('--')) {
    console.log('Usage: npm run check-graphs -- --project <id> [--stale] [--write] [--data-dir dir]');
    process.exit(1);
  }
  const config = parseArgs(args);
  if (!existsSync(paths.db(config))) {
    console.error(`No database in ${config.dataDir}.`);
    process.exit(1);
  }
  const ctx = createContext(config);
  const write = args.includes('--write');
  try {
    const results = await checkGraphs(ctx, projectId, { write, stale: args.includes('--stale') });
    for (const r of results) console.log(`${r.verdict.toUpperCase().padEnd(7)} ${r.graphId}  "${r.title}"\n${r.detail.split('\n').map((l) => `        ${l}`).join('\n')}`);
    const count = (v: GraphCheckResult['verdict']) => results.filter((r) => r.verdict === v).length;
    console.log(`\n${results.length} graphs: ${count('pass')} pass, ${count('fail')} fail, ${count('skipped')} skipped.${write ? ` Wrote ${results.filter((r) => r.written).length}.` : ' Dry run: nothing written.'}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    ctx.db.close();
  }
}
