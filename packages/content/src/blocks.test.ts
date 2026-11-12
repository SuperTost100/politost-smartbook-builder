import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figureNumber, imageFilename, joinBlocks, splitBlocks } from './blocks.ts';

const NESTED = `Testo introduttivo.

:::exercise{id="E1.1" chapter="1" difficulty="facile"}
## Domanda
Quanto vale $x$?

:::hint
Usa la formula.

:::solution
Annidato: la soluzione dentro il suggerimento.
:::
:::
:::

Dopo l'esercizio.`;

test('splitBlocks keeps nested exercise fences whole', () => {
  const blocks = splitBlocks(NESTED);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, 'paragraph');
  assert.equal(blocks[1].kind, 'other');
  assert.ok(blocks[1].text.startsWith(':::exercise'));
  assert.ok(blocks[1].text.trimEnd().endsWith(':::'));
  assert.ok(blocks[1].text.includes('\n\n:::hint'), 'blank lines inside the fence stay inside one block');
  assert.equal(blocks[2].text, "Dopo l'esercizio.");
});

test('splitBlocks classifies kinds', () => {
  const md = `### Titolo

Un paragrafo.

- uno
- due

$$
x = 1

+ y
$$

:::formula{key="a" label="A"}
$$a=b$$
:::

:::image{src="assets/a.png" alt="A"}
:::`;
  const kinds = splitBlocks(md).map((b) => b.kind);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'list', 'math', 'formula', 'image']);
});

test('display math with blank lines stays one block', () => {
  const blocks = splitBlocks('Prima.\n\n$$\na\n\nb\n$$\n\nDopo.');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].text, '$$\na\n\nb\n$$');
});

test('joinBlocks(splitBlocks(md)) normalizes only blank lines and line endings', () => {
  const messy = `Uno.\r\n\r\n\r\n\r\nDue.\n\n\n${NESTED}\n\n\n`;
  const round = joinBlocks(splitBlocks(messy));
  assert.equal(round, `Uno.\n\nDue.\n\n${NESTED}`);
  // idempotent
  assert.equal(joinBlocks(splitBlocks(round)), round);
});

test('empty input gives no blocks', () => {
  assert.deepEqual(splitBlocks(''), []);
  assert.equal(joinBlocks([]), '');
});

test('an unclosed $$ does not swallow the blocks after it', () => {
  const blocks = splitBlocks('Uno.\n\nDue $$ x^2\n\nTre.\n\nQuattro.');
  assert.deepEqual(blocks.map((b) => b.text), ['Uno.', 'Due $$ x^2', 'Tre.', 'Quattro.']);
  const lone = splitBlocks('Uno.\n\n$$\nx^2\n\nTre.\n\nQuattro.');
  assert.equal(lone.length, 4);
  assert.equal(splitBlocks('Uno.\n\n$$\nx^2\n\ny\n$$\n\nDue.').length, 3, 'a paired $$ keeps its blank line');
});

test('imageFilename reads the source of an image block whose alt text or caption holds a brace', () => {
  assert.equal(imageFilename(':::image{src="assets/x.png" alt="A"}\n:::'), 'x.png');
  assert.equal(imageFilename(':::image{alt="a } b" src="assets/x.png"}\n:::'), 'x.png');
  assert.equal(imageFilename(':::image{alt="Radius $r_{1}$" caption="Fig." src="assets/y-r1a2b3.svg"}\n:::'), 'y-r1a2b3.svg');
  assert.equal(imageFilename(':::image{alt="a } b"}\n:::'), null, 'a brace in a value is not a source');
  assert.equal(imageFilename(':::image{alt="src=\\"assets/x.png\\""}'), null);
  assert.equal(imageFilename('Some text with src="assets/x.png".'), null, 'only an image block has one');
});

test('figureNumber reads the number the compiler put in front of a caption, also after an alt text with a brace', () => {
  assert.equal(figureNumber(':::image{src="assets/x.png" alt="A" caption="Fig. 4.3 — Un cerchio"}'), '4.3');
  assert.equal(figureNumber(':::image{alt="f(x) = a_{1}" src="assets/x.png" caption="Figura 2: Un cerchio"}'), '2');
  assert.equal(figureNumber(':::image{src="assets/x.png" alt="A" caption="Un cerchio"}'), null);
  assert.equal(figureNumber(null), null);
});
