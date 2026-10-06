import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinBlocks, splitBlocks } from './blocks.ts';

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
