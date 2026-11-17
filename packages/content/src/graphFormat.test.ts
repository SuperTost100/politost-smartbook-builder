import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGraphPayload, formatGraphText, formatLintKeys, graphPayloadDiff, GRAPH_PALETTE } from './graphFormat.ts';
import { lintGraph } from './graphLint.ts';
import { sampleGraph } from './verify.ts';

const it = (s: string) => formatGraphText(s, { language: 'it' });
const en = (s: string) => formatGraphText(s, { language: 'en' });
/** The reader's stripHtml (politost-smartbook src/lib/plotlySanitize.ts), which runs on every string of a payload. */
const readerStrip = (s: string) => s.replace(/<[^>]*>/g, '');

// Labels of the four books (GRAPH-LOOK.md, 2026-11-17) and what the reader should show.
const CONVERTED: [string, string][] = [
  ['f(x) = |x| = sqrt(x^2)', 'f(x) = |x| = √(x²)'],
  ['y = e^x  (crescita esponenziale)', 'y = eˣ  (crescita esponenziale)'],
  ['y = x^x  (crescita sovra-esponenziale)', 'y = xˣ  (crescita sovra-esponenziale)'],
  ['y(0) = 1: y = 2e^(2t) − e^t (esempio svolto)', 'y(0) = 1: y = 2e²ᵗ − eᵗ (esempio svolto)'],
  ['g(x) = floor(x) - 0.5 (discontinua: salta l\'asse x senza annullarsi)', 'g(x) = ⌊x⌋ − 0,5 (discontinua: salta l\'asse x senza annullarsi)'],
  ['f(y)=y*(y-1), g(t)=1, y(0)=1/2', 'f(y)=y·(y−1), g(t)=1, y(0)=1/2'],
  ['Componente x: a_x = 5 cos(θ)', 'Componente x: aₓ = 5 cos(θ)'],
  ['Attrito statico: f = −F, equilibra la forza applicata fino a F_s,MAX = μ_s N', 'Attrito statico: f = −F, equilibra la forza applicata fino a Fₛ,MAX = μₛ N'],
  ['T1(x) = x (retta tangente)', 'T₁(x) = x (retta tangente)'],
  ['T3(x) = x - x^3/6', 'T₃(x) = x − x³/6'],
  ['s_n = 2 − 1/2^n', 'sₙ = 2 − 1/2ⁿ'],
  ['1/(x^α*(1+x))', '1/(xᵅ·(1+x))'],
  ['h(x) = (x-0.5)^3 + 0.5: traslazione di g(x) = x^3, resta invertibile', 'h(x) = (x−0,5)³ + 0,5: traslazione di g(x) = x³, resta invertibile'],
  ['Secante per x̄ = 1.5 (pendenza 2.5)', 'Secante per x̄ = 1,5 (pendenza 2,5)'],
  ['Semiretta θ = arctan(0.5)', 'Semiretta θ = arctan(0,5)'],
  ['h(x) = -x^4 (massimo relativo in x=0, n=4 pari)', 'h(x) = −x⁴ (massimo relativo in x=0, n=4 pari)'],
  ['M(x) = x - [x] (funzione periodica, mantissa)', 'M(x) = x − [x] (funzione periodica, mantissa)'],
  ['Adiabatica reversibile per A (γ = 5/3): pV^γ costante', 'Adiabatica reversibile per A (γ = 5/3): pVᵞ costante'],
  ['Primo ordine ([A]₀ = 1, k = 1): [A]ₜ = [A]₀e^(−kt)', 'Primo ordine ([A]₀ = 1, k = 1): [A]ₜ = [A]₀e⁻ᵏᵗ'],
  // e^(…) with no superscript form is written exp(…).
  ['I% = (1 − e^(−0,25·Δχ²)) · 100', 'I% = (1 − exp(−0,25·Δχ²)) · 100'],
  ['Emissioni di CO_2 e H2O', 'Emissioni di CO₂ e H₂O'],
  ['Titolazione di CH3COOH con NaOH, poi O2', 'Titolazione di CH₃COOH con NaOH, poi O₂'],
  ['Centro (1.77, 0.31) m', 'Centro (1,77; 0,31) m'],
  ['F = 2*x', 'F = 2x'],
  ['x<sup>2</sup> e y<sub>0</sub><br>fine', 'x² e y₀ fine'],
];

