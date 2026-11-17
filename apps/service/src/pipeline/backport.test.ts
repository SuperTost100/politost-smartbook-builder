import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { compileBook, packPtsb, unpackPtsb, type BookInput } from '@smartbuilder/content';
import type { Question } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId } from '../db/db.ts';
import { makeCtx, seedProject } from '../llm/testkit.ts';
import { paths } from '../config.ts';
import { currentHead, getQuestion, insertExport, listRevisions, loadBookInput, rewriteHead, storeAsset, updateEnrichmentPayload, updateQuestion } from '../repo/index.ts';
import { applyChanges, backportProject, planBackport } from './backport.ts';
import { exerciseQuestions } from './publish.ts';

const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
const PARABOLA = { id: 'parabola', title: 'Moto accelerato', type: 'function', config: { functions: [{ fn: 'x^2', label: 's(t)' }], xDomain: [0, 3], yDomain: [0, 10] } };

const S1 = `La **velocità media** è il rapporto tra spazio e tempo.

:::formula{key="vel-media" label="Velocità media"}
$$v = \\frac{s}{t}$$
:::

Con la {{formula:@vel-media}} si ottiene il risultato in un passo.

Tre casi:

1. moto uniforme;

:::image{src="assets/fig.svg" alt="Spazio e tempo" caption="Moto con a_x costante"}
:::`;
const S2 = 'Per la velocità vedi la [sezione precedente](ref:section/s1) e la {{formula:@vel-media}}.';

function book(): BookInput {
  const q = (o: Partial<Question> & Pick<Question, 'id' | 'kind' | 'statement' | 'solution' | 'chapterId'>): Question => ({
    projectId: 'p1', origin: 'authentic', resourceId: null, pageFrom: null, pageTo: null, examGroup: null, examDate: null, number: null, hint: '',
    difficulty: 'medio', topicIds: [], status: 'verified', checks: [], rev: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
  });
  return {
    meta: { slug: 'p1', title: 'Analisi 1', subject: 'Analisi', authors: [], language: 'it', version: '1.0.0' },
    chapters: [{ id: 'c1', slug: 'moto', number: 1, title: 'Moto', intro: '', sections: [{ id: 's1', title: 'Velocità', markdown: S1 }, { id: 's2', title: 'Esempi', markdown: S2 }] }],
    questions: [
      q({ id: 'q1', kind: 'exercise', chapterId: 'c1', statement: 'Calcola $v$ per $s = 10$ e $t = 2$.', solution: 'Con la {{formula:@vel-media}} vale $v = 4$.' }),
      q({ id: 'x1', kind: 'exam', chapterId: 'c1', origin: 'generated', statement: 'Un treno percorre 120 km in 2 ore.', solution: 'La velocità vale 60 km/h.' }),
    ],
    enrichments: [{ id: 'g1', projectId: 'p1', nodeId: 's1', kind: 'graph', payload: PARABOLA, status: 'verified', checks: [], lintAccepted: [], spec: null, checkedRevisionId: null, lintOpen: [], createdAt: '2026-01-01T00:00:00Z' }],
    assets: [{ filename: 'fig.svg', bytes: SVG, caption: 'Moto con a_x costante', alt: 'Spazio e tempo' }],
    sections: { esercizi: true, esami: true, ide: false, grafici: true },
  };
}

const str = (v: string | Uint8Array | undefined) => (typeof v === 'string' ? v : Buffer.from(v ?? []).toString('utf8'));
/** The compiled book as the books repo holds it, with `edit` applied to the text of each file. */
function published(input: BookInput, edit: Record<string, (s: string) => string> = {}): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = { ...compileBook(input).files };
  for (const [file, fn] of Object.entries(edit)) {
    const next = fn(str(out[file]));
    assert.notEqual(next, str(out[file]), `the edit of ${file} changes nothing`);
    out[file] = next;
  }
  return out;
}
const statusOf = (plan: ReturnType<typeof planBackport>, unit: string) => plan.units.find((u) => u.unit === unit)?.status;
const CH = 'chapters/01-moto.md';

/** The hand edits of the audit, one of each kind. */
const AUDIT_EDITS: Record<string, (s: string) => string> = {
  // a phrase on a line that holds a numbered formula reference, and two list items inserted
  [CH]: (s) => s
    .replace('si ottiene il risultato in un passo', 'si ottiene subito il risultato')
    .replace('1. moto uniforme;', '1. moto uniforme;\n2. moto accelerato;\n3. moto vario.'),
  'esercizi.md': (s) => s.replace('vale $v = 4$', 'vale $v = 5$'),
  'grafici.json': (s) => s.replace('"x^2"', '"0.5*x^2"'),
};

