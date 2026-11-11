import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelCode, sanitizeModelMarkdown, sanitizeModelText, sanitizeModelValue } from './sanitize.ts';

test('a control character before a letter replaces the eaten backslash', () => {
  assert.equal(sanitizeModelText('$+\u001finfty$'), '$+\\infty$');
  assert.equal(sanitizeModelText('$\u0001alpha$'), '$\\alpha$');
});

test('terminal mode codes such as hide-cursor vanish, with or without their escape byte', () => {
  assert.equal(sanitizeModelText('$[\u001b[?25l\\mathbb{R}$'), '$[\\mathbb{R}$');
  assert.equal(sanitizeModelText('$[?25l\\mathbb{R}$ e [?25h fine'), '$\\mathbb{R}$ e  fine');
  assert.equal(sanitizeModelText('\u001b[?2004hTesto'), 'Testo');
  assert.equal(sanitizeModelText('$[2,+\\infty[$'), '$[2,+\\infty[$', 'an interval is not a terminal code');
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

test('tool-call markup is removed: lines of tags with their newline, inline tags cut out', () => {
  assert.equal(
    sanitizeModelText('…delle successioni monotone limitate.</markdown>\n</invoke>'),
    '…delle successioni monotone limitate.',
  );
  assert.equal(sanitizeModelText('Prima riga\n  </invoke> <parameter name="x">\nseconda riga'), 'Prima riga\nseconda riga');
  assert.equal(sanitizeModelText('<markdown>Testo $a<b$ e <i>.</markdown>'), 'Testo $a<b$ e <i>.');
  assert.equal(sanitizeModelText('$x<parameters$ e <marked>'), '$x<parameters$ e <marked>');
});

const codeSchema = { type: 'object', properties: { code: { type: 'string', 'x-code': true }, text: { type: 'string' }, fns: { type: 'array', items: { type: 'object', properties: { fn: { anyOf: [{ type: 'string', 'x-code': true }, { type: 'null' }] } } } } } };

test('a field the schema marks as code keeps A\\C, \\n in a string and \\t in Python, while text still gets repaired', () => {
  const out = sanitizeModelValue(
    { code: 'x = A\\C;\nfprintf("a\\n");\nprint("a\\tb")\n', text: '$\\C \\sen x$', fns: [{ fn: 'sin(x)\\Q' }] },
    codeSchema,
  );
  assert.equal(out.code, 'x = A\\C;\nfprintf("a\\n");\nprint("a\\tb")\n');
  assert.equal(out.text, '$\\mathbb{C} \\operatorname{sen} x$');
  assert.equal(out.fns[0].fn, 'sin(x)\\Q', 'a nullable code field inside an array is still code');
});

test('code still loses terminal codes, markup and stray control characters, and keeps tabs and newlines', () => {
  assert.equal(sanitizeModelCode('a\u001b[1;31mb\u001b[0m\u0007\tc\n[?25ld'), 'ab\tc\nd');
  assert.equal(sanitizeModelCode('x\u000cy</markdown>'), 'xy');
});

test('without a schema every string is repaired as before', () => {
  assert.equal(sanitizeModelValue({ code: '$\\C$' }).code, '$\\mathbb{C}$');
});

test('rows of an array or an aligned block keep their line breaks, also when a row starts with u or i', () => {
  const table = 'Tabella:\n\n$$\n\\begin{array}{cc|c}\nA & B & A \\cdot B \\\\\n\\hline\nu & 0 & 0 \\\\\ni & 1 & 1\n\\end{array}\n$$\n';
  assert.equal(sanitizeModelText(table), table);
  const aligned = '$$\n\\begin{aligned}\nR &= 1 \\\\\nu_1 &= R i_1 \\\\\ni_2 &= u_2 / R\n\\end{aligned}\n$$';
  assert.equal(sanitizeModelText(aligned), aligned);
  // An eaten \n right after a space is still restored.
  assert.equal(sanitizeModelText('$$a \\\\ \nabla f$$'), '$$a \\\\ \\nabla f$$');
});

test('Markdown that never was a JSON string keeps its line breaks and its backslashes', () => {
  // The first row after \begin{aligned} starts with i_1, and a line of a display block starts with u_1: neither is an eaten \n.
  const aligned = '$$\n\\begin{aligned}\ni_1 &= \\frac{V}{R} \\\\\ni_2 &= 0\n\\end{aligned}\n$$';
  assert.equal(sanitizeModelMarkdown(aligned), aligned);
  assert.equal(sanitizeModelText(aligned), aligned.replace('\\begin{aligned}\n', '\\begin{aligned}\\n'), 'the guess for a JSON string reads that row as \\ni_1');
  const lines = '$$\na = b\nu_1 = c\n$$';
  assert.equal(sanitizeModelMarkdown(lines), lines);
  const commands = 'Con $\\nu$, $a \\neq b$, $\\theta$, $\\beta$ e $\\tau$.\tFine\n\\nabla f';
  assert.equal(sanitizeModelMarkdown(commands), commands);
});

test('Markdown still loses terminal codes, tool markup and control bytes, and gets the KaTeX names it lacks rewritten', () => {
  assert.equal(sanitizeModelMarkdown('Testo\u001b[1;31m rosso\u001b[0m\u0007.</markdown>'), 'Testo rosso.');
  assert.equal(sanitizeModelMarkdown('$\\cotan x + \\sen x$, $x\\in\\Q$'), '$\\operatorname{cotan} x + \\operatorname{sen} x$, $x\\in\\mathbb{Q}$');
});
