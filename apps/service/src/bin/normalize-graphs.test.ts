import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { AppContext } from '../context.ts';
import { makeCtx, seedProject } from '../llm/testkit.ts';
import { getEnrichment } from '../repo/index.ts';
import { normalizeGraphs } from './normalize-graphs.ts';

let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
beforeEach(() => { kit = makeCtx(); ctx = kit.ctx; seedProject(ctx, 'p1'); });
afterEach(() => kit.cleanup());

const xs = Array.from({ length: 21 }, (_, k) => k / 10);
const RAW = {
  id: 'parabola', title: 'Parabola y = 0.5*x^2', type: 'plotly',
  config: {
    data: [
      { type: 'scatter', mode: 'lines', name: 'y = 0.5*x^2', x: xs, y: xs.map((x) => 0.5 * x * x), line: { color: '#C2410C', width: 2.5 } },
      { type: 'scatter', mode: 'lines', name: 'Componente y: a_y', x: xs, y: xs.map((x) => x), line: { color: '#C2410C', width: 2.5 } },
    ],
    layout: { xaxis: { title: 'x', range: [0, 2] }, yaxis: { title: 'y', range: [0, 2] } },
  },
};
const CHECKS = [
  { method: 'numeric', ok: true, detail: 'Sampled.' },
  { method: 'lint', ok: true, detail: 'No problems in the data.' },
  { method: 'independent', ok: true, detail: '"y = 0.5*x^2": matches 0.5*x^2' },
];

function seedGraph() {
  ctx.db.insert('enrichments', { id: 'g1', project_id: 'p1', node_id: 's1', kind: 'graph', payload: RAW, status: 'verified', checks: CHECKS, spec: { id: 'parabola' }, checked_rev_id: 'r1', created_at: '2026-01-01T00:00:00Z' });
}

test('a dry run lists every change and what is left for a hand edit, and writes nothing', () => {
  seedGraph();
  const [r] = normalizeGraphs(ctx, 'p1');
  assert.deepEqual(r!.changes, [
    'title: "Parabola y = 0.5*x^2" → "Parabola y = 0,5x²"',
    'config.data[0] "y = 0.5*x^2".name: "y = 0.5*x^2" → "y = 0,5x²"',
    'config.data[1] "Componente y: a_y".line.color: "#C2410C" → "#3B82F6"',
  ]);
  assert.match(r!.remaining.join('\n'), /raw-notation \("Componente y: a_y"\).*"_y"/);
  assert.deepEqual(r!.newlyBlocked, []);
  assert.equal(r!.written, false);
  assert.deepEqual(getEnrichment(ctx, 'g1').payload, RAW);
});

test('--write saves the formatted graph and keeps its spec and checks; a second run finds nothing to change', () => {
  seedGraph();
  const [r] = normalizeGraphs(ctx, 'p1', { write: true });
  assert.equal(r!.written, true);
  const g = getEnrichment(ctx, 'g1');
  assert.equal(g.payload.title, 'Parabola y = 0,5x²');
  assert.equal(g.status, 'verified');
  assert.deepEqual(g.checks.map((c) => c.method), ['numeric', 'lint', 'independent']);
  assert.ok(g.spec);
  assert.equal(g.checkedRevisionId, 'r1');
  const again = normalizeGraphs(ctx, 'p1', { write: true });
  assert.deepEqual(again.map((x) => [x.changes.length, x.written]), [[0, false]]);
});
