import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFunctionGraph, numericallyEqual, sampleFunctionGraph } from './verify.ts';

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
  assert.equal(checkFunctionGraph({ id: 'p', title: 'P', type: 'plotly', config: { data: [], layout: {} } }).ok, false, 'a plotly graph with no curve is a failure');
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

test('checkFunctionGraph checks a sampled plotly graph like the generator does', () => {
  const spec = { id: 'g', title: 'G', functions: [{ expr: 'x^2', label: 'f' }], xDomain: [0, 2] as [number, number], yDomain: [0, 4] as [number, number], xLabel: 'x', yLabel: 'y' };
  const good = sampleFunctionGraph(spec).payload;
  assert.equal(checkFunctionGraph(good).ok, true);
  assert.equal(checkFunctionGraph({ ...good, config: { ...good.config, data: [] } }).ok, false, 'no curve');
  const trace = good.config.data[0] as Record<string, unknown>;
  const flat = { ...good, config: { ...good.config, data: [{ ...trace, y: (trace.y as number[]).map(() => 100) }] } };
  assert.match(checkFunctionGraph(flat).detail, /never enters/);
  const holes = { ...good, config: { ...good.config, data: [{ ...trace, y: (trace.y as number[]).map(() => null) }] } };
  assert.equal(checkFunctionGraph(holes).ok, false, 'undefined everywhere');
  assert.equal(checkFunctionGraph({ id: 'g', title: 'G', type: 'plotly', config: 'x' }).ok, false);
});

test('checkFunctionGraph accepts the other trace types the reader supports and reports the rest', () => {
  const plotly = (...data: unknown[]) => checkFunctionGraph({ id: 'p', title: 'P', type: 'plotly', config: { data, layout: {} } });
  assert.equal(plotly({ type: 'histogram', x: [1, 1, 2, 3] }).ok, true, 'a histogram has x and no y');
  assert.equal(plotly({ type: 'histogram', y: [1, 1, 2, 3] }).ok, true, 'a horizontal histogram has y and no x');
  assert.equal(plotly({ type: 'histogram', x: [] }).ok, false, 'a histogram without data');
  assert.equal(plotly({ type: 'bar', x: ['a', 'b'], y: [3, 5] }).ok, true, 'a bar trace with category labels');
  assert.equal(plotly({ type: 'bar', x: ['a', 'b'] }).ok, false, 'a bar trace without heights');
  assert.equal(plotly({ type: 'box', y: [1, 2, 3, 9] }).ok, true);
  assert.equal(plotly({ type: 'pie', values: [1, 2], labels: ['a', 'b'] }).ok, true);
  assert.equal(plotly({ type: 'pie', labels: ['a', 'b'] }).ok, false, 'a pie without values');
  assert.equal(plotly({ type: 'scatter', mode: 'lines', x: [0, 1, 2], y: [0, 1, 4] }).ok, true, 'a line trace with good data');
  assert.equal(plotly({ x: [0, 1, 2], y: [0, 1, 4] }).ok, true, 'scatter is the default type');
  assert.equal(plotly({ type: 'scattergl', x: [0, 1], y: [0, 1] }).ok, true, 'the reader reads scattergl as scatter');
  const mostlyUndefined = plotly({ type: 'scatter', mode: 'lines', x: [0, 1, 2, 3], y: [null, null, null, 1] });
  assert.equal(mostlyUndefined.ok, false);
  assert.match(mostlyUndefined.detail, /undefined on most/);
  assert.equal(plotly({ type: 'scatter', x: [0, 1], y: [] }).ok, false, 'a line trace without points');
  assert.equal(plotly({ type: 'scatter', mode: 'text', x: [0], y: [0], text: ['a'] }).ok, true, 'a text-only scatter is not a curve');
  const unsupported = plotly({ type: 'surface', z: [[1, 2], [3, 4]] });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.detail, /surface/);
  assert.equal(plotly().ok, false, 'an empty graph');
  assert.equal(plotly({ type: 'histogram', x: [1, 2] }, { type: 'scatter', y: [null, null] }).ok, false, 'one bad trace fails the graph');
});

// ---------------------------------------------------------------------------------------------
// Logarithmic axes in interactive graphs
// ---------------------------------------------------------------------------------------------

/**
 * A copy of the reader's `sanitizePlotlyConfig` (src/lib/plotlySanitize.ts in politost-smartbook, origin/main on 2026-11-11), so the
 * test shows what survives the reader. Update it when the reader's rule changes.
 */
function readerSanitize(data: unknown, layout: unknown): { data: object[]; layout: Record<string, unknown> } | null {
  const TRACE_TYPES = new Set(['scatter', 'bar', 'histogram', 'pie', 'box']);
  const ALLOWED_KEYS = new Set([
    'type', 'mode', 'name', 'x', 'y', 'text', 'textposition', 'textfont', 'marker',
    'hovertemplate', 'hoverinfo', 'orientation', 'opacity',
    'title', 'xaxis', 'yaxis', 'shapes', 'annotations', 'showlegend',
    'plot_bgcolor', 'paper_bgcolor', 'margin', 'height', 'width', 'autosize', 'legend',
    'font', 'size', 'color', 'family', 'style', 'range', 'tickfont', 'tickvals', 'ticktext',
    'gridcolor', 'dtick', 'x0', 'x1', 'y0', 'y1', 'fillcolor', 'line', 'width', 'symbol',
    'showarrow', 'l', 'r', 't', 'b',
  ]);
  const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
  const isPlainData = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) ? v.every(isPlainData) : isPlain(v) && Object.values(v).every(isPlainData));
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/<[^>]*>/g, '');
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (Array.isArray(v)) return v.filter(isPlainData).map(clean);
    if (!isPlain(v)) return undefined;
    return Object.fromEntries(Object.entries(v).filter(([k, c]) => ALLOWED_KEYS.has(k) && isPlainData(c)).map(([k, c]) => [k, clean(c)]));
  };
  if (!Array.isArray(data) || !data.length) return null;
  const traces: object[] = [];
  for (const trace of data) {
    if (!isPlain(trace) || !TRACE_TYPES.has(typeof trace.type === 'string' ? trace.type : 'scatter')) return null;
    traces.push(clean(trace) as object);
  }
  return { data: traces, layout: (clean(layout) ?? {}) as Record<string, unknown> };
}

