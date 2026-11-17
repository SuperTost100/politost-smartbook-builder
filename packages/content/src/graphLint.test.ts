import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphLintCheck, lintGraph, lintKey } from './graphLint.ts';
import { sampleFunctionGraph, sampleGraph } from './verify.ts';

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
  assert.deepEqual(codes(sampled([{ expr: 'x/x', label: 'Valore in x = 1' }, { expr: 'x^2', label: 'f(x) = x²' }], { x: [0, 2] })), ['point-as-curve']);
  assert.deepEqual(codes(sampled([{ expr: '1.77', label: 'Corpo A' }, { expr: '2.5', label: 'Corpo B' }])), ['all-constant']);
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

test('label formulas keep their parentheses, a parenthesised aside with "=" is read on its own, and a value at one point is no claim', () => {
  assert.deepEqual(codes(sampled([{ expr: '2*(x+1)', label: 'y = 2(x+1)' }])), []);
  assert.deepEqual(codes(sampled([{ expr: 'cos(x)', label: 'y = sin(x)' }])), ['label-mismatch'], 'a function call in a label is a claim');
  assert.deepEqual(codes(sampled([{ expr: '50*x', label: 'F = 50·x (N)' }], { y: [-100, 100] })), [], 'a unit in parentheses after the formula');
  assert.deepEqual(codes(sampled([{ expr: '2*x', label: 'Retta (y = 2x)' }])), [], 'an aside holding the formula');
  assert.deepEqual(codes(sampled([{ expr: '3*x', label: 'Retta (y = 2x)' }])), ['label-mismatch']);
  assert.deepEqual(codes(sampled([{ expr: '3*exp(x-1)', label: 'y′ = y; y(1) = 3' }], { y: [0, 10] })), [], 'an initial condition');
  assert.deepEqual(codes(sampled([{ expr: '5*x', label: 'fᵧ(2,x) = 5' }])), ['label-mismatch'], 'a partial derivative stated constant but drawn as 5x');
});

test('a trace without x starts at its x0, as Plotly draws it', () => {
  const trace = (name: string, x0?: number) => ({ type: 'scatter', mode: 'lines', name, y: [10, 11, 12], ...(x0 === undefined ? {} : { x0 }) });
  assert.deepEqual(codes(raw([trace('y = x', 10)], { xaxis: { title: 'x' }, yaxis: { title: 'y', range: [0, 20] } })), []);
  assert.deepEqual(codes(raw([trace('y = x')], { xaxis: { title: 'x' }, yaxis: { title: 'y', range: [0, 20] } })), ['label-mismatch']);
  assert.deepEqual(codes(raw([trace('a', 0), trace('b', 5)])), [], 'the same y at other x is not a duplicate');
});

test('a steep continuous curve the builder sampled is not a joined jump; the same data from an author is', () => {
  const steep = sampled([{ expr: 'atan(20000*(x-1.0025))', label: 'gradino ripido' }], { x: [0, 2], y: [-2, 2] });
  assert.deepEqual(codes(steep), ['joined-jump'], 'from the data alone it looks like a jump');
  assert.equal(graphLintCheck(steep, [], { sampled: true }).ok, true);
  assert.equal(graphLintCheck(steep).ok, false);
});

const severities = (p: Record<string, unknown>) => lintGraph(p).map((f) => `${f.severity} ${f.code}`).sort();
const raw2 = (data: object[], xTitle = 'x', yTitle = 'y') => raw(data, { xaxis: { title: xTitle }, yaxis: { title: yTitle } });

test('shapes, placeholders and a "logarithmic" title are warnings: correct graphs trip them, and they never fail the check alone', () => {
  // An isochore on a P-T plane is a line through the origin, not a vertical line.
  const isochore = sampled([{ expr: '0.0410*x', label: 'Isocora (V = 2 L): P = 0.0410·T' }], { x: [0, 600], y: [0, 30], xLabel: 'Temperatura T (K)', yLabel: 'Pressione P (atm)' });
  assert.deepEqual(severities(isochore), ['warn needs-parametric']);
  assert.equal(graphLintCheck(isochore).ok, true);
  // The length of a circle against its radius is a function, whatever the word "Circonferenza" says.
  const length = sampled([{ expr: '2*pi*x', label: 'Circonferenza: C = 2π·r' }], { x: [0, 5], y: [0, 35], xLabel: 'Raggio r (m)', yLabel: 'Lunghezza C (m)' });
  assert.deepEqual(severities(length), ['warn needs-parametric']);
  assert.equal(graphLintCheck(length).ok, true);
  const halfCircle = sampled([{ expr: 'sqrt(1 - x^2)', label: 'Circonferenza r = 1' }], { x: [-1, 1], y: [-1.5, 1.5] });
  assert.deepEqual(severities(halfCircle), ['warn needs-parametric'], 'a closed curve drawn as y = f(x) is still named');
  const arrhenius = sampled([{ expr: '20 - 6000*x', label: 'ln k = 20 − 6000·x' }], { x: [0.002, 0.004], y: [-10, 5], xLabel: '1/T (1/K)', yLabel: 'Logaritmo naturale della costante, ln k' });
  assert.deepEqual(severities(arrhenius), ['warn axis-scale']);
  assert.equal(graphLintCheck(arrhenius).ok, true);
  assert.deepEqual(severities(sampled([{ expr: 'x', label: 'f(x) = x' }], { yLabel: 'Pressione (scala logaritmica)' })), ['warn axis-scale'], 'a linear axis titled logarithmic is still named');
  const trig = sampled([{ expr: 'sin(x)', label: 'Seno' }, { expr: 'cos(x)', label: 'Coseno' }], { x: [-6.3, 6.3], y: [-1.5, 1.5] });
  assert.deepEqual(severities(trig), ['warn placeholder']);
  assert.equal(graphLintCheck(trig).ok, true);
  assert.deepEqual(severities(sampled([{ expr: 'x', label: 'Alcani' }, { expr: 'x^2', label: 'Alcheni' }, { expr: 'sin(x)', label: 'Alchini' }])), ['warn placeholder']);
  // The principled rules still block.
  assert.equal(graphLintCheck(sampled([{ expr: 'x', label: 'Charles' }, { expr: 'x', label: 'Gay-Lussac' }], { x: [0, 4] })).ok, false);
});

