import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCaption } from './materialize.ts';

test('captions lose $, simple LaTeX commands and a leading figure number', () => {
  assert.equal(cleanCaption('Grafico di $\\sin(x)/x$ per $x \\to 0$'), 'Grafico di sin(x)/x per x → 0');
  assert.equal(cleanCaption('Energia $\\Delta E$ in \\text{kJ}'), 'Energia Δ E in kJ');
  assert.equal(cleanCaption('Fig. 3: Andamento della funzione'), 'Andamento della funzione');
  assert.equal(cleanCaption('Figura 2.1 - Una parabola'), 'Una parabola');
  assert.equal(cleanCaption('Figure 4. A parabola'), 'A parabola');
});

test('captions keep ordinary text, a figure word that is not a number, and underscores and carets', () => {
  assert.equal(cleanCaption('La figura mostra una parabola'), 'La figura mostra una parabola');
  assert.equal(cleanCaption('Figure geometriche piane'), 'Figure geometriche piane');
  assert.equal(cleanCaption('Andamento di x_2 e x^2'), 'Andamento di x_2 e x^2');
});
