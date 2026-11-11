// Exam splitting for papers of any course: headings, dates, solutions, and the real Analisi files staying as they were.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildAiSplit, summarizeSplit } from '../pipeline/examSplit.ts';
import { extractResource, segmentQuestions, splitQuestions, storeResource } from './index.ts';
import { splitMarkdown } from './markdown.ts';
import { findDate, isSolutionMarker, plainLines, segmentExams, splitExams } from './segment.ts';
import { makeCtx } from './testkit.ts';
import { seedPage, seedResource } from '../llm/testkit.ts';

const pages = (...texts: string[][]) => texts.map((lines, idx) => ({ idx, text: lines.join('\n') }));
const summary = (rows: ReturnType<typeof segmentExams>) => rows.map((r) => `${r.examGroup} #${r.number} ${r.examDate} p${r.pageFrom}-${r.pageTo}`);

// An Elettrotecnica paper of the Politecnico kind: a header table of name, matricola and date, then problems with sub-questions.
const ELETTROTECNICA = pages(
  [
    'Politecnico di Torino', 'Corso di Laurea in Ingegneria Elettronica', 'ELETTROTECNICA', 'Appello del 12 febbraio 2024',
    'Cognome e nome:', 'Matricola:', 'Data:', '12/02/2024',
    'Problema 1 (10 punti)', 'Il circuito in figura è in regime stazionario. R1 = 10 Ω, R2 = 20 Ω, E = 12 V.',
    'a) Calcolare la corrente in R2.', 'b) Calcolare la potenza erogata dal generatore.', 'c) Determinare il circuito equivalente di Thévenin ai morsetti A-B.',
  ],
  [
    'Problema 2 (12 punti)', 'Un circuito RLC serie è alimentato da e(t) = 10 cos(1000 t) V.',
    'a) Calcolare l’impedenza equivalente.', 'b) Determinare la corrente a regime.',
    'Problema 3 (10 punti)', 'Un trasformatore ideale ha rapporto spire 1:4.', 'a) Calcolare la tensione al secondario.',
  ],
  [
    'Politecnico di Torino', 'ELETTROTECNICA', 'Appello del 5 luglio 2024', 'Cognome e nome:', 'Matricola:', 'Data:', '05/07/2024',
    'Problema 1 (14 punti)', 'Il bipolo in figura è formato da un induttore e da un resistore.', 'a) Scrivere l’equazione di stato.', 'b) Calcolare l’energia immagazzinata.',
    'Problema 2 (16 punti)', 'Un amplificatore operazionale ideale in configurazione invertente.', 'a) Calcolare il guadagno.',
  ],
);

test('Elettrotecnica: "Appello del <data>" sessions, "Problema N" exercises, sub-questions a) b) c) stay inside their exercise', () => {
  const rows = segmentExams('r1', ELETTROTECNICA, { label: 'esami-elettrotecnica', untitled: true });
  assert.deepEqual(summary(rows), [
    'Appello del 12 febbraio 2024 #1 2024-02-12 p0-0', 'Appello del 12 febbraio 2024 #2 2024-02-12 p1-1', 'Appello del 12 febbraio 2024 #3 2024-02-12 p1-1',
    'Appello del 5 luglio 2024 #1 2024-07-05 p2-2', 'Appello del 5 luglio 2024 #2 2024-07-05 p2-2',
  ]);
  assert.match(rows[0].statement, /^Problema 1 \(10 punti\)\n.*\na\) Calcolare la corrente in R2\.\nb\) .*\nc\) Determinare il circuito equivalente/s);
  assert.doesNotMatch(rows[0].statement, /Problema 2|Cognome|Matricola/);
  assert.match(rows[1].statement, /a\) Calcolare l’impedenza equivalente\.\nb\) Determinare la corrente a regime\.$/);
  assert.equal(splitExams('r1', ELETTROTECNICA, { label: 'x', untitled: true }).noHeading, false);
});

test('a paper whose heading has no date takes it from the header table ("Data" then the value)', () => {
  const rows = segmentExams('r1', pages([
    'Prova scritta di Elettrotecnica', 'Cognome e nome', 'Matricola', 'Data', '12 febbraio 2024',
    'Problema 1', 'Un circuito con due maglie.', 'a) Scrivere le equazioni.', 'Problema 2', 'Un doppio bipolo.',
  ]), { label: 'x', untitled: true });
  assert.deepEqual(summary(rows), ['Prova scritta del 12 febbraio 2024 #1 2024-02-12 p0-0', 'Prova scritta del 12 febbraio 2024 #2 2024-02-12 p0-0']);
});

