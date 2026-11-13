import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatForRules, formatModelText, formatterHandles } from './format.ts';
import { lintQuestionText, lintSection } from './lint.ts';

/** Passages of the owner's "Analisi Matematica 2" revisions: d2a8b8fe (####), 997962f6 and 7c33a051 (the fix model's damage), 3f099707 and 7ee9e029 (correct drafts). */
const fixture = (name: string) => readFileSync(new URL(`./testdata/analisi2/${name}`, import.meta.url), 'utf8');
const rules = (md: string, rule: string) => lintSection(md, { sectionId: 's', language: 'it' }).filter((f) => f.rule === rule);
/** The text with what the formatter may change taken out: layout, heading marks, $ and $$ delimiters, \displaystyle and punctuation next to a formula. */
const words = (md: string) => md.replace(/\\displaystyle/g, '').replace(/[\s#$.,;:>]/g, '');
const CORPUS = ['d2a8b8fe-headings.md', '997962f6-blank-in-display.md', '7c33a051-display-after-list.md', '3f099707-inline-in-list.md', '7ee9e029-clean.md'].map(fixture).concat([
  'Quindi $f$ è pari. Studiamo ora $$ g(x) = x^3 - x. $$ Il dominio è $\\mathbb{R}$ ok.',
  'Vale\n$$\na\n\n\nb\n$$\ne basta.\n### Titolo\n$$x$$\n## Altro\ntesto',
  '- uno $$a$$ e $b$\n- due\n\n  $$\n\n  c\n  $$\n\n> citazione $x$ $$\n> y\n>\n> z $$ fine',
  '```\n$$\n\nx\n$$\n#### nel codice\n```\n\n:::hint\n#### nel suggerimento\n$$\n\ny\n$$\n:::\n\nTesto </markdown> con \\cotan x.',
  '$$ aperto senza chiusura\n\n#### Titolo\n\nCon $x$.',
]);

test('every heading of a section becomes ###, as in revision d2a8b8fe', () => {
  const md = fixture('d2a8b8fe-headings.md');
  assert.equal(rules(md, 'heading-level').length, 3);
  const out = formatModelText(md);
  assert.equal(rules(out, 'heading-level').length, 0);
  assert.equal(out, md.replaceAll('#### ', '### '));
});

test('headings: levels 1 to 6 become ###, the compiler heading, code, ::: blocks and display math stay, and a question keeps its text', () => {
  assert.equal(formatModelText('# Uno\n\n## Due\n\n##### Cinque\n\n###### Sei\n\n### Tre'), '### Uno\n\n### Due\n\n### Cinque\n\n### Sei\n\n### Tre');
  assert.equal(formatModelText('## p3 | Idrocarburi\n\ntesto'), '## p3 | Idrocarburi\n\ntesto');
  const kept = '```\n#### nel codice\n```\n\n:::hint\n#### nel suggerimento\n:::\n\n$$\n#### nella formula\n$$';
  assert.equal(formatModelText(kept), kept);
  assert.equal(formatModelText('#### Titolo', { kind: 'question' }), '#### Titolo');
  assert.equal(formatModelText('####senza spazio'), '####senza spazio');
});

test('with an unclosed $$ the display math is not laid out, because everything after it would count as one formula', () => {
  // The lint reports the unclosed $$ as a blocker. Laying it out would join the paragraphs up to the next $$ into one block.
  const rest = 'Testo $a$ con $$ x = 1 mai chiuso.\n\nSecondo paragrafo con $b$.\n\nTerzo $$ y $$ fine.';
  assert.equal(formatModelText(`#### Titolo isolato\n\n${rest}`), `### Titolo isolato\n\n${rest}`);
  assert.equal(formatModelText(rest), rest);
  // The same inside one block, when a code fence and a later $$ make the count of the whole text even.
  const fenced = `${rest}\n\n\`\`\`\ncodice\n\`\`\`\n\nQuarto $$ z fine.`;
  assert.equal(formatModelText(fenced), fenced);
  // A block that closes its own $$ is still laid out next to one that does not.
  const two = `Primo $c$ e $$ w $$ qui.\n\n\`\`\`\ncodice\n\`\`\`\n\n${rest}`;
  assert.equal(formatModelText(two), `Primo $c$ e\n\n$$\nw\n$$\n\nqui.\n\n\`\`\`\ncodice\n\`\`\`\n\n${rest}`);
  // Closed, the same text is laid out.
  const closed = rest.split('mai chiuso.').join('$$ chiuso.');
  assert.notEqual(formatModelText(closed), closed);
  assert.match(formatModelText(closed), /\n\nSecondo paragrafo con \$b\$\.\n\n/, 'and the paragraphs stay paragraphs');
});

test('a fix for chosen notes runs only the formatter of their rules', () => {
  const text = '#### Titolo\n\nVale $a$ e $$ b+2 $$ fine.';
  assert.equal(formatForRules(text, ['heading-level']), '### Titolo\n\nVale $a$ e $$ b+2 $$ fine.', 'the math stays as typed');
  const math = formatForRules(text, ['math-mixed']);
  assert.match(math, /^#### Titolo\n/, 'the heading stays as typed');
  assert.match(math, /\n\$\$\nb\+2\n\$\$\n/);
  assert.equal(formatForRules(text, ['math-blank-line', 'compile:heading-level']), formatModelText(text));
  assert.equal(formatForRules(text, ['placeholder']), text);
  assert.equal(formatForRules('#### In una domanda', ['heading-level'], 'question'), '#### In una domanda', 'a question keeps its headings');
});

test('a blank line inside a $$ block goes, as in revision 997962f6', () => {
  const md = fixture('997962f6-blank-in-display.md');
  assert.equal(rules(md, 'math-blank-line').length, 1);
  const out = formatModelText(md);
  assert.equal(rules(out, 'math-blank-line').length, 0);
  assert.equal(out, md.replace('$$\n\n\\mathbf', () => '$$\n\\mathbf'));
});

test('the lint reports a blank line inside $$ once for each place, and not a blank line between two blocks', () => {
  assert.equal(rules('Testo.\n\n$$\na\n\n\nb\n$$\n\nFine.', 'math-blank-line').length, 1);
  assert.equal(rules('$$\na\n$$\n\n$$\nb\n$$', 'math-blank-line').length, 0);
  assert.equal(rules('$$\n\na\n\n$$', 'math-blank-line').length, 2);
  assert.equal(lintSection('$$\n\na\n$$', { sectionId: 's', language: 'it' })[0]?.severity, 'minor');
});

test('display math outside lists gets lines of its own and blank lines around it', () => {
  assert.equal(formatModelText('Sia\n$$\nx^2\n$$\nvero.'), 'Sia\n\n$$\nx^2\n$$\n\nvero.');
  assert.equal(formatModelText('Vale $$ a + b $$ sempre'), 'Vale $$ a + b $$ sempre', 'inside a sentence, with no inline math, it is valid as written');
  assert.equal(formatModelText('Vale $c$ e $$ a + b $$ sempre'), 'Vale $c$ e\n\n$$\na + b\n$$\n\nsempre');
  assert.equal(formatModelText('Intro\n\n$$ a\n+ b $$\n\nFine'), 'Intro\n\n$$\na\n+ b\n$$\n\nFine');
  assert.equal(formatModelText('### Titolo\n$$x$$\n### Altro'), '### Titolo\n\n$$x$$\n\n### Altro');
  assert.equal(formatModelText('Prima.\n\n$$x$$\n\nDopo.'), 'Prima.\n\n$$x$$\n\nDopo.', 'a one-line formula on its own line stays');
});

test('display math in a list or a quote loses its blank lines and stays where it is', () => {
  assert.equal(formatModelText('- uno\n\n  $$\n\n  c\n  $$\n- due'), '- uno\n\n  $$\n  c\n  $$\n- due');
  assert.equal(formatModelText('> Vale\n> $$\n>\n> c\n> $$'), '> Vale\n> $$\n> c\n> $$');
});

test('the correct drafts of 3f099707 and 7ee9e029, and the fix model\'s output of 7c33a051, are left as they are', () => {
  for (const name of ['3f099707-inline-in-list.md', '7ee9e029-clean.md', '7c33a051-display-after-list.md']) assert.equal(formatModelText(fixture(name)), fixture(name), name);
});

test('code fences, ::: blocks and an unclosed $$ are not touched', () => {
  const kept = '```\n$$\n\nx\n$$\n```\n\n:::hint\n$$\n\ny\n$$\n:::';
  assert.equal(formatModelText(kept), kept);
  const open = '$$ aperto senza chiusura\n\nCon $x$ e testo.';
  assert.equal(formatModelText(open), open);
});

test('tool-call markup goes, a function name KaTeX lacks is rewritten, and a formula key another section has is unwrapped', () => {
  assert.equal(formatModelText('Vale $\\cotan x$.\n</markdown>'), 'Vale $\\operatorname{cotan} x$.');
  assert.equal(formatModelText(':::formula{key="k" label="L"}\n$$a$$\n:::\n\nFine', { takenFormulaKeys: new Set(['k']) }), '$$a$$\n\nFine');
});

test('on a corpus: no word, number or formula changes, a second run changes nothing, and the lint finds nothing the formatter handles', () => {
  for (const md of CORPUS) {
    const out = formatModelText(md);
    assert.equal(formatModelText(out), out, `idempotent on ${JSON.stringify(md.slice(0, 40))}`);
    assert.equal(words(out), words(md.replace(/\s?<\/markdown>/, '').replace(/\\cotan x/, '\\operatorname{cotan} x')), `same words in ${JSON.stringify(md.slice(0, 40))}`);
    // The lint also reports headings and blank lines inside code and ::: blocks, which the formatter leaves alone on purpose.
    if (md.includes('aperto senza chiusura') || md.includes('```')) continue;
    const left = lintSection(out, { sectionId: 's', language: 'it' }).filter((f) => formatterHandles(f.rule, f.severity, 'section'));
    assert.deepEqual(left, [], `lint after the formatter on ${JSON.stringify(md.slice(0, 40))}`);
  }
});

test('formatterHandles: the math rules for every text, heading-level for sections, and never the compiler heading', () => {
  assert.ok(formatterHandles('math-mixed', 'minor', 'question'));
  assert.ok(formatterHandles('compile:math-blank-line', 'minor', 'section'));
  assert.ok(formatterHandles('heading-level', 'minor', 'section'));
  assert.ok(!formatterHandles('heading-level', 'blocker', 'section'));
  assert.ok(!formatterHandles('heading-level', 'minor', 'question'));
  assert.ok(!formatterHandles('katex', 'blocker', 'section'));
  assert.ok(!formatterHandles('literal-escape', 'blocker', 'section'));
});

test('question text keeps its headings and the lint still reports them', () => {
  const out = formatModelText('# Titolo\n\nTesto $x$ e $$y$$.', { kind: 'question' });
  assert.equal(out, '# Titolo\n\nTesto $x$ e\n\n$$\ny.\n$$');
  assert.equal(lintQuestionText(out, { file: 'statement', language: 'it' }).filter((f) => f.rule === 'heading-level').length, 1);
});

test('a heading-like line inside a longer fence is left alone', () => {
  const md = '~~~~\n~~~\n# literal\n~~~~\n\n# Titolo';
  assert.equal(formatModelText(md), '~~~~\n~~~\n# literal\n~~~~\n\n### Titolo');
});

const QUESTION_BLOCK = 'Si applica il teorema.\n\n:::formula{key="green-rettangolo" label="Teorema di Green"}\n$$\\oint_{\\partial R} F\\cdot d\\mathbf{r}=\\iint_R \\mathrm{rot}\\,F\\,dA$$\n:::\n\nQuindi $L=2$.';

test('a question loses the wrapper of every numbered formula block, whatever its key, and keeps the math', () => {
  const out = formatModelText(QUESTION_BLOCK, { kind: 'question' });
  assert.equal(out, 'Si applica il teorema.\n\n$$\\oint_{\\partial R} F\\cdot d\\mathbf{r}=\\iint_R \\mathrm{rot}\\,F\\,dA$$\n\nQuindi $L=2$.');
  assert.deepEqual(lintQuestionText(out, { file: 'solution', language: 'it' }).filter((f) => f.rule === 'formula-malformed'), []);
  assert.equal(formatModelText(out, { kind: 'question' }), out, 'a second run changes nothing');
  assert.equal(formatModelText('A\n\n:::formula{key="a" label="A"}\n$$x$$\n:::\n\nB\n\n:::formula{key="b" label="B"}\n$$y$$\n:::', { kind: 'question' }), 'A\n\n$$x$$\n\nB\n\n$$y$$');
});

test('a section keeps a formula block whose key no other section has', () => {
  assert.equal(formatModelText(QUESTION_BLOCK), QUESTION_BLOCK);
});

test('in a question the unwrap leaves code fences, other ::: blocks and blocks that are not one display formula alone', () => {
  const fenced = '```\n:::formula{key="k" label="L"}\n$$a$$\n:::\n```';
  assert.equal(formatModelText(fenced, { kind: 'question' }), fenced);
  const hint = ':::hint\nUsa $x$.\n:::';
  assert.equal(formatModelText(hint, { kind: 'question' }), hint);
  for (const bad of [':::formula{key="k" label="L"}\n$$a$$\n\nTesto accanto\n:::', ':::formula{key="k" label="L"}\n$$a$$ $$b$$\n:::', ':::formula{key="k" label="L"}\n$$a$$\n\nSenza chiusura', ':::formula{key="k" label="L"}\nx = 1\n:::']) {
    assert.equal(formatModelText(bad, { kind: 'question' }), bad, JSON.stringify(bad));
  }
});

test('formatForRules unwraps the blocks of a question for formula-malformed only, and formatterHandles says so', () => {
  assert.equal(formatForRules(QUESTION_BLOCK, ['compile:formula-malformed'], 'question'), formatModelText(QUESTION_BLOCK, { kind: 'question' }));
  assert.equal(formatForRules(QUESTION_BLOCK, ['formula-ref-unknown'], 'question'), QUESTION_BLOCK);
  assert.equal(formatForRules(QUESTION_BLOCK, ['formula-malformed']), QUESTION_BLOCK, 'a section is not touched');
  assert.ok(formatterHandles('compile:formula-malformed', 'blocker', 'question'));
  assert.ok(!formatterHandles('formula-malformed', 'blocker', 'section'));
  assert.ok(!formatterHandles('formula-ref-unknown', 'blocker', 'question'));
});
