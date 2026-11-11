import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInkDrawing } from './ink.ts';
import { axisSamples, logTicks, renderPlotSvg, validatePlotSpec, type PlotSpec } from './plot.ts';

/** Minimal well-formedness check: balanced tags, no stray "<" or "&" in text or attributes. */
function assertWellFormed(svg: string): void {
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg)) !== null) {
    const between = svg.slice(last, m.index);
    assert.ok(!/[<>]/.test(between), `stray angle bracket: ${between.slice(0, 40)}`);
    assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(between + m[3]), `unescaped ampersand near ${m[2]}`);
    if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]);
    last = tagRe.lastIndex;
  }
  assert.deepEqual(stack, []);
  assert.ok(!/[<>]/.test(svg.slice(last).trim()));
}

const BASIC: PlotSpec = {
  title: 'Parabola',
  xRange: [-3, 3],
  yRange: [-1, 9],
  xLabel: 'x',
  yLabel: 'y',
  functions: [{ expr: 'x^2', label: 'x^2' }, { expr: '2*x + 1', style: 'dashed' }, { expr: 'sin(x)', domain: [-2, 2] }, { expr: 'cos(x)' }],
  points: [{ x: 0, y: 0, label: 'O' }, { x: 1, y: 1, open: true }],
  asymptotes: [{ kind: 'horizontal', value: 0, label: 'y=0' }, { kind: 'vertical', value: 2 }],
  annotations: [{ x: -2, y: 7, text: 'ramo sinistro' }],
};

test('validatePlotSpec accepts a good spec', () => {
  const r = validatePlotSpec(BASIC);
  assert.equal(r.ok, true);
});

test('validatePlotSpec rejects bad shapes and unsafe expressions', () => {
  const bad = (spec: unknown) => {
    const r = validatePlotSpec(spec);
    assert.equal(r.ok, false);
    return r.ok ? [] : r.errors;
  };
  assert.ok(bad(null).length);
  assert.ok(bad({ ...BASIC, xRange: [3, -3] }).some((e) => /xRange/.test(e)));
  assert.ok(bad({ ...BASIC, yRange: [0] }).length);
  assert.ok(bad({ ...BASIC, functions: [], points: [] }).some((e) => /at least one/.test(e)));
  assert.ok(bad({ ...BASIC, points: [{ x: 'a', y: 1 }] }).length);
  assert.ok(bad({ ...BASIC, asymptotes: [{ kind: 'diagonal', value: 1 }] }).length);
  for (const expr of ['y + 1', 'process.exit()', 'a = 3', 'f(x) = x', 'import("fs")', 'x; 2', 'sin', '[1,2,3]', '"abc"', 'evaluate("1")', 'sin(x, 2)', 'x.y', 'x!', 'x % 2', 'abs(x) > 2', '1:3', 'x'.repeat(500)]) {
    const errors = bad({ ...BASIC, functions: [{ expr }] });
    assert.ok(errors.some((e) => /functions\.0\.expr/.test(e)), `should reject ${expr}`);
  }
  for (const expr of ['x^2', '-x', '2x', 'e^x', 'pi*x', 'sqrt(abs(x))', 'log(x, 10)', 'sin(x)/x', 'cbrt(x) + floor(x) - ceil(x) + sign(x)', '(x+1)*(x-1)', 'atan(x) + sinh(x) + tanh(x)']) {
    assert.equal(validatePlotSpec({ ...BASIC, functions: [{ expr }] }).ok, true, `should accept ${expr}`);
  }
});

test('renderPlotSvg: sane, safe, deterministic SVG', () => {
  const svg = renderPlotSvg(BASIC);
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.match(svg, /viewBox="0 0 640 400"/);
  assert.match(svg, /width="640" height="400"/);
  // Transparent with the dark-ink marker, so a reader can show it on a dark page.
  assert.ok(!svg.includes('<rect width="640" height="400"'), 'no background rectangle');
  assert.ok(isInkDrawing(svg));
  assert.ok(svg.includes('<path '));
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/(href|src)=/i.test(svg) && !/https?:/.test(svg.replace('http://www.w3.org/2000/svg', '')));
  assert.ok(!/\son\w+=/i.test(svg), 'no event handlers');
  assert.ok(!/<foreignObject|<image|<use/i.test(svg));
  assert.ok(svg.includes('#C2410C') && svg.includes('#1D4ED8') && svg.includes('#15803D'));
  assert.ok(svg.includes('stroke-dasharray'));
  assert.ok(svg.includes('clip-path="url(#plot-area)"'));
  assert.equal(renderPlotSvg(BASIC), svg, 'deterministic');
  assertWellFormed(svg);
});