test('multiple choice "Quesito N" with options A) to D): the options stay in the question; "Esame di <any course>" names the session', () => {
  const rows = segmentExams('r1', pages(
    ['Esame di ELETTRONICA DIGITALE', 'Test del 14/06/2024', 'Quesito 1', 'Quale porta logica realizza Y = A·B?', 'A) AND', 'B) OR', 'C) NAND', 'D) XOR', 'Quesito 2', 'Un flip-flop D campiona il dato sul fronte:', 'A) di salita', 'B) di discesa'],
    ['Quesito 3', 'Quanti bit servono per 20 livelli?', 'A) 4', 'B) 5', 'C) 6', 'D) 20'],
  ), { label: 'x', untitled: true });
  assert.deepEqual(summary(rows), ['Esame del 14 giugno 2024 #1 2024-06-14 p0-0', 'Esame del 14 giugno 2024 #2 2024-06-14 p0-0', 'Esame del 14 giugno 2024 #3 2024-06-14 p1-1']);
  assert.match(rows[0].statement, /A\) AND\nB\) OR\nC\) NAND\nD\) XOR$/);
  assert.match(rows[2].statement, /D\) 20$/);
});

test('a paper with problems and questions keeps the word in the number, so "1" is not used twice', () => {
  const rows = segmentExams('r1', pages([
    'Appello del 10/09/2024', 'Problema 1', 'Circuito in regime sinusoidale.', 'Problema 2', 'Doppio bipolo.', 'Quesito 1', 'Vero o falso?', 'Quesito 2', 'Calcolare R.',
  ]), { label: 'x', untitled: true });
  assert.deepEqual(rows.map((r) => r.number), ['Problema 1', 'Problema 2', 'Quesito 1', 'Quesito 2']);
});

test('a course outside electronics: "Tema d\'esame", lower case, colon and full stop after the exercise word, letters', () => {
  const rows = segmentExams('r1', pages(
    ['Tema d’esame 21 giugno 2023', 'Chimica', 'Domanda 1:', 'Bilanciare la reazione.', 'domanda 2.', 'Calcolare il pH di una soluzione 0,1 M.', 'PROBLEMA 3', 'Un gas a 300 K.'],
    ['Compito di chimica generale', '2023-09-08', 'Parte A', 'Cinetica.', 'parte b:', 'Equilibrio.'],
  ), { label: 'x', untitled: true });
  assert.deepEqual(summary(rows), [
    "Tema d'esame del 21 giugno 2023 #1 2023-06-21 p0-0", "Tema d'esame del 21 giugno 2023 #2 2023-06-21 p0-0", "Tema d'esame del 21 giugno 2023 #3 2023-06-21 p0-0",
    'Compito del 8 settembre 2023 #A 2023-09-08 p1-1', 'Compito del 8 settembre 2023 #B 2023-09-08 p1-1',
  ]);
});

test('findDate reads the usual Italian forms and refuses impossible dates', () => {
  const d = (t: string) => { const x = findDate(t); return x ? `${x.y}-${x.m}-${x.d}` : null; };
  assert.equal(d('Appello 12/02/2024'), '2024-2-12');
  assert.equal(d('12 febbraio 2024'), '2024-2-12');
  assert.equal(d('2024-02-12'), '2024-2-12');
  assert.equal(d('1° marzo 2024'), '2024-3-1');
  assert.equal(d('12.02.24'), '2024-2-12');
  assert.equal(d('12-2-2024'), '2024-2-12');
  assert.equal(d('31/13/2024'), null);
  assert.equal(d('Esercizio 12, versione 2024'), null);
});

test('exercise words: prose that starts like a heading is not one', () => {
  const rows = segmentExams('r1', pages([
    'Appello del 12/02/2024', 'Problema 1', 'Il condensatore è carico.', 'parte a destra della figura è collegata a massa.', 'Domanda a scelta multipla senza numero.', 'Problema 2', 'Fine.',
  ]), { label: 'x', untitled: true });
  assert.deepEqual(rows.map((r) => r.number), ['1', '2']);
  assert.match(rows[0].statement, /parte a destra della figura è collegata a massa\.\nDomanda a scelta/);
  // A sentence starting with "Compito" is no session heading when no date or exercise follows it.
  assert.equal(splitExams('r1', pages(['Compito di casa: leggere il capitolo.', 'Fine.']), { label: 'x', untitled: true }).noHeading, true);
});