const BODE_GRAPH = {
  id: 'bode', title: 'Low-pass', xScale: 'log' as const, xDomain: [10, 100000] as [number, number], yDomain: [-40, 5] as [number, number],
  xLabel: 'f (Hz)', yLabel: '|H| (dB)', functions: [{ expr: '-10*log10(1+(x/1000)^2)', label: '|H|' }],
};

test('sampleFunctionGraph: a log x axis is sampled evenly in the exponent and written as a Plotly log axis', () => {
  const r = sampleFunctionGraph(BODE_GRAPH);
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /exponent/);
  const { xaxis, yaxis } = r.payload.config.layout as { xaxis: { type: string; range: number[] }; yaxis: { type?: string; range: number[] } };
  assert.deepEqual(xaxis.range, [1, 5], 'the range of a log axis is in exponents');
  assert.equal(xaxis.type, 'log');
  assert.equal(yaxis.type, undefined, 'a linear axis keeps the layout it had');
  const xs = (r.payload.config.data[0] as { x: number[] }).x;
  assert.equal(xs.length, 401);
  assert.equal(xs[0], 10);
  assert.equal(xs[400], 100000);
  const gaps = xs.slice(1).map((x, i) => Math.log10(x) - Math.log10(xs[i]));
  assert.ok(gaps.every((g) => Math.abs(g - 4 / 400) < 1e-6), 'equal steps of the exponent');
});

test('sampleFunctionGraph: a log y axis shows only positive values and breaks the line elsewhere', () => {
  const r = sampleFunctionGraph({ id: 'd', title: 'D', xDomain: [-2, 2], yDomain: [0.01, 100], xLabel: 'x', yLabel: 'y', yScale: 'log', functions: [{ expr: 'x', label: 'x' }, { expr: '10^x', label: '10^x' }] });
  assert.equal(r.ok, true, r.detail);
  const ys = (r.payload.config.data[0] as { y: (number | null)[] }).y;
  assert.ok(ys.slice(0, 200).every((y) => y === null), 'x is not positive on the left half');
  assert.deepEqual((r.payload.config.layout as { yaxis: { range: number[] } }).yaxis.range, [-2, 2]);
});

test('sampleFunctionGraph: a log axis needs a positive domain, and says so', () => {
  const r = sampleFunctionGraph({ ...BODE_GRAPH, xDomain: [0, 1000] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /x domain \[0, 1000\] must be positive on a log axis/);
  assert.equal((r.payload.config.layout as { xaxis: { type?: string } }).xaxis.type, undefined, 'the payload falls back to a linear axis');
});

test('a log graph keeps its axis type and exponent range through the reader\'s sanitiser', () => {
  const { payload } = sampleFunctionGraph({ ...BODE_GRAPH, yScale: 'log', yDomain: [0.001, 10], functions: [{ expr: '1/sqrt(1+(x/1000)^2)', label: '|H|' }] });
  const shown = readerSanitize(payload.config.data, payload.config.layout);
  assert.ok(shown, 'the reader accepts the graph');
  const { xaxis, yaxis } = shown.layout as { xaxis: Record<string, unknown>; yaxis: Record<string, unknown> };
  assert.equal(xaxis.type, 'log');
  assert.deepEqual(xaxis.range, [1, 5]);
  assert.equal(yaxis.type, 'log');
  assert.deepEqual(yaxis.range, [-3, 1]);
  assert.equal(xaxis.title, 'f (Hz)');
});

test('checkFunctionGraph reads a log axis: range in exponents, positive values only', () => {
  const good = sampleFunctionGraph({ ...BODE_GRAPH, yScale: 'log', yDomain: [0.001, 10], functions: [{ expr: '1/sqrt(1+(x/1000)^2)', label: '|H|' }] }).payload;
  assert.equal(checkFunctionGraph(good).ok, true, checkFunctionGraph(good).detail);
  const trace = good.config.data[0] as Record<string, unknown>;
  // The same y values far above the visible range [10^-3, 10^1]: the range must be read as 10^range, not as the exponents -3 and 1.
  const high = { ...good, config: { ...good.config, data: [{ ...trace, y: (trace.y as number[]).map(() => 1000) }] } };
  assert.match(checkFunctionGraph(high).detail, /never enters the visible range \[0\.001, 10\]/);
  // Values of 0.5 are inside [10^-3, 10^1] but would be outside [-3, 1] read as plain numbers.
  const inside = { ...good, config: { ...good.config, data: [{ ...trace, y: (trace.y as number[]).map(() => 0.5) }] } };
  assert.equal(checkFunctionGraph(inside).ok, true);
  const negative = { ...good, config: { ...good.config, data: [{ ...trace, y: (trace.y as number[]).map(() => -0.5) }] } };
  assert.match(checkFunctionGraph(negative).detail, /undefined on most of the domain \(a log axis shows only positive values\)/);
  const xNegative = { ...good, config: { ...good.config, data: [{ ...trace, x: (trace.x as number[]).map((x) => -x) }] } };
  assert.equal(checkFunctionGraph(xNegative).ok, false, 'a log x axis cannot show negative x');
});
