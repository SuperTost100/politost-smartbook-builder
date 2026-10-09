import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormulaIndex, parseChapterMarkdown, parseExercises, validateExercises } from '@politost/content-core';
import { compileBook, compileChapter, numberChapters, numberStatements } from './compile.ts';
import { enrichment, fixtureBook, question } from './fixtures.ts';
import type { BookInput, CompiledBook } from './types.ts';

const text = (b: CompiledBook, p: string): string => {
  const v = b.files[p];
  assert.equal(typeof v, 'string', `${p} should be a text file`);
  return v as string;
};
const blockers = (b: CompiledBook) => b.findings.filter((f) => f.severity === 'blocker');

test('fixture book compiles without findings and produces the expected files', () => {
  const book = compileBook(fixtureBook());
  assert.deepEqual(book.findings, []);
  assert.deepEqual(Object.keys(book.files).sort(), [
    'assets/fig-vel.svg', 'chapters/01-cinematica.md', 'chapters/02-dinamica.md', 'esami.md', 'esercizi.md', 'grafici.json', 'ide.json', 'smartbook.json',
  ]);
  assert.deepEqual(book.formulaNumbers, { 'intro-eq': '1.1', 'vel-media': '1.2', 'acc-media': '1.3', lavoro: '2.1' });
  assert.deepEqual(book.sectionNumbers, {
    'ch-cin': { chapter: 1, paragraph: 1 },
    'sec-vel': { chapter: 1, paragraph: 2 },
    'sec-acc': { chapter: 1, paragraph: 3 },
    'sec-lavoro': { chapter: 2, paragraph: 1 },
  });
});

test('chapter intro survives as the first paragraph and shifts numbering', () => {
  const book = compileBook(fixtureBook());
  const md = text(book, 'chapters/01-cinematica.md');
  assert.ok(md.startsWith('---\nchapter: 1\ntitle: Cinematica\n---\n'));
  const ch = parseChapterMarkdown(md, 1);
  assert.deepEqual(ch.paragraphs.map((p) => [p.id, p.title]), [['p1', 'Introduzione'], ['p2', 'Velocità'], ['p3', 'Accelerazione']]);
  assert.match(ch.paragraphs[0].content, /In questo capitolo studiamo il moto\./);
  // Chapter 2 has no intro: no extra paragraph.
  assert.deepEqual(parseChapterMarkdown(text(book, 'chapters/02-dinamica.md'), 2).paragraphs.map((p) => p.id), ['p1']);
});

test('content-core merges prose before the first paragraph heading into p1 (why the intro becomes its own p1)', () => {
  const ch = parseChapterMarkdown('Prosa iniziale.\n\n## p1 | Primo\n\nCorpo uno.\n\n## p2 | Secondo\n\nCorpo due.\n', 1);
  assert.equal(ch.paragraphs.length, 2);
  // The intro is glued to the first paragraph instead of staying separate.
  assert.match(ch.paragraphs[0].content, /Prosa iniziale[\s\S]*Corpo uno/);
  assert.match(ch.paragraphs[1].content, /Corpo due/);
});

test('intro title follows the book language', () => {
  const intro = (language: string) => {
    const b = compileBook(fixtureBook({ meta: { ...fixtureBook().meta, language } }));
    return parseChapterMarkdown(text(b, 'chapters/01-cinematica.md'), 1).paragraphs[0].title;
  };
  assert.equal(intro('it'), 'Introduzione');
  assert.equal(intro('en'), 'Introduction');
  assert.equal(intro('fr'), 'Introduction');
});