test('renderPlotSvg: tick labels, axis labels, title and legend', () => {
  const svg = renderPlotSvg(BASIC);
  for (const label of ['>-2<', '>0<', '>2<', '>Parabola<', '>ramo sinistro<', '>y=0<', '>O<']) assert.ok(svg.includes(label), label);
  assert.ok(svg.includes('rotate(-90)'));
});

test('renderPlotSvg: axes through zero only when visible', () => {
  const withAxes = renderPlotSvg({ xRange: [-1, 1], yRange: [-1, 1], functions: [{ expr: 'x' }] });
  assert.match(withAxes, /stroke="#374151"/);
  assert.equal((withAxes.match(/<g stroke="#374151"[^>]*>\n(<line[^\n]*\n){2}<\/g>/g) ?? []).length, 1);
  const without = renderPlotSvg({ xRange: [1, 2], yRange: [1, 2], functions: [{ expr: 'x' }] });
  assert.ok(/<g stroke="#374151"[^>]*>\n<\/g>/.test(without), 'no axis lines when 0 is outside the ranges');
});

test('renderPlotSvg: paths break at discontinuities', () => {
  const svg = renderPlotSvg({ xRange: [-6, 6], yRange: [-5, 5], functions: [{ expr: 'tan(x)' }] });
  const d = /<path d="([^"]+)"/.exec(svg)![1];
  const subpaths = d.split('M').filter(Boolean);
  assert.ok(subpaths.length >= 3, `tan(x) should have several branches, got ${subpaths.length}`);
  // 1/x is undefined at 0: the branches never connect across it
  const inv = renderPlotSvg({ xRange: [-2, 2], yRange: [-4, 4], functions: [{ expr: '1/x' }] });
  assert.ok(/<path d="M[^M"]+M/.test(inv));
  // sqrt(x) is NaN for x < 0: a single branch starting at x = 0
  const root = renderPlotSvg({ xRange: [-4, 4], yRange: [-1, 3], functions: [{ expr: 'sqrt(x)' }] });
  assert.equal((/<path d="([^"]+)"/.exec(root)![1].match(/M/g) ?? []).length, 1);
});

test('renderPlotSvg: open and closed point markers', () => {
  const svg = renderPlotSvg({ xRange: [0, 4], yRange: [0, 4], functions: [{ expr: 'x' }], points: [{ x: 1, y: 1 }, { x: 2, y: 2, open: true }, { x: 9, y: 9 }] });
  assert.equal((svg.match(/<circle /g) ?? []).length, 2, 'points outside the range are skipped');
  assert.ok(svg.includes('fill="#111827" stroke="#111827"'));
  assert.ok(svg.includes('fill="#FFFFFF" stroke="#111827"'));
});

test('renderPlotSvg: all text is escaped', () => {
  const nasty = `<script>alert(1)</script> & "quote" 'single'`;
  const svg = renderPlotSvg({
    title: nasty, xRange: [0, 1], yRange: [0, 1], xLabel: nasty, yLabel: nasty,
    functions: [{ expr: 'x', label: nasty }], points: [{ x: 0.5, y: 0.5, label: nasty }],
    annotations: [{ x: 0.2, y: 0.2, text: nasty }], asymptotes: [{ kind: 'vertical', value: 0.5, label: nasty }],
  });
  assert.ok(!svg.includes('<script'));
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quote&quot; &#39;single&#39;'));
  assertWellFormed(svg);
});

test('renderPlotSvg: huge values are clipped, not drawn out of the area', () => {
  const svg = renderPlotSvg({ xRange: [-1, 1], yRange: [-1, 1], functions: [{ expr: 'exp(x*100)' }] });
  assertWellFormed(svg);
  assert.ok(!/[0-9]{7,}/.test(/<path d="([^"]+)"/.exec(svg)?.[1] ?? ''));
});

test('renderPlotSvg refuses invalid specs', () => {
  assert.throws(() => renderPlotSvg({ ...BASIC, functions: [{ expr: 'process.exit()' }] }), /Invalid plot spec/);
});

/** x, y and estimated width of each text element carrying one of the given labels. */
function labelBoxes(svg: string, labels: string[]) {
  return labels.map((label) => {
    const m = new RegExp(`<text x="([\\d.-]+)" y="([\\d.-]+)"[^>]*>${label}</text>`).exec(svg);
    assert.ok(m, `label ${label} drawn`);
    const x = Number(m[1]);
    const y = Number(m[2]);
    return { x0: x, x1: x + label.length * 12 * 0.56, y0: y - 11, y1: y + 3 };
  });
}