const KEPT = [
  'f(x) = |x|',
  'Differenza di elettronegatività, Δχ',
  'Fattore di comprimibilità del CO₂ secondo van der Waals',
  'λ = 2,4·10⁻⁵ K⁻¹ e 10⁻⁶',
  'Frazione molare del soluto, x_soluto',
  'T_soglia ≈ 1 056 K',
  'μ_d/μₛ',
  'Gerarchia sovra-esponenziale di Gay-Lussac',
  'Quantità di moto ed energia cinetica in un urto (esempio 7.2)',
  'Ellissoide d’inerzia dell’esercizio E8.11',
  'Costanti C1 e C2, polinomio T1 e foglio A4',
  'file_name.txt su https://example.org/a_b^2*c-1.5',
  'Q_c = 123,3 M⁻¹ < K_c',
  'limite puntuale per 0 ≤ x < 1',
  'Retta y = x (ramo destro, x ≥ 0)',
  'Fase 1 - riscaldamento',
];

test('maths notation becomes Unicode, decimals take the book\'s comma, and text that is not maths stays', () => {
  for (const [from, to] of CONVERTED) assert.equal(it(from), to, from);
  for (const s of KEPT) assert.equal(it(s), s, s);
});

test('an English book keeps its decimal point and gets the same Unicode', () => {
  assert.equal(en('g(x) = floor(x) - 0.5'), 'g(x) = ⌊x⌋ − 0.5');
  assert.equal(en('Centro (1.77, 0.31) m'), 'Centro (1.77, 0.31) m');
});

test('a < followed by a > becomes words, because the reader strips the span between them; a lone sign stays', () => {
  const label = 'ΔHᵣ° < 0, ΔSᵣ° > 0: valori illustrativi (ΔHᵣ° = −100 kJ/mol; ΔSᵣ° = +100 J/(mol·K))';
  assert.notEqual(readerStrip(label), label, 'the reader would lose "< 0, ΔSᵣ° >"');
  const out = it(label);
  assert.equal(out, 'ΔHᵣ° minore di 0, ΔSᵣ° maggiore di 0: valori illustrativi (ΔHᵣ° = −100 kJ/mol; ΔSᵣ° = +100 J/(mol·K))');
  assert.equal(readerStrip(out), out);
  assert.equal(en('a < b and c > d'), 'a less than b and c greater than d');
  assert.equal(it('ΔHᵣ° > 0, ΔSᵣ° < 0: valori'), 'ΔHᵣ° > 0, ΔSᵣ° < 0: valori', 'a > before a < is not stripped');
  assert.equal(it('x -> 0 e x >= 1'), 'x → 0 e x ≥ 1');
});

test('formatting twice changes nothing', () => {
  for (const s of [...CONVERTED.map(([from]) => from), ...KEPT, 'e^(2*t) e 2*x^2 - 1.5', 'x^(1/2) e e^(-0.25*x)']) {
    assert.equal(it(it(s)), it(s), s);
  }
  const payload = gibbs();
  const once = formatGraphPayload(payload, { language: 'it' });
  assert.deepEqual(formatGraphPayload(once, { language: 'it' }), once);
});

// ---------- colours ----------

const line = (name: string, color: string, x: number[], y: number[], extra: object = {}) => ({ type: 'scatter', mode: 'lines', name, x, y, line: { color, width: 2.5 }, ...extra });
const xs = [-1, -0.5, 0, 0.5, 1];
const plot = (data: object[], layout: object = { xaxis: { title: 'x' }, yaxis: { title: 'y' } }) => ({ id: 'g', title: 'G', type: 'plotly', config: { data, layout } });
const colors = (p: { config: { data: unknown[] } }) => p.config.data.map((t) => (t as { line?: { color?: string }; marker?: { color?: string } }).line?.color ?? (t as { marker?: { color?: string } }).marker?.color);