test('solutions headed Soluzione, Soluzioni, Svolgimento, Risoluzione or "Soluzione del problema N" are matched to their exercise', () => {
  const rows = segmentExams('r1', pages(
    ['Appello del 12/02/2024', 'Problema 1', 'Testo uno.', 'Problema 2', 'Testo due.', 'Problema 3', 'Testo tre.', 'Quesito 1', 'Testo quesito.'],
    ['Soluzioni', 'Problema 1', 'Si applica Kirchhoff.', 'Problema 2', 'Si usa Thévenin.'],
    ['Soluzione del problema 3', 'Si usa la sovrapposizione.', 'Svolgimento', 'Quesito 1', 'Risposta B.'],
  ), { label: 'x', untitled: true });
  assert.deepEqual(rows.map((r) => [r.number, r.solution.split('\n').at(-1)]), [
    ['Problema 1', 'Si applica Kirchhoff.'], ['Problema 2', 'Si usa Thévenin.'], ['Problema 3', 'Si usa la sovrapposizione.'], ['Quesito 1', 'Risposta B.'],
  ]);
  assert.ok(rows.every((r) => !/Soluzion|Svolgimento/.test(r.statement)));
  // "Soluzione 2": only the number.
  const n = segmentExams('r2', pages(['Appello del 12/02/2024', 'Esercizio 1', 'Uno.', 'Esercizio 2', 'Due.', 'Soluzione 2', 'Risposta due.']), { label: 'x', untitled: true });
  assert.deepEqual(n.map((r) => r.solution), ['', 'Soluzione 2\nRisposta due.']);
});

test('a heading repeated at the top of later pages is a running header; numbering that starts again is a second copy', () => {
  const header = 'Appello del 12/02/2024 - Elettrotecnica';
  const one = segmentExams('r1', pages(
    [header, 'Problema 1', 'Uno.'], [header, 'Seguito dell’uno.', 'Problema 2', 'Due.'], [header, 'Problema 3', 'Tre.'],
  ), { label: 'x', untitled: true });
  assert.deepEqual(summary(one), ['Appello del 12 febbraio 2024 #1 2024-02-12 p0-1', 'Appello del 12 febbraio 2024 #2 2024-02-12 p1-1', 'Appello del 12 febbraio 2024 #3 2024-02-12 p2-2']);
  const two = segmentExams('r2', pages(
    [header, 'Problema 1', 'Uno A.', 'Problema 2', 'Due A.'], [header, 'Problema 1', 'Uno B.', 'Problema 2', 'Due B.'],
  ), { label: 'x', untitled: true });
  assert.deepEqual(two.map((r) => `${r.examGroup} #${r.number}`), [
    'Appello del 12 febbraio 2024 - versione 1 #1', 'Appello del 12 febbraio 2024 - versione 1 #2', 'Appello del 12 febbraio 2024 - versione 2 #1', 'Appello del 12 febbraio 2024 - versione 2 #2',
  ]);
});

test('an exercise that continues on the next page under a repeated header is one question, not a second copy of the paper', () => {
  const header = 'Appello del 12 febbraio 2024';
  const rows = segmentExams('r1', pages(
    [header, 'Esercizio 1', 'Uno.', 'Esercizio 2', 'Due, prima parte.'],
    [header, 'Esercizio 2', 'Due, seguito.', 'Esercizio 3', 'Tre.'],
  ), { label: 'x', untitled: true });
  assert.deepEqual(summary(rows), [
    'Appello del 12 febbraio 2024 #1 2024-02-12 p0-0', 'Appello del 12 febbraio 2024 #2 2024-02-12 p0-1', 'Appello del 12 febbraio 2024 #3 2024-02-12 p1-1',
  ]);
  assert.match(rows[1].statement, /Due, prima parte\.\nDue, seguito\./);
  // Numbering that starts again from the first exercise is still a second copy.
  const copies = segmentExams('r2', pages(
    [header, 'Esercizio 1', 'Uno A.', 'Esercizio 2', 'Due A.'], [header, 'Esercizio 1', 'Uno B.', 'Esercizio 2', 'Due B.'],
  ), { label: 'x', untitled: true });
  assert.deepEqual(copies.map((r) => `${r.examGroup} #${r.number}`), [
    'Appello del 12 febbraio 2024 - versione 1 #1', 'Appello del 12 febbraio 2024 - versione 1 #2', 'Appello del 12 febbraio 2024 - versione 2 #1', 'Appello del 12 febbraio 2024 - versione 2 #2',
  ]);
});

test('"Compito FILA A" under a heading with a date is the version of that paper, not another session', () => {
  const rows = segmentExams('r1', pages(['Appello del 12/02/2024', 'Compito FILA A', 'Esercizio 1', 'Uno.']), { label: 'x', untitled: true });
  assert.deepEqual(rows.map((r) => `${r.examGroup} #${r.number}`), ['Appello del 12 febbraio 2024 #1']);
  const own = segmentExams('r2', pages(['Compito B - 12/02/2024', 'Esercizio 1', 'Uno.']), { label: 'x', untitled: true });
  assert.deepEqual(own.map((r) => `${r.examGroup} #${r.number}`), ['Compito del 12 febbraio 2024 #1B']);
});

