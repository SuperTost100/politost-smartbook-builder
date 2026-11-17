// Rules added after the November 2026 audit of the four published books. Each case that fires is a real hit from those books
// (or a minimal copy of it); each case that must not fire is a near-miss found while tuning the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { katexError, lintCompiled, lintQuestionText, lintSection } from './lint.ts';
import { applyGuardedChanges } from './patch.ts';
import type { LintFinding } from './types.ts';

const lint = (md: string): LintFinding[] => lintSection(md, { sectionId: 'sec', language: 'it' });
const hits = (md: string, rule: string) => lint(md).filter((f) => f.rule === rule);
const sev = (md: string, rule: string) => hits(md, rule)[0]?.severity;

test('stray-digit-wrap: a digit copied around an inline formula is a blocker', () => {
  assert.equal(sev('Si ottengono $4\\mathrm{C_4H_{10}}4$ molecole.', 'stray-digit-wrap'), 'blocker');
  assert.equal(hits('Gli orbitali $4sp^24$ sono ibridi.', 'stray-digit-wrap').length, 1);
  // near misses: arithmetic that starts and ends with the same digit
  for (const ok of ['Vale $2\\times2$.', 'Vale $2\\sqrt2$.', 'Vale $1\\cdot1$.', 'Vale $2\\sin2$ e $3\\ln3$.', 'Il testo `$4\\mathrm{C}4$` è codice.', 'Tende a $1x=1$.', 'Il limite $\\dots\\to0$ e $3 + 3$.']) {
    assert.deepEqual(hits(ok, 'stray-digit-wrap'), [], ok);
  }
  // a display formula and an exercise line are not inline text
  assert.deepEqual(hits('$$\n4\\mathrm{C}4\n$$', 'stray-digit-wrap'), []);
});

test('ref-scheme: a link that is none of the four forms the reader resolves is a blocker', () => {
  assert.equal(sev('Vedi la [legge](ref:formula:@legge-di-hess).', 'ref-scheme'), 'blocker');
  assert.equal(hits('Vedi [qui](ref:formulas/@a) e [là](ref:chapter/3#p4x).', 'ref-scheme').length, 2);
  for (const ok of ['[a](ref:formula/@legge-di-hess)', '[a](ref:formula/3.2)', '[a](ref:section/s-3-1)', '[a](ref:chapter/3#p4)', 'Il codice `[x](ref:formula:@x)` resta.', 'Un [sito](https://example.org/x)']) {
    assert.deepEqual(hits(ok, 'ref-scheme'), [], ok);
  }
});

test('foreign-script: Cyrillic or CJK letters are a major finding; Greek, accents and code are not', () => {
  assert.equal(sev('Il carbonio, $40{,}00\\,\\mathrm{g}$ di н e il resto.', 'foreign-script'), 'major');
  assert.equal(hits('Questo vale $x = \\text{н}$.', 'foreign-script').length, 1, 'also inside math');
  assert.equal(hits('Il termine 水 non va qui.', 'foreign-script').length, 1);
  for (const ok of ['Una città è più bella, e vale α e Ω.', 'Il comando `привет` è codice.', 'Vale $\\alpha + \\beta$.']) assert.deepEqual(hits(ok, 'foreign-script'), [], ok);
});

test('prose-tilde: a "~" outside math is major; a tilde in math and a strike-through are not', () => {
  assert.equal(sev('Il ferro ha numero di ossidazione ~+2 nel composto.', 'prose-tilde'), 'major');
  for (const ok of ['Vale $\\tilde{x} = a~b$.', 'Un testo ~~cancellato~~ qui.', 'Il codice `a ~ b` resta.']) assert.deepEqual(hits(ok, 'prose-tilde'), [], ok);
});

