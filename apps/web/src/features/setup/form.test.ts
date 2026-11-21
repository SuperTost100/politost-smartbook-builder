import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookOptions } from '@smartbuilder/domain';
import { changedFields, splitAuthors, wholeNumberIn, type SetupValues } from './form.ts';

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