test('renderPlotSvg: point labels stay inside the plot and apart from each other', () => {
  // A heating curve: two close points at the melting plateau, one at the right edge.
  const svg = renderPlotSvg({
    xRange: [0, 60], yRange: [-30, 130],
    functions: [{ expr: '100', domain: [14, 55] }],
    points: [{ x: 0.75, y: 0, label: 'inizio fusione' }, { x: 6.76, y: 0, label: 'fine fusione' }, { x: 55, y: 100, label: 'fine ebollizione' }],
  });
  const [a, b, c] = labelBoxes(svg, ['inizio fusione', 'fine fusione', 'fine ebollizione']);
  const apart = (p: typeof a, q: typeof a) => p.x1 <= q.x0 || q.x1 <= p.x0 || p.y1 <= q.y0 || q.y1 <= p.y0;
  assert.ok(apart(a, b), 'the two melting labels do not overlap');
  for (const box of [a, b, c]) assert.ok(box.x0 >= 58 && box.x1 <= 616, `label inside the plot: ${JSON.stringify(box)}`);
});

test('renderPlotSvg: the legend is as wide as its longest label and avoids the curves', () => {
  const long = 'evaporazione (sosta termica)';
  const svg = renderPlotSvg({
    xRange: [0, 10], yRange: [0, 10],
    // The line runs through the top-right corner, so the legend should go elsewhere.
    functions: [{ expr: 'x', label: 'y = x' }, { expr: '9.5', domain: [6, 10], label: long }],
  });
  const rect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#FFFFFF" fill-opacity/.exec(svg);
  assert.ok(rect, 'legend has a background');
  const [x, , w] = rect.slice(1).map(Number);
  assert.ok(w >= long.length * 12 * 0.56 + 36, 'wide enough for the longest label');
  assert.ok(x < 300, 'placed away from the top-right corner the curves cross');
});

// ---------------------------------------------------------------------------------------------
// Logarithmic axes
// ---------------------------------------------------------------------------------------------

/** A first-order low-pass magnitude in dB against frequency: the plot of the writer's rule block. */
const BODE: PlotSpec = {
  title: 'Low-pass magnitude',
  xScale: 'log',
  xRange: [10, 100000],
  yRange: [-40, 5],
  xLabel: 'f (Hz)',
  yLabel: '|H| (dB)',
  functions: [{ expr: '-10*log10(1+(x/1000)^2)', label: '|H(f)|' }],
  points: [{ x: 1000, y: -3.01, label: 'fc = 1 kHz' }],
  asymptotes: [{ kind: 'vertical', value: 1000 }],
};

test('axisSamples: linear is even in x, log is even in the exponent and keeps the ends', () => {
  assert.deepEqual(axisSamples(0, 10, 5, 'linear'), [0, 2, 4, 6, 8, 10]);
  const xs = axisSamples(10, 100000, 4, 'log');
  assert.equal(xs.length, 5);
  assert.equal(xs[0], 10);
  assert.equal(xs[4], 100000);
  for (const [i, want] of [100, 1000, 10000].entries()) assert.ok(Math.abs(Math.log10(xs[i + 1]) - Math.log10(want)) < 1e-12, `sample ${i + 1}`);
  const gaps = xs.slice(1).map((x, i) => Math.log10(x) - Math.log10(xs[i]));
  assert.ok(gaps.every((g) => Math.abs(g - 1) < 1e-12), 'equal gaps in the exponent');
});

test('logTicks: powers of ten are labelled, 2 to 9 are minor ticks when a decade is wide', () => {
  const t = logTicks(1, 1000, 8, 150);
  assert.deepEqual(t.filter((x) => x.labelled).map((x) => x.value), [1, 10, 100, 1000]);
  assert.deepEqual(t.filter((x) => !x.labelled).map((x) => x.value), [2, 3, 4, 5, 6, 7, 8, 9, 20, 30, 40, 50, 60, 70, 80, 90, 200, 300, 400, 500, 600, 700, 800, 900]);
});

test('logTicks: no minor ticks when a decade is narrow, and labels thin out over many decades', () => {
  assert.ok(logTicks(1, 1e6, 8, 40).every((x) => x.labelled), 'a narrow decade has no minor ticks');
  const wide = logTicks(1e-12, 1e12, 8, 20);
  assert.deepEqual(wide.filter((x) => x.labelled).map((x) => x.exp), [-12, -8, -4, 0, 4, 8, 12], '25 powers, one label in 4');
});

test('logTicks: a range inside one decade still gets labels', () => {
  const t = logTicks(20, 800, 8, 200);
  assert.deepEqual(t.filter((x) => x.labelled).map((x) => x.value), [20, 50, 100, 200, 500]);
  assert.equal(logTicks(1.5, 1.8, 8, 200).filter((x) => x.labelled).length, 0, 'nothing to label between 1.5 and 1.8 is allowed, the grid is empty');
});