describe('planBackport', () => {
  test('maps a hand edit of each kind to its source, and the new compile reproduces the books', () => {
    const input = book();
    const target = published(input, {
      ...AUDIT_EDITS,
      [CH]: (s) => AUDIT_EDITS[CH](s).replace('Moto con aₓ costante', 'Moto con aₓ costante nel tempo'),
    });
    const plan = planBackport(input, target);
    assert.deepEqual(plan.units.map((u) => [u.unit, u.kind, u.status]), [
      [`${CH}#p1`, 'section', 'mapped'],
      ['esercizi.md#E1.1', 'question', 'mapped'],
      ['grafici.json#parabola', 'graph', 'mapped'],
    ]);
    assert.equal(plan.bookRefusal, null);
    assert.deepEqual(plan.residual, []);
    const next = applyChanges(input, plan.changes);
    // The new text is written in source form: the reference keeps its key, not the compiled number.
    assert.equal(next.chapters[0].sections[0].markdown, S1
      .replace('si ottiene il risultato in un passo', 'si ottiene subito il risultato')
      .replace('1. moto uniforme;', '1. moto uniforme;\n2. moto accelerato;\n3. moto vario.'));
    assert.equal(next.questions[0].solution, 'Con la {{formula:@vel-media}} vale $v = 5$.');
    assert.equal(next.assets[0].caption, 'Moto con aₓ costante nel tempo');
    assert.equal(next.enrichments[0].payload.config && JSON.stringify(next.enrichments[0].payload).includes('0.5*x^2'), true);
    for (const [file, bytes] of Object.entries(target)) assert.equal(str(compileBook(next).files[file]), str(bytes), file);
  });

  test('a section reference rewritten by hand goes back to the section id', () => {
    const input = book();
    const plan = planBackport(input, published(input, { [CH]: (s) => s.replace('la [sezione precedente]', 'la [sezione sulla velocità]') }));
    assert.equal(statusOf(plan, `${CH}#p2`), 'mapped');
    assert.equal(applyChanges(input, plan.changes).chapters[0].sections[1].markdown, S2.replace('sezione precedente', 'sezione sulla velocità'));
  });

  test("text the compiler writes is compiler-owned and changes nothing: the old exam label, caption symbols, the version", () => {
    const input = book();
    const target = published(input, {
      'esami.md': (s) => s.replace("**Esercizio in stile d'esame**", "**Esercizio in stile d'esame (generato)**"),
      [CH]: (s) => s.replace('aₓ', 'a_x'),
      'smartbook.json': (s) => s.replace('"version": "1.0.0"', '"version": "1.0.3"'),
    });
    const plan = planBackport(input, target);
    assert.deepEqual(plan.units.map((u) => [u.unit, u.status]), [
      [`${CH}#p1`, 'compiler-owned'], ['esami.md#X1 label', 'compiler-owned'], ['smartbook.json', 'compiler-owned'],
    ]);
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.residual.map((r) => r.file), [CH, 'esami.md', 'smartbook.json']);
  });

  test('a unit that adds a blocker finding is refused, and the others are still mapped', () => {
    const input = book();
    const plan = planBackport(input, published(input, {
      [CH]: (s) => s.replace('si ottiene il risultato', 'si ottiene $\\frac{1}{$ il risultato'),
      'esercizi.md': AUDIT_EDITS['esercizi.md'],
    }));
    const refused = plan.units.find((u) => u.unit === `${CH}#p1`)!;
    assert.equal(refused.status, 'refused');
    assert.match(refused.reason!, /adds a blocker finding/);
    assert.equal(statusOf(plan, 'esercizi.md#E1.1'), 'mapped');
    assert.deepEqual(plan.changes.map((c) => c.kind), ['question']);
    assert.equal(plan.after.findings.filter((f) => f.severity === 'blocker').length, 0);
  });

  test("a hand-fixed graph that trips the graph lint is written with the lint accepted only when the run accepts it", () => {
    const input = book();
    const trace = (name: string) => ({ x: [0, 1, 2], y: [0, 1, 4], name, mode: 'lines' });
    input.enrichments[0].payload = { id: 'parabola', title: 'Moto accelerato', type: 'plotly', config: { data: [trace('a')], layout: { xaxis: { title: 't' }, yaxis: { title: 's' } } } };
    const target = published(input, { 'grafici.json': (s) => JSON.stringify(JSON.parse(s).map((g: { config: { data: unknown[] } }) => ({ ...g, config: { ...g.config, data: [trace('a'), trace('b')] } })), null, 2) + '\n' });
    assert.equal(statusOf(planBackport(input, target), 'grafici.json#parabola'), 'refused', 'refused unless the run accepts the lint');
    const plan = planBackport(input, target, { acceptGraphLint: true });
    const unit = plan.units.find((u) => u.unit === 'grafici.json#parabola')!;
    assert.equal(unit.status, 'mapped');
    assert.equal(unit.reason, 'graph lint accepted: duplicate:b');
    assert.deepEqual(applyChanges(input, plan.changes).enrichments[0].lintAccepted, ['duplicate:b']);
  });

  test('a unit the new compile does not reproduce is refused', () => {
    const input = book();
    // The compiler writes every heading of a section as ###, so a ## heading added by hand cannot come out as written.
    const plan = planBackport(input, published(input, { [CH]: (s) => s.replace('Tre casi:', '## Casi\n\nTre casi:') }));
    assert.deepEqual(plan.units.map((u) => [u.unit, u.status, u.reason]), [[`${CH}#p1`, 'refused', 'the new compile does not reproduce the books text']]);
    assert.deepEqual(plan.changes, []);
  });

  test('a graph the builder check fails is refused, and the other units are still mapped', () => {
    const input = book();
    const plan = planBackport(input, published(input, {
      'grafici.json': (s) => s.replace('"x^2"', '"sqrt(-1-x^2)"'),
      'esercizi.md': AUDIT_EDITS['esercizi.md'],
    }));
    assert.equal(statusOf(plan, 'grafici.json#parabola'), 'refused');
    assert.match(plan.units.find((u) => u.unit === 'grafici.json#parabola')!.reason!, /graph check fails/);
    assert.equal(statusOf(plan, 'esercizi.md#E1.1'), 'mapped');
    assert.deepEqual(plan.changes.map((c) => c.kind), ['question']);
  });

  test('a book whose exercises differ in number from the books is refused, because the numbers may point at other questions', () => {
    const input = book();
    // An exercise of the export was deleted in the builder since: E1.1 of the books is no longer the first question.
    const extra = { ...input.questions[0], id: 'q0', statement: 'Un esercizio poi cancellato.' };
    const target = published({ ...input, questions: [extra, ...input.questions] }, AUDIT_EDITS);
    const plan = planBackport(input, target);
    assert.match(plan.bookRefusal ?? '', /esercizi\.md does not hold the same exercises as the books/);
    assert.deepEqual(plan.changes, []);
  });

  test('a caption change that also changes another section using the same figure refuses the book', () => {
    const input = book();
    input.chapters[0].sections[1].markdown = `${S2}\n\n:::image{src="assets/fig.svg" alt="Spazio e tempo"}\n:::`;
    const target = published(input);
    // Only the first occurrence is edited in the books; the asset row would change the second one too.
    target[CH] = str(target[CH]).replace('Moto con aₓ costante', 'Moto con aₓ costante nel tempo');
    const plan = planBackport(input, target);
    assert.match(plan.bookRefusal ?? '', /#p2 matches the books now and would no longer match/);
    assert.deepEqual(plan.changes, []);
  });

  test('a change with no source is unmapped: a figure file', () => {
    const input = book();
    const plan = planBackport(input, published(input, { 'assets/fig.svg': (s) => s.replace('<rect', '<circle') }));
    assert.deepEqual(plan.units.map((u) => [u.unit, u.status]), [['assets/fig.svg', 'unmapped']]);
    assert.deepEqual(plan.changes, []);
  });

  test('a book whose outline differs from the export is refused before any section is mapped', () => {
    const input = book();
    const target = published(input, AUDIT_EDITS);
    // Another outline revision approved since the export, with the two sections swapped.
    input.chapters[0].sections.reverse();
    const plan = planBackport(input, target);
    assert.match(plan.bookRefusal ?? '', /outline differs .* at chapters\/01-moto\.md/);
    assert.deepEqual(plan.units, []);
    assert.deepEqual(plan.changes, []);
    const retitled = planBackport(book(), published(book(), { [CH]: (s) => s.replace('## p2 | Esempi', '## p2 | Esempi svolti') }));
    assert.match(retitled.bookRefusal ?? '', /outline differs/);
  });
});