test('list-start: a numbered list that starts at 3 after prose is major; resumed, continued and numbered-from-1 lists are not', () => {
  const lost = 'Le strutture di Lewis sono di tre classi.\n\n3. Gusci di valenza espansi: alcune specie.';
  const f = hits(lost, 'list-start');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'major');
  assert.equal(f[0].line, 3);
  assert.deepEqual(hits('Le classi sono tre.\n\n1. Prima.\n2. Seconda.\n3. Terza.', 'list-start'), []);
  // a list a paragraph interrupted keeps counting
  assert.deepEqual(hits('1. Prima.\n2. Seconda.\n\nUn commento.\n\n3. Terza.', 'list-start'), []);
  // a list continued after a display formula
  assert.deepEqual(hits('1. Prima.\n\n$$\nx = 1\n$$\n\n2. Seconda.\n\n$$\ny\n$$\n\n3. Terza.', 'list-start'), []);
  assert.deepEqual(hits('Si ha\n\n$$\nx = 1\n$$\n\n3. Terza.', 'list-start'), []);
  // a new section starts counting again, and a year at the start of a sentence is no list
  assert.equal(hits('1. Prima.\n\n### Altro\n\n3. Terza.', 'list-start').length, 1);
  assert.equal(hits('1. Prima.\n### Altro\n\n3. Terza.', 'list-start').length, 1);
  assert.deepEqual(hits('1984 fu un anno.', 'list-start'), []);
});

test('decimal-comma: a list that content-core 0.6.0 reads as a decimal, and a pair it reads as a factor, are major', () => {
  const real = [
    'Per $i=1,2$ valgono le stesse.', // index list
    'Gli atomi $1,2$ del legame.', // locants
    'Il punto $0,1\\in A$ è interno.', // membership
    'I valori $-4/3,4/3,0$ sono radici.', // fractions
    'La media $m(f;-1,1)=0$ si calcola.', // after a semicolon
    'Vale $\\frac{(1,00)(0,08206)(273,15)}{1,00} = 2,24$ atm.', // a pair that is a factor
  ];
  for (const md of real) assert.equal(sev(md, 'decimal-comma'), 'major', md);
  // near misses from the false positives found while tuning
  const fine = [
    'Con $m = 0,9$ si ottiene.', // a decimal
    'Nell\'intervallo $\\lbrack 0,1\\rbrack ^2$ si studia.', // a real pair
    'La coppia $(3,4)$ è un punto.', // a plain pair
    'Vale $x_{1,2}$ e $a_{1,2,3}$.', // indices
    'Vale $1{,}2$ e $0,05$ g.', // marked, and a leading zero
    'Con $\\log(2,5)$ si ha una sola cifra.', // one argument: a decimal
  ];
  for (const md of fine) assert.deepEqual(hits(md, 'decimal-comma'), [], md);
  assert.match(hits(real[0], 'decimal-comma')[0].message, /1, 2/);
});

test('the decimal-comma copy of digitCommas is the file content-core ships', () => {
  const ours = readFileSync(new URL('./decimalComma.ts', import.meta.url), 'utf8').split('\n').slice(3).join('\n');
  const theirs = readFileSync(new URL('../../../node_modules/@politost/content-core/src/decimalComma.ts', import.meta.url), 'utf8').split('\n').slice(35).join('\n');
  assert.equal(ours, theirs, 'content-core changed: copy src/decimalComma.ts from the type DigitCommaKind on, and re-measure the decimal-comma rule');
});

test('double-period: ".." in prose is minor; an ellipsis, a decimal and math are not', () => {
  assert.equal(sev('Il monossido di azoto, N.O.., è un gas.', 'double-period'), 'minor');
  assert.equal(sev('Fine frase.. Poi altro.', 'double-period'), 'minor');
  for (const ok of ['Attendere... poi misurare.', 'Vale $a..b$ e 3.5.', 'Un file `a..b` resta.']) assert.deepEqual(hits(ok, 'double-period'), [], ok);
});

test('a $[?]$ left by a model is a blocker and a fix that adds one is reverted', () => {
  assert.equal(sev('È per questo che $[?]$ si misura tramite $q_p$.', 'placeholder'), 'blocker');
  const blocks = ['Un valore $x$ e il resto.'];
  const r = applyGuardedChanges(blocks, [{ block: 0, text: 'Un valore $[?]$ e il resto.' }], lint);
  assert.deepEqual(r.blocks, blocks);
  assert.equal(r.reverted.length, 1);
});

