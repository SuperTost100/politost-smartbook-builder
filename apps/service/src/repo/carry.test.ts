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
