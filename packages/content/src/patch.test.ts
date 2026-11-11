import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSection } from './lint.ts';
import { addsCommentary, applyGuardedChanges, dropReferences, guardRules, lostStructure, MAX_DELETED_BLOCKS, MIN_KEPT_SHARE, parsePatchAnswer, quoteInBlock, repairSectionRefs, sameQuote, unwrapFormulaKeys } from './patch.ts';

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

test('a patch answer is read part by part, and the new text reaches the caller exactly as written', () => {
  const body = 'Vale $\\frac{1}{2}\\nu + \\theta\\beta$ e\t\\text{tab}.\n\nSecondo paragrafo.';
  const r = parsePatchAnswer(`@@@ block 2 | issues 1, 3\n${body}\n\n@@@ delete 4 | issues 2\n\n@@@ resolved | issues 3\nIl testo dice già la soglia.\n@@@ figures\n[{"key":"a"}]\n`, { blocks: 6, issues: 3 });
  assert.ok(r.ok);
  assert.deepEqual(r.data.changes, [{ block: 2, text: body, issues: [1, 3] }, { block: 4, text: '', issues: [2] }]);
  assert.deepEqual(r.data.resolved, [{ issues: [3], reason: 'Il testo dice già la soglia.' }]);
  assert.deepEqual(r.data.figures, [{ key: 'a' }]);
  const none = parsePatchAnswer('@@@ none\n', { blocks: 1, issues: 1 });
  assert.ok(none.ok && !none.data.changes.length && !none.data.resolved.length && none.data.figures === null);
  // An author's instruction names no problems: a list is ignored instead of failing.
  const instruction = parsePatchAnswer('@@@ block 0 | issues 1\nNuovo.', { blocks: 1, issues: 0 });
  assert.ok(instruction.ok && instruction.data.changes[0].issues.length === 0);
  // Windows line ends do not leave a carriage return in the text.
  const crlf = parsePatchAnswer('@@@ block 0\r\nUno\r\nDue', { blocks: 1, issues: 0 });
  assert.ok(crlf.ok && crlf.data.changes[0].text === 'Uno\nDue');
});

test('a malformed patch answer is refused with a problem the model can act on', () => {
  const problem = (text: string, limits = { blocks: 3, issues: 2 }) => {
    const r = parsePatchAnswer(text, limits);
    assert.equal(r.ok, false, text);
    return r.ok ? '' : r.problem;
  };
  assert.match(problem(''), /no parts/);
  assert.match(problem('Ecco le modifiche:\n@@@ block 0\nx'), /before the first/);
  assert.match(problem('@@@ block 0\n'), /has no text.*@@@ delete 0/);
  assert.match(problem('@@@ block 0\nA\n@@@ delete 0'), /twice/);
  assert.match(problem('@@@ block 3\nA'), /from 0 to 2/);
  assert.match(problem('@@@ block x\nA'), /not a valid part header|number of an existing block/);
  assert.match(problem('@@@ block 0 | issues 3\nA'), /between 1 and 2/);
  assert.match(problem('@@@ resolved\nfatto'), /needs the numbers/);
  assert.match(problem('@@@ none\n@@@ block 0\nA'), /stands alone/);
  assert.match(problem('@@@ figures\n[not json'), /not valid JSON/);
  assert.match(problem('@@@ figures\n{"a":1}'), /JSON array/);
  assert.match(problem('@@@ banana 1\nA'), /not a valid part header/);
});

