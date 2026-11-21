import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTitle } from './format.ts';

test('a review run is named for what it was started for', () => {
  assert.equal(runTitle({ kind: 'review', reviewScope: { mode: 'changed' } }), 'Reviewing');
  assert.equal(runTitle({ kind: 'review', reviewScope: { mode: 'sweep' } }), 'Reviewing and sweeping');
  assert.equal(runTitle({ kind: 'review', reviewScope: { mode: 'full' } }), 'Full review');
  assert.equal(runTitle({ kind: 'review', reviewScope: { mode: 'recheck' } }), 'Second opinion');
  assert.equal(runTitle({ kind: 'review', reviewScope: { exercises: 1 } }), 'Checking 1 exercise');
  assert.equal(runTitle({ kind: 'review', reviewScope: { exercises: 12 } }), 'Checking 12 exercises');
});

test('a run without a recorded scope keeps the name of its kind', () => {
  assert.equal(runTitle({ kind: 'review', reviewScope: null }), 'Reviewing');
  assert.equal(runTitle({ kind: 'review' }), 'Reviewing');
  assert.equal(runTitle({ kind: 'generate', reviewScope: null }), 'Drafting');
});