test('a bare "log" in a label may be decimal; "ln" is natural', () => {
  const ph = (expr: string, label: string) => sampled([{ expr, label }], { x: [0.001, 1], y: [0, 7], xLabel: 'Concentrazione c (mol/L)', yLabel: 'pH' });
  assert.deepEqual(codes(ph('-log10(x)', 'pH = −log(c)')), []);
  assert.deepEqual(codes(ph('-log(x)', 'pH = −log(c)')), [], 'the natural reading fits too');
  assert.deepEqual(codes(ph('-2*log10(x)', 'pH = −log(c)')), ['label-mismatch'], 'neither reading fits');
  assert.deepEqual(codes(ph('-log10(x)', 'pH = −ln(c)')), ['label-mismatch'], 'ln is only natural');
});

test('a circle claim needs the centre the label states', () => {
  const circle = (xt: string, yt: string, label: string) => sampleGraph({ id: 'c', title: 'c', xLabel: 'x', yLabel: 'y', xDomain: [-3, 4], yDomain: [-3, 4], traces: [{ kind: 'parametric', label, xt, yt, tRange: [0, 6.2832] }] }).payload as unknown as Record<string, unknown>;
  assert.deepEqual(codes(circle('1+2*cos(t)', '1+2*sin(t)', 'Circonferenza r = 2, centro (1, 1)')), []);
  assert.deepEqual(codes(circle('2*cos(t)', '2*sin(t)', 'Circonferenza r = 2, centro (1, 1)')), ['label-mismatch'], 'drawn around the origin');
  assert.deepEqual(codes(circle('1+3*cos(t)', '1+3*sin(t)', 'Circonferenza r = 2, centro (1, 1)')), ['label-mismatch'], 'the wrong radius');
  assert.deepEqual(codes(circle('1+2*cos(t)', '1+2*sin(t)', 'Circonferenza r = 2')), [], 'no centre stated: nothing to check');
});

test('a parenthesised list of parameters is not a claim about the curve; a single aside still is', () => {
  // legge-di-fourier: the power against ΔT, with the other parameters listed in the label.
  const xs = Array.from({ length: 401 }, (_, k) => 0.01 + (k * (20 - 0.01)) / 400);
  const fourier = raw2([{ type: 'scatter', mode: 'lines', name: 'ΔT variabile (k = 0,80; A = 2,0; d = 0,10)', x: xs, y: xs.map((x) => 16 * x) }], 'ΔT (K), k (W/(m·K)), A (m²) oppure d (m)', 'Potenza termica (W)');
  assert.deepEqual(lintGraph(fourier).filter((f) => f.code === 'label-mismatch'), []);
  assert.deepEqual(codes(sampled([{ expr: '3*x', label: 'Retta (y = 2x)' }])), ['label-mismatch']);
});

test('a joined jump is a narrow step: a wide segment drawn by hand is not one', () => {
  const line = (name: string, x: number[], y: number[]) => raw([{ type: 'scatter', mode: 'lines', name, x, y }]);
  assert.deepEqual(codes(line('Segmento AB', [0, 4], [1, 3])), []);
  assert.deepEqual(codes(line('Curva di riscaldamento', [0, 2, 10, 14, 40, 42], [-20, 0, 0, 100, 100, 120])), []);
  assert.deepEqual(codes(line('Rampa e plateau', [0, 1, 3], [0, 5, 5])), []);
  // The same climb over a step of 0.5% of the x extent is a vertical segment.
  const xs = Array.from({ length: 201 }, (_, k) => k / 5);
  assert.deepEqual(codes(line('Curva di riscaldamento', xs, xs.map((x) => (x < 20 ? 0 : 100)))), ['joined-jump']);
});
