import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookOptions } from '@smartbuilder/domain';
import { changedFields, compareStored, splitAuthors, wholeNumberIn, withFields, withoutFields, type SetupValues } from './form.ts';

test('a number field takes whole numbers in its range and refuses the rest', () => {
  assert.equal(wholeNumberIn('3', 1, 5), 3);
  assert.equal(wholeNumberIn('1', 1, 5), 1);
  assert.equal(wholeNumberIn('5', 1, 5), 5);
  for (const text of ['', ' ', '2.5', '2,5', '0', '6', '-1', 'tre', '1e1']) assert.equal(wholeNumberIn(text, 1, 5), null, JSON.stringify(text));
});

const options = { outsideMaterial: false, ide: true, labLanguage: 'python', graphs: true, figures: true, firstChapterGate: true, outlineGate: true, exercisesPerTopic: 3, exercisesPerHotTopic: 6, chapterScope: [], offProgram: 'delete', noClaudeFallback: false, selfCheck: true, reviewSamples: 2, figurePolicy: 'helpful', circuitSymbols: 'american' } satisfies BookOptions;
const book: SetupValues = { title: 'Analisi 1', subject: 'Analisi', slug: 'analisi-1', authors: ['A'], language: 'it', audience: 'Primo anno', goals: 'Esame', options };

test('a form sends only what the author changed in it', () => {
  assert.deepEqual(changedFields(book, book), {});
  assert.deepEqual(changedFields(book, { ...book, audience: 'Primo anno TEST' }), { audience: 'Primo anno TEST' });
  assert.deepEqual(changedFields(book, { ...book, options: { ...options, reviewSamples: 3 } }), { options: { reviewSamples: 3 } });
  assert.deepEqual(changedFields(book, { ...book, authors: ['A', 'B'], options: { ...options, chapterScope: ['c1'] } }), { authors: ['A', 'B'], options: { chapterScope: ['c1'] } });
});

test('going back to an automatic area is sent as null, and an area left alone is not sent', () => {
  const pinned = { ...book, options: { ...options, subjectArea: 'physics' as const } };
  assert.deepEqual(changedFields(pinned, book), { options: { subjectArea: null } });
  assert.deepEqual(changedFields(book, pinned), { options: { subjectArea: 'physics' } });
  assert.deepEqual(changedFields(pinned, pinned), {});
});

test('authors are compared as the form saves them, so a stored name with a comma is not sent when the field is left alone', () => {
  const stored = splitAuthors(['Doe, Jane', 'Rossi'].join(', '));
  assert.deepEqual(stored, ['Doe', 'Jane', 'Rossi']);
  const loaded = { ...book, authors: stored };
  assert.deepEqual(changedFields(loaded, { ...loaded, authors: splitAuthors('Doe, Jane, Rossi') }), {});
  assert.deepEqual(splitAuthors(' Ada ;\nBea,, '), ['Ada', 'Bea']);
});

test('a field this form changed that was saved elsewhere since is stale; other fields saved elsewhere are refreshed', () => {
  const stored = { ...book, audience: 'Secondo tab', goals: 'Orale', options: { ...options, reviewSamples: 4 } };
  const patch = changedFields(book, { ...book, audience: 'Primo tab', title: 'Analisi I' });
  const { stale, refreshed } = compareStored(book, stored, patch);
  assert.deepEqual(stale, [{ key: 'audience', stored: 'Secondo tab', mine: 'Primo tab' }]);
  assert.deepEqual(refreshed.sort(), ['goals', 'options.reviewSamples']);
  assert.deepEqual(compareStored(book, book, patch), { stale: [], settled: [], refreshed: [] });
});

test('an option this form changed and another tab changed too is stale, and an area cleared elsewhere counts', () => {
  const pinned = { ...book, options: { ...options, subjectArea: 'physics' as const } };
  const patch = changedFields(pinned, { ...pinned, options: { ...options, subjectArea: 'chemistry' } });
  assert.deepEqual(compareStored(pinned, book, patch).stale, [{ key: 'options.subjectArea', stored: undefined, mine: 'chemistry' }]);
});

test('withFields takes only the named fields', () => {
  const stored = { ...book, audience: 'B', options: { ...options, ide: false } };
  const next = withFields(book, stored, ['options.ide']);
  assert.equal(next.audience, 'Primo anno');
  assert.equal(next.options.ide, false);
  assert.equal(book.options.ide, true, 'the base is not changed');
});

test('a field both tabs saved with the same value is no conflict, and it is not sent again', () => {
  const stored = { ...book, audience: 'identical again', options: { ...options, ide: false } };
  const patch = changedFields(book, { ...book, audience: 'identical again', goals: 'Orale', options: { ...options, ide: false } });
  const { stale, settled, refreshed } = compareStored(book, stored, patch);
  assert.deepEqual(stale, []);
  assert.deepEqual(settled.sort(), ['audience', 'options.ide']);
  assert.deepEqual(refreshed, []);
  assert.deepEqual(withoutFields(patch, settled), { goals: 'Orale' });
});

test('after a save the saved book is the baseline, so the next edit of the same field is no conflict', () => {
  const saved = { ...book, goals: 'Primo salvataggio' };
  const patch = changedFields(saved, { ...saved, goals: 'Secondo salvataggio' });
  assert.deepEqual(compareStored(saved, saved, patch).stale, []);
  // The baseline from before the save is what made the false conflict.
  assert.deepEqual(compareStored(book, saved, patch).stale.map((f) => f.key), ['goals']);
});

test('an area cleared to Automatic in both tabs is settled', () => {
  const pinned = { ...book, options: { ...options, subjectArea: 'physics' as const } };
  const patch = changedFields(pinned, book);
  assert.deepEqual(compareStored(pinned, book, patch).settled, ['options.subjectArea']);
  assert.deepEqual(withoutFields(patch, ['options.subjectArea']), {});
});