// One row per heading form the splitter supports: [heading line, lines after it, lines before it, the date as the model would report it].
const HEADING_FORMS: [string, string[], string[], string][] = [
  ['Esame del 12 febbraio 2024', [], [], '2024-02-12'],
  ['Esame del 12 febbraio 2024 - Turno A', [], [], '2024-02-12'],
  ['3 Esame del 12 febbraio 2024', [], [], '2024-02-12'],
  ['Esame di ANALISI MATEMATICA I 12/02/2024 - Turno B', [], [], '2024-02-12'],
  ['Esame di Elettronica digitale', ['Data: 12/02/2024'], [], '2024-02-12'],
  ['Esame di Elettronica digitale del 12/02/2024', [], [], '2024-02-12'],
  ['Appello del 2024-02-12', [], [], '2024-02-12'],
  ['Appello del 12 febbraio 2024', [], [], '2024-02-12'],
  ['Appello del 12 febbraio 2024 - Turno A', [], [], '2024-02-12'],
  ['Appello del 12.02.24', [], [], '2024-02-12'],
  ['Appello 12-2-2024 (secondo turno)', [], [], '2024-02-12'],
  ['Appello', ['Cognome e nome:', 'Matricola:', 'Data:', '12 febbraio 2024'], [], '2024-02-12'],
  ['Appello', [], ['12/02/2024'], '2024-02-12'],
  ['Compito del 1° marzo 2024', [], [], '2024-03-01'],
  ['Compito FILA A - 12/02/2024', [], [], '2024-02-12'],
  ['Compito A', ['12/02/2024'], [], '2024-02-12'],
  ["Tema d'esame del 12/02/2024", [], [], '2024-02-12'],
  ['Tema d’esame 2024-02-12 - Gruppo 2', [], [], '2024-02-12'],
  ['Prova scritta 23/06/2022 - Corso di Fisica - Prof. Rossi', [], [], '2022-06-23'],
  ['Prova scritta 12.02.24', [], [], '2024-02-12'],
  ['Prova scritta del 12 febbraio 2024', [], [], '2024-02-12'],
  ['Prova scritta del 2024-02-12', [], [], '2024-02-12'],
  ['Prova scritta', ['Data: 12/02/2024'], [], '2024-02-12'],
];

test('a session has the same name from the text rules and from the AI split, for every heading form', () => {
  for (const [heading, after, before, date] of HEADING_FORMS) {
    const lines = [...before, heading, ...after, 'Esercizio 1', 'Uno.'];
    const text = pages(lines);
    const rules = splitExams('r', text, { label: 'file', untitled: true }).rows;
    assert.equal(rules.length, 1, `${heading}: the rules find one question`);
    const ai = buildAiSplit('r', text, { sessions: [{ title: heading, date, page: 1, start: heading, exercises: [{ number: '1', page: 1, start: 'Esercizio 1' }] }] }, 'file');
    assert.ok('rows' in ai, `${heading}: the AI split is accepted`);
    assert.equal(ai.rows[0].examGroup, rules[0].examGroup, heading);
    assert.equal(ai.rows[0].examDate, rules[0].examDate, `${heading}: date`);
    assert.equal(rules[0].examDate, date, `${heading}: the rules read the date`);
  }
});

// ---------- warnings ----------

const rowsOf = (n: Record<string, number>) => Object.entries(n).flatMap(([group, count]) => Array.from({ length: count }, (_, i) => ({ examGroup: group, number: String(i + 1) }))) as never;

test('summarizeSplit: nothing found, no heading, one question per session, and a good split', () => {
  assert.deepEqual(summarizeSplit([], false), { sessions: 0, questions: 0, warning: 'no_questions' });
  assert.deepEqual(summarizeSplit([], true), { sessions: 0, questions: 0, warning: 'no_questions' });
  assert.deepEqual(summarizeSplit(rowsOf({ 'esami-2024': 4 }), true), { sessions: 1, questions: 4, warning: 'no_heading' });
  assert.deepEqual(summarizeSplit(rowsOf({ A: 1, B: 1, C: 1 }), false), { sessions: 3, questions: 3, warning: 'thin_sessions' });
  assert.deepEqual(summarizeSplit(rowsOf({ A: 1 }), false), { sessions: 1, questions: 1, warning: 'thin_sessions' });
  assert.deepEqual(summarizeSplit(rowsOf({ A: 2, B: 3 }), false), { sessions: 2, questions: 5, warning: null });
  assert.deepEqual(summarizeSplit(rowsOf({ A: 1, B: 2 }), false), { sessions: 2, questions: 3, warning: null });
});

