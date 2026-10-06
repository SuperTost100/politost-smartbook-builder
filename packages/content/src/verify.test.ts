import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFunctionGraph, numericallyEqual } from './verify.ts';

const graph = (functions: unknown[], xDomain: unknown = [-2, 2], yDomain: unknown = [-1, 5]) => ({
  id: 'g', title: 'G', type: 'function', config: { functions, xDomain, yDomain },
});

test('checkFunctionGraph: a polynomial inside the domain passes', () => {
  const r = checkFunctionGraph(graph([{ fn: 'x^2', label: 'x^2' }, { fn: '0.5*x + 1' }]));
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /400\/400 finite/);
});

test('checkFunctionGraph: accepts the bare config as well as the whole payload', () => {
  assert.equal(checkFunctionGraph({ functions: [{ fn: 'x' }], xDomain: [0, 1] }).ok, true);
});

test('checkFunctionGraph: the reader evaluator cannot do sin(x) or implicit products', () => {
  const sin = checkFunctionGraph(graph([{ fn: 'sin(x)' }]));
  assert.equal(sin.ok, false);
  assert.match(sin.detail, /unsupported characters "sin"/);
  const implicit = checkFunctionGraph(graph([{ fn: '2x' }]));
  assert.equal(implicit.ok, false);
  assert.match(implicit.detail, /does not evaluate/);
  assert.equal(checkFunctionGraph(graph([{ fn: '2*x' }])).ok, true);
  assert.equal(checkFunctionGraph(graph([{ fn: '(x+1' }])).ok, false);
});

test('checkFunctionGraph: needs 80% finite samples', () => {
  const half = checkFunctionGraph(graph([{ fn: '1/(x*x)' }], [0, 0.0001], [0, 1e12]));
  assert.ok(half.ok, half.detail); // finite everywhere except x = 0 (one sample)
  const mostlyUndefined = checkFunctionGraph(graph([{ fn: '1/(x - x)' }], [-1, 1], [-1, 1]));
  assert.equal(mostlyUndefined.ok, false);
  const hole = checkFunctionGraph(graph([{ fn: '0/0 + x' }], [-1, 1], [-1, 1]));
  assert.equal(hole.ok, false);
});

test('checkFunctionGraph: some value must fall inside yDomain', () => {
  const r = checkFunctionGraph(graph([{ fn: 'x^2 + 100' }]));
  assert.equal(r.ok, false);
  assert.match(r.detail, /no value falls inside yDomain/);
  assert.equal(checkFunctionGraph({ functions: [{ fn: 'x^2 + 100' }], xDomain: [-2, 2] }).ok, true, 'yDomain is optional');
});

test('checkFunctionGraph: structural problems', () => {
  assert.equal(checkFunctionGraph(graph([])).ok, false);
  assert.equal(checkFunctionGraph(graph([{ fn: 'x' }], [1, 1])).ok, false);
  assert.equal(checkFunctionGraph(graph([{ fn: 'x' }], 'a')).ok, false);
  assert.equal(checkFunctionGraph(graph([{ fn: 'x' }], [0, 1], [3, 1])).ok, false);
  assert.equal(checkFunctionGraph(graph([{ nofn: true }])).ok, false);
  assert.equal(checkFunctionGraph({ id: 'p', title: 'P', type: 'plotly', config: { data: [], layout: {} } }).ok, true);
  assert.equal(checkFunctionGraph({ type: 'surface', config: {} }).ok, false);
});

test('numericallyEqual: equal expressions', () => {
  for (const [a, b] of [['x^2 - 1', '(x-1)*(x+1)'], ['sin(x)^2 + cos(x)^2', '1'], ['2*x + x', '3x'], ['exp(log(x))', 'x']] as const) {
    const r = numericallyEqual(a, b, { domain: [0.1, 5] });
    assert.equal(r.ok, true, `${a} vs ${b}: ${r.detail}`);
  }
  assert.equal(numericallyEqual('e^x', 'exp(x)').ok, true);
  assert.equal(numericallyEqual('pi*x', '3.141592653589793*x').ok, true);
});

test('numericallyEqual: different expressions fail and say where', () => {
  const r = numericallyEqual('x^2', 'x^2 + 0.001');
  assert.equal(r.ok, false);
  assert.match(r.detail, /differ at x=/);
  assert.equal(numericallyEqual('x', '-x').ok, false);
  assert.equal(numericallyEqual('sqrt(x)', 'x', { domain: [-1, 1] }).ok, false);
});

test('numericallyEqual: relative tolerance 1e-6', () => {
  assert.equal(numericallyEqual('1000000*x', '1000000.0001*x', { domain: [1, 2] }).ok, true);
  assert.equal(numericallyEqual('x', '1.00001*x', { domain: [1, 2] }).ok, false);
});

test('numericallyEqual: points where both are undefined are ignored', () => {
  const r = numericallyEqual('sqrt(x)', 'sqrt(x)', { domain: [-5, 5] });
  assert.equal(r.ok, true, r.detail);
  assert.equal(numericallyEqual('log(x)', 'log(x) + 0', { domain: [-3, 3] }).ok, true);
  // never defined: nothing to compare
  const none = numericallyEqual('sqrt(x)', 'sqrt(x)', { domain: [-5, -1] });
  assert.equal(none.ok, false);
  assert.match(none.detail, /comparable/);
});

test('numericallyEqual: several variables and unsafe input', () => {
  assert.equal(numericallyEqual('x*y + y', 'y*(x+1)', { vars: ['x', 'y'] }).ok, true);
  assert.equal(numericallyEqual('x*y', 'x*z', { vars: ['x', 'y'] }).ok, false);
  for (const bad of ['process.exit()', 'x = 3', 'f(x) = x', 'evaluate("2")', 'import("fs")', 'z + 1']) {
    const r = numericallyEqual(bad, 'x');
    assert.equal(r.ok, false, bad);
    assert.match(r.detail, /first expression/);
  }
  assert.match(numericallyEqual('x', 'unknown(x)').detail, /second expression/);
  assert.equal(numericallyEqual('x', 'x', { domain: [2, 1] }).ok, false);
});

test('numericallyEqual is deterministic', () => {
  assert.deepEqual(numericallyEqual('x^2', 'x^2 + 1e-3'), numericallyEqual('x^2', 'x^2 + 1e-3'));
});

test('sampleFunctionGraph turns functions the reader cannot evaluate into plotly data', async () => {
  const { sampleFunctionGraph } = await import('./verify.ts');
  const r = sampleFunctionGraph({ id: 'g', title: 'Seno', functions: [{ expr: 'sin(x)/x', label: 'sin(x)/x' }, { expr: '1/x', label: '1/x' }], xDomain: [-10, 10], yDomain: [-3, 3], xLabel: 'x', yLabel: 'y' });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.payload.type, 'plotly');
  const hyper = r.payload.config.data[1] as { y: (number | null)[] };
  assert.ok(hyper.y.includes(null), 'discontinuity at 0 breaks the line');
  const bad = sampleFunctionGraph({ id: 'b', title: 'B', functions: [{ expr: 'import("fs")', label: 'x' }], xDomain: [0, 1], yDomain: [0, 1], xLabel: 'x', yLabel: 'y' });
  assert.equal(bad.ok, false);
});
