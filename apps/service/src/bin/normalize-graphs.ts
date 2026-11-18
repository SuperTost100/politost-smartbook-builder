// Graph formatting without a model: npm run normalize-graphs -- --project <id> [--write] [--data-dir <dir>]
// Runs the graph formatter (`formatGraphPayload`) on every graph of a project: Unicode maths and the book's decimal separator in
// every text a student sees, distinct colours for traces that share one by accident, explicit ticks where Plotly would write
// SI suffixes or on a log axis. Without --write it prints, per graph, each text and style change and what the graph lint
// still finds for a hand edit, and changes nothing. --write saves each graph as an author edit does (updateEnrichmentPayload),
// which keeps the graph's spec and checks, because the formatter changes only labels, colours and ticks.
// Safe while the service runs: the database is in WAL mode and each graph is read and written in one short transaction, which
// skips a graph that changed since it was read. The running service's open pages show the change after a reload.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatGraphPayload, formatLintKeys, graphLintCheck, graphPayloadDiff, lintGraph, lintKey } from '@smartbuilder/content';
import { parseArgs, paths } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import { getEnrichment, getProject, listEnrichments, updateEnrichmentPayload } from '../repo/index.ts';

/** The lint codes that point at text or style only a hand edit can fix. */
const HAND = new Set(['raw-notation', 'dropped-key', 'long-axis-title', 'axis-variable']);

export interface GraphNormalizeResult {
  enrichmentId: string;
  graphId: string;
  title: string;
  /** One line per change: the path in the payload, the old value and the new one. Empty when the graph is already formatted. */
  changes: string[];
  /** What the graph lint still finds after formatting, for a hand edit. */
  remaining: string[];
  /** A blocking lint finding that formatting would make the graph fail on, which the graph did not fail on before. */
  newlyBlocked: string[];
  /** With --write: the formatted graph was saved. */
  written: boolean;
}

/** Formats the graphs of a project; with `write`, saves the ones that change. */
export function normalizeGraphs(ctx: AppContext, projectId: string, opts: { write?: boolean } = {}): GraphNormalizeResult[] {
  const { language } = getProject(ctx, projectId);
  const out: GraphNormalizeResult[] = [];
  for (const e of listEnrichments(ctx, projectId).filter((x) => x.kind === 'graph')) {
    const after = formatGraphPayload(e.payload, { language });
    const changes = graphPayloadDiff(e.payload, after);
    const findings = lintGraph(after);
    const remaining = findings.filter((f) => HAND.has(f.code)).map((f) => `${f.code}${f.trace ? ` ("${f.trace}")` : ''}: ${f.detail}`);
    // The save carries each acceptance over to the formatted trace name (formatLintKeys), so the check after formatting does too.
    const accepted = formatLintKeys(e.lintAccepted, { language });
    const blocked = (p: Record<string, unknown>) => graphLintCheck(p, accepted).findings.filter((f) => f.severity === 'block' && !accepted.includes(lintKey(f))).map(lintKey);
    const before = new Set(blocked(e.payload));
    const result: GraphNormalizeResult = {
      enrichmentId: e.id, graphId: typeof e.payload.id === 'string' ? e.payload.id : e.id, title: typeof e.payload.title === 'string' ? e.payload.title : e.id,
      changes, remaining, newlyBlocked: blocked(after).filter((k) => !before.has(k)), written: false,
    };
    if (opts.write && changes.length) {
      // An author may have saved the graph since it was read: that edit wins, and this graph is left for the next run.
      result.written = ctx.db.tx(() => {
        if (JSON.stringify(getEnrichment(ctx, e.id).payload) !== JSON.stringify(e.payload)) return false;
        updateEnrichmentPayload(ctx, e.id, after);
        return true;
      });
    }
    out.push(result);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--project');
  const projectId = i >= 0 ? args[i + 1] : undefined;
  if (!projectId || projectId.startsWith('--')) {
    console.log('Usage: npm run normalize-graphs -- --project <id> [--write] [--data-dir dir]');
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
    const results = normalizeGraphs(ctx, projectId, { write });
    for (const r of results) {
      if (!r.changes.length && !r.remaining.length) continue;
      const head = r.changes.length ? (write ? (r.written ? 'CHANGED' : 'SKIPPED (edited meanwhile)') : 'WOULD CHANGE') : 'FORMATTED';
      console.log(`${head} ${r.graphId}  "${r.title}"`);
      for (const c of r.changes) console.log(`        ${c}`);
      for (const f of r.remaining) console.log(`        left for a hand edit: ${f}`);
      for (const k of r.newlyBlocked) console.log(`        the graph lint would now block it: ${k}`);
    }
    const changed = results.filter((r) => r.changes.length);
    console.log(`\n${results.length} graphs: ${changed.length} ${write ? `changed, ${results.filter((r) => r.written).length} written` : 'would change (dry run: nothing written, --write saves them)'}, ${results.filter((r) => r.remaining.length).length} with something left for a hand edit.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    ctx.db.close();
  }
}