test('formulas are numbered per chapter in order of appearance and refs are rewritten', () => {
  const book = compileBook(fixtureBook());
  const ch1 = parseChapterMarkdown(text(book, 'chapters/01-cinematica.md'), 1);
  assert.deepEqual(ch1.formulas.map((f) => [f.id, f.label]), [['1.1', 'Spostamento'], ['1.2', 'Velocità media'], ['1.3', 'Accelerazione media']]);
  assert.equal(ch1.formulas[1].latex, '$$v = \\frac{s}{t}$$');
  const md1 = text(book, 'chapters/01-cinematica.md');
  assert.ok(md1.includes('{{formula:1.1}}'));
  assert.ok(md1.includes('[formula della velocità](ref:formula/1.2)'));
  assert.ok(md1.includes("[introduzione](ref:chapter/1#p1)"));
  assert.ok(md1.includes('[paragrafo sul lavoro](ref:chapter/2#p1)'));
  assert.ok(!md1.includes('@'), 'no source-dialect leftovers');
  assert.ok(!md1.includes('ref:section'));
  const md2 = text(book, 'chapters/02-dinamica.md');
  assert.ok(md2.includes('[la formula](ref:formula/1.2)'));
  assert.ok(md2.includes('[capitolo precedente](ref:chapter/1#p3)'));
});

test('a hover reference to another chapter becomes a link (the reader validates hovers per chapter)', () => {
  const book = compileBook(fixtureBook());
  assert.ok(text(book, 'chapters/01-cinematica.md').includes('La [formula (2.1)](ref:formula/2.1) ne è'));
  assert.ok(!text(book, 'chapters/01-cinematica.md').includes('{{formula:2.1}}'));
});

test('references get spaces when they touch words', () => {
  const b = compileBook(fixtureBook({
    chapters: [{ id: 'c', slug: 'c', number: 1, title: 'C', intro: '', sections: [{ id: 's', title: 'S', markdown: 'Vedi:\n\n:::formula{key="k" label="K"}\n$$a=b$$\n:::\n\nla{{formula:@k}}e[x](ref:formula/@k)y.' }] }],
    questions: [], enrichments: [],
  }));
  assert.ok(text(b, 'chapters/01-c.md').includes('la {{formula:1.1}} e [x](ref:formula/1.1) y.'));
});

test('renumbering: moving a section updates every reference without touching the source', () => {
  const input = fixtureBook();
  const [vel, acc] = input.chapters[0].sections;
  const moved: BookInput = { ...input, chapters: [{ ...input.chapters[0], sections: [acc, vel] }, input.chapters[1]] };
  const book = compileBook(moved);
  assert.deepEqual(book.findings, []);
  assert.deepEqual(book.formulaNumbers, { 'intro-eq': '1.1', 'acc-media': '1.2', 'vel-media': '1.3', lavoro: '2.1' });
  assert.deepEqual(book.sectionNumbers['sec-acc'], { chapter: 1, paragraph: 2 });
  assert.deepEqual(book.sectionNumbers['sec-vel'], { chapter: 1, paragraph: 3 });
  const md2 = text(book, 'chapters/02-dinamica.md');
  assert.ok(md2.includes('[la formula](ref:formula/1.3)'));
  assert.ok(md2.includes('[capitolo precedente](ref:chapter/1#p2)'));
  // exercises follow the new numbers too
  assert.match(text(book, 'esercizi.md'), /Usa la \{\{formula:1\.3\}\}/);
  // and the same input compiled in the original order is unchanged
  assert.equal(input.chapters[0].sections[0].markdown.includes('1.2'), false);
});

test('compileChapter previews one chapter with known sections from the rest of the book', () => {
  const input = fixtureBook();
  const whole = compileBook(input);
  const preview = compileChapter(input.chapters[1], whole.sectionNumbers, { knownFormulas: whole.formulaNumbers });
  assert.equal(preview.markdown, text(whole, 'chapters/02-dinamica.md'));
  assert.deepEqual(preview.findings, []);
  assert.deepEqual(preview.formulaNumbers, { lavoro: '2.1' });
  const lonely = compileChapter(input.chapters[1]);
  assert.ok(lonely.findings.some((f) => f.rule === 'formula-ref-unknown'));
  assert.ok(lonely.findings.some((f) => f.rule === 'section-ref-unknown'));
});

