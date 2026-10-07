import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separateDisplayMath } from './displayMath.ts';
import { lintSection } from './lint.ts';

const mixed = (md: string) => lintSection(md, { sectionId: 's', language: 'it' }).filter((f) => f.rule === 'math-mixed').length;
/** Fixes md, checks the lint is quiet afterwards (it was not before) and that a second run changes nothing. */
const fix = (md: string) => {
  assert.equal(mixed(md), 1, 'the input should be flagged');
  const out = separateDisplayMath(md);
  assert.equal(mixed(out), 0);
  assert.equal(separateDisplayMath(out), out);
  return out;
};

test('display math in the middle of a paragraph gets blocks of its own', () => {
  assert.equal(
    fix('Quindi $f$ è pari. Studiamo ora $$ g(x) = x^3 - x. $$ Il dominio è $\\mathbb{R}$ ok.'),
    'Quindi $f$ è pari. Studiamo ora\n\n$$\ng(x) = x^3 - x.\n$$\n\nIl dominio è $\\mathbb{R}$ ok.',
  );
  assert.equal(
    fix('**Esempio.** Determiniamo il dominio naturale di $$ f(x) = \\sqrt{4 - x^2} $$ e poi $x$.'),
    '**Esempio.** Determiniamo il dominio naturale di\n\n$$\nf(x) = \\sqrt{4 - x^2}\n$$\n\ne poi $x$.',
  );
});

test('display math in a list, table or quote becomes inline', () => {
  assert.equal(fix('- Esponenziale: $$e^x = 1 + o(x^3)$$\n- Con $x$ piccolo'), '- Esponenziale: $\\displaystyle e^x = 1 + o(x^3)$\n- Con $x$ piccolo');
  assert.equal(fix('1. Vale $$\n a + b\n$$ sempre\n2. $y$'), '1. Vale $\\displaystyle a + b$ sempre\n2. $y$');
  assert.equal(separateDisplayMath('> Sia $x$ con $$ x^2\n> + 1 $$ qui'), '> Sia $x$ con $\\displaystyle x^2 + 1$ qui');
  assert.equal(separateDisplayMath('| $a$ | $$b$$ |'), '| $a$ | $\\displaystyle b$ |');
});

test('display math on its own lines inside a paragraph is split off, emphasis stays balanced', () => {
  const md = '**Teorema 8.2** (di Weierstrass). *Sia $f : [a,b] \\to \\mathbb{R}$ una funzione continua tali che*\n$$\n\\forall x \\in [a,b] \\qquad f(x_m) \\le f(x) \\le f(x_M),\n$$\n*cioè il massimo esiste*';
  assert.equal(
    fix(md),
    '**Teorema 8.2** (di Weierstrass). *Sia $f : [a,b] \\to \\mathbb{R}$ una funzione continua tali che*\n\n$$\n\\forall x \\in [a,b] \\qquad f(x_m) \\le f(x) \\le f(x_M),\n$$\n\n*cioè il massimo esiste*',
  );
});

test('a split that would cut an emphasis falls back to inline math for that formula', () => {
  assert.equal(fix('*Sia $x$ tale che $$y = 1$$ e basta* ok'), '*Sia $x$ tale che $\\displaystyle y = 1$ e basta* ok');
  assert.equal(fix('**Nota: $a$ e $$b$$ dopo** fine'), '**Nota: $a$ e $\\displaystyle b$ dopo** fine');
  // A star inside math is not emphasis.
  assert.match(fix('Il prodotto $a^*$ vale $$b$$ qui'), /\n\n\$\$\nb\n\$\$\n\n/);
  // Two formulas: the first can be split, the second sits inside an emphasis.
  assert.equal(fix('Sia $x$: $$a$$ poi *dato $$b$$ finito* qui'), 'Sia $x$:\n\n$$\na\n$$\n\npoi *dato $\\displaystyle b$ finito* qui');
});

test('empty pieces are dropped; a trailing full stop joins the formula', () => {
  assert.equal(fix('$$a$$ con $x$'), '$$\na\n$$\n\ncon $x$');
  assert.equal(fix('Con $x$ vale $$a$$'), 'Con $x$ vale\n\n$$\na\n$$');
  assert.equal(fix('Con $x$ vale $$a$$.'), 'Con $x$ vale\n\n$$\na.\n$$');
});

test('code fences and ::: blocks stay byte-identical', () => {
  const keep = '```python\nprint("$a$ $$b$$")\n\n\n```\n\n:::formula{key="k" label="L"}\n$$ a = $b$ $$\n:::\n\n:::hint\nCon $x$ vale $$a$$\n\n:::solution\n$$z$$ e $w$\n:::\n:::';
  assert.equal(separateDisplayMath(keep), keep);
  const around = `Con $x$ e $$a$$ qui\n\n${keep}\n\nCon $y$ e $$b$$ qui`;
  const out = separateDisplayMath(around);
  assert.ok(out.includes(keep));
  assert.equal(out, `Con $x$ e\n\n$$\na\n$$\n\nqui\n\n${keep}\n\nCon $y$ e\n\n$$\nb\n$$\n\nqui`);
  assert.equal(separateDisplayMath(out), out);
});

test('blocks without the mix are returned as they are', () => {
  const md = '# Titolo $x$\n\nSolo $inline$ e $altro$.\n\n$$\nsolo display\n$$\n\nTesto con $$ display $$ senza inline.\n\n\n\n- elenco\n';
  assert.equal(separateDisplayMath(md), md);
  assert.equal(separateDisplayMath(''), '');
});

test('punctuation right after a split formula moves inside the display', () => {
  assert.equal(separateDisplayMath('Sia $f$ pari. Vale $$g(x) = x^3$$. Quindi $g$ è dispari.'), 'Sia $f$ pari. Vale\n\n$$\ng(x) = x^3.\n$$\n\nQuindi $g$ è dispari.');
  assert.equal(separateDisplayMath('Sia $f$ tale che $$f(x) = 1.$$ Allora $f$ è costante.'), 'Sia $f$ tale che\n\n$$\nf(x) = 1.\n$$\n\nAllora $f$ è costante.');
});
