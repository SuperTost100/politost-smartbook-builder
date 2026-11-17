import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { compileBook, type BookInput } from '@smartbuilder/content';
import type { Question } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId } from '../db/db.ts';
import { makeCtx, seedProject } from '../llm/testkit.ts';
import { currentHead, getQuestion, listRevisions, loadBookInput, storeAsset } from '../repo/index.ts';
import { applyChanges, backportProject, planBackport } from './backport.ts';

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
    enrichments: [{ id: 'g1', projectId: 'p1', nodeId: 's1', kind: 'graph', payload: PARABOLA, status: 'verified', checks: [], createdAt: '2026-01-01T00:00:00Z' }],
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

  test('a unit the new compile does not reproduce is refused', () => {
    const input = book();
    // The compiler writes every heading of a section as ###, so a ## heading added by hand cannot come out as written.
    const plan = planBackport(input, published(input, { [CH]: (s) => s.replace('Tre casi:', '## Casi\n\nTre casi:') }));
    assert.deepEqual(plan.units.map((u) => [u.unit, u.status, u.reason]), [[`${CH}#p1`, 'refused', 'the new compile does not reproduce the books text']]);
    assert.deepEqual(plan.changes, []);
  });

  test('a graph the builder check fails, and a unit that changed in the builder since the export, are refused', () => {
    const input = book();
    const plan = planBackport(input, published(input, {
      'grafici.json': (s) => s.replace('"x^2"', '"sqrt(-1-x^2)"'),
      'esercizi.md': AUDIT_EDITS['esercizi.md'],
    }), { conflict: (c) => (c.kind === 'question' ? 'changed in the builder' : null) });
    assert.equal(statusOf(plan, 'grafici.json#parabola'), 'refused');
    assert.match(plan.units.find((u) => u.unit === 'grafici.json#parabola')!.reason!, /graph check fails/);
    assert.equal(plan.units.find((u) => u.unit === 'esercizi.md#E1.1')!.reason, 'changed in the builder');
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

  test('changes with no source are unmapped: an added exercise, a figure file', () => {
    const input = book();
    const plan = planBackport(input, published(input, {
      'esercizi.md': (s) => `${s}\n:::exercise{id="E1.9" chapter="1" difficulty="medio"}\n## Domanda\nNuovo.\n:::\n`,
      'assets/fig.svg': (s) => s.replace('<rect', '<circle'),
    }));
    assert.deepEqual(plan.units.map((u) => [u.unit, u.status]), [['assets/fig.svg', 'unmapped'], ['esercizi.md#E1.9', 'unmapped']]);
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

describe('backportProject', () => {
  let kit: ReturnType<typeof makeCtx>;
  let ctx: AppContext;
  let dir: string;
  beforeEach(() => { kit = makeCtx(); ctx = kit.ctx; dir = mkdtempSync(join(tmpdir(), 'sb-books-')); });
  afterEach(() => { kit.cleanup(); rmSync(dir, { recursive: true, force: true }); });

  /** The fixture book stored as a project, exported at `exportedAt` into `dir` with `edit` applied. */
  function seed(exportedAt: string, edit: Record<string, (s: string) => string>) {
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
    const stored = loadBookInput(ctx, 'p1', { approvedOnly: true });
    for (const [file, bytes] of Object.entries({ ...published(stored, edit), 'ptsb.json': JSON.stringify({ createdAt: exportedAt }) })) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), bytes);
    }
  }
  const counts = () => ['content_revisions', 'questions', 'enrichments', 'assets', 'review_issues']
    .map((t) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n);

  test('a dry run writes nothing; the real run writes author edits; a second run finds nothing to do', () => {
    seed('2026-02-01T00:00:00Z', { ...AUDIT_EDITS, [CH]: (s) => AUDIT_EDITS[CH](s).replace('Moto con aₓ costante', 'Moto con aₓ costante nel tempo') });
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
    assert.match(ctx.db.get<{ payload: string }>("SELECT payload FROM enrichments WHERE id = 'g1'")!.payload, /0\.5\*x\^2/);
    const asset = ctx.db.get<{ id: string; caption: string }>("SELECT id, caption FROM assets WHERE filename = 'fig.svg'")!;
    assert.equal(asset.caption, 'Moto con aₓ costante nel tempo');
    // One event when the figure was stored, one for the caption: announced like any figure edit.
    assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type = 'asset.updated' AND data LIKE ?`, `%${asset.id}%`)!.n, 2);

    const again = backportProject(ctx, 'p1', dir);
    assert.deepEqual(again.units.map((u) => u.status), ['compiler-owned']);
    assert.equal(again.written, false);
    assert.deepEqual(again.residual.map((r) => r.file), ['ptsb.json']);
  });

  test('a section changed in the builder after the export is not overwritten', () => {
    seed('2026-01-01T12:00:00Z', { [CH]: AUDIT_EDITS[CH] });
    const r = backportProject(ctx, 'p1', dir);
    assert.equal(r.written, false);
    assert.match(r.units[0].reason!, /changed in the builder on 2026-01-02/);
    assert.equal(currentHead(ctx, 'p1', 's1')!.origin, 'ai');
  });

  test('a folder without ptsb.json is refused', () => {
    seed('2026-02-01T00:00:00Z', AUDIT_EDITS);
    rmSync(join(dir, 'ptsb.json'));
    assert.throws(() => backportProject(ctx, 'p1', dir), /no ptsb\.json/);
  });
});
