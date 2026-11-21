import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revealDelta } from './reveal.ts';

const band = { top: 73, bottom: 834 };

test('a box already inside the clear band does not scroll', () => {
  assert.equal(revealDelta({ top: 100, bottom: 800 }, band), 0);
  assert.equal(revealDelta({ top: 73, bottom: 834 }, band), 0);
});

test('a box below the band scrolls only until its bottom clears the toasts', () => {
  assert.equal(revealDelta({ top: 841, bottom: 951 }, band), 117);
});

test('a box taller than the band keeps its top below the header', () => {
  assert.equal(revealDelta({ top: 400, bottom: 1400 }, band), 327);
});

test('a box above the band scrolls up to just under the header', () => {
  assert.equal(revealDelta({ top: 20, bottom: 130 }, band), -53);
});
