import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statementPreview } from './preview.ts';

test('inline formulas stay as $…$ for the renderer', () => {
  assert.equal(statementPreview('Un condensatore piano ha capacità $C = 2\\,\\mu F$. Calcolare la carica $Q$.'), 'Un condensatore piano ha capacità $C = 2\\,\\mu F$. Calcolare la carica $Q$.');
  assert.equal(statementPreview('Sia \\(f(x) = x^2\\).'), 'Sia $f(x) = x^2$.');
});

test('a one-line display formula becomes inline, a multi-line one ends the preview', () => {
  assert.equal(statementPreview('Calcolare\n$$\n\\int_0^1 x \\, dx\n$$\nper parti.'), 'Calcolare $\\int_0^1 x \\, dx$ per parti.');
  assert.equal(statementPreview('Risolvere il sistema $$\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}$$ con Cramer.'), 'Risolvere il sistema …');
});

test('a formula with a literal dollar sign keeps \\( \\) so the dollar does not close it', () => {
  assert.equal(statementPreview('Costa \\(\\$5\\) al pezzo.'), 'Costa \\(\\$5\\) al pezzo.');
});

test('braces inside a formula are kept, markdown marks around it are dropped', () => {
  assert.equal(statementPreview('**Esercizio.** Calcolare $\\frac{1}{2}$.'), 'Esercizio. Calcolare $\\frac{1}{2}$.');
});

test('a long statement is cut in the text, never inside a formula', () => {
  const long = `${'a'.repeat(140)} $\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}$ fine`;
  assert.equal(statementPreview(long), `${'a'.repeat(140)} …`);
  assert.equal(statementPreview('b'.repeat(200)), `${'b'.repeat(150)}…`);
});

test('a statement that opens with a long formula still shows it', () => {
  const tex = `x = ${'1 + '.repeat(60)}1`;
  assert.equal(statementPreview(`$${tex}$ dopo`), `$${tex}$…`);
});