test('unresolvable references: blocker finding and plain text instead of a broken ref', () => {
  const input = fixtureBook();
  input.chapters[1].sections.push({ id: 'sec-rotta', title: 'Rotta', markdown: 'Vedi {{formula:@fantasma}} e [qui](ref:formula/@spettro) e [la sezione](ref:section/non-esiste) e {{formula:7.7}}.' });
  const book = compileBook(input);
  const md = text(book, 'chapters/02-dinamica.md').split('## p2 | Rotta')[1];
  assert.ok(!md.includes('{{formula'));
  assert.ok(!md.includes('ref:'));
  assert.ok(!md.includes('7.7}}'));
  assert.ok(md.includes('Vedi formula @fantasma e qui e la sezione e formula 7.7.'), md);
  const f = blockers(book);
  assert.equal(f.filter((x) => x.rule === 'formula-ref-unknown').length, 3);
  assert.equal(f.filter((x) => x.rule === 'section-ref-unknown').length, 1);
  assert.ok(f.every((x) => x.file === 'sec-rotta' && x.line === 1 && x.quote));
});

test('image blocks must reference an existing asset', () => {
  const book = compileBook(fixtureBook({ assets: [] }));
  const f = blockers(book).filter((x) => x.rule === 'image');
  assert.ok(f.length >= 1);
  assert.ok(f.some((x) => /fig-vel\.svg/.test(x.message) && x.file === 'sec-vel'));
});

test('source lints run on sections and surface in the findings', () => {
  const input = fixtureBook();
  input.chapters[0].sections[0].markdown += '\n\n### Sintesi del lavoro svolto\n\n:::formula{R = F1 + F2}\n';
  const book = compileBook(input);
  assert.ok(book.findings.some((f) => f.rule === 'meta-leak' && f.file === 'sec-vel'));
  assert.ok(book.findings.some((f) => f.rule === 'formula-malformed' && f.file === 'sec-vel'));
  // The malformed shorthand is dropped from the output rather than shipped.
  assert.ok(!text(book, 'chapters/01-cinematica.md').includes('R = F1'));
});

test('content-core validators run on the compiled output', () => {
  const input = fixtureBook();
  input.enrichments.push(enrichment({ id: 'bad', kind: 'ide', nodeId: 'sec-vel', payload: { id: 'x' } }));
  const book = compileBook(input);
  assert.ok(book.findings.some((f) => f.rule === 'content-core' && f.severity === 'blocker' && f.file === 'ide.json'));
  // Warnings map to minor.
  const warn = compileBook(fixtureBook({ questions: [question({ id: 'q', kind: 'exercise', chapterId: 'ch-cin', hint: '' })] }));
  assert.ok(warn.findings.some((f) => f.rule === 'content-core' && f.severity === 'minor' && /hint mancante/.test(f.message)));
});

test('smartbook.json: metadata, section labels and flags', () => {
  const cfg = JSON.parse(text(compileBook(fixtureBook()), 'smartbook.json'));
  assert.equal(cfg.id, 'fisica-demo');
  assert.equal(cfg.access, 'public');
  assert.equal(cfg.specVersion, '1.1');
  assert.deepEqual(cfg.authors, ['Ada Rossi']);
  assert.equal(cfg.version, '0.1.0');
  assert.deepEqual(Object.entries(cfg.sections).map(([k, v]) => [k, (v as { label: string }).label]), [
    ['smartbook', 'Capitoli'], ['formulario', 'Formulario'], ['esercizi', 'Esercizi'], ['esami', "Prove d'esame"], ['ide', 'Laboratorio'], ['grafici', 'Grafici & Calcoli'], ['risposte', 'Soluzioni'],
  ]);
  assert.equal(cfg.sections.risposte.enabled, false);
  assert.deepEqual(cfg.chapters, [
    { id: 'cinematica', number: 1, title: 'Cinematica', file: '01-cinematica.md', printable: true },
    { id: 'dinamica', number: 2, title: 'Dinamica', file: '02-dinamica.md', printable: true },
  ]);

  const en = JSON.parse(text(compileBook(fixtureBook({ meta: { ...fixtureBook().meta, language: 'en', authors: [] } })), 'smartbook.json'));
  assert.ok(!('authors' in en), 'empty authors are omitted');
  assert.deepEqual(Object.values(en.sections).map((v) => (v as { label: string }).label), ['Chapters', 'Formulas', 'Exercises', 'Exams', 'Lab', 'Graphs & Calculators', 'Solutions']);
  const unknown = JSON.parse(text(compileBook(fixtureBook({ meta: { ...fixtureBook().meta, language: 'de' } })), 'smartbook.json'));
  assert.equal(unknown.sections.smartbook.label, 'Chapters');

  const off = compileBook(fixtureBook({ sections: { esercizi: false, esami: true, ide: false, grafici: true } }));
  const offCfg = JSON.parse(text(off, 'smartbook.json'));
  assert.deepEqual([offCfg.sections.esercizi.enabled, offCfg.sections.esami.enabled, offCfg.sections.ide.enabled, offCfg.sections.grafici.enabled], [false, true, false, true]);
  assert.ok(!('esercizi.md' in off.files) && !('ide.json' in off.files));
});