test('splitQuestions: an exam file with unknown headings is reported as "no heading", one with no exercises as "no questions"', () => {
  const { ctx, projectId } = makeCtx();
  seedResource(ctx, { id: 'weird', projectId, role: 'exams', filename: 'esami-2024.pdf' });
  seedPage(ctx, 'weird', 0, ['Sessione invernale', 'Esercizio 1', 'Uno.', 'Esercizio 2', 'Due.'].join('\n'));
  const weird = splitQuestions(ctx, 'weird');
  assert.deepEqual([weird.rows.length, weird.noHeading, summarizeSplit(weird.rows, weird.noHeading).warning], [2, true, 'no_heading']);
  seedResource(ctx, { id: 'blank', projectId, role: 'exams', filename: 'scansione.pdf' });
  seedPage(ctx, 'blank', 0, 'Testo senza alcuna intestazione riconoscibile.');
  const blank = splitQuestions(ctx, 'blank');
  assert.deepEqual([blank.rows.length, summarizeSplit(blank.rows, blank.noHeading).warning], [0, 'no_questions']);
});

// ---------- a Markdown exam file (acceptance run, 11 November 2026) ----------

// Two Elettrotecnica papers written in Markdown: a header table with pipes, "**Problema 1**" in bold and "**Soluzioni (Appello del …)**" after each paper.
const MARKDOWN_EXAMS = readFileSync(new URL('./testdata/appelli-elettrotecnica-2024.md', import.meta.url), 'utf8');
const markdownPages = () => splitMarkdown(MARKDOWN_EXAMS, 'appelli').units.map((u, idx) => ({ idx, text: u.text }));

test('a Markdown exam file: bold exercise headings and a header table with pipes still give the two sessions and their problems', () => {
  const split = splitExams('r', markdownPages(), { label: 'appelli-elettrotecnica-2024', untitled: true });
  assert.equal(split.noHeading, false);
  const sessions = new Map<string, string[]>();
  for (const r of split.rows) sessions.set(r.examGroup!, [...(sessions.get(r.examGroup!) ?? []), `${r.number}:${r.examDate}`]);
  assert.deepEqual([...sessions.keys()], ['Prova scritta del 12 febbraio 2024', 'Prova scritta del 3 luglio 2024']);
  assert.deepEqual(split.rows.slice(0, 2).map((r) => r.number), ['1', '2']);
  assert.match(split.rows[0].statement, /^Problema 1 \(12 punti\)\n+Un generatore di tensione continua/);
  assert.doesNotMatch(split.rows[0].statement, /\*\*|\|/);
  assert.equal(split.rows[0].examDate, '2024-02-12');
});

test('Markdown marks: heading marks, bold, italics and a pipe table are read as the plain lines they stand for', () => {
  const rows = segmentExams('r', pages([
    '# Appello del 5 luglio 2024', '', '| Cognome e nome | ________ |', '|---|---|', '| **Data** | 05/07/2024 |', '---', '',
    '## Esercizio 1', 'Un resistore da $10\\ \\Omega$.', '', '__Esercizio 2__ (8 punti)', 'Un condensatore.', '', '*Quesito 3*', 'Un induttore.',
  ]), { label: 'x', untitled: true });
  assert.deepEqual(summary(rows), ['Appello del 5 luglio 2024 #1 2024-07-05 p0-0', 'Appello del 5 luglio 2024 #2 2024-07-05 p0-0', 'Appello del 5 luglio 2024 #3 2024-07-05 p0-0']);
  assert.deepEqual(rows.map((r) => r.statement.split('\n')[0]), ['Esercizio 1', 'Esercizio 2 (8 punti)', 'Quesito 3']);
  assert.ok(rows[0].statement.includes('$10\\ \\Omega$'), 'math keeps its characters');
});

// ---------- "Soluzioni (Appello del …)": a solutions heading with a qualifier ----------

// The text layer of the PDF that the acceptance run uploaded second: a header table (one cell per line), two problems, then "Soluzioni (Appello del …)".
const header = (day: string) => ['Corso', 'Elettrotecnica (ING-IND/31)', 'Corso di Laurea', 'Ingegneria Elettronica, primo anno', 'Prova', `Prova scritta, Appello del ${day}`, 'Durata', '90 minuti, calcolatrice consentita, nessun appunto', 'Nome e cognome', '______________________________', 'Matricola', '______________'];
const PAPER_1 = [...header('12 febbraio 2024'), 'Problema 1 (12 punti)', 'Un generatore di tensione continua V₀ = 12 V è collegato a un resistore R = 4,7 kΩ.', 'a) Calcolare la costante di tempo τ del circuito.', 'Problema 2 (12 punti)', 'Un filtro passa-basso RC del primo ordine ha R = 1 kΩ e C = 47 nF.', 'a) Calcolare la frequenza di taglio f_c del filtro.'];
const SOLUTIONS_1 = ['Soluzioni (Appello del 12 febbraio 2024)', 'Problema 1.', 'a) τ = RC = 103,4 µs.', 'Problema 2.', 'a) f_c = 1/(RC) = 21,28 kHz.'];
const PAPER_2 = [...header('3 luglio 2024'), 'Problema 1 (12 punti)', 'Un amplificatore invertente con amplificatore operazionale ideale ha R₁ = 3,3 kΩ.', 'a) Calcolare il guadagno G = v_out/v_in.', 'Problema 2 (12 punti)', 'Un condensatore C = 1 µF è carico alla tensione V₀ = 9 V.', 'a) Calcolare la costante di tempo τ.'];
const SOLUTIONS_2 = ['Soluzioni (Appello del 3 luglio 2024)', 'Problema 1.', 'a) G = −R₂/R₁ = −10.', 'Problema 2.', 'a) τ = RC = 22 ms.'];
const solved = (rows: ReturnType<typeof segmentExams>) => rows.map((r) => `${r.examGroup} #${r.number} ${/^Problema \d\.\n/.test(r.solution) ? r.solution.split('\n')[0] : 'no solution'}`);

