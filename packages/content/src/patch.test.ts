import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSection } from './lint.ts';
import { applyGuardedChanges, quoteInBlock, sameQuote } from './patch.ts';

const lint = (md: string) => lintSection(md, { sectionId: 's1', language: 'it' });
const F = ':::formula{key="k1" label="L"}\n$$x=1$$\n:::';

test('plain changes are applied; out-of-range blocks are ignored', () => {
  const r = applyGuardedChanges(['Uno.', 'Due.'], [{ block: 0, text: ' Uno bis. ' }, { block: 7, text: 'x' }], lint);
  assert.deepEqual(r.blocks, ['Uno bis.', 'Due.']);
  assert.deepEqual(r.kept, [0]);
  assert.deepEqual(r.reverted, []);
});

test('deleting a heading, a directive or a formula is reverted; deleting plain text is allowed up to 3 blocks', () => {
  const r = applyGuardedChanges(['### Titolo', F, 'A.', 'B.', 'C.', 'D.'], [0, 1, 2, 3, 4, 5].map((block) => ({ block, text: '' })), lint);
  assert.deepEqual(r.blocks, ['### Titolo', F, '', '', '', 'D.']);
  assert.deepEqual(r.reverted.map((x) => x.block), [0, 1, 5]);
  assert.match(r.reverted[2].reason, /more than 3/);
});

test('dropping a formula key or a heading, and unbalanced fences, are reverted', () => {
  const r = applyGuardedChanges(['### Titolo\n\nTesto.', F, 'Fine.'], [
    { block: 0, text: '### Altro titolo\n\nTesto.' },
    { block: 1, text: ':::formula{key="k2" label="L"}\n$$x=1$$\n:::' },
    { block: 2, text: ':::note\nFine.' },
  ], lint);
  assert.deepEqual(r.kept, []);
  assert.equal(r.reverted.length, 3);
  const ok = applyGuardedChanges([F], [{ block: 0, text: ':::formula{key="k1" label="Nuova"}\n$$x=2$$\n:::' }], lint);
  assert.deepEqual(ok.kept, [0]);
});

test('a change that adds a blocker or major finding (a KaTeX error) is reverted; one that removes findings is kept', () => {
  const r = applyGuardedChanges(['Vale $x$.', 'Altro $y$.'], [{ block: 0, text: 'Vale $\\frac{1}{$.' }, { block: 1, text: 'Altro $z$.' }], lint);
  assert.deepEqual(r.blocks, ['Vale $x$.', 'Altro $z$.']);
  assert.deepEqual(r.reverted.map((x) => x.block), [0]);
  const fixed = applyGuardedChanges(['Vale $\\frac{1}{$.'], [{ block: 0, text: 'Vale $\\frac{1}{2}$.' }], lint);
  assert.deepEqual(fixed.kept, [0]);
});

test('quotes match on their first 60 normalised characters, in either direction', () => {
  assert.equal(sameQuote('Una  frase\nlunga.', 'Una frase lunga. E il resto.'), true);
  assert.equal(sameQuote('Una frase.', 'Un\'altra.'), false);
  assert.equal(sameQuote('', 'x'), false);
  assert.equal(quoteInBlock('frase $x$ [[n1]]', 'Una frase $x$ [[n1]] qui.'), true);
  assert.equal(quoteInBlock('altro', 'Una frase.'), false);
});