test('validatePlotSpec: a log axis needs a positive range, and the error names the axis', () => {
  const x = validatePlotSpec({ ...BODE, xRange: [0, 1000] });
  assert.equal(x.ok, false);
  assert.ok(!x.ok && x.errors.some((e) => /^xRange: must be positive on a log axis/.test(e)), JSON.stringify(x));
  const y = validatePlotSpec({ ...BODE, yScale: 'log', yRange: [-1, 10] });
  assert.ok(!y.ok && y.errors.some((e) => /^yRange: must be positive on a log axis/.test(e)));
  assert.equal(validatePlotSpec({ ...BODE, xRange: [0, 1000], xScale: 'linear' }).ok, true);
  assert.equal(validatePlotSpec({ ...BODE, xScale: 'ln' }).ok, false);
  assert.throws(() => renderPlotSvg({ ...BODE, xRange: [-1, 100] }), /xRange: must be positive on a log axis/);
});

test('renderPlotSvg: a log x axis puts powers of ten on the grid with a raised exponent', () => {
  const svg = renderPlotSvg(BODE);
  assertWellFormed(svg);
  for (const e of [1, 2, 3, 4, 5]) assert.ok(svg.includes(`>10<tspan dy="-4" font-size="8.5">${e}</tspan><`), `10^${e}`);
  assert.ok(!svg.includes('>10<tspan dy="-4" font-size="8.5">6</tspan>'), 'only powers inside the range');
  // The plot area is x 58..616 (558 wide): 4 decades, so each power of ten is 139.5 further right than the last.
  const at = (e: number) => Number(new RegExp(`<text x="([0-9.]+)" y="[0-9.]+" text-anchor="middle">10<tspan dy="-4" font-size="8.5">${e}</tspan>`).exec(svg)![1]);
  for (const e of [1, 2, 3, 4, 5]) assert.ok(Math.abs(at(e) - (58 + (e - 1) * 139.5)) < 0.02, `10^${e} at ${at(e)}`);
  // Minor ticks at 2 to 9 are lighter grid lines: 4 decades of 8, the 4 below 10^5 and none above it.
  const minor = /<g stroke="#E5E7EB"[^>]*>\n((?:<line[^\n]*\n)*)<\/g>/.exec(svg)![1];
  assert.equal((minor.match(/<line /g) ?? []).length, 4 * 8 + 0);
  assert.ok(svg.includes('<path '), 'the curve is drawn');
});

test('renderPlotSvg: points and asymptotes follow the same transform as the axis', () => {
  const svg = renderPlotSvg(BODE);
  const cx = Number(/<circle cx="([0-9.]+)"/.exec(svg)![1]);
  const vline = Number(/<g clip-path="url\(#plot-area\)" stroke="#6B7280"[^>]*>\n<line x1="([0-9.]+)"/.exec(svg)![1]);
  const expected = 58 + (2 / 4) * (616 - 58); // 1000 is the 3rd power: 2 decades up from 10 of 4 in all
  assert.ok(Math.abs(cx - expected) < 0.02, `point at ${cx}, expected ${expected}`);
  assert.ok(Math.abs(vline - expected) < 0.02, `asymptote at ${vline}, expected ${expected}`);
  assert.ok(svg.includes('>fc = 1 kHz<'));
});

test('renderPlotSvg: a log curve is sampled in the exponent, so every decade gets the same number of points', () => {
  const svg = renderPlotSvg({ xScale: 'log', xRange: [1, 10000], yRange: [0, 5], functions: [{ expr: 'log10(x)' }] });
  const d = /<path d="([^"]+)"/.exec(svg)![1];
  const xs = d.replace(/^M/, '').split('L').map((p) => Number(p.split(' ')[0]));
  assert.equal(xs.length, 801);
  const inFirstDecade = xs.filter((x) => x <= 58 + (558 / 4) + 0.01).length;
  assert.ok(Math.abs(inFirstDecade - 201) <= 1, `first decade holds ${inFirstDecade} of 801 points`);
});

test('renderPlotSvg: a log y axis breaks the curve where y is not positive', () => {
  const svg = renderPlotSvg({ yScale: 'log', xRange: [-2, 2], yRange: [0.01, 100], functions: [{ expr: 'x' }, { expr: '10^x' }] });
  assertWellFormed(svg);
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 2);
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.ok(paths[0].split('L').length <= 400, 'x is drawn only where it is positive (the right half of the samples)');
  assert.ok(svg.includes('>10<tspan dy="-4" font-size="8.5">−2</tspan>'), 'a negative exponent uses a real minus sign');
});

test('renderPlotSvg: a linear plot is unchanged by the scale options', () => {
  assert.equal(renderPlotSvg({ ...BASIC, xScale: 'linear', yScale: 'linear' }), renderPlotSvg(BASIC));
});
