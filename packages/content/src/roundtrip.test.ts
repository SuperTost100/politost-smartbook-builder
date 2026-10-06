import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseChapterFrontmatter, parseChapterMarkdown, parseExercises, validateExercises } from '@politost/content-core';
import { compileBook } from './compile.ts';
import { decompileChapter } from './decompile.ts';
import { packPtsb, readBackPtsb } from './ptsb.ts';
import type { BookInput, ChapterInput } from './types.ts';

const BASE = new URL('./testdata/esempio/', import.meta.url).pathname;
const read = (p: string) => readFileSync(`${BASE}${p}`, 'utf8');

interface SmartbookJson { id: string; title: string; subject: string; chapters: { id: string; number: number; title: string; file: string }[] }
const cfg = JSON.parse(read('smartbook.json')) as SmartbookJson;

function sourceFromReader(): BookInput {
  const chapters: ChapterInput[] = cfg.chapters.map((c) => {
    const raw = read(`chapters/${c.file}`);
    const d = decompileChapter(raw, c.number);
    assert.equal(d.intro, '');
    return { id: c.id, slug: c.id, number: c.number, title: c.title, intro: d.intro, sections: d.sections };
  });
  return {
    meta: { slug: cfg.id, title: cfg.title, subject: cfg.subject, authors: [], language: 'it', version: '1.0.0' },
    chapters,
    questions: [],
    enrichments: [],
    assets: readdirSync(`${BASE}assets`).map((f) => ({ filename: f, bytes: new Uint8Array(readFileSync(`${BASE}assets/${f}`)) })),
    sections: { esercizi: false, esami: false, ide: false, grafici: false },
  };
}

test('decompileChapter turns ids into keys and refs into section ids', () => {
  const d = decompileChapter(read('chapters/02-nel-libro.md'), 2);
  assert.deepEqual(d.sections.map((s) => [s.id, s.title]), [['s-2-1', 'Testo e formule'], ['s-2-2', 'Immagini e figure'], ['s-2-3', 'Collegamenti tra le parti']]);
  assert.ok(d.sections[0].markdown.includes(':::formula{key="f-2-1" label="Velocità media"}'));
  assert.ok(d.sections[0].markdown.includes('{{formula:@f-2-1}}'));
  assert.ok(d.sections[0].markdown.includes('[formulario](ref:formula/@f-2-1)'));
  assert.ok(d.sections[2].markdown.includes('(ref:section/s-1-2)'));
  assert.ok(d.sections[2].markdown.includes('(ref:section/s-3-1)'));
  assert.ok(!d.sections.some((s) => /id="|ref:chapter/.test(s.markdown)));
});

test('decompileChapter keeps prose before the first heading as the intro', () => {
  const d = decompileChapter('---\nchapter: 1\ntitle: T\n---\n\nPrologo con {{formula:1.1}}.\n\n## p1 | A\n\nCorpo.\n', 1);
  assert.equal(d.intro, 'Prologo con {{formula:@f-1-1}}.');
  assert.equal(d.sections.length, 1);
});

test('compile(decompile(esempio)) equals the original chapters semantically', () => {
  const book = compileBook(sourceFromReader());
  assert.deepEqual(book.findings.filter((f) => f.severity === 'blocker'), [], JSON.stringify(book.findings, null, 1));
  for (const c of cfg.chapters) {
    const orig = read(`chapters/${c.file}`);
    const got = book.files[`chapters/${c.file}`];
    assert.equal(typeof got, 'string', `chapters/${c.file} compiled`);
    const a = parseChapterMarkdown(orig, c.number);
    const b = parseChapterMarkdown(got as string, c.number);
    assert.deepEqual(b.paragraphs, a.paragraphs, `${c.file}: paragraphs (id, title, content)`);
    assert.deepEqual(b.formulas, a.formulas, `${c.file}: formulas (id, label, latex)`);
    const fa = parseChapterFrontmatter(orig);
    const fb = parseChapterFrontmatter(got as string);
    assert.deepEqual([fb.chapterNumber, fb.title], [fa.chapterNumber, fa.title]);
    // Same text, in fact, apart from blank-line layout.
    assert.equal((got as string).replace(/\n{2,}/g, '\n\n').trim(), orig.replace(/\n{2,}/g, '\n\n').trim());
  }
  assert.deepEqual(Object.keys(book.formulaNumbers).sort(), ['f-2-1', 'f-2-2', 'f-3-1']);
  assert.equal(book.formulaNumbers['f-2-2'], '2.2');
});

test('the compiled esempio packs and reads back', () => {
  const book = compileBook(sourceFromReader());
  const r = readBackPtsb(packPtsb(book, { createdAt: '2026-01-01T00:00:00Z' }), book);
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

test('esempio exercises parse and validate (reference for the compiler output format)', () => {
  assert.equal(validateExercises(read('esercizi.md'), 'esercizi').valid, true);
  assert.equal(validateExercises(read('esami.md'), 'esami').valid, true);
  assert.equal(parseExercises(read('esami.md'), 'esame')[0].question.split('\n')[0], '**Simulazione — Esercizio unico**');
});
