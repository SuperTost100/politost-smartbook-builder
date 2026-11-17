import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { sampleFunctionGraph } from '@smartbuilder/content';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from '../llm/testkit.ts';
import { checkGraphs } from './check-graphs.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'p1';
const answer = (obj: unknown) => () => ({ structured: obj as never, text: JSON.stringify(obj), usage: usageOf(10, 10) });
const verdict = (expected: string) => answer({ traces: [{ label: 'v = 2 t', expected, problem: '' }], fit: 'fits' });

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  ctx = kit.ctx;
  ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(ctx, P);
});
afterEach(() => {
  setFunnel(null);
  kit.cleanup();
});

/** A section with its text and a published graph as the books have them: no spec, never checked by the checker. */
function seed(): { rev: string; graph: string } {
  const rev = newId();
  ctx.db.insert('content_revisions', { id: rev, project_id: P, node_id: 's1', kind: 'section', markdown: 'La velocità cresce come $$v = 2t$$', origin: 'ai', model: null, parent_rev_id: null, status: 'current', citations: {}, created_at: now() });
  const graph = newId();
  const payload = sampleFunctionGraph({ id: 'v', title: 'Velocità', functions: [{ expr: '2*x', label: 'v = 2 t' }], xDomain: [0, 5], yDomain: [0, 10], xLabel: 'Tempo t (s)', yLabel: 'v (m/s)' }).payload;
  ctx.db.insert('enrichments', { id: graph, project_id: P, node_id: 's1', kind: 'graph', payload, status: 'verified', checks: [{ method: 'numeric', ok: true, detail: 'ok' }], created_at: now() });
  return { rev, graph };
}
const row = (id: string) => ctx.db.get<{ status: string; checks: string; checked_rev_id: string | null }>('SELECT status, checks, checked_rev_id FROM enrichments WHERE id = ?', id)!;

test('a dry run prints the verdict of a graph without a spec and writes nothing', async () => {
  const { graph } = seed();
  fake.next(verdict('3*x'));
  const [r] = await checkGraphs(ctx, P);
  assert.equal(r!.verdict, 'fail');
  assert.match(r!.detail, /points differ from 3\*x/);
  assert.match(fake.calls[0]!.prompt, /1\. v = 2 t: a curve y = f\(x\) drawn for x from 0 to 5/, 'the checker is told the trace read from the payload');
  assert.deepEqual({ ...row(graph) }, { status: 'verified', checks: JSON.stringify([{ method: 'numeric', ok: true, detail: 'ok' }]), checked_rev_id: null });
  assert.equal(ctx.db.all('SELECT 1 FROM review_issues').length, 0);
});

test('--write stores the check with the revision it read; a failing graph becomes an issue once', async () => {
  const { rev, graph } = seed();
  fake.next(verdict('2*x'));
  const [pass] = await checkGraphs(ctx, P, { write: true });
  assert.deepEqual([pass!.verdict, pass!.written], ['pass', true]);
  assert.equal(row(graph).checked_rev_id, rev);
  assert.deepEqual(json<{ method: string }[]>(row(graph).checks, []).map((c) => c.method), ['numeric', 'independent']);
  fake.next(verdict('3*x'), verdict('3*x'));
  await checkGraphs(ctx, P, { write: true });
  await checkGraphs(ctx, P, { write: true });
  assert.equal(row(graph).status, 'issue');
  assert.deepEqual(json<{ method: string; ok: boolean }[]>(row(graph).checks, []).map((c) => [c.method, c.ok]), [['numeric', true], ['independent', false]], 'the new check replaces the old one');
  const issues = ctx.db.all<{ message: string }>(`SELECT message FROM review_issues WHERE source = 'verification' AND status = 'open'`);
  assert.equal(issues.length, 1, 'a second failing run opens no second issue');
  assert.match(issues[0]!.message, /points differ from 3\*x/);
});

test('--stale checks only graphs whose section changed since their last check', async () => {
  const { rev } = seed();
  fake.next(verdict('2*x'));
  await checkGraphs(ctx, P, { write: true });
  assert.deepEqual(await checkGraphs(ctx, P, { stale: true }), [], 'checked against the current text');
  ctx.db.run(`UPDATE content_revisions SET status = 'superseded' WHERE id = ?`, rev);
  ctx.db.insert('content_revisions', { id: newId(), project_id: P, node_id: 's1', kind: 'section', markdown: 'La velocità cresce come $$v = 2t$$, corretto.', origin: 'human', model: null, parent_rev_id: rev, status: 'current', citations: {}, created_at: now() });
  fake.next(verdict('2*x'));
  const stale = await checkGraphs(ctx, P, { stale: true });
  assert.deepEqual(stale.map((r) => r.verdict), ['pass']);
});

test('a trace without x and a graph of the reader\'s own function type are read as the reader draws them', async () => {
  const { graph } = seed();
  // Plotly counts x up from x0: the points are (1, 3), (2, 6), ... on the line 3x, not 2x.
  const implicit = { id: 'v', title: 'Velocità', type: 'plotly', config: { data: [{ type: 'scatter', mode: 'lines', name: 'v = 2 t', x0: 1, y: Array.from({ length: 20 }, (_, k) => 3 * (k + 1)) }], layout: { xaxis: { title: 't' }, yaxis: { title: 'v', range: [0, 60] } } } };
  ctx.db.run('UPDATE enrichments SET payload = ? WHERE id = ?', JSON.stringify(implicit), graph);
  fake.next(verdict('2*x'));
  const [r] = await checkGraphs(ctx, P);
  assert.equal(r!.verdict, 'fail');
  assert.match(r!.detail, /points differ from 2\*x/);
  const fn = { id: 'v', title: 'Velocità', type: 'function', config: { functions: [{ fn: '2*x', label: 'v = 2 t' }], xDomain: [0, 5], yDomain: [0, 10], xLabel: 't', yLabel: 'v' } };
  ctx.db.run('UPDATE enrichments SET payload = ? WHERE id = ?', JSON.stringify(fn), graph);
  // An answer for no trace cannot vouch for a graph that has one.
  fake.next(answer({ traces: [], fit: 'fits' }), verdict('2*x'));
  assert.equal((await checkGraphs(ctx, P))[0]!.verdict, 'fail');
  const [ok] = await checkGraphs(ctx, P);
  assert.equal(ok!.verdict, 'pass', ok!.detail);
  assert.match(fake.calls.at(-1)!.prompt, /x axis: t[\s\S]*1\. v = 2 t: a curve y = f\(x\) drawn for x from 0 to 5/);
});