test('exercises: ids, order, attributes, and the reader validates them', () => {
  const book = compileBook(fixtureBook());
  const raw = text(book, 'esercizi.md');
  const v = validateExercises(raw, 'esercizi');
  assert.deepEqual(v, { valid: true, exerciseCount: 3, errors: [], warnings: [] });
  const ex = parseExercises(raw, 'esercizio');
  assert.deepEqual(ex.map((e) => [e.id, e.chapter, e.difficulty, e.type]), [
    ['E1.1', 1, 'medio', 'esercizio'], ['E1.2', 1, 'facile', 'esercizio'], ['E2.1', 2, 'difficile', 'esercizio'],
  ]);
  assert.equal(ex[1].hint, 'Usa la {{formula:1.2}}.');
  assert.match(ex[1].solution ?? '', /v = 5/);
  assert.ok(raw.startsWith('---\ntype: esercizi\nprintable: true\n---\n'));
});

test('exams: ids from the exam date, session line for authentic, marker for generated', () => {
  const book = compileBook(fixtureBook());
  const raw = text(book, 'esami.md');
  const v = validateExercises(raw, 'esami');
  assert.equal(v.valid, true, v.errors.join('; '));
  const ex = parseExercises(raw, 'esame');
  assert.deepEqual(ex.map((e) => [e.id, e.type, e.chapter]), [['X2023-1', 'esame', 2], ['X1', 'esame', 1]]);
  const authentic = ex[0].question.split('\n');
  assert.equal(authentic[0], '**Esame del 25 gennaio 2023 - turno 1**');
  assert.equal(ex[0].solution, 'Vedi la {{formula:2.1}}.');
  assert.equal(ex[1].question.split('\n')[0], "**Esercizio in stile d'esame (generato)**");
  assert.ok(!ex[0].question.includes('generato'));
  // Exams have no hints, even when the question carries one.
  assert.ok(ex.every((e) => !e.hint), 'exam hints are not compiled');
  assert.ok(text(book, 'esercizi.md').includes(':::hint'));

  const en = compileBook(fixtureBook({ meta: { ...fixtureBook().meta, language: 'en' } }));
  assert.ok(text(en, 'esami.md').includes('**Exam-style exercise (generated)**'));
});

test('exam ids count per year', () => {
  const qs = [
    question({ id: 'a', kind: 'exam', examDate: '2022-06-01', examGroup: 'S1', chapterId: 'ch-cin' }),
    question({ id: 'b', kind: 'exam', examDate: '2022-06-01', examGroup: 'S1', chapterId: 'ch-din' }),
    question({ id: 'c', kind: 'exam', examDate: '2023-02-01', examGroup: 'S2', chapterId: 'ch-cin' }),
    question({ id: 'd', kind: 'exam', origin: 'generated' }),
    question({ id: 'e', kind: 'exam', origin: 'generated' }),
  ];
  const ids = parseExercises(text(compileBook(fixtureBook({ questions: qs })), 'esami.md'), 'esame').map((e) => e.id);
  assert.deepEqual(ids, ['X2022-1', 'X2022-2', 'X2023-1', 'X1', 'X2']);
});

test('questions with blocks the reader cannot parse are flagged', () => {
  const book = compileBook(fixtureBook({
    questions: [question({ id: 'q', kind: 'exercise', chapterId: 'ch-cin', statement: 'Guarda:\n\n:::image{src="assets/fig-vel.svg" alt="Fig"}\n:::\n\nCalcola.' })],
  }));
  assert.ok(book.findings.some((f) => f.rule === 'exercise-fence' && f.file === 'question:q'));
});