test('the fix guard reverts a change that adds a new blocker or major rule: a lost list item, a stray digit, a tilde', () => {
  const blocks = ['Le classi sono tre.\n\n1. Prima.\n2. Seconda.\n3. Gusci di valenza espansi.'];
  const list = applyGuardedChanges(blocks, [{ block: 0, text: 'Le classi sono tre.\n\n3. Gusci di valenza espansi.' }], lint);
  assert.deepEqual(list.blocks, blocks);
  assert.equal(list.reverted.length, 1);
  const ok = ['Si ottengono molecole.'];
  assert.equal(applyGuardedChanges(ok, [{ block: 0, text: 'Si ottengono $4\\mathrm{C_4H_{10}}4$ molecole.' }], lint).reverted.length, 1);
  assert.equal(applyGuardedChanges(ok, [{ block: 0, text: 'Si ottengono ~4 molecole.' }], lint).reverted.length, 1);
});

test('the new rules run on question text too', () => {
  const f = lintQuestionText('Calcolare $4\\mathrm{C}4$ н.', { file: 'statement', language: 'it' });
  assert.deepEqual(f.map((x) => x.rule).sort(), ['foreign-script', 'stray-digit-wrap']);
});

const exercise = (id: string, text: string) => `:::exercise{id="${id}" difficulty="2"}\n## Domanda\n${text}\n:::hint\nSuggerimento.\n:::\n:::solution\nSoluzione.\n:::\n:::\n`;
const CH = '---\nchapter: 1\ntitle: Uno\n---\n\n## p1 | Primo\n\nTesto.\n';

test('duplicate-exercise: the same statement twice is minor; same-data-exercise: the same four numbers in order', () => {
  const same = 'Un composto contiene il 40,00% di carbonio e il 6,71% di idrogeno e il 53,29% di ossigeno in 100 g, calcolare la formula minima.';
  const reworded = 'Un campione ha il 40,00% di carbonio, il 6,71% di idrogeno e il 53,29% di ossigeno su 100 g: determinare la formula minima del campione.';
  const found = lintCompiled({
    'chapters/01-uno.md': CH,
    'esercizi.md': exercise('E1.1', same) + exercise('E1.2', same) + exercise('E1.3', reworded),
  }, { integrity: false, content: false });
  const dup = found.filter((f) => f.rule === 'duplicate-exercise');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, 'minor');
  assert.match(dup[0].message, /E1\.2.*E1\.1/);
  const data = found.filter((f) => f.rule === 'same-data-exercise');
  assert.equal(data.length, 1);
  assert.match(data[0].message, /E1\.3.*E1\.1/);
  // near misses: different statements, different numbers, fewer than four numbers
  const none = lintCompiled({
    'chapters/01-uno.md': CH,
    'esercizi.md': exercise('E2.1', 'Calcolare la massa di 3 mol di acqua nelle condizioni standard di temperatura.') + exercise('E2.2', 'Calcolare la massa di 5 mol di acqua nelle condizioni standard di temperatura.')
      + exercise('E2.3', 'Un composto contiene il 40,00% di carbonio e il 7,00% di idrogeno, calcolare la formula.'),
  }, { integrity: false, content: false });
  assert.deepEqual(none.filter((f) => /exercise/.test(f.rule)), []);
});

test('katexError renders as the reader does: undefined commands and missing braces fail, decimal commas and valid math do not', () => {
  assert.match(katexError('\\foo', false) ?? '', /Undefined control sequence/);
  assert.match(katexError('\\frac{a}', true) ?? '', /parse error/i);
  assert.equal(katexError('a_', false) !== null, true);
  for (const ok of ['x^2 + 1', '(0,20)^2 = 0,04', '1,5\\,\\mathrm{kg}', '\\text{н}']) assert.equal(katexError(ok, false), null, ok);
  assert.equal(katexError('\\begin{pmatrix} 1,5 & 2 \\\\ 3 & 4 \\end{pmatrix}', true), null);
});
