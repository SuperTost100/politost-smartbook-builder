import { checkFunctionGraph, formatGraphPayload, formatLintKeys, graphLintCheck, lintGraph, lintKey } from '@smartbuilder/content';
import type { Enrichment } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { notFound } from './errors.ts';
import type { Rec } from './util.ts';

export function mapEnrichment(r: Rec): Enrichment {
  const payload = json<Record<string, unknown>>(r.payload, {});
  const lintAccepted = json<string[]>(r.lint_accepted, []);
  const lint = r.kind === 'graph' ? lintGraph(payload).map((f) => ({ key: lintKey(f), code: f.code, ...(f.trace ? { trace: f.trace } : {}), detail: f.detail })) : [];
  const lintOpen = lint.filter((f) => !lintAccepted.includes(f.key));
  const lintAcceptedFindings = lint.filter((f) => lintAccepted.includes(f.key));
  return { id: r.id, projectId: r.project_id, nodeId: r.node_id, kind: r.kind, payload, status: r.status, checks: json(r.checks, []), lintAccepted, spec: r.spec ? json(r.spec, null) : null, checkedRevisionId: r.checked_rev_id ?? null, lintOpen, lintAcceptedFindings, createdAt: r.created_at };
}

export function listEnrichments(ctx: AppContext, projectId: string): Enrichment[] {
  return ctx.db.all<Rec>('SELECT * FROM enrichments WHERE project_id = ? ORDER BY rowid', projectId).map(mapEnrichment);
}

export function getEnrichment(ctx: AppContext, id: string): Enrichment {
  const r = ctx.db.get<Rec>('SELECT * FROM enrichments WHERE id = ?', id);
  if (!r) throw notFound('This enrichment');
  return mapEnrichment(r);
}

export function insertEnrichment(ctx: AppContext, e: Omit<Enrichment, 'id' | 'createdAt' | 'status' | 'checks' | 'lintAccepted' | 'spec' | 'checkedRevisionId' | 'lintOpen' | 'lintAcceptedFindings'> & Partial<Pick<Enrichment, 'status' | 'checks'>>): Enrichment {
  const id = newId();
  ctx.db.insert('enrichments', { id, project_id: e.projectId, node_id: e.nodeId, kind: e.kind, payload: e.payload, status: e.status ?? 'draft', checks: e.checks ?? [], created_at: now() });
  ctx.events.emit('enrichment.updated', { enrichmentId: id, nodeId: e.nodeId }, { projectId: e.projectId });
  return getEnrichment(ctx, id);
}

/**
 * An edited graph goes through the numeric check and the graph lint again and becomes 'verified' or 'issue', like a
 * generated one. `acceptLint` accepts every lint finding of this payload, warnings included ("Accept anyway"): the acceptance
 * is kept with the graph, so later edits that keep the same finding on the same trace do not bring it back. `stopAccepting`
 * takes the keys given back out of the accepted list ("Stop accepting"), so those findings fail the graph and reach the
 * export report again.
 * The payload is formatted first (formatGraphPayload: Unicode maths, the book's decimal separator, distinct colours, explicit
 * ticks), as every saved graph is. An edit drops the spec, the section check and the independent check, which were about the
 * graph as drawn. Saving the same payload (Accept anyway), or one that differs only by what the formatter changes
 * (normalize-graphs), keeps them, so accepting a lint finding never hides what the checker found.
 * A lab example is not run here (that needs the sandbox), so it goes back to 'draft'.
 * shortcut: an edited lab example ships unchecked, upgrade by running checkLabCode from the route.
 */
export function updateEnrichmentPayload(ctx: AppContext, id: string, edit: Record<string, unknown>, opts: { acceptLint?: boolean; stopAccepting?: readonly string[] } = {}): Enrichment {
  const cur = getEnrichment(ctx, id);
  let payload = edit;
  if (cur.kind === 'graph') {
    const language = projectLanguage(ctx, cur.projectId);
    const format = (p: Record<string, unknown>) => formatGraphPayload(p, { language });
    payload = format(edit);
    const edited = JSON.stringify(payload) !== JSON.stringify(format(cur.payload));
    const checked = checkFunctionGraph(payload);
    const fresh = opts.acceptLint ? lintGraph(payload).map(lintKey) : [];
    // A finding accepted on "y = x^2" stays accepted on the "y = x²" the formatter writes.
    // A stopped key also drops the stored key it was formatted from ("y = x^2" for "y = x²"), or the next save would
    // format that one again and bring the acceptance back.
    const dropped = new Set(opts.stopAccepting ?? []);
    const stillAccepted = cur.lintAccepted.filter((k) => !formatLintKeys([k], { language }).some((f) => dropped.has(f)));
    const accepted = [...new Set([...formatLintKeys(stillAccepted, { language }), ...fresh])].filter((k) => !dropped.has(k));
    const lint = graphLintCheck(payload, accepted);
    const kept = edited ? [] : cur.checks.filter((c) => c.method !== 'numeric' && c.method !== 'lint');
    const checks = [{ method: 'numeric', ok: checked.ok, detail: checked.detail }, { method: 'lint', ok: lint.ok, detail: lint.detail }, ...kept];
    ctx.db.update('enrichments', id, {
      payload, status: checks.every((c) => c.ok) ? 'verified' : 'issue', lint_accepted: accepted, checks,
      ...(edited ? { spec: null, checked_rev_id: null } : {}),
    });
  } else ctx.db.update('enrichments', id, { payload, status: 'draft', checks: [] });
  ctx.events.emit('enrichment.updated', { enrichmentId: id, nodeId: cur.nodeId }, { projectId: cur.projectId });
  return getEnrichment(ctx, id);
}

/** The book's language, which sets the decimal separator the graph formatter writes. */
export function projectLanguage(ctx: AppContext, projectId: string): string {
  return ctx.db.get<{ language: string }>('SELECT language FROM projects WHERE id = ?', projectId)?.language ?? '';
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