test('ide.json and grafici.json come from enrichments; [] when enabled but empty', () => {
  const book = compileBook(fixtureBook());
  const ide = JSON.parse(text(book, 'ide.json'));
  assert.deepEqual(ide.map((s: { id: string }) => s.id), ['vel']);
  assert.equal(ide[0].language, 'python');
  const gr = JSON.parse(text(book, 'grafici.json'));
  assert.equal(gr[0].config.functions[0].fn, '0.5*2*x^2');

  const empty = compileBook(fixtureBook({ enrichments: [] }));
  assert.equal(JSON.parse(text(empty, 'ide.json')).length, 0);
  assert.equal(JSON.parse(text(empty, 'grafici.json')).length, 0);
  assert.equal(text(empty, 'ide.json').trim(), '[]');
});

test('enrichments are ordered by position in the book', () => {
  const mk = (id: string, nodeId: string) => enrichment({ id, kind: 'ide', nodeId, payload: { id, title: id, language: 'python', code: `print("${id}")` } });
  const book = compileBook(fixtureBook({ enrichments: [mk('late', 'sec-lavoro'), mk('early', 'sec-vel'), mk('mid', 'sec-acc')] }));
  assert.deepEqual(JSON.parse(text(book, 'ide.json')).map((s: { id: string }) => s.id), ['early', 'mid', 'late']);
});

test('identical IDE snippets across enrichments are reported (F-09)', () => {
  const same = { id: 'mrua', title: 'MRUA', language: 'python', code: 'x = 1' };
  const book = compileBook(fixtureBook({ enrichments: [
    enrichment({ id: 'a', kind: 'ide', nodeId: 'sec-vel', payload: same }),
    enrichment({ id: 'b', kind: 'ide', nodeId: 'sec-lavoro', payload: { ...same, id: 'mrua-2' } }),
  ] }));
  assert.ok(book.findings.some((f) => f.rule === 'duplicate-ide'));
});

test('assets are copied byte for byte; bad names are rejected', () => {
  const book = compileBook(fixtureBook());
  const svg = book.files['assets/fig-vel.svg'] as Uint8Array;
  assert.ok(svg instanceof Uint8Array && svg.length > 20);
  const bad = compileBook(fixtureBook({ assets: [{ filename: 'fig vel.gif', bytes: new Uint8Array([1]) }] }));
  assert.ok(bad.findings.some((f) => f.rule === 'image' && /not allowed/.test(f.message)));
});

test('duplicate keys, chapter numbers and section ids are reported', () => {
  const input = fixtureBook();
  input.chapters[1].sections.push({ id: 'sec-vel', title: 'Doppione', markdown: ':::formula{key="vel-media" label="Altra"}\n$$a$$\n:::\n\nTesto.' });
  const book = compileBook(input);
  assert.ok(book.findings.some((f) => f.rule === 'formula-malformed' && /Duplicate formula key/.test(f.message)));
  assert.ok(book.findings.some((f) => f.rule === 'book-structure' && /used more than once/.test(f.message)));
  const twice = fixtureBook();
  twice.chapters[1].number = 1;
  assert.ok(compileBook(twice).findings.some((f) => f.rule === 'book-structure' && /Chapter number 1/.test(f.message)));
});

test('headings inside sections are demoted and a pN heading cannot split the section', () => {
  const input = fixtureBook();
  input.chapters[1].sections[0].markdown = '## p9 | Intruso\n\nTesto.\n\n#### Profondo\n\nAltro.';
  const book = compileBook(input);
  const ch = parseChapterMarkdown(text(book, 'chapters/02-dinamica.md'), 2);
  assert.equal(ch.paragraphs.length, 1);
  assert.ok(book.findings.some((f) => f.rule === 'heading-level' && f.severity === 'blocker'));
});

test('book-wide formula index of the compiled book is complete', () => {
  const book = compileBook(fixtureBook());
  const chapters = [1, 2].map((n) => parseChapterMarkdown(text(book, `chapters/0${n}-${n === 1 ? 'cinematica' : 'dinamica'}.md`), n));
  assert.deepEqual([...buildFormulaIndex(chapters).keys()], ['1.1', '1.2', '1.3', '2.1']);
});