/** Analisi 2, gibbs-onde-quadra: the sampler's four colours repeat on traces 5 and 6. */
function gibbs() {
  return plot([
    line('S₃', '#C2410C', xs, [-1, -0.9, 0, 0.9, 1]),
    line('S₇', '#1D4ED8', xs, [-1, -1, 0, 1, 1]),
    line('S₁₅', '#15803D', xs, [-1, -1.1, 0, 1.1, 1]),
    line('Limite destro', '#7C3AED', [0, 0.5, 1], [1, 1, 1]),
    line('Limite sinistro', '#C2410C', [-1, -0.5, 0], [-1, -1, -1]),
    { type: 'scatter', mode: 'markers', name: 'Valore regolarizzato', x: [0], y: [0], marker: { color: '#1D4ED8', size: 9 } },
  ]);
}

test('a trace that repeats an earlier colour by accident gets the palette colour farthest from the others', () => {
  const out = formatGraphPayload(gibbs());
  const c = colors(out);
  assert.deepEqual(c.slice(0, 4), ['#C2410C', '#1D4ED8', '#15803D', '#7C3AED'], 'the first colours stay');
  assert.ok(GRAPH_PALETTE.includes(c[4] as never) && GRAPH_PALETTE.includes(c[5] as never));
  assert.equal(new Set(c).size, 6, 'every trace has its own colour');
  assert.notEqual(c[4], '#EA580C', 'not the palette orange, a shade of the S₃ it clashed with');
});

test('traces meant as one keep their shared colour', () => {
  const pieces = plot([line('Tampone', '#C2410C', [0, 10, 24.9], [3, 4.7, 7]), line('Eccesso', '#C2410C', [25, 30, 50], [10.5, 12, 12.5])]);
  assert.deepEqual(colors(formatGraphPayload(pieces)), ['#C2410C', '#C2410C'], 'one curve drawn in two pieces');
  const example = plot([
    line('|M| = rF', '#1D4ED8', [0, 1.5], [0, 60]),
    line('|M| = rF cos 30°', '#C2410C', [0, 1.5], [0, 52]),
    { type: 'scatter', mode: 'markers+text', name: 'Esempio svolto', x: [1.2], y: [41.6], marker: { color: '#C2410C' } },
  ]);
  assert.deepEqual(colors(formatGraphPayload(example)), ['#1D4ED8', '#C2410C', '#C2410C'], 'a point marked on its own curve');
  const hidden = plot([line('a', '#C2410C', xs, xs), line('b', '#C2410C', xs, xs.map((x) => -x), { showlegend: false })]);
  assert.deepEqual(colors(formatGraphPayload(hidden)), ['#C2410C', '#C2410C'], 'showlegend false');
  const grouped = plot([line('a', '#C2410C', xs, xs, { legendgroup: 'f' }), line('b', '#C2410C', xs, xs.map((x) => -x), { legendgroup: 'f' })]);
  assert.deepEqual(colors(formatGraphPayload(grouped)), ['#C2410C', '#C2410C'], 'one legend group');
  const apart = plot([line('Ghiaccio', '#C2410C', [0, 1], [-20, 0]), line('Vapore', '#C2410C', [4, 5], [100, 120])]);
  assert.notEqual(colors(formatGraphPayload(apart))[1], '#C2410C', 'two segments far apart are two curves');
});

test('new graphs draw with the palette, so traces 5 to 7 no longer repeat the first colours', () => {
  const g = sampleGraph({
    id: 'g', title: 'T', xDomain: [0, 1], yDomain: [0, 8], xLabel: 'x', yLabel: 'y',
    traces: Array.from({ length: 7 }, (_, k) => ({ kind: 'function' as const, fn: `x + ${k}`, label: `y = x + ${k}` })),
  });
  assert.deepEqual(colors(g.payload as never), [...GRAPH_PALETTE]);
});