test('"Soluzioni (Appello del …)" after each paper is a solutions heading: four questions, each with its solution', () => {
  const rows = segmentExams('r', pages([...PAPER_1, ...SOLUTIONS_1], [...PAPER_2, ...SOLUTIONS_2]), { label: 'appelli', untitled: true });
  assert.deepEqual(solved(rows), [
    'Prova scritta del 12 febbraio 2024 #1 Problema 1.', 'Prova scritta del 12 febbraio 2024 #2 Problema 2.',
    'Prova scritta del 3 luglio 2024 #1 Problema 1.', 'Prova scritta del 3 luglio 2024 #2 Problema 2.',
  ]);
  assert.match(rows[1].solution, /21,28 kHz/);
  assert.doesNotMatch(rows[0].statement, /Soluzioni/);
});

test('the same in the Markdown file of the acceptance run', () => {
  const rows = segmentExams('r', markdownPages(), { label: 'appelli-elettrotecnica-2024', untitled: true });
  assert.equal(rows.length, 4);
  assert.deepEqual(solved(rows), ['Prova scritta del 12 febbraio 2024 #1 Problema 1.', 'Prova scritta del 12 febbraio 2024 #2 Problema 2.', 'Prova scritta del 3 luglio 2024 #1 Problema 1.', 'Prova scritta del 3 luglio 2024 #2 Problema 2.']);
});

test('solutions printed after all the papers go to the session their heading names', () => {
  // Both papers first, then the solutions of the first paper, then those of the second: the heading, not the position, says which is which.
  const rows = segmentExams('r', pages([...PAPER_1, ...PAPER_2, ...SOLUTIONS_1, ...SOLUTIONS_2]), { label: 'appelli', untitled: true });
  assert.deepEqual(solved(rows), [
    'Prova scritta del 12 febbraio 2024 #1 Problema 1.', 'Prova scritta del 12 febbraio 2024 #2 Problema 2.',
    'Prova scritta del 3 luglio 2024 #1 Problema 1.', 'Prova scritta del 3 luglio 2024 #2 Problema 2.',
  ]);
  assert.match(rows[0].solution, /103,4 µs/);
  assert.match(rows[2].solution, /−10/);
  // A qualifier that names no session of the file leaves the solutions with the session they follow.
  const other = segmentExams('r', pages([...PAPER_1, 'Soluzioni (versione A)', 'Problema 1.', 'a) τ = RC.']), { label: 'appelli', untitled: true });
  assert.match(other[0].solution, /τ = RC\./);
});

test('isSolutionMarker: a bare word or a qualified heading, never a sentence', () => {
  for (const t of ['Soluzioni', 'SOLUZIONI.', 'Svolgimento:', 'Soluzioni (Appello del 12 febbraio 2024)', 'Soluzioni - Appello del 3 luglio 2024', "Soluzioni dell'appello del 3 luglio 2024", 'Soluzione: (versione A)', 'Risoluzioni (Esame del 5 luglio 2024)']) assert.ok(isSolutionMarker(t), t);
  for (const t of ['Soluzione di questo circuito si ottiene con la regola del partitore', 'Soluzioni numeriche (si usi la calcolatrice) del circuito di prima, riportate in tabella qui sotto per intero', 'Soluzione Esercizio 1', 'La soluzione (Appello)', 'soluzioni']) assert.ok(!isSolutionMarker(t), t);
});

// ---------- the real Analisi papers ----------