test('numberChapters gives the same section and formula numbers as the full compile, chapter introductions included', () => {
  const input = fixtureBook();
  const book = compileBook(input);
  const n = numberChapters(input.chapters, input.meta.language);
  assert.deepEqual(n.sectionNumbers, book.sectionNumbers);
  assert.deepEqual(n.formulaNumbers, book.formulaNumbers);
});

test('figure captions lose LaTeX and get chapter numbers', async () => {
  const { latexToPlain } = await import('./plaintext.ts');
  assert.equal(latexToPlain('La funzione $f(x) = \\frac{\\sin x}{x}$ per $x\\to 0$ vale $1$'), 'La funzione f(x) = (sin x)/x per x→0 vale 1');
  assert.equal(latexToPlain('$x^{10} = o(x^2)$'), 'x¹⁰ = o(x²)');
});

test('links into chapters left out of an export become plain text with a minor finding', async () => {
  const { compileBook } = await import('./compile.ts');
  const book = compileBook({
    meta: { slug: 'b', title: 'B', subject: 'S', authors: [], language: 'it', version: '1.0.0' },
    chapters: [{ id: 'c6', slug: 'limiti', number: 6, title: 'Limiti', intro: '', sections: [{ id: 's1', title: 'Uno', markdown: 'Vedi la [definizione](ref:section/gone) prima.' }] }],
    questions: [], enrichments: [], assets: [], sections: { esercizi: false, esami: false, ide: false, grafici: false },
    omittedSectionIds: ['gone'],
  });
  assert.ok(!book.findings.some((f) => f.severity === 'blocker'), JSON.stringify(book.findings));
  assert.ok(book.findings.some((f) => f.rule === 'section-ref-omitted'));
  const ch = Object.entries(book.files).find(([k]) => k.startsWith('chapters/'))![1] as string;
  assert.ok(ch.includes('Vedi la definizione prima.'), ch);
});

test('caption and alt kept on the asset reach the compiled book (and the chapter preview), numbered and as plain text', () => {
  const input = fixtureBook();
  input.assets = [{ filename: 'fig-vel.svg', bytes: input.assets[0].bytes, caption: 'Spazio $s(t)$ corretto', alt: 'Retta per $v$ costante' }];
  const md = text(compileBook(input), 'chapters/01-cinematica.md');
  assert.match(md, /alt="Retta per v costante"/);
  assert.match(md, /caption="Fig\. 1\.1 — Spazio s\(t\) corretto"/);
  assert.ok(!md.includes('Moto uniforme"'));

  // Empty asset metadata falls back to the attributes written in the text.
  const plain = text(compileBook(fixtureBook()), 'chapters/01-cinematica.md');
  assert.match(plain, /caption="Fig\. 1\.1 — Moto uniforme"/);
  const empty = fixtureBook();
  empty.assets = [{ ...empty.assets[0], caption: '', alt: '  ' }];
  assert.match(text(compileBook(empty), 'chapters/01-cinematica.md'), /alt="Spazio in funzione del tempo"/);

  const ch = fixtureBook().chapters[0];
  const preview = compileChapter(ch, undefined, { assets: new Set(['assets/fig-vel.svg']), assetMeta: { 'assets/fig-vel.svg': { caption: 'Dal catalogo', alt: 'Alt catalogo' } } });
  assert.match(preview.markdown, /alt="Alt catalogo"/);
  assert.match(preview.markdown, /caption="Fig\. 1\.1 — Dal catalogo"/);
});

test('exercise headings become bold lines but "# comment" inside a fenced code block stays code', () => {
  const solution = '# Passo 1\n\nCodice:\n\n```python\n# Compute the answer\nx = 2\n## not a heading either\nprint(x)\n```\n\n~~~\n# tilde fence\n~~~\n\n## Passo 2';
  const book = compileBook(fixtureBook({ questions: [question({ id: 'q', kind: 'exercise', chapterId: 'ch-cin', statement: 'Calcola.', solution })] }));
  const raw = text(book, 'esercizi.md');
  assert.ok(raw.includes('```python\n# Compute the answer\nx = 2\n## not a heading either\nprint(x)\n```'), raw);
  assert.ok(raw.includes('~~~\n# tilde fence\n~~~'));
  assert.ok(raw.includes('**Passo 1**'));
  assert.ok(raw.includes('**Passo 2**'));
  assert.ok(!raw.includes('**Compute the answer**'));
});

