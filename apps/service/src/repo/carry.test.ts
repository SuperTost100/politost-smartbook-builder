import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryCitations } from './content.ts';

const old = 'Uno.\n\nDue.\n\nTre.';
const cit = { '0': ['n1'], '1': ['n2'], '2': ['n3'] };

test('unchanged text keeps citations', () => assert.deepEqual(carryCitations(old, old, cit), cit));
test('editing one block keeps every citation in place', () =>
  assert.deepEqual(carryCitations(old, 'Uno.\n\nDue, corretto.\n\nTre.', cit), cit));
test('deleting a block does not shift the others', () =>
  assert.deepEqual(carryCitations(old, 'Uno.\n\nTre.', cit), { '0': ['n1'], '1': ['n3'] }));
test('inserting a block leaves the new one uncited', () =>
  assert.deepEqual(carryCitations(old, 'Uno.\n\nNuovo.\n\nDue.\n\nTre.', cit), { '0': ['n1'], '2': ['n2'], '3': ['n3'] }));
test('editing the first block into a copy of the second keeps the unchanged second block\'s citation (A/B/C -> B/B/C)', () => {
  const out = carryCitations('A.\n\nB.\n\nC.', 'B.\n\nB.\n\nC.', cit);
  assert.deepEqual(out, { '0': ['n1'], '1': ['n2'], '2': ['n3'] });
});
test('a duplicate added after an existing block does not take its citation', () =>
  assert.deepEqual(carryCitations('A.\n\nB.', 'A.\n\nB.\n\nB.', { '0': ['n1'], '1': ['n2'] }), { '0': ['n1'], '1': ['n2'] }));
test('blocks that moved keep the citation of the one that stays in order', () =>
  assert.deepEqual(carryCitations('Uno.\n\nDue.\n\nTre.', 'Tre.\n\nUno.\n\nDue.', cit), { '1': ['n1'], '2': ['n2'] }));
test('an edited block between unchanged ones inherits its old position, even when blocks were added around it', () =>
  assert.deepEqual(carryCitations(old, 'Prima.\n\nUno.\n\nDue, corretto.\n\nTre.\n\nDopo.', cit), { '1': ['n1'], '2': ['n2'], '3': ['n3'] }));
test('two edited blocks in a row are paired in order; extra new ones stay uncited', () =>
  assert.deepEqual(carryCitations(old, 'Uno.\n\nX.\n\nY.\n\nZ.\n\nTre.', cit), { '0': ['n1'], '1': ['n2'], '4': ['n3'] }));
test('a very long text is still handled', () => {
  const many = Array.from({ length: 3000 }, (_, i) => `Blocco ${i}.`);
  const c = Object.fromEntries(many.map((_, i) => [String(i), [`n${i}`]]));
  const edited = [...many]; edited[1500] = 'Modificato.'; edited.splice(10, 0, 'Nuovo.');
  const out = carryCitations(many.join('\n\n'), edited.join('\n\n'), c);
  assert.deepEqual(out['11'], ['n10']);
  assert.deepEqual(out['1501'], ['n1500']);
});
