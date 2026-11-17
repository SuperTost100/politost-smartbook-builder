import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphLintCheck, lintGraph, lintKey } from './graphLint.ts';
import { sampleFunctionGraph } from './verify.ts';

type Fn = { expr: string; label: string };
const sampled = (functions: Fn[], opts: { x?: [number, number]; y?: [number, number]; xLabel?: string; yLabel?: string } = {}) =>
  sampleFunctionGraph({ id: 'g', title: 'G', functions, xDomain: opts.x ?? [-2, 2], yDomain: opts.y ?? [-5, 5], xLabel: opts.xLabel ?? 'x', yLabel: opts.yLabel ?? 'y' }).payload as unknown as Record<string, unknown>;
const raw = (data: object[], layout: object = { xaxis: { title: 'x' }, yaxis: { title: 'y' } }) => ({ id: 'g', title: 'G', type: 'plotly', config: { data, layout } });
const codes = (p: Record<string, unknown>) => [...new Set(lintGraph(p).map((f) => f.code))].sort();

test('graphs that state their law correctly get no findings', () => {
  assert.deepEqual(codes(sampled([{ expr: 'sin(x)', label: 'sin x' }, { expr: 'x - x^3/6', label: 'T₃(x) = x − x³/6' }], { x: [-3, 3], y: [-2, 2] })), []);
  assert.deepEqual(codes(sampled([{ expr: '50*x', label: 'F = 50·x' }], { x: [0, 0.2], y: [0, 12], xLabel: 'Allungamento x (m)', yLabel: 'Forza F (N)' })), []);
  assert.deepEqual(codes(sampled([{ expr: 'floor(x)', label: 'parte intera' }], { x: [0, 3], y: [-1, 4] })), [], 'a step function sampled with gaps');
  assert.deepEqual(lintGraph({ id: 'f', title: 'F', type: 'function', config: { functions: [{ fn: 'x^2', label: 'f' }], xDomain: [0, 1] } }), [], 'the reader\'s own function graphs carry no data to read');
});

test('each blocking check fires on the error it is for', () => {
  assert.deepEqual(codes(raw([])), ['empty']);
  assert.deepEqual(codes(sampled([{ expr: 'x', label: 'Charles' }, { expr: 'x', label: 'Gay-Lussac' }], { x: [0, 4] })), ['duplicate']);
  // floor joined by vertical segments, as the old sampler drew it.
  const xs = Array.from({ length: 301 }, (_, k) => k / 100);
  assert.deepEqual(codes(raw([{ type: 'scatter', mode: 'lines', name: 'parte intera', x: xs, y: xs.map(Math.floor) }], { xaxis: { title: 'x' }, yaxis: { title: 'y', range: [-1, 4] } })), ['joined-jump']);
  assert.deepEqual(codes(sampled([{ expr: '100*x', label: 'velocità' }, { expr: '0.01*x', label: 'quota' }], { x: [0, 1], y: [0, 100] })), ['invisible']);
  assert.deepEqual(codes(sampled([{ expr: 'x^3', label: 'y = x²' }])), ['label-mismatch']);
  assert.deepEqual(codes(sampled([{ expr: 'sqrt(1 - x^2)', label: 'Circonferenza r = 1' }], { x: [-1, 1], y: [-1.5, 1.5] })), ['needs-parametric']);
  assert.deepEqual(codes(sampled([{ expr: 'x/x', label: 'Valore in x = 1' }, { expr: 'x^2', label: 'f(x) = x²' }], { x: [0, 2] })), ['point-as-curve']);
  assert.deepEqual(codes(sampled([{ expr: '1.77', label: 'Corpo A' }, { expr: '2.5', label: 'Corpo B' }])), ['all-constant']);
  assert.deepEqual(codes(sampled([{ expr: 'x', label: 'Alcani' }, { expr: 'x^2', label: 'Alcheni' }, { expr: 'sin(x)', label: 'Alchini' }])), ['placeholder']);
  assert.deepEqual(codes(sampled([{ expr: 'x', label: 'f(x) = x' }], { yLabel: 'Pressione (scala logaritmica)' })), ['axis-scale']);
});

test('warnings: one axis for several quantities, several units on one axis', () => {
  const multi = lintGraph(sampled([{ expr: 'x', label: 'f(x) = x' }], { xLabel: 'Distanza, forza o temperatura' }));
  assert.deepEqual(multi.map((f) => [f.code, f.severity]), [['multiplexed-axis', 'warn']]);
  const units = lintGraph(sampled([{ expr: '2*x', label: 'pressione (Pa)' }, { expr: '3*x', label: 'velocità (m/s)' }]));
  assert.deepEqual(units.map((f) => [f.code, f.severity]), [['mixed-units', 'warn']]);
});

test('graphLintCheck fails on a blocking finding until the author accepts it, and never on a warning', () => {
  const dup = sampled([{ expr: 'x', label: 'Charles' }, { expr: 'x', label: 'Gay-Lussac' }], { x: [0, 4] });
  const first = graphLintCheck(dup);
  assert.equal(first.ok, false);
  assert.match(first.detail, /duplicate \("Gay-Lussac"\): same data as "Charles"/);
  const accepted = graphLintCheck(dup, first.findings.map(lintKey));
  assert.equal(accepted.ok, true);
  assert.match(accepted.detail, /accepted by the author/);
  assert.equal(graphLintCheck(dup, ['duplicate:Charles']).ok, false, 'an acceptance names the trace it is for');
  const warned = graphLintCheck(sampled([{ expr: 'x', label: 'f(x) = x' }], { xLabel: 'Distanza, forza o temperatura' }));
  assert.equal(warned.ok, true);
  assert.match(warned.detail, /\(warning\)/);
  assert.deepEqual(graphLintCheck(sampled([{ expr: 'x', label: 'f(x) = x' }])), { method: 'lint', ok: true, detail: 'No problems in the data.', findings: [] });
});
