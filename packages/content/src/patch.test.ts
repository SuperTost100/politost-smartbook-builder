import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSection } from './lint.ts';
import { applyGuardedChanges, dropReferences, guardRules, MAX_DELETED_BLOCKS, MIN_KEPT_SHARE, quoteInBlock, repairSectionRefs, sameQuote, unwrapFormulaKeys } from './patch.ts';

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

test('removals may delete headings, formulas and ::: blocks, and more blocks; changed blocks keep their guards', () => {
  const blocks = ['Testo.', '### Formula di Binet', ':::formula{key="binet" label="Formula di Binet"}\n$$u\'\'+u=0$$\n:::', 'Uno.', 'Due.', 'Tre.', 'Quattro.', '### Altro'];
  const del = [1, 2, 3, 4, 5, 6].map((block) => ({ block, text: '' }));
  const out = applyGuardedChanges(blocks, [...del, { block: 7, text: '### Rinominato' }], () => [], { removals: true });
  assert.deepEqual(out.kept, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(out.reverted.map((r) => r.block), [7], 'a heading still cannot be rewritten');
  assert.deepEqual(applyGuardedChanges(blocks, del, () => []).kept, [3, 4, 5], 'without removals the heading and the formula stay, and at most 3 blocks go');
});

test('a fix for a figure problem may delete a block that is only that image; nothing else changes', () => {
  const IMG = ':::image{src="assets/s1-retta.svg" alt="a" caption="c"}\n:::';
  const blocks = ['### Titolo', 'Testo.', IMG, F];
  const del = [0, 2, 3].map((block) => ({ block, text: '' }));
  // Without a figure problem the image stays, as before.
  assert.deepEqual(applyGuardedChanges(blocks, del, lint).reverted.map((x) => x.block), [0, 2, 3]);
  const r = applyGuardedChanges(blocks, del, lint, { figures: true });
  assert.deepEqual(r.blocks, ['### Titolo', 'Testo.', '', F]);
  assert.deepEqual(r.kept, [2]);
  assert.deepEqual(r.reverted.map((x) => x.block), [0, 3]);
  // An image inside a block with other text is removed by rewriting the block, which was always allowed.
  const mixed = applyGuardedChanges([`Testo.\n\n${IMG}`], [{ block: 0, text: 'Testo.' }], lint, { figures: true });
  assert.deepEqual(mixed.kept, [0]);
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

test('a formula key defined elsewhere loses its wrapper and keeps its math', () => {
  const md = `Testo.\n\n${F}\n\n:::formula{key="k2" label="M"}\n$$y=2$$\n:::\n\nFine.`;
  assert.equal(unwrapFormulaKeys(md, new Set(['k1'])), 'Testo.\n\n$$x=1$$\n\n:::formula{key="k2" label="M"}\n$$y=2$$\n:::\n\nFine.');
  assert.equal(unwrapFormulaKeys(md, new Set()), md);
});

test('section links to an unknown id are pointed at the node they mean, or become plain text', () => {
  const nodes = [{ id: 'c1', slug: 'funzioni-reali' }, { id: 'f88aee69-291a-4ea8-bf78-0f5718dacdfc' }, { id: 'ab4a5b0e-7d31-4742-b8ee-ebcf244154f2' }, { id: 'ab4a5b0e-0000-4742-b8ee-ebcf244154f2' }];
  const md = [
    'Vedi [rotolamento](ref:section/f88aee69-ba1d-4bd4-a22f-8d3d1dad579c),',
    '[il capitolo](ref:section/funzioni-reali),',
    '[due candidati](ref:section/ab4a5b0e-9999-4742-b8ee-ebcf244154f2),',
    '[nessuno](ref:section/4c723236-4f4a-4f4a-4f4a-4f4a4f4a4f4a)',
    'e [giusto](ref:section/ab4a5b0e-7d31-4742-b8ee-ebcf244154f2).',
  ].join(' ');
  assert.equal(repairSectionRefs(md, nodes), [
    'Vedi [rotolamento](ref:section/f88aee69-291a-4ea8-bf78-0f5718dacdfc),',
    '[il capitolo](ref:section/c1),',
    'due candidati,',
    'nessuno',
    'e [giusto](ref:section/ab4a5b0e-7d31-4742-b8ee-ebcf244154f2).',
  ].join(' '));
  assert.equal(repairSectionRefs('$]a,b[$; vedi [teorema](ref:section/missing)', nodes), '$]a,b[$; vedi teorema');
});

test('references to a removed section become plain text: its links keep the label, its formulas become their name', () => {
  const md = 'Vedi [la sezione](ref:section/s2), la {{formula:@decadimento}} e [questa legge](ref:formula/@decadimento). Resta [altro](ref:section/s9) e {{formula:@altra}}.';
  assert.equal(dropReferences(md, 's2', [{ key: 'decadimento', label: 'Legge del decadimento radioattivo' }]),
    'Vedi la sezione, la legge del decadimento radioattivo e questa legge. Resta [altro](ref:section/s9) e {{formula:@altra}}.');
});

test('a change that trades one serious finding for a placeholder is reverted, though the total stays the same', () => {
  const findings = (md: string) => [
    ...(md.includes('ERR') ? [{ rule: 'katex', severity: 'blocker' as const, message: 'e', file: 's1' }] : []),
    ...(md.includes('[?]') ? [{ rule: 'placeholder', severity: 'blocker' as const, message: 'p', file: 's1' }] : []),
  ];
  const r = applyGuardedChanges(['Testo ERR.', 'Altro.'], [{ block: 0, text: 'Testo $[?]$.' }], findings);
  assert.deepEqual(r.kept, []);
  assert.equal(r.blocks[0], 'Testo ERR.');
  assert.deepEqual(applyGuardedChanges(['Testo ERR.'], [{ block: 0, text: 'Testo.' }], findings).kept, [0], 'removing the error alone is kept');
});

test('a change that turns a major finding into a blocker of the same rule is reverted', () => {
  const findings = (md: string) => md.includes('MAJ') ? [{ rule: 'katex', severity: 'major' as const, message: 'm', file: 's1' }]
    : md.includes('BLK') ? [{ rule: 'katex', severity: 'blocker' as const, message: 'b', file: 's1' }] : [];
  assert.deepEqual(applyGuardedChanges(['Vale MAJ.'], [{ block: 0, text: 'Vale BLK.' }], findings).kept, []);
});

test('the rules told to the fix model are the limits the guard enforces', () => {
  const plain = guardRules();
  const limit = Number(/Delete at most (\d+) blocks/.exec(plain)?.[1]);
  assert.equal(limit, MAX_DELETED_BLOCKS);
  const blocks = Array.from({ length: limit + 2 }, (_, i) => `Blocco ${i}.`);
  const del = (n: number) => applyGuardedChanges(blocks, blocks.slice(0, n).map((_, block) => ({ block, text: '' })), lint);
  assert.equal(del(limit).reverted.length, 0, 'deleting as many as the rules allow is accepted');
  assert.equal(del(limit + 1).reverted.length, 1, 'one more is reverted');
  assert.match(plain, /Never delete a block that holds a heading, a formula or another ::: block/);
  assert.match(plain, /Never delete a figure block/);
  assert.match(plain, new RegExp(`less than ${Math.round(MIN_KEPT_SHARE * 100)}%`));
  // A fix about a figure may delete a figure block; a fix for off-program material may delete much more.
  assert.match(guardRules({ figures: true }), /may be deleted because a problem is about that figure/);
  const cut = Number(/up to (\d+) blocks/.exec(guardRules({ removals: true }))?.[1]);
  const many = Array.from({ length: cut + 1 }, (_, i) => `Blocco ${i}.`);
  const removed = (n: number) => applyGuardedChanges(many, many.slice(0, n).map((_, block) => ({ block, text: '' })), lint, { removals: true });
  assert.equal(removed(cut).reverted.length, 0);
  assert.equal(removed(cut + 1).reverted.length, 1);
});
