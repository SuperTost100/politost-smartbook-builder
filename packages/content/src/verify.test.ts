import { readFileSync } from 'node:fs';
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

test('a plotly trace must have a point inside the displayed x range as well as the y range', () => {
  const graph = (layout: unknown, x: unknown[], y: unknown[]) => checkFunctionGraph({ id: 'p', title: 'P', type: 'plotly', config: { data: [{ type: 'scatter', mode: 'lines', x, y }], layout } });
  // A log x axis with range [1, 2] shows 10 to 100: x values of 1000 and 2000 are off the screen.
  const off = graph({ xaxis: { type: 'log', range: [1, 2] }, yaxis: { range: [0, 10] } }, [1000, 2000], [5, 6]);
  assert.equal(off.ok, false);
  assert.match(off.detail, /never enters the visible x range \[10, 100\]/);
  assert.equal(graph({ xaxis: { type: 'log', range: [1, 2] } }, [1000, 2000], [5, 6]).ok, false, 'also when only the x range is set');
  assert.equal(graph({ xaxis: { range: [0, 3] }, yaxis: { range: [0, 10] } }, [10, 20], [5, 6]).ok, false, 'a linear x axis');
  assert.equal(graph({ xaxis: { type: 'log', range: [1, 2] }, yaxis: { range: [0, 10] } }, [1000, 50], [5, 6]).ok, true, 'one point on screen is enough');
  assert.equal(graph({ xaxis: { range: [0, 3] }, yaxis: { range: [0, 10] } }, [1, 2], [50, 60]).ok, false, 'a y range off the screen still fails');
  assert.equal(graph({ yaxis: { range: [0, 10] } }, [1000, 2000], [5, 6]).ok, true, 'without an x range there is no x limit');
  assert.equal(graph({ xaxis: { range: [0, 3] }, yaxis: { range: [0, 10] } }, [1, 2], [50, 6]).ok, true, 'the same point must be inside both ranges: x=2, y=6');
  assert.equal(graph({ xaxis: { range: [0, 1.5] }, yaxis: { range: [0, 10] } }, [1, 2], [50, 6]).ok, false, 'x=1 has y=50 and x=2 is off: no point is inside both');
  // A trace without an x array starts at its x0 and steps by 1, as the reader draws it (the reader keeps x0 and drops dx).
  const implicit = (trace: object, range: [number, number]) => checkFunctionGraph({ id: 'p', title: 'P', type: 'plotly', config: { data: [{ type: 'scatter', mode: 'lines', y: [5, 6], ...trace }], layout: { xaxis: { range }, yaxis: { range: [0, 10] } } } });
  assert.equal(implicit({ x0: 100 }, [99, 102]).ok, true, 'the points are at x=100 and x=101');
  assert.equal(implicit({ x0: 100 }, [0, 3]).ok, false);
  assert.equal(implicit({}, [0, 3]).ok, true, 'without x0 they are at 0 and 1');
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

test('checkFunctionGraph gives a trace without x the coordinates 0, 1, 2, ... that Plotly uses', () => {
  const layout = { xaxis: { type: 'log' }, yaxis: {} };
  const trace = (y: number[], x?: number[]) => ({ type: 'plotly', config: { data: [{ type: 'scatter', mode: 'lines', y, ...(x ? { x } : {}) }], layout } });
  // x is 0, 1, 2, 3: three points are positive, so three of four are visible on a log axis.
  assert.equal(checkFunctionGraph(trace([1, 2, 3, 4])).ok, true, checkFunctionGraph(trace([1, 2, 3, 4])).detail);
  // Explicit x values are read as they are: one positive x in four is too few.
  assert.equal(checkFunctionGraph(trace([1, 2, 3, 4], [-1, -2, 0, 5])).ok, false, 'explicit x values are still read as they are');
  assert.match(checkFunctionGraph(trace([1, 2, 3, 4], [-1, -2, 0, 5])).detail, /undefined on most of the domain/);
});

test('sampleFunctionGraph breaks the line at jumps and poles found by bisection, and keeps a steep continuous curve whole', () => {
  const sample = (expr: string, xDomain: [number, number], yDomain: [number, number]) => {
    const r = sampleFunctionGraph({ id: 'j', title: 'J', functions: [{ expr, label: expr }], xDomain, yDomain, xLabel: 'x', yLabel: 'y' });
    const t = r.payload.config.data[0] as { x: number[]; y: (number | null)[] };
    return t.x.filter((_, k) => t.y[k] === null);
  };
  // A unit step of floor on a window 8 high: the old rule (a step larger than the whole window) joined it.
  const step = sample('floor(x) - 0.5', [0.5, 2.2], [-2, 6]);
  assert.ok(step.some((x) => x > 0.995 && x < 1.005), `a gap at x = 1, got ${step.join(', ')}`);
  assert.ok(step.some((x) => x > 1.995 && x < 2.005), 'and one at x = 2');
  assert.equal(step.length, 2);
  // A pole whose two sides stay inside a wide window.
  const pole = sample('1/(x-1)', [0, 3], [-400, 400]);
  assert.equal(pole.length, 1);
  assert.ok(Math.abs(pole[0]! - 1) < 0.01, `a gap at the pole, got ${pole[0]}`);
  assert.ok(sample('x - floor(x)', [-3, 3], [-4, 9]).length >= 5, 'the mantissa breaks at every integer');
  assert.deepEqual(sample('atan(200*(x-1))', [0, 2], [-2, 2]), [], 'a steep but continuous curve is not cut');
  assert.deepEqual(sample('x^3', [-10, 10], [-1000, 1000]), [], 'nor is a smooth curve with large steps');
});

test('jumpsBetween tells a jump from a steep slope', async () => {
  const { jumpsBetween } = await import('./verify.ts');
  const floor = (x: number) => Math.floor(x);
  assert.equal(jumpsBetween(floor, 0.99, 1.01, 0, 1), true);
  const steep = (x: number) => Math.atan(200 * (x - 1));
  assert.equal(jumpsBetween(steep, 0.99, 1.01, steep(0.99), steep(1.01)), false);
  const pole = (x: number) => 1 / (x - 1);
  assert.equal(jumpsBetween(pole, 0.99, 1.02, pole(0.99), pole(1.02)), true);
});

test('sampleGraph draws every trace kind with the Plotly parts the reader keeps', async () => {
  const { sampleGraph } = await import('./verify.ts');
  const r = sampleGraph({
    id: 'k', title: 'K', xDomain: [-3, 3], yDomain: [-3, 3], xLabel: 'x', yLabel: 'y',
    traces: [
      { kind: 'function', label: 'y = x per x ≥ 0', fn: 'x', domain: [0, 5] },
      { kind: 'parametric', label: 'Circonferenza r = 1', xt: 'cos(t)', yt: 'sin(t)', tRange: [0, 6.2832] },
      { kind: 'points', label: 'Buco e punto', points: [{ x: 1, y: 2, open: true }, { x: 1, y: 1 }] },
      { kind: 'vline', label: 'Isocora V = 2', value: 2 },
    ],
  });
  assert.equal(r.ok, true, r.detail);
  const [fn, circle, pts, vline] = r.payload.config.data as { type: string; mode: string; x: number[]; y: (number | null)[]; marker?: { symbol: string[] } }[];
  assert.equal(fn!.x[0], 0, 'a function trace starts at its own domain');
  assert.equal(fn!.x.at(-1), 3, 'and stops at the x axis');
  assert.ok(Math.abs(circle!.x[100]! - Math.cos(6.2832 / 4)) < 1e-6, 'a parametric curve is sampled in t');
  assert.deepEqual([pts!.mode, pts!.marker!.symbol], ['markers', ['circle-open', 'circle']]);
  assert.deepEqual([vline!.x, vline!.y], [[2, 2], [-3, 3]]);
  const bars = sampleGraph({ id: 'b', title: 'B', xDomain: [0, 1], yDomain: [0, 10], xLabel: 'Composto', yLabel: 'n', traces: [{ kind: 'bars', label: 'Atomi di H', bars: [{ category: 'Etano', value: 6 }, { category: 'Etene', value: 4 }, { category: 'Etino', value: 2 }] }] });
  assert.equal(bars.ok, true, bars.detail);
  assert.deepEqual((bars.payload.config.layout as { xaxis: unknown }).xaxis, { title: 'Composto' }, 'a category axis gets no numeric range that would clip the third bar');
  // Everything the sampler writes survives the reader's sanitiser, symbols of open points included.
  for (const p of [r.payload, bars.payload]) {
    const shown = readerSanitize(p.config.data, p.config.layout);
    assert.ok(shown, 'the reader accepts the graph');
    assert.deepEqual(shown.data, JSON.parse(JSON.stringify(p.config.data)));
  }
});

test('sampleGraph breaks a parametric curve at a pole in t and leaves a smooth one whole', async () => {
  const { sampleGraph } = await import('./verify.ts');
  const base = { id: 'p', title: 'P', xDomain: [-1, 2] as [number, number], yDomain: [-10, 10] as [number, number], xLabel: 'x', yLabel: 'y' };
  const nulls = (xt: string, yt: string, tRange: [number, number]) => {
    const r = sampleGraph({ ...base, traces: [{ kind: 'parametric', label: 'c', xt, yt, tRange }] });
    const d = r.payload.config.data[0] as { x: (number | null)[] };
    return d.x.filter((v) => v === null).length;
  };
  assert.equal(nulls('t', '1/t', [-1, 2]), 1, 'the hyperbola is not joined across t = 0');
  assert.equal(nulls('cos(t)', 'sin(t)', [0, 6.2832]), 0);
});

test('sampleGraph reports traces it cannot draw', async () => {
  const { sampleGraph } = await import('./verify.ts');
  const base = { id: 'e', title: 'E', xDomain: [0, 2] as [number, number], yDomain: [0, 2] as [number, number], xLabel: 'x', yLabel: 'y' };
  assert.match(sampleGraph({ ...base, traces: [{ kind: 'function', label: 'f', fn: 'x', domain: [5, 6] }] }).detail, /lies outside the x axis/);
  assert.match(sampleGraph({ ...base, traces: [{ kind: 'parametric', label: 'c', xt: 'cos(t)', yt: 'sin(t)' }] }).detail, /tRange/);
  assert.match(sampleGraph({ ...base, traces: [{ kind: 'points', label: 'p', points: [] }] }).detail, /no points/);
  assert.match(sampleGraph({ ...base, traces: [{ kind: 'points', label: 'p', points: [{ x: 9, y: 9 }] }] }).detail, /no point lies in the visible window/);
  assert.match(sampleGraph({ ...base, traces: [{ kind: 'vline', label: 'v', value: 7 }] }).detail, /needs an x value inside \[0, 2\]/);
  assert.match(sampleGraph({ ...base, traces: [{ kind: 'bars', label: 'b', bars: [{ category: 'A', value: 1 }, { category: '', value: 2 }] }] }).detail, /no name or no value/);
});

test('graphSourceCheck wants every trace to quote the section, and warns about one source drawn two ways', async () => {
  const { graphSourceCheck, sourceQuoted } = await import('./verify.ts');
  const section = 'La soluzione è $$y(t) = \\frac{2}{2 - t^2}$$ per $|t| < \\sqrt{2}$.';
  assert.equal(sourceQuoted('y(t)=\\frac{2}{2-t^2}', section), true, 'spaces and $ do not matter');
  assert.equal(sourceQuoted('y(t) = \\frac{1}{1 - t^2/4}', section), false);
  assert.equal(sourceQuoted('y', section), false, 'a quote of one or two characters proves nothing');
  // A quote must hold maths: prose occurs in the section and states no formula.
  const nernst = 'Per la reazione di Nernst con $n=2$ elettroni vale $E = E^\\circ - \\frac{0{,}0592}{n}\\log Q$.';
  for (const prose of ['la reazione', 'Nernst', 'con']) assert.equal(sourceQuoted(prose, nernst), false, prose);
  for (const maths of ['n=2', 'E^\\circ', '\\log Q']) assert.equal(sourceQuoted(maths, nernst), true, maths);
  const ok = graphSourceCheck([{ kind: 'function', label: 'y', fn: '2/(2-x^2)', source: 'y(t) = \\frac{2}{2 - t^2}' }], section);
  assert.equal(ok.ok, true, ok.detail);
  const invented = graphSourceCheck([{ kind: 'function', label: 'y2', fn: '1/(1-x^2/4)', source: 'y(t) = \\frac{1}{1 - t^2/4}' }], section);
  assert.equal(invented.ok, false);
  assert.match(invented.detail, /which the section does not contain/);
  const twice = graphSourceCheck([
    { kind: 'function', label: 'a', fn: '2/(2-x^2)', source: 'y(t) = \\frac{2}{2 - t^2}' },
    { kind: 'function', label: 'b', fn: '1/(1-x^2/4)', source: 'y(t) = \\frac{2}{2 - t^2}' },
  ], section);
  assert.equal(twice.ok, true);
  assert.match(twice.detail, /"b" and "a" quote the same source with different expressions \(warning\)/);
});

test('compareExpected checks the data against the expected curve and fits free constants', async () => {
  const { compareExpected } = await import('./verify.ts');
  const xs = Array.from({ length: 21 }, (_, k) => k / 2);
  const ys = xs.map((x) => 101325 - 500 * x * x);
  assert.equal(compareExpected('101325 - 500*x^2', xs, ys, 60000)!.ok, true);
  const wrong = compareExpected('101325 + 500*x^2', xs, ys, 60000)!;
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /points differ from 101325 \+ 500\*x\^2/);
  // The section gives no reference pressure: a constant C is fitted, but the shape must still match.
  const fit = compareExpected('C - 500*x^2', xs, ys, 60000)!;
  assert.equal(fit.ok, true, fit.detail);
  assert.match(fit.detail, /C = 101325/);
  assert.deepEqual(fit.constants, { C: 101325 }, 'the fitted value, to compare across the traces of one graph');
  assert.equal(compareExpected('C - 400*x^2', xs, ys, 60000)!.ok, false);
  assert.equal(compareExpected('C1 + C2*x^2', xs, ys, 60000)!.ok, true, 'two constants');
  assert.equal(compareExpected('exp(C*x)', xs, ys, 60000), null, 'not affine in its constant: no verdict');
  assert.equal(compareExpected('', xs, ys, 60000), null);
  // A branch drawn where the expected curve does not exist is a difference, not a point to skip.
  const wide = Array.from({ length: 41 }, (_, k) => -2 + k / 10).filter((x) => x !== 0);
  const branch = compareExpected('log(x)', wide, wide.map((x) => Math.log(Math.abs(x))), 4)!;
  assert.equal(branch.ok, false);
  assert.match(branch.detail, /the data has a value and log\(x\) is undefined/);
  assert.equal(compareExpected('log(x)', [-5, -4, -3, -2, -1], [1, 2, 3, 4, 5], 10)!.ok, false, 'drawn only where the expected curve is undefined');
  assert.equal(compareExpected('x', [1, 2], [1, 2], 1), null, 'too few points');
});

test('checkFunctionGraph lets through a branch drawn on part of a shared x grid, and still fails a trace that is mostly undefined', () => {
  // Two hand-drawn graphs of the books: each branch is one unbroken run of points on half of the x grid the other traces use.
  const book = (id: string) => JSON.parse(readFileSync(new URL(`./testdata/graphs/${id}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
  for (const id of ['valore-assoluto-punto-angoloso', 'gibbs-onde-quadra']) {
    assert.equal(checkFunctionGraph(book(id)).ok, true, `${id}: ${checkFunctionGraph(book(id)).detail}`);
  }
  const lines = (y: (number | null)[]) => checkFunctionGraph({ type: 'plotly', config: { data: [{ type: 'scatter', mode: 'lines', x: y.map((_, k) => k), y }], layout: {} } });
  const grid = Array.from({ length: 401 }, (_, k) => k);
  assert.equal(lines(grid.map((k) => (k < 200 ? k : null))).ok, true, 'a branch on 200 of 401 points');
  // What the rule is for: a curve the reader would barely draw.
  assert.match(lines(grid.map((k) => (k % 3 === 0 ? k : null))).detail, /undefined on most of the domain/, 'defined only at scattered points');
  assert.match(lines(grid.map((k) => (k < 5 ? k : null))).detail, /undefined on most of the domain/, 'a run of 5 points out of 401');
  assert.match(lines([null, null, null, 1]).detail, /undefined on most of the domain/, 'one point of four');
  assert.match(lines(grid.map((k) => (k < 100 || k > 300 ? k : null))).detail, /undefined on most of the domain/, 'two short runs with a hole in the middle');
});
