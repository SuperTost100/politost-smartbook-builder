import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCaption, figureSchemaFor } from './materialize.ts';
import { renderPlotSvg, validatePlotSpec } from '@smartbuilder/content';
import { rasterizeDrawing } from './drawing/index.ts';

test('captions lose a leading figure number', () => {
  assert.equal(cleanCaption('Fig. 3: Andamento della funzione'), 'Andamento della funzione');
  assert.equal(cleanCaption('Figura 2.1 - Una parabola'), 'Una parabola');
  assert.equal(cleanCaption('Figure 4. A parabola'), 'A parabola');
});

test('captions keep ordinary text, a figure word that is not a number, and formulas for the compiler to convert', () => {
  assert.equal(cleanCaption('La figura mostra una parabola'), 'La figura mostra una parabola');
  assert.equal(cleanCaption('Figure geometriche piane'), 'Figure geometriche piane');
  assert.equal(cleanCaption('Grafico di $\\frac{1}{x}$ per $x \\to 0$'), 'Grafico di $\\frac{1}{x}$ per $x \\to 0$');
  assert.equal(cleanCaption('Andamento di x_2 e x^2'), 'Andamento di x_2 e x^2');
});

const lowPass = { xScale: 'log', xRange: [10, 100000], yRange: [-40, 5], xLabel: 'f (Hz)', yLabel: 'dB', functions: [{ expr: '-10*log10(1+(x/1000)^2)', label: null, domain: null, style: null }], points: null, asymptotes: null };
const request = (plot: unknown) => ({ key: 'bode', kind: 'plot', caption: 'c', alt: 'a', plot });

test('a plot spec takes xScale and yScale as "linear" or "log" and leaves them out when unset', () => {
  const schema = figureSchemaFor(['plot']);
  assert.equal(schema.safeParse(request(lowPass)).success, true);
  assert.equal(schema.safeParse(request({ ...lowPass, xScale: undefined })).success, true);
  assert.equal(schema.safeParse(request({ ...lowPass, xScale: 'ln' })).success, false);
});

test('a low-pass plot on a log axis renders to a PNG, and a zero in the log range is refused', () => {
  const v = validatePlotSpec({ xScale: 'log', xRange: [10, 100000], yRange: [-40, 5], xLabel: 'f (Hz)', functions: [{ expr: lowPass.functions[0].expr }] });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  const png = rasterizeDrawing(renderPlotSvg(v.spec), 800);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const bad = validatePlotSpec({ ...v.spec, xRange: [0, 1000] });
  assert.ok(!bad.ok && /xRange: must be positive on a log axis/.test(bad.errors[0]));
});