const SRC = '/home/tost/politost-sources/Analisi/ESAME';
// Questions and sessions per file. 2021-22 holds "Esame dell’11 febbraio 2022", which the Analisi-only pattern did not read:
// the splitter used to fold its exercises into the previous session (9 questions, 4 sessions before).
const REAL: Record<string, [number, number]> = {
  'Esami scritti 2014-15.pdf': [11, 5], 'Esami scritti 2015-16.pdf': [18, 9], 'Esami scritti 2016-17.pdf': [12, 6], 'Esami scritti 2017-18.pdf': [12, 5],
  'Esami scritti 2018-19.pdf': [12, 6], 'Esami scritti 2019-20.pdf': [14, 6], 'Esami scritti 2020-21.pdf': [10, 5], 'Esami scritti 2021-22.pdf': [11, 5],
  'Esami scritti 2022-23.pdf': [7, 3], 'Esami scritti 2023-24.pdf': [6, 3], 'esami2024-2025.pdf': [64, 32],
};

test('real Analisi papers: questions and sessions per file, none of them flagged', { skip: !existsSync(SRC), timeout: 120_000 }, async () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.pdf'));
  assert.deepEqual([...files].sort(), Object.keys(REAL).sort());
  const k = makeCtx();
  const got: Record<string, [number, number]> = {};
  for (const f of files) {
    const id = await storeResource(k.ctx, k.projectId, { filename: f, bytes: readFileSync(join(SRC, f)), role: 'exams' });
    await extractResource(k.ctx, id, new AbortController().signal);
    const s = splitQuestions(k.ctx, id);
    const sum = summarizeSplit(s.rows, s.noHeading);
    assert.equal(sum.warning, null, f);
    got[f] = [sum.questions, sum.sessions];
    assert.equal(segmentQuestions(k.ctx, id).length, s.rows.length);
  }
  assert.deepEqual(got, REAL);
});

test('a dated session heading at the top of a new page starts a new session, however short the page before it', () => {
  const rows = segmentExams('r', pages(
    ['Appello del 12 febbraio 2024', 'Esercizio 1', 'Uno.'],
    ['Appello del 5 luglio 2024', 'Esercizio 1', 'Due.'],
  ));
  assert.deepEqual(summary(rows), ['Appello del 12 febbraio 2024 #1 2024-02-12 p0-0', 'Appello del 5 luglio 2024 #1 2024-07-05 p1-1']);
});

// ---------- two papers on one day ----------

const TURN_A = ['Esame del 12 febbraio 2024 - Turno A', 'Problema 1 (12 punti)', 'Un resistore R = 4,7 kΩ è collegato a un generatore V₀ = 12 V. Calcolare la corrente.'];
const TURN_B = ['Esame del 12 febbraio 2024 - Turno B', 'Problema 1 (12 punti)', 'Un condensatore C = 1 µF è carico alla tensione V₀ = 9 V. Calcolare la carica.'];

test('solutions printed after two papers of one day go to the turn their heading names', () => {
  const rows = segmentExams('r', pages([...TURN_A, ...TURN_B, 'Soluzioni (Esame del 12 febbraio 2024 - Turno A)', 'Problema 1.', 'I = V/R = 2,55 mA.', 'Soluzioni (Esame del 12 febbraio 2024 - Turno B)', 'Problema 1.', 'Q = CV = 9 µC.']));
  assert.equal(rows.length, 2);
  assert.match(rows[0].solution, /2,55 mA/);
  assert.match(rows[1].solution, /9 µC/);
});

test('a solutions heading that gives only the date does not pick one of two papers of that day', () => {
  const rows = segmentExams('r', pages([...TURN_A, ...TURN_B, 'Soluzioni (Esame del 12 febbraio 2024)', 'Problema 1.', 'Q = CV = 9 µC.']));
  assert.equal(rows[0].solution, '');
  assert.match(rows[1].solution, /9 µC/);
});

test('plainLines: a line of absolute values stays whole, the rows of a table with a separator line give one line per cell', () => {
  assert.deepEqual(plainLines('Calcolare\n| x | + | y |\nper x = 1.'), ['Calcolare', '| x | + | y |', 'per x = 1.']);
  assert.deepEqual(plainLines('| Cognome | Mario |\n|---|---|\n| Data | 12/02/2024 |'), ['Cognome', 'Mario', 'Data', '12/02/2024']);
  assert.deepEqual(plainLines('| x | + | y |\n\n| a | b |\n| :-- | --: |\n| c | d |'), ['| x | + | y |', 'a', 'b', 'c', 'd']);
});

// ---------- the header of the next paper is not the end of the last solution (acceptance run, part 2) ----------

const ELETTROTECNICA_FILES = ['appelli-elettrotecnica-2024.md', 'appelli-elettrotecnica-2024.pdf', 'appelli-elettrotecnica-2024-v1-soluzioni-con-data.pdf'];

