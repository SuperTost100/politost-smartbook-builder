import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelText, sanitizeModelValue } from './sanitize.ts';

test('a control character before a letter replaces the eaten backslash', () => {
  assert.equal(sanitizeModelText('$+\u001finfty$'), '$+\\infty$');
  assert.equal(sanitizeModelText('$\u0001alpha$'), '$\\alpha$');
});

test('form feed, backspace and carriage return restore \\f, \\b and \\r commands', () => {
  assert.equal(sanitizeModelText('$\u000crac{1}{2}$'), '$\\frac{1}{2}$');
  assert.equal(sanitizeModelText('$\u0008eta$'), '$\\beta$');
  assert.equal(sanitizeModelText('$\rho$'), '$\\rho$');
});

test('other control characters are deleted; ANSI escapes vanish; tab and newline stay', () => {
  assert.equal(sanitizeModelText('$\u0000\\sup$'), '$\\sup$');
  assert.equal(sanitizeModelText('$x^{-\u001b[0m\\alpha}$'), '$x^{-\\alpha}$');
  assert.equal(sanitizeModelText('a\u001b[1;31mb\u001b[0m'), 'ab');
  assert.equal(sanitizeModelText('riga\tuno\nriga due\u0007.'), 'riga\tuno\nriga due.');
  assert.equal(sanitizeModelText('testo normale $\\frac{1}{2}$'), 'testo normale $\\frac{1}{2}$');
});

test('every string of a parsed value is cleaned, other values are untouched', () => {
  assert.deepEqual(sanitizeModelValue({ a: ['$+\u001finfty$', 3, null], b: { c: 'x\u0000', d: true } }), { a: ['$+\\infty$', 3, null], b: { c: 'x', d: true } });
});

test('an eaten \\t or \\n in math is restored; real tabs and newlines in prose stay', () => {
  assert.equal(sanitizeModelText('$\x09heta \\in [0,\\pi]$'), '$\\theta \\in [0,\\pi]$');
  assert.equal(sanitizeModelText('$$\n\\sin\x09heta\n$$'), '$$\n\\sin\\theta\n$$');
  assert.equal(sanitizeModelText('$f(x) = 3 \x09ext{se } x>0$'), '$f(x) = 3 \\text{se } x>0$');
  assert.equal(sanitizeModelText('$\nabla f$ e $a \neq b$'), '$\\nabla f$ e $a \\neq b$');
  assert.equal(sanitizeModelText('Una riga\nuna seconda riga\theta'), 'Una riga\nuna seconda riga\theta');
  assert.equal(sanitizeModelText('$x$\nesiste'), '$x$\nesiste');
  assert.equal(sanitizeModelText('\nabla $x$'), '\nabla $x$');
});

test('function names KaTeX lacks become operators; \\Q and \\C become blackboard letters', () => {
  assert.equal(sanitizeModelText('$e^x\\cotan x + \\sen x$'), '$e^x\\operatorname{cotan} x + \\operatorname{sen} x$');
  assert.equal(sanitizeModelText('$\\sgn(x)$, $x\\in\\Q$, $z\\in\\C$'), '$\\operatorname{sgn}(x)$, $x\\in\\mathbb{Q}$, $z\\in\\mathbb{C}$');
  // Commands KaTeX knows are left alone.
  assert.equal(sanitizeModelText('$\\cot x + \\sin x + \\Cap + \\senso$'), '$\\cot x + \\sin x + \\Cap + \\senso$');
});
