import { checkFunctionGraph, graphLintCheck, lintKey } from '@smartbuilder/content';
import type { Enrichment } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { notFound } from './errors.ts';
import type { Rec } from './util.ts';

export function mapEnrichment(r: Rec): Enrichment {
  return { id: r.id, projectId: r.project_id, nodeId: r.node_id, kind: r.kind, payload: json(r.payload, {}), status: r.status, checks: json(r.checks, []), lintAccepted: json(r.lint_accepted, []), createdAt: r.created_at };
}

export function listEnrichments(ctx: AppContext, projectId: string): Enrichment[] {
  return ctx.db.all<Rec>('SELECT * FROM enrichments WHERE project_id = ? ORDER BY rowid', projectId).map(mapEnrichment);
}

export function getEnrichment(ctx: AppContext, id: string): Enrichment {
  const r = ctx.db.get<Rec>('SELECT * FROM enrichments WHERE id = ?', id);
  if (!r) throw notFound('This enrichment');
  return mapEnrichment(r);
}

export function insertEnrichment(ctx: AppContext, e: Omit<Enrichment, 'id' | 'createdAt' | 'status' | 'checks' | 'lintAccepted'> & Partial<Pick<Enrichment, 'status' | 'checks'>>): Enrichment {
  const id = newId();
  ctx.db.insert('enrichments', { id, project_id: e.projectId, node_id: e.nodeId, kind: e.kind, payload: e.payload, status: e.status ?? 'draft', checks: e.checks ?? [], created_at: now() });
  ctx.events.emit('enrichment.updated', { enrichmentId: id, nodeId: e.nodeId }, { projectId: e.projectId });
  return getEnrichment(ctx, id);
}

/**
 * An edited graph goes through the numeric check and the graph lint again and becomes 'verified' or 'issue', like a
 * generated one. `acceptLint` accepts every blocking lint finding of this payload ("Accept anyway"): the acceptance is
 * kept with the graph, so later edits that keep the same finding on the same trace do not bring it back.
 * A lab example is not run here (that needs the sandbox), so it goes back to 'draft'.
 * shortcut: an edited lab example ships unchecked, upgrade by running checkLabCode from the route.
 */
export function updateEnrichmentPayload(ctx: AppContext, id: string, payload: Record<string, unknown>, opts: { acceptLint?: boolean } = {}): Enrichment {
  const cur = getEnrichment(ctx, id);
  if (cur.kind === 'graph') {
    const checked = checkFunctionGraph(payload);
    const fresh = opts.acceptLint ? graphLintCheck(payload).findings.filter((f) => f.severity === 'block').map(lintKey) : [];
    const accepted = [...new Set([...cur.lintAccepted, ...fresh])];
    const lint = graphLintCheck(payload, accepted);
    ctx.db.update('enrichments', id, {
      payload, status: checked.ok && lint.ok ? 'verified' : 'issue', lint_accepted: accepted,
      checks: [{ method: 'numeric', ok: checked.ok, detail: checked.detail }, { method: 'lint', ok: lint.ok, detail: lint.detail }],
    });
  } else ctx.db.update('enrichments', id, { payload, status: 'draft', checks: [] });
  ctx.events.emit('enrichment.updated', { enrichmentId: id, nodeId: cur.nodeId }, { projectId: cur.projectId });
  return getEnrichment(ctx, id);
}

export function setEnrichmentChecks(ctx: AppContext, id: string, status: Enrichment['status'], checks: Enrichment['checks']): Enrichment {
  ctx.db.update('enrichments', id, { status, checks });
  const e = getEnrichment(ctx, id);
  ctx.events.emit('enrichment.updated', { enrichmentId: id, nodeId: e.nodeId }, { projectId: e.projectId });
  return e;
}

export function deleteEnrichment(ctx: AppContext, id: string): void {
  const cur = getEnrichment(ctx, id);
  ctx.db.run('DELETE FROM enrichments WHERE id = ?', id);
  ctx.events.emit('enrichment.updated', { enrichmentId: id, nodeId: cur.nodeId, deleted: true }, { projectId: cur.projectId });
}