test('a "# comment" inside a fenced code block of a section stays code (not turned into a ### heading)', () => {
  const input = fixtureBook();
  input.chapters[0].sections[0].markdown += '\n\n```python\n# commento\nx = 1\n```\n\nFine.';
  const md = text(compileBook(input), 'chapters/01-cinematica.md');
  assert.ok(md.includes('```python\n# commento\nx = 1\n```'), md);
  assert.ok(!md.includes('### commento'));
});

test('brackets in math cannot be captured by a later link', async () => {
  const { protectMathBrackets, compileBook } = await import('./compile.ts');
  assert.equal(protectMathBrackets('di $[2,+\\infty[$ e $\\sqrt[3]{x}$'), 'di $\\lbrack 2,+\\infty\\lbrack $ e $\\sqrt[3]{x}$');
  const book = compileBook({
    meta: { slug: 'b', title: 'B', subject: 'S', authors: [], language: 'it', version: '1.0.0' },
    chapters: [{ id: 'c1', slug: 'uno', number: 1, title: 'Uno', intro: '', sections: [
      { id: 's1', title: 'A', markdown: 'Ad esempio $ [2, +\\infty[ $ è illimitato. Vedi [la sezione B](ref:section/s2).' },
      { id: 's2', title: 'B', markdown: 'Testo.' },
    ] }],
    questions: [], enrichments: [], assets: [], sections: { esercizi: false, esami: false, ide: false, grafici: false },
  });
  const ch = Object.entries(book.files).find(([k]) => k.startsWith('chapters/'))![1] as string;
  assert.ok(ch.includes('[la sezione B](ref:chapter/1#p2)'), ch);
  assert.ok(!/\$[^$]*\[[^$]*\$/.test(ch.split('\n').find((l) => l.startsWith('Ad esempio'))!), ch);
});

// ---- statement numbering -------------------------------------------------------------------------

const chapterOf = (number: number, ...sections: string[]) => ({
  id: `c${number}`, slug: `c${number}`, number, title: 'Capitolo', intro: '',
  sections: sections.map((markdown, i) => ({ id: `s${i + 1}`, title: `Sezione ${i + 1}`, markdown })),
});
const body = (number: number, ...sections: string[]) => compileChapter(chapterOf(number, ...sections)).markdown;

test('statement labels are numbered per kind and chapter, keeping names and punctuation', () => {
  const md = body(4,
    '**Teorema 6.1 (limite delle successioni monotone).** Testo.\n\n**Definizione 3.9.1.** Una cosa.\n\n**Teorema 8.1** (limitatezza locale). Altro.\n\n**Esempio.** Uno.',
    '*Teorema (derivabilità implica continuità).* Testo.\n\n- **Definizione** (di limite). Voce\n\n**Errore tipico.** Si sbaglia.\n\n**Esempio svolto 2.** Due.\n\n**Esempio 7.3** (con nome). Tre.\n\n**Esercizio** Quattro.',
  );
  for (const want of [
    '**Teorema 4.1 (limite delle successioni monotone).** Testo.', '**Definizione 4.1.** Una cosa.', '**Teorema 4.2** (limitatezza locale). Altro.', '**Esempio 4.1.** Uno.',
    '*Teorema 4.3 (derivabilità implica continuità).* Testo.', '- **Definizione 4.2** (di limite). Voce', '**Errore tipico 4.1.** Si sbaglia.',
    '**Esempio svolto 4.2.** Due.', '**Esempio 4.3** (con nome). Tre.', '**Esercizio 4.1** Quattro.',
  ]) assert.ok(md.includes(want), `${want}\n${md}`);
});

test('the introduction is numbered first, and Dimostrazione, code and ::: blocks are left alone', () => {
  const ch = chapterOf(2, '**Proposizione 5.5.** Tesi.\n\n**Dimostrazione.** Ovvia.\n\n```\n**Teorema 9.9** in codice\n```\n\n:::hint\n**Teorema 9.8** nel suggerimento\n:::\n\nuna riga\n**Teorema 7.7** non inizia il paragrafo');
  ch.intro = '**Teorema 1.1.** Dall\'introduzione.';
  const md = compileChapter(ch).markdown;
  assert.match(md, /\*\*Teorema 2\.1\.\*\* Dall'introduzione\./);
  assert.match(md, /\*\*Proposizione 2\.1\.\*\* Tesi\./);
  assert.match(md, /\*\*Dimostrazione\.\*\* Ovvia\./);
  assert.match(md, /```\n\*\*Teorema 9\.9\*\* in codice\n```/);
  assert.match(md, /\*\*Teorema 9\.8\*\* nel suggerimento/);
  assert.match(md, /una riga\n\*\*Teorema 7\.7\*\* non inizia/);
});

test('references follow their label: the same section wins, then the nearest earlier one', () => {
  const [a, b, c, d] = numberStatements([
    '**Teorema 8.1.** Primo.\n\nVedi il teorema 8.1 e (Definizione 3.9.1).',
    '**Definizione 3.9.1.** Una.\n\n**Teorema 8.1.** Secondo, che usa il Teorema 8.1.',
    'Qui si usa il Teorema 8.1, il teorema 8.2 e $Teorema 8.1$.',
    '**Lemma 1.1.** Fine.\n\nPer il Teorema 8.1 e il Lemma 1.1.',
  ], 4, 'it');
  assert.equal(a, '**Teorema 4.1.** Primo.\n\nVedi il teorema 4.1 e (Definizione 4.1).'); // no such label here: the first later section has it
  assert.equal(b, '**Definizione 4.1.** Una.\n\n**Teorema 4.2.** Secondo, che usa il Teorema 4.2.');
  assert.equal(c, 'Qui si usa il Teorema 4.2, il teorema 8.2 e $Teorema 8.1$.'); // nearest earlier section; 8.2 has no label; math untouched
  assert.equal(d, '**Lemma 4.1.** Fine.\n\nPer il Teorema 4.2 e il Lemma 4.1.');
});

test('a reference to a number that no label carries stays, even when another kind has it', () => {
  const [t] = numberStatements(['**Teorema 6.1.** A.\n\nVedi la Definizione 6.1 e il Teorema 6.1.'], 3, 'it');
  assert.equal(t, '**Teorema 3.1.** A.\n\nVedi la Definizione 6.1 e il Teorema 3.1.');
});

test('an English book uses English kinds, and Italian kinds are not numbered there', () => {
  const md = compileChapter(chapterOf(3, '**Theorem 5.1** (Weierstrass). Text.\n\n**Worked example.** One.\n\n**Example 2.** Two, see Theorem 5.1 and Worked example 2.\n\n**Proof.** Skip.\n\n**Teorema 1.** Italiano.'), undefined, { language: 'en' }).markdown;
  assert.match(md, /\*\*Theorem 3\.1\*\* \(Weierstrass\)\. Text\./);
  assert.match(md, /\*\*Worked example 3\.1\.\*\* One\./);
  assert.match(md, /\*\*Example 3\.2\.\*\* Two, see Theorem 3\.1 and Worked example 2\./);
  assert.match(md, /\*\*Proof\.\*\* Skip\./);
  assert.match(md, /\*\*Teorema 1\.\*\* Italiano\./);
});

test('numbering is part of the book compile and leaves questions alone', () => {
  const input = fixtureBook();
  input.chapters[0].sections[0].markdown += '\n\n**Teorema 9.9.** Nuovo.';
  input.questions = [question({ id: 'q1', kind: 'exercise', chapterId: input.chapters[0].id, statement: '**Teorema 9.9** nel testo di una domanda.' })];
  const book = compileBook(input);
  assert.match(text(book, 'chapters/01-cinematica.md'), /\*\*Teorema 1\.1\.\*\* Nuovo\./);
  assert.match(text(book, 'esercizi.md'), /\*\*Teorema 9\.9\*\* nel testo di una domanda\./);
});
