import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlotSvg, validatePlotSpec, type PlotSpec } from './plot.ts';

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
  assert.match(svg, /<rect width="640" height="400" fill="#FFFFFF"\/>/);
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