for (const f of ELETTROTECNICA_FILES) {
  test(`${f}: the last solution of the February paper ends with its own text, not with the header cells of the July paper`, async () => {
    const k = makeCtx();
    const id = await storeResource(k.ctx, k.projectId, { filename: f, bytes: readFileSync(new URL(`./testdata/${f}`, import.meta.url)), role: 'exams' });
    await extractResource(k.ctx, id, new AbortController().signal);
    const { rows } = splitQuestions(k.ctx, id);
    assert.deepEqual(rows.map((r) => `${r.examGroup} #${r.number}`), ['Prova scritta del 12 febbraio 2024 #1', 'Prova scritta del 12 febbraio 2024 #2', 'Prova scritta del 3 luglio 2024 #1', 'Prova scritta del 3 luglio 2024 #2']);
    const last = rows[1].solution;
    assert.match(last, /45\s*(?:\^\\circ|°)\$?\.$/, last.slice(-80));
    assert.doesNotMatch(last, /Corso|Elettrotecnica \(|Ingegneria|\bProva\b/);
    for (const r of rows) assert.doesNotMatch(`${r.statement}\n${r.solution}`, /^(?:Corso|Prova|Matricola|Durata)$/m);
    assert.match(rows[2].statement, /^Problema 1 \(12 punti\)/);
  });
}

test('a solution that ends in short lines is cut only where the next paper\'s header table starts', () => {
  const paper = (day: string) => ['Corso', 'Elettrotecnica (ING-IND/31)', 'Prova', `Prova scritta, Appello del ${day}`, 'Problema 1', 'Un circuito.', 'a) Calcolare la corrente.'];
  const rows = segmentExams('r', pages([...paper('12 febbraio 2024'), 'Soluzioni', 'Problema 1.', 'a) I = 2 A.', 'Risposta:', '3,386 kHz', ...paper('3 luglio 2024')]), { label: 'x', untitled: true });
  assert.equal(rows[0].solution, 'Problema 1.\na) I = 2 A.\nRisposta:\n3,386 kHz');
  // A statement is cut the same way when the solutions are not printed after the paper.
  const noSolutions = segmentExams('r', pages([...paper('12 febbraio 2024'), ...paper('3 luglio 2024')]), { label: 'x', untitled: true });
  assert.equal(noSolutions[0].statement, 'Problema 1\nUn circuito.\na) Calcolare la corrente.');
});

test('a solution that ends in a small table with "Durata" and a value keeps it when no header table follows', () => {
  const solution = ['Problema 1.', 'a) La durata del transitorio è', 'Durata', '20 s'];
  // The next paper starts with its heading and has no header table, so "Durata" and "20 s" are the answer.
  const rows = segmentExams('r', pages([`Prova scritta, Appello del 12 febbraio 2024`, 'Problema 1', 'Un circuito.', 'a) Calcolare la durata.', 'Soluzioni', ...solution], [`Prova scritta, Appello del 3 luglio 2024`, 'Problema 1', 'Un altro circuito.']), { label: 'x', untitled: true });
  assert.equal(rows[0].solution, solution.join('\n'));
  // Without a solutions section the same cells end the statement of the paper.
  const noSolutions = segmentExams('r', pages([`Prova scritta, Appello del 12 febbraio 2024`, 'Problema 1', 'Un circuito. Il tempo di misura', 'Durata', '20 s'], [`Prova scritta, Appello del 3 luglio 2024`, 'Problema 1', 'Altro.']), { label: 'x', untitled: true });
  assert.equal(noSolutions[0].statement, 'Problema 1\nUn circuito. Il tempo di misura\nDurata\n20 s');
});

test('the page range of a question still reaches the page where its answer ends when the answer is a small table', () => {
  const rows = segmentExams('r', pages(
    ['Prova scritta, Appello del 12 febbraio 2024', 'Problema 1', 'Un circuito.'],
    ['Soluzioni', 'Problema 1.'],
    ['Durata', '20 s'],
    ['Prova scritta, Appello del 3 luglio 2024', 'Problema 1', 'Altro.'],
  ), { label: 'x', untitled: true });
  assert.equal(rows[0].solution, 'Problema 1.\nDurata\n20 s');
  assert.equal(rows[0].pageTo, 2);
});

test('a block with one header label before the session heading stays in the solution', () => {
  const rows = segmentExams('r', pages(
    ['Prova scritta, Appello del 12 febbraio 2024', 'Problema 1', 'Un circuito.', 'Soluzioni', 'Problema 1.', 'a) I = 2 A.', 'Corso', 'Elettrotecnica (ING-IND/31)', 'Prova scritta, Appello del 3 luglio 2024', 'Problema 1', 'Altro.'],
  ), { label: 'x', untitled: true });
  assert.equal(rows[0].solution, 'Problema 1.\na) I = 2 A.\nCorso\nElettrotecnica (ING-IND/31)');
});