// ---------- ticks ----------

const ticks = (layout: object, data: object[] = [line('f', '#C2410C', [0, 1], [0, 1])]) =>
  (formatGraphPayload(plot(data, layout), { language: 'it' }).config.layout as Record<string, { tickvals?: number[]; ticktext?: string[] }>);

test('an axis Plotly would label with SI suffixes, or a log axis, gets ticks in the book\'s number format', () => {
  const pressure = ticks({ xaxis: { title: 'h' }, yaxis: { title: 'p (Pa)', range: [0, 450000] } });
  assert.deepEqual(pressure.yaxis!.ticktext, ['0', '100 000', '200 000', '300 000', '400 000']);
  assert.deepEqual(pressure.yaxis!.tickvals, [0, 100000, 200000, 300000, 400000]);
  assert.equal(pressure.xaxis!.tickvals, undefined, 'an axis from 0 to 1 keeps Plotly\'s ticks');
  const heat = ticks({ yaxis: { title: 'q', range: [0, 16000] } });
  assert.deepEqual(heat.yaxis!.ticktext, ['0', '5 000', '10 000', '15 000'], 'grouped alike on one axis');
  const field = ticks({ yaxis: { title: 'G', range: [-0.0000025, 0] } });
  assert.deepEqual(field.yaxis!.ticktext, ['−2,5·10⁻⁶', '−2·10⁻⁶', '−1,5·10⁻⁶', '−1·10⁻⁶', '−0,5·10⁻⁶', '0']);
  const ph = ticks({ xaxis: { title: '[H₃O⁺]', type: 'log', range: [-15, 1] } });
  assert.deepEqual(ph.xaxis!.ticktext, ['10⁻¹⁴', '10⁻¹²', '10⁻¹⁰', '10⁻⁸', '10⁻⁶', '10⁻⁴', '10⁻²', '1']);
  const n = ticks({ xaxis: { title: 'n', type: 'log', range: [Math.log10(2), Math.log10(20)] } });
  assert.deepEqual(n.xaxis!.tickvals, [2, 5, 10, 20]);
  const small = ticks({ xaxis: { title: 'x', type: 'log', range: [-1, 0] } });
  assert.deepEqual(small.xaxis!.ticktext, ['0,1', '0,2', '0,5', '1']);
  const fromData = ticks({ yaxis: { title: 'p' } }, [line('p', '#C2410C', [0, 1], [0, 70000])]);
  assert.deepEqual(fromData.yaxis!.ticktext, ['0', '20 000', '40 000', '60 000'], 'no range: the data\'s extent');
  const english = formatGraphPayload(plot([line('f', '#C2410C', [0, 1], [0, 1])], { yaxis: { range: [0, 450000] } }), { language: 'en' }).config.layout as Record<string, { ticktext?: string[] }>;
  assert.deepEqual(english.yaxis!.ticktext!.slice(0, 2), ['0', '100,000']);
  const authored = ticks({ yaxis: { title: 'p', range: [0, 450000], tickvals: [0, 450000], ticktext: ['zero', '4.5'] } });
  assert.deepEqual([authored.yaxis!.tickvals, authored.yaxis!.ticktext], [[0, 450000], ['zero', '4,5']], 'an author\'s ticks stay; only their text is formatted');
  const bars = ticks({ yaxis: { title: 'v' } }, [{ type: 'bar', name: 'v', x: ['a', 'b'], y: [1, 2] }]);
  assert.equal(bars.xaxis, undefined);
});

test('data, ranges and tickvals never change, and the diff names each text and style change', () => {
  const before = plot([line('y = x^2', '#C2410C', [0, 0.5, 1.5], [0, 0.25, 2.25])], { xaxis: { title: 'x', range: [0, 1.5] }, yaxis: { title: 'y', range: [0, 2.5] } });
  const after = formatGraphPayload(before, { language: 'it' });
  assert.deepEqual(after.config.data[0], { ...before.config.data[0], name: 'y = x²' });
  assert.deepEqual(after.config.layout, before.config.layout);
  assert.deepEqual(graphPayloadDiff(before, after), ['config.data[0] "y = x^2".name: "y = x^2" → "y = x²"']);
  assert.equal((before.config.data[0] as { name: string }).name, 'y = x^2', 'the input is not changed');
});