test('a rewrite of a whole section keeps its headings, formula keys, ::: blocks and images', () => {
  const formula = ':::formula{key="ohm" label="Legge di Ohm"}\n$$V = R i$$\n:::';
  const image = ':::image{src="assets/rc.svg" alt="a" caption="c"}\n:::';
  const note = ':::note\nAttenzione.\n:::';
  const before = `### Il circuito\n\nTesto.\n\n${formula}\n\n${note}\n\n${image}\n\nFine.`;
  assert.equal(lostStructure(before, before.replace('Testo.', 'Testo corretto.').replace('V = R i', 'V = R\\,i')), null);
  assert.match(lostStructure(before, before.replace('### Il circuito', '### Il circuito RC'))!, /heading "### Il circuito"/);
  assert.match(lostStructure(before, before.replace('key="ohm"', 'key="legge-ohm"'))!, /formula "ohm"/);
  assert.match(lostStructure(before, before.replace(formula, '$$V = R i$$'))!, /formula "ohm"/);
  assert.match(lostStructure(before, before.replace(note, 'Attenzione.'))!, /:::note block/);
  assert.match(lostStructure(before, before.replace(image, ''))!, /:::image block/);
  assert.match(lostStructure(before, before.replace('assets/rc.svg', 'assets/altro.svg'))!, /image "assets\/rc.svg"/);
  assert.match(lostStructure(before, `${before}\n\n:::formula{key="nuova" label="N"}\n$$a$$`)!, /fence open/);
  assert.equal(lostStructure(before, `${before}\n\n:::formula{key="nuova" label="N"}\n$$a$$\n:::`), null, 'a rewrite may add');
});

test('a rewrite that opens or closes with a note about itself is told from one that corrects a paragraph', () => {
  const before = 'Il circuito è il filtro RC passa-basso, il più semplice che lascia passare le basse frequenze.\n\nCon $R = 2$ si ha $V = 5$.\n\nIl risultato finale vale $5\\,\\mathrm{V}$ ai capi del resistore.';
  assert.equal(addsCommentary(before, before.replace('$V = 5$', '$V = 6$').replace('vale $5', 'vale $6')), false, 'a corrected result');
  assert.equal(addsCommentary(before, before.replace('Il circuito è il filtro RC passa-basso,', 'Il circuito, ossia il filtro RC passa-basso,')), false, 'a reworded opening');
  assert.equal(addsCommentary(before, `Ho corretto un passaggio algebrico errato e una forma grammaticale. Il resto torna.\n\n${before}`), true);
  assert.equal(addsCommentary(before, `${before}\n\nNota: ho cambiato il risultato finale da 5 a 6 volt nel secondo paragrafo.`), true);
  assert.equal(addsCommentary(before, `Ecco la versione corretta:\n\n${before}`), true, 'a short opening with words the section does not have');
  assert.equal(addsCommentary('$$a = b$$\n\nTesto del paragrafo centrale della sezione.\n\n$$c = d$$', '$$a = b + 1$$\n\nTesto del paragrafo centrale della sezione.\n\n$$c = d$$'), false, 'a formula at either end has no words to compare');
});

test('a corrected formula at either end of a section is not read as a note about the correction', () => {
  const text = 'Il circuito è il filtro RC passa-basso, il più semplice che lascia passare le basse frequenze.';
  const wrong = '$$\\frac{d}{dx}\\sin x = \\sin x$$';
  const right = '$$\\frac{d}{dx}\\sin x = \\cos x$$';
  assert.equal(addsCommentary(`${wrong}\n\n${text}\n\n${wrong}`, `${right}\n\n${text}\n\n${right}`), false, 'display formulas at both ends');
  assert.equal(addsCommentary(`${wrong}\n\n${text}`, `${right}\n\n${text}`), false, 'a display formula first');
  const block = (f: string) => `:::formula{key="derivata" label="Derivata"}\n${f}\n:::`;
  assert.equal(addsCommentary(`${text}\n\n${block(wrong)}`, `${text}\n\n${block(right)}`), false, 'a formula block last');
  const inline = 'La derivata vale $\\frac{d}{dx}\\sin x = \\sin x$ per ogni valore reale della variabile indipendente.';
  assert.equal(addsCommentary(inline, inline.replace('= \\sin x', '= \\cos x')), false, 'an inline formula inside a long paragraph');
  assert.equal(addsCommentary(`${text}\n\n${wrong}`, `${text}\n\n${wrong}\n\nNota: ho cambiato la derivata del seno nella formula precedente.`), true, 'prose after a formula is still a note');
  assert.equal(addsCommentary(`${wrong}\n\n${text}`, `Ho corretto la derivata del seno nella formula.\n\n${right}\n\n${text}`), true, 'prose before a formula is still a note');
});