describe('planBackport against the published export', () => {
  const pubOf = (input: BookInput) => compileBook(input).files;

  test('two formulas swapped in the builder since the publish refuse the book, though their numbers stay in sequence', () => {
    const VEL = ':::formula{key="vel-media" label="Velocità media"}\n$$v = \\frac{s}{t}$$\n:::';
    const ACC = ':::formula{key="acc-media" label="Accelerazione media"}\n$$a = \\frac{v}{t}$$\n:::';
    const text = (first: string, second: string) => `Prima formula.\n\n${first}\n\nSeconda formula.\n\n${second}\n\nCon la {{formula:@vel-media}} si ottiene il risultato in un passo.`;
    const input = book();
    input.chapters[0].sections[0].markdown = text(VEL, ACC);
    const pub = pubOf(input);
    const target = published(input, { [CH]: (s) => s.replace('si ottiene il risultato in un passo', 'si ottiene subito il risultato') });
    // The builder swaps them: 1.1 and 1.2 now name the other formula, and the books' {{formula:1.1}} would point at the wrong one.
    input.chapters[0].sections[0].markdown = text(ACC, VEL);
    const swapped = String(compileBook(input).files[CH]);
    assert.deepEqual([...swapped.matchAll(/:::formula\{id="([^"]+)"/g)].map((m) => m[1]), ['1.1', '1.2'], 'the numbers stay in sequence');
    const plan = planBackport(input, target, { published: pub });
    assert.match(plan.bookRefusal ?? '', /numbers its formulas differently/);
    assert.deepEqual(plan.changes, []);
  });

  test('two formulas with the same label swapped in the builder refuse the book when the manifest gives their keys', () => {
    const A = ':::formula{key="vel-media" label="Velocità"}\n$$v = \\frac{s}{t}$$\n:::';
    const B = ':::formula{key="vel-istantanea" label="Velocità"}\n$$v = \\frac{ds}{dt}$$\n:::';
    const text = (first: string, second: string) => `Prima.\n\n${first}\n\nSeconda.\n\n${second}\n\nCon la {{formula:@vel-media}} si ottiene il risultato in un passo.`;
    const input = book();
    input.chapters[0].sections[0].markdown = text(A, B);
    const pub = pubOf(input);
    const publishedFormulas = compileBook(input).formulaNumbers;
    const target = published(input, { [CH]: (s) => s.replace('si ottiene il risultato in un passo', 'si ottiene subito il risultato') });
    input.chapters[0].sections[0].markdown = text(B, A);
    // The labels cannot tell them apart; the keys can.
    assert.equal(planBackport(input, target, { published: pub }).bookRefusal, null);
    const plan = planBackport(input, target, { published: pub, publishedFormulas });
    assert.match(plan.bookRefusal ?? '', /numbers its formulas differently/);
    assert.deepEqual(plan.changes, []);
  });

  test('an exercise added in the builder since the publish refuses the book even when the books did not touch the exercises', () => {
    const input = book();
    const pub = pubOf(input);
    const target = published(input, { [CH]: (s) => s.replace('si ottiene il risultato in un passo', 'si ottiene subito il risultato') });
    input.questions.unshift({ ...input.questions[0], id: 'q0', statement: 'Un esercizio nuovo, scritto dopo la pubblicazione.' });
    const plan = planBackport(input, target, { published: pub });
    assert.match(plan.bookRefusal ?? '', /esercizi\.md does not hold the same exercises as the books/);
    assert.deepEqual(plan.changes, []);
  });

  test('an exercise deleted and another added in the builder since the publish refuse the book, though the numbers are the same', () => {
    const input = book();
    const second = { ...input.questions[0], id: 'q2', statement: 'Calcola $s$ per $v = 3$ e $t = 2$.', solution: 'Vale $s = 6$.' };
    input.questions.splice(1, 0, second);
    const pub = pubOf(input);
    const publishedExercises = exerciseQuestions(input);
    const target = published(input, { [CH]: (s) => s.replace('si ottiene il risultato in un passo', 'si ottiene subito il risultato') });
    // q1 is deleted and q3 added: still E1.1 and E1.2, but E1.1 is now q2.
    input.questions.splice(0, 1);
    input.questions.splice(1, 0, { ...second, id: 'q3', statement: 'Un esercizio nuovo, scritto dopo la pubblicazione.' });
    const plan = planBackport(input, target, { published: pub, publishedExercises });
    assert.match(plan.bookRefusal ?? '', /esercizi\.md does not hold the same exercises as the books/);
    assert.deepEqual(plan.changes, []);
    // The same binding passes.
    assert.equal(planBackport(book(), published(book(), { [CH]: (s) => s.replace('in un passo', 'in un solo passo') }), { published: pubOf(book()), publishedExercises: exerciseQuestions(book()) }).bookRefusal, null);
  });

  test('a section refused for edits on both sides keeps its builder text even when a shared caption changes', () => {
    const input = book();
    input.chapters[0].sections[1].markdown = `${S2}\n\n:::image{src="assets/fig.svg" alt="Spazio e tempo"}\n:::`;
    const pub = pubOf(input);
    // The books change the caption in p1 and a word of p2; the builder changes another word of p2.
    const target = published(input, { [CH]: (s) => s.replace('Moto con aₓ costante"', 'Moto con aₓ costante nel tempo"').replace('la [sezione precedente]', 'la [sezione sopra]') });
    input.chapters[0].sections[1].markdown = input.chapters[0].sections[1].markdown.replace('Per la velocità', 'Per la velocità media');
    const plan = planBackport(input, target, { published: pub });
    assert.equal(plan.units.find((u) => u.unit === `${CH}#p2`)?.status, 'refused');
    assert.match(plan.bookRefusal ?? '', /#p2 was changed in the builder since the publish, and the back-port would change it too/);
    assert.deepEqual(plan.changes, []);
  });

  test('a caption fixed in the books is refused when it would change a section the builder edited since the publish', () => {
    const input = book();
    input.chapters[0].sections[1].markdown = `${S2}\n\n:::image{src="assets/fig.svg" alt="Spazio e tempo"}\n:::`;
    const pub = pubOf(input);
    // The books change the caption in p1 and leave p2 as published; the builder edits the prose of p2 since.
    const target = published(input, { [CH]: (s) => s.replace('Moto con aₓ costante"', 'Moto con aₓ costante nel tempo"') });
    input.chapters[0].sections[1].markdown = input.chapters[0].sections[1].markdown.replace('Per la velocità', 'Per la velocità media');
    const plan = planBackport(input, target, { published: pub });
    assert.match(plan.bookRefusal ?? '', /#p2 was changed in the builder since the publish, and the back-port would change it too/);
    assert.deepEqual(plan.changes, []);
  });
});

describe('backportProject', () => {
  let kit: ReturnType<typeof makeCtx>;
  let ctx: AppContext;
  let dir: string;
  beforeEach(() => { kit = makeCtx(); ctx = kit.ctx; dir = mkdtempSync(join(tmpdir(), 'sb-books-')); });
  afterEach(() => { kit.cleanup(); rmSync(dir, { recursive: true, force: true }); });

  /** The fixture book stored as a project. */
  function seedProjectRows() {
    seedProject(ctx, 'p1');
    const input = book();
    const outline = { chapters: [{ id: 'c1', slug: 'moto', title: 'Moto', objectives: [], prerequisites: [], sections: input.chapters[0].sections.map((s) => ({ id: s.id, title: s.title, objectives: [], topicIds: [], depth: 'standard', subsections: [] })) }], exclusions: [], notation: '' };
    const oid = newId();
    ctx.db.insert('outline_revisions', { id: oid, project_id: 'p1', outline, origin: 'human', note: '', created_at: '2026-01-01T00:00:00Z', approved_at: '2026-01-01T00:00:00Z' });
    ctx.db.run(`UPDATE projects SET outline_rev_id = ?, options = '{"selfCheck":false,"graphs":true}' WHERE id = 'p1'`, oid);
    for (const s of input.chapters[0].sections) {
      ctx.db.insert('content_revisions', { id: newId(), project_id: 'p1', node_id: s.id, kind: 'section', markdown: s.markdown, origin: 'ai', model: 'm', parent_rev_id: null, status: 'current', citations: {}, created_at: '2026-01-02T00:00:00Z' });
    }
    for (const q of input.questions) {
      ctx.db.insert('questions', {
        id: q.id, project_id: 'p1', kind: q.kind, origin: q.origin, statement: q.statement, hint: q.hint, solution: q.solution, difficulty: q.difficulty,
        topic_ids: [], chapter_id: q.chapterId, status: 'verified', checks: [], rev: 1, created_at: q.createdAt, updated_at: q.updatedAt,
      });
    }
    ctx.db.insert('enrichments', { id: 'g1', project_id: 'p1', node_id: 's1', kind: 'graph', payload: PARABOLA, status: 'verified', checks: [], created_at: '2026-01-01T00:00:00Z' });
    storeAsset(ctx, 'p1', { filename: 'fig.svg', bytes: SVG, origin: 'imported', nodeId: 's1', caption: 'Moto con a_x costante', alt: 'Spazio e tempo' });
  }

  /** Publishes the project into `dir` as publish-book does: a stored export, its files, and a .builder.json naming it. */
  function publishNow() {
    const files = compileBook(loadBookInput(ctx, 'p1', { approvedOnly: true })).files;
    const bytes = packPtsb({ files, formulaNumbers: {}, sectionNumbers: {}, findings: [] });
    const path = join(paths.exports(ctx.config, 'p1'), `p1-${newId()}.ptsb`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const row = insertExport(ctx, { projectId: 'p1', filename: 'p1.ptsb', path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, approved: true, report: { ok: true, errors: [], warnings: [], lint: [] } });
    rmSync(dir, { recursive: true, force: true });
    for (const [file, b] of Object.entries(unpackPtsb(bytes))) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), b);
    }
    const stored = loadBookInput(ctx, 'p1', { approvedOnly: true });
    const manifest = { projectId: 'p1', exportId: row.id, exportedAt: row.createdAt, builderVersion: 'test', files: {}, findings: [], exercises: exerciseQuestions(stored), formulas: compileBook(stored).formulaNumbers };
    writeFileSync(join(dir, '.builder.json'), JSON.stringify(manifest));
  }

  /** Applies hand edits to the files of the folder. */
  function editFolder(edit: Record<string, (s: string) => string>) {
    for (const [file, fn] of Object.entries(edit)) {
      const before = readFileSync(join(dir, file), 'utf8');
      const after = fn(before);
      assert.notEqual(after, before, `the edit of ${file} changes nothing`);
      writeFileSync(join(dir, file), after);
    }
  }

  function seed(edit: Record<string, (s: string) => string>) {
    seedProjectRows();
    publishNow();
    editFolder(edit);
  }
  const counts = () => ['content_revisions', 'questions', 'enrichments', 'assets', 'review_issues']
    .map((t) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n);
  const graphPayload = () => ctx.db.get<{ payload: string }>("SELECT payload FROM enrichments WHERE id = 'g1'")!.payload;

  test('a dry run writes nothing; the real run writes author edits; a second run finds nothing to do', () => {
    seed({ ...AUDIT_EDITS, [CH]: (s) => AUDIT_EDITS[CH](s).replace('Moto con aₓ costante', 'Moto con aₓ costante nel tempo') });
    const rows = counts();
    const dry = backportProject(ctx, 'p1', dir, { dryRun: true });
    assert.equal(dry.written, false);
    assert.deepEqual(dry.units.map((u) => [u.unit, u.status]), [
      [`${CH}#p1`, 'mapped'], ['esercizi.md#E1.1', 'mapped'], ['grafici.json#parabola', 'mapped'], ['ptsb.json', 'compiler-owned'],
    ]);
    assert.deepEqual(counts(), rows);

    const real = backportProject(ctx, 'p1', dir);
    assert.equal(real.written, true);
    const head = currentHead(ctx, 'p1', 's1')!;
    assert.equal(head.origin, 'human');
    assert.match(head.markdown, /2\. moto accelerato;/);
    assert.deepEqual(listRevisions(ctx, 'p1', 's1').map((r) => r.status), ['current', 'superseded']);
    const q = getQuestion(ctx, 'q1');
    assert.equal(q.solution, 'Con la {{formula:@vel-media}} vale $v = 5$.');
    assert.notEqual(ctx.db.get<{ edited_at: string | null }>('SELECT edited_at FROM questions WHERE id = ?', 'q1')!.edited_at, null);
    assert.equal(ctx.db.get<{ origin: string }>('SELECT origin FROM question_revisions WHERE question_id = ?', 'q1')!.origin, 'backport');
    assert.match(graphPayload(), /0\.5\*x\^2/);
    const asset = ctx.db.get<{ id: string; caption: string }>("SELECT id, caption FROM assets WHERE filename = 'fig.svg'")!;
    assert.equal(asset.caption, 'Moto con aₓ costante nel tempo');
    // One event when the figure was stored, one for the caption: announced like any figure edit.
    assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type = 'asset.updated' AND data LIKE ?`, `%${asset.id}%`)!.n, 2);

    const again = backportProject(ctx, 'p1', dir);
    assert.deepEqual(again.units.map((u) => u.status), ['compiler-owned']);
    assert.equal(again.written, false);
    assert.deepEqual(again.residual.map((r) => r.file), ['ptsb.json']);
  });

  test('a folder with no .builder.json is refused: publish first', () => {
    seed(AUDIT_EDITS);
    rmSync(join(dir, '.builder.json'));
    assert.throws(() => backportProject(ctx, 'p1', dir, { dryRun: true }), /has no \.builder\.json.*Publish the book with npm run publish-book first/);
  });

  test('a graph edited in the builder after the publish survives a one-word section back-port', () => {
    seed({ [CH]: (s) => s.replace('si ottiene il risultato in un passo', 'si ottiene il risultato in un solo passo') });
    updateEnrichmentPayload(ctx, 'g1', { ...PARABOLA, title: 'Moto uniformemente accelerato' });
    const r = backportProject(ctx, 'p1', dir);
    assert.deepEqual(r.units.filter((u) => u.status !== 'compiler-owned').map((u) => [u.unit, u.status]), [[`${CH}#p1`, 'mapped']]);
    assert.equal(r.written, true);
    assert.match(graphPayload(), /Moto uniformemente accelerato/);
    assert.match(currentHead(ctx, 'p1', 's1')!.markdown, /in un solo passo/);
  });

  test('builder edits to other units of the same files stay when the books edited their neighbours', () => {
    seedProjectRows();
    ctx.db.insert('questions', {
      id: 'q2', project_id: 'p1', kind: 'exercise', origin: 'authentic', statement: 'Calcola $s$ per $v = 3$ e $t = 2$.', hint: '', solution: 'Vale $s = 6$.', difficulty: 'medio',
      topic_ids: [], chapter_id: 'c1', status: 'verified', checks: [], rev: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });
    const LINE = { id: 'retta', title: 'Moto uniforme', type: 'function', config: { functions: [{ fn: '2*x', label: 's(t)' }], xDomain: [0, 3], yDomain: [0, 10] } };
    ctx.db.insert('enrichments', { id: 'g2', project_id: 'p1', node_id: 's1', kind: 'graph', payload: LINE, status: 'verified', checks: [], created_at: '2026-01-01T00:00:00Z' });
    publishNow();
    // The builder changes s2, q2 and g2 after the publish; the books change p1, q1 and g1.
    rewriteHead(ctx, 'p1', 's2', (m) => `${m} Vale anche per i moti vari.`, { origin: 'human', expectedHeadId: currentHead(ctx, 'p1', 's2')!.id });
    updateQuestion(ctx, 'q2', 1, { solution: 'Vale $s = 3 \cdot 2 = 6$.' });
    updateEnrichmentPayload(ctx, 'g2', { ...LINE, title: 'Moto rettilineo uniforme' });
    editFolder(AUDIT_EDITS);
    const r = backportProject(ctx, 'p1', dir);
    assert.deepEqual(r.units.filter((u) => u.status !== 'compiler-owned').map((u) => [u.unit, u.status]), [
      [`${CH}#p1`, 'mapped'], ['esercizi.md#E1.1', 'mapped'], ['grafici.json#parabola', 'mapped'],
    ]);
    assert.equal(r.written, true);
    assert.match(currentHead(ctx, 'p1', 's2')!.markdown, /Vale anche per i moti vari\./);
    assert.equal(getQuestion(ctx, 'q2').solution, 'Vale $s = 3 \cdot 2 = 6$.');
    assert.match(ctx.db.get<{ payload: string }>("SELECT payload FROM enrichments WHERE id = 'g2'")!.payload, /Moto rettilineo uniforme/);
    assert.match(currentHead(ctx, 'p1', 's1')!.markdown, /2\. moto accelerato;/);
    assert.match(graphPayload(), /0\.5\*x\^2/);
  });

  test("a second contributor's fix does not revert the first one", () => {
    seedProjectRows();
    publishNow();
    const branchB = mkdtempSync(join(tmpdir(), 'sb-books-b-'));
    try {
      // Contributor B starts from the same publish as A.
      for (const f of ['chapters/01-moto.md', 'esercizi.md', 'esami.md', 'grafici.json', 'smartbook.json', 'ptsb.json', '.builder.json']) {
        mkdirSync(dirname(join(branchB, f)), { recursive: true });
        writeFileSync(join(branchB, f), readFileSync(join(dir, f)));
      }
      mkdirSync(join(branchB, 'assets'), { recursive: true });
      writeFileSync(join(branchB, 'assets', 'fig.svg'), readFileSync(join(dir, 'assets', 'fig.svg')));
      writeFileSync(join(branchB, 'esercizi.md'), readFileSync(join(dir, 'esercizi.md'), 'utf8').replace('vale $v = 4$', 'vale $v = 5$'));
      // A's fix is back-ported and published first.
      editFolder({ [CH]: (s) => s.replace('si ottiene il risultato in un passo', 'si ottiene subito il risultato') });
      assert.equal(backportProject(ctx, 'p1', dir).written, true);
      publishNow();
      // B's folder still has A's sentence as it was, which is not B's edit: only B's exercise is written.
      const r = backportProject(ctx, 'p1', branchB);
      assert.deepEqual(r.units.filter((u) => u.status !== 'compiler-owned').map((u) => [u.unit, u.status]), [['esercizi.md#E1.1', 'mapped']]);
      assert.equal(r.written, true);
      assert.match(currentHead(ctx, 'p1', 's1')!.markdown, /si ottiene subito il risultato/);
      assert.equal(getQuestion(ctx, 'q1').solution, 'Con la {{formula:@vel-media}} vale $v = 5$.');
    } finally {
      rmSync(branchB, { recursive: true, force: true });
    }
  });

  test('a question checked again in the builder without a text change does not block the back-port', () => {
    seed({ [CH]: AUDIT_EDITS[CH] });
    ctx.db.run(`UPDATE questions SET updated_at = '2030-01-01T00:00:00Z', status = 'verified' WHERE id = 'q1'`);
    const r = backportProject(ctx, 'p1', dir);
    assert.equal(r.written, true);
    assert.deepEqual(r.units.filter((u) => u.status !== 'compiler-owned').map((u) => [u.unit, u.status]), [[`${CH}#p1`, 'mapped']]);
  });

  test('a unit edited both in the builder since the publish and in the books is refused, and the builder keeps its text', () => {
    seed({ ...AUDIT_EDITS, [CH]: (s) => s.replace('si ottiene il risultato in un passo', 'si ottiene il risultato subito') });
    const head = currentHead(ctx, 'p1', 's1')!;
    rewriteHead(ctx, 'p1', 's1', (m) => m.replace('Tre casi:', 'Tre casi possibili:'), { origin: 'human', expectedHeadId: head.id });
    const rows = counts();
    const r = backportProject(ctx, 'p1', dir);
    const unit = r.units.find((u) => u.unit === `${CH}#p1`)!;
    assert.equal(unit.status, 'refused');
    assert.match(unit.reason!, /changed in the builder since the publish, and in the books/);
    // The other units are still written.
    assert.equal(r.written, true);
    assert.equal(getQuestion(ctx, 'q1').solution, 'Con la {{formula:@vel-media}} vale $v = 5$.');
    assert.match(currentHead(ctx, 'p1', 's1')!.markdown, /Tre casi possibili:/);
    assert.doesNotMatch(currentHead(ctx, 'p1', 's1')!.markdown, /il risultato subito/);
    assert.equal(counts()[0], rows[0], 'no new section revision');
  });

  test('a hand edit that adds a numbered formula or a heading is refused', () => {
    seed({ [CH]: (s) => s.replace('Tre casi:', ':::formula{id="1.2" label="Nuova"}\n$$a = b$$\n:::\n\nTre casi:') });
    assert.match(backportProject(ctx, 'p1', dir, { dryRun: true }).units[0].reason ?? '', /adds what the export does not have.*formula 1\.2/);
    publishNow();
    editFolder({ [CH]: (s) => s.replace('Tre casi:', '### Casi\n\nTre casi:') });
    const r = backportProject(ctx, 'p1', dir, { dryRun: true });
    assert.equal(r.units[0].status, 'refused');
    assert.match(r.units[0].reason ?? '', /### Casi/);
  });

  test('a graph the graph lint blocks is refused, and written with --accept-graph-lint', () => {
    seedProjectRows();
    const trace = (name: string) => ({ x: [0, 1, 2], y: [0, 1, 4], name, mode: 'lines' });
    const plotly = { id: 'parabola', title: 'Moto accelerato', type: 'plotly', config: { data: [trace('a')], layout: { xaxis: { title: 't' }, yaxis: { title: 's' } } } };
    ctx.db.run(`UPDATE enrichments SET payload = ? WHERE id = 'g1'`, JSON.stringify(plotly));
    publishNow();
    editFolder({ 'grafici.json': (s) => JSON.stringify(JSON.parse(s).map((g: { config: { data: unknown[] } }) => ({ ...g, config: { ...g.config, data: [trace('a'), trace('b')] } })), null, 2) + '\n' });
    const refused = backportProject(ctx, 'p1', dir);
    assert.equal(refused.units[0].status, 'refused');
    assert.match(refused.units[0].reason ?? '', /graph lint blocks it: duplicate:b \(add --accept-graph-lint/);
    assert.equal(refused.written, false);
    const ok = backportProject(ctx, 'p1', dir, { acceptGraphLint: true });
    assert.equal(ok.written, true);
    assert.deepEqual(JSON.parse(ctx.db.get<{ lint_accepted: string }>("SELECT lint_accepted FROM enrichments WHERE id = 'g1'")!.lint_accepted), ['duplicate:b']);
  });

  test('a question added in the builder after the publish refuses the book, since it can shift the exercise numbers', () => {
    seed(AUDIT_EDITS);
    ctx.db.insert('questions', {
      id: 'q0', project_id: 'p1', kind: 'exercise', origin: 'generated', statement: 'Nuovo.', hint: '', solution: 'Sì.', difficulty: 'medio',
      topic_ids: [], chapter_id: 'c1', status: 'draft', checks: [], rev: 1, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
    });
    const r = backportProject(ctx, 'p1', dir, { dryRun: true });
    assert.match(r.bookRefusal ?? '', /does not hold the same exercises as the books/);
    assert.deepEqual(r.changes, []);
  });

  test('a formula added in the builder after the publish refuses the book, since it can shift the formula numbers', () => {
    seed({ [CH]: AUDIT_EDITS[CH] });
    const head = currentHead(ctx, 'p1', 's1')!;
    rewriteHead(ctx, 'p1', 's1', (m) => `:::formula{key="nuova" label="Nuova"}\n$$a = b$$\n:::\n\n${m}`, { origin: 'human', expectedHeadId: head.id });
    const r = backportProject(ctx, 'p1', dir, { dryRun: true });
    assert.match(r.bookRefusal ?? '', /numbers its formulas differently/);
    assert.deepEqual(r.changes, []);
  });
});

test('the simulation of a graph write keeps a failed independent check when the payload is the builder\'s own, as the write does', () => {
  const input = book();
  const g = input.enrichments[0]!;
  Object.assign(g, { status: 'issue', checks: [{ method: 'numeric', ok: true, detail: 'ok' }, { method: 'independent', ok: false, detail: 'differs' }] });
  assert.equal(applyChanges(input, [{ kind: 'graph', enrichmentId: 'g1', payload: PARABOLA }]).enrichments[0]!.status, 'issue');
  const edited = { ...PARABOLA, title: 'Moto accelerato, corretto' };
  assert.equal(applyChanges(input, [{ kind: 'graph', enrichmentId: 'g1', payload: edited }]).enrichments[0]!.status, 'verified', 'an edit drops the check that was about the old graph');
});
