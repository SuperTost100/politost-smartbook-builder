import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCaption } from './materialize.ts';

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