test('the graph lint reads the labels the formatter writes as the formulas they are', () => {
  const xs2 = Array.from({ length: 41 }, (_, k) => k / 10);
  const graph = (name: string, f: (x: number) => number) => plot([line(name, '#C2410C', xs2, xs2.map(f))], { xaxis: { title: 'x' }, yaxis: { title: 'y', range: [-1, 30] } });
  const mismatch = (p: object) => lintGraph(formatGraphPayload(p as Record<string, unknown>, { language: 'it' })).filter((f) => f.code === 'label-mismatch').length;
  assert.equal(mismatch(graph('g(x) = floor(x) - 0.5', (x) => Math.floor(x) - 0.5)), 0);
  assert.equal(mismatch(graph('g(x) = floor(x) - 0.5', (x) => x - 0.5)), 1, '⌊x⌋ is read as floor');
  assert.equal(mismatch(graph('y = e^(x/2)', (x) => Math.exp(x / 2))), 0);
  assert.equal(mismatch(graph('y = 2*x^2 - 1.5', (x) => 2 * x * x - 1.5)), 0);
  assert.equal(mismatch(graph('y = 2*x^2 - 1.5', (x) => 2 * x * x)), 1);
});

test('nested notation is formatted in one call, so a second call changes nothing', () => {
  assert.equal(it('y = e^(x^2)'), 'y = exp(x²)');
  assert.equal(it('floor(floor(x)) + abs(abs(x) - 1)'), '⌊⌊x⌋⌋ + ||x| − 1|');
  assert.equal(it(it('y = e^(x^2)')), it('y = e^(x^2)'));
});

test('an accepted lint finding is also accepted under the trace name the formatter writes', () => {
  assert.deepEqual(formatLintKeys(['duplicate:z = 2*t^2', 'mixed-units:'], { language: 'it' }), ['duplicate:z = 2*t^2', 'duplicate:z = 2t²', 'mixed-units:']);
});

test('points marked on a recoloured curve take its new colour', () => {
  const g = plot([
    line('A', '#C2410C', [0, 1], [0, 1]),
    line('B', '#C2410C', [0, 1], [2, 3]),
    { type: 'scatter', mode: 'markers', name: 'Punto di B', x: [0.5], y: [2.5], marker: { color: '#C2410C' } },
  ]);
  const c = colors(formatGraphPayload(g));
  assert.equal(c[0], '#C2410C');
  assert.notEqual(c[1], '#C2410C');
  assert.equal(c[2], c[1]);
});

test('an axis far narrower than its magnitude gets no ticks, and formatting it ends', () => {
  const layout = ticks({ yaxis: { title: 'y', range: [10000000000000000, 10000000000000002] } });
  assert.equal(layout.yaxis!.tickvals, undefined);
});

test('an axis symbol with a subscript still matches the formula of a formatted label', () => {
  const g = plot([line('y = a_x^2', '#C2410C', [0, 1, 2], [0, 1, 2])], { xaxis: { title: 'a_x' }, yaxis: { title: 'y', range: [0, 5] } });
  const mismatch = (p: Record<string, unknown>) => lintGraph(p).filter((f) => f.code === 'label-mismatch').length;
  assert.equal(mismatch(g), 1);
  assert.equal(mismatch(formatGraphPayload(g, { language: 'it' })), 1);
});

test('notation nested deeper than a few levels is still formatted in one call', () => {
  const deep = 'g(x) = floor(floor(floor(floor(floor(floor(x)))))) e e^(e^(x^2))';
  assert.equal(it(deep), 'g(x) = ⌊⌊⌊⌊⌊⌊x⌋⌋⌋⌋⌋⌋ e exp(exp(x²))');
  assert.equal(it(it(deep)), it(deep));
});
