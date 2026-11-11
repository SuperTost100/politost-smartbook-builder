// How a section is drafted: order inside a chapter, the answer format, the prompt layout and the writer's self-check.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { META_SEPARATOR } from '../llm/body.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf, written } from '../llm/testkit.ts';
import { Queue, TaskError, type TaskContext } from '../queue/queue.ts';
import type { AppContext } from '../context.ts';
import { sectionDraft } from './draft.ts';
import { generateSpecs } from './runs.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  ctx = kit.ctx;
  ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(ctx, P);
});
afterEach(() => {
  setFunnel(null);
  kit.cleanup();
});

/** Approved outline: chapters of [chapterId, sectionIds], optionally closed by an exam guide. */
function seedOutline(chapters: [string, string[]][], o: { guides?: boolean } = {}) {
  const outline = {
    chapters: chapters.map(([id, sections], i) => ({
      id, slug: `cap-${i + 1}`, title: `Capitolo ${i + 1}`, objectives: [], prerequisites: [],
      sections: [
        ...sections.map((sid, j) => ({ id: sid, title: `Sezione ${i + 1}.${j + 1}`, objectives: [`Obiettivo ${i + 1}.${j + 1}`], topicIds: [], depth: 'standard', subsections: [] })),
        ...(o.guides ? [{ id: `${id}-guide`, title: 'Come viene chiesto', objectives: [], topicIds: [], depth: 'standard', subsections: [], role: 'exam-guide' }] : []),
      ],
    })),
    exclusions: [], notation: '',
  };
  const id = newId();
  ctx.db.insert('outline_revisions', { id, project_id: P, outline, origin: 'human', note: '', created_at: now(), approved_at: now() });
  ctx.db.run('UPDATE projects SET outline_rev_id = ? WHERE id = ?', id, P);
  return outline;
}

const options = (o: Record<string, unknown>) => ctx.db.run('UPDATE projects SET options = ? WHERE id = ?', JSON.stringify(o), P);

describe('sections of a chapter are written in order', () => {
  const draftDeps = (specs: { key: string; deps?: string[] }[]) => Object.fromEntries(specs.filter((s) => s.key.startsWith('draft:')).map((s) => [s.key, s.deps]));

  test('a draft waits for the draft before it in its chapter, and chapters stay independent', () => {
    seedOutline([['c1', ['s1', 's2', 's3']], ['c2', ['s4', 's5']]]);
    options({ firstChapterGate: true });
    const deps = draftDeps(generateSpecs(ctx, P));
    assert.deepEqual(deps['draft:s1'], ['evidence:s1']);
    assert.deepEqual(deps['draft:s2'], ['evidence:s2', 'draft:s1']);
    assert.deepEqual(deps['draft:s3'], ['evidence:s3', 'draft:s2']);
    assert.deepEqual(deps['draft:s4'], ['evidence:s4'], 'the next chapter does not wait for the previous one');
    assert.deepEqual(deps['draft:s5'], ['evidence:s5', 'draft:s4']);
  });

  test('the first-chapter gate and the exam guide keep their dependencies', () => {
    seedOutline([['c1', ['s1', 's2']], ['c2', ['s3', 's4']]], { guides: true });
    options({ firstChapterGate: true });
    const specs = generateSpecs(ctx, P);
    const by = Object.fromEntries(specs.map((s) => [s.key, s.deps]));
    assert.deepEqual(by['evidence:s3'], ['gate:first-chapter']);
    assert.deepEqual(by['evidence:s1'], []);
    assert.deepEqual(by['draft:c2-guide'], ['gate:first-chapter', 'draft:s3', 'draft:s4'], 'the guide waits for every section of its chapter, and the last section is not repeated');
    assert.deepEqual(by['draft:s4'], ['evidence:s4', 'draft:s3']);
    assert.deepEqual(by['gate:first-chapter'], ['review:c1', 'practice-done:c1']);
  });

  test('a scoped run waits only for the earlier sections it contains', () => {
    seedOutline([['c1', ['s1', 's2', 's3']]]);
    const specs = generateSpecs(ctx, P, undefined, ['s2', 's3']);
    assert.deepEqual(draftDeps(specs), { 'draft:s2': ['evidence:s2'], 'draft:s3': ['evidence:s3', 'draft:s2'] });
  });

  test('a failed section blocks only its successors, and retrying it lets the chapter go on', async () => {
    seedOutline([['c1', ['s1', 's2', 's3']], ['c2', ['s4']]]);
    options({ firstChapterGate: false });
    const specs = generateSpecs(ctx, P).filter((s) => s.kind === 'section.evidence' || s.kind === 'section.draft');
    const queue = new Queue(ctx.db, ctx.events, () => 2);
    const written: string[] = [];
    let healthy = false;
    queue.register('section.evidence', async () => ({ ok: true }));
    queue.register('section.draft', async (t) => {
      const id = t.task.input.nodeId as string;
      if (id === 's2' && !healthy) throw new TaskError('The model answered nonsense.', 'fatal');
      written.push(id);
      return { nodeId: id };
    });
    const runId = queue.createRun(P, 'generate', specs);
    const until = async (fn: () => boolean) => { for (let i = 0; i < 250 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn(), 'timed out'); };
    queue.start();
    try {
      await until(() => queue.runSummary(runId)!.status === 'failed');
      const state = (section: string) => queue.tasks(runId).find((t) => t.kind === 'section.draft' && t.label === `Write "Sezione ${section}"`)!;
      assert.equal(state('1.2').state, 'failed');
      assert.equal(state('1.3').state, 'cancelled');
      assert.equal(state('1.3').error?.message, 'Not run: an earlier task failed.', 'the cause shows on the task that failed, and the successor says why it did not run');
      assert.deepEqual(written.sort(), ['s1', 's4'], 'the other chapter was not held up');
      healthy = true;
      queue.retry(runId, [state('1.2').id]);
      await until(() => queue.runSummary(runId)!.status === 'completed');
      assert.deepEqual(written.sort(), ['s1', 's2', 's3', 's4']);
    } finally {
      await queue.stop();
    }
  });
});

/** A running task with a TaskContext, as the queue would hand it to a handler. */
function startTask(kind: string, input: Record<string, unknown>): TaskContext {
  const runId = newId();
  ctx.db.insert('runs', { id: runId, project_id: P, kind: 'generate', status: 'running', snapshot: {}, created_at: now() });
  const id = newId();
  const key = `${kind}:${id}`;
  ctx.db.insert('tasks', { id, run_id: runId, project_id: P, kind, label: kind, key, input, state: 'running', pool: 'local', attempts: 1, max_attempts: 3, created_at: now() });
  return {
    task: { id, runId, projectId: P, kind, key, label: kind, input, attempts: 1 }, signal: new AbortController().signal, deps: {},
    enqueue: (specs) => ctx.queue.addTasks(runId, P, specs), progress: () => undefined, setProvider: () => undefined,
  };
}
const current = (nodeId: string) => ctx.db.get<{ markdown: string }>(`SELECT markdown FROM content_revisions WHERE node_id = ? AND status = 'current'`, nodeId)!.markdown;
const plain = (t: string) => () => ({ text: t, usage: usageOf(10, 10) });

describe('the long text travels outside JSON', () => {
  const circuit = 'Per la maglia vale:\n\n$$\n\\begin{aligned}\ni_1 &= \\frac{V}{R} \\\\\nu_2 &= R\\,i_1\n\\end{aligned}\n$$\n\nCon $\\nu \\neq \\theta$ e $\\beta$.';

  test('a first row that starts with i, \\nu and \\neq are stored as the writer wrote them', async () => {
    seedOutline([['c1', ['s1']]]);
    fake.next(written({ markdown: circuit, summary: 'La maglia.' }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.status, 'current');
    assert.equal(r.summary, 'La maglia.');
    assert.equal(current('s1'), circuit);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].responseSchema, undefined, 'no JSON schema is sent for a text answer');
  });

  test('an answer without the separator gets one repair turn that says what is missing', async () => {
    seedOutline([['c1', ['s1']]]);
    fake.next(plain('Solo il testo della sezione.'), written({ markdown: 'Testo della sezione.' }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.status, 'current');
    assert.equal(current('s1'), 'Testo della sezione.');
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[1].prompt, /<<<META>>> is missing/);
    assert.match(fake.calls[1].prompt, /full corrected answer in the same format/);
  });

  test('a second answer without it fails the task with the reason', async () => {
    seedOutline([['c1', ['s1']]]);
    fake.next(plain('Solo testo.'), plain('Ancora solo testo.'));
    await assert.rejects(
      sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' })),
      (e: unknown) => e instanceof TaskError && e.kind === 'input' && /invalid answer twice: The line <<<META>>> is missing/.test(e.message),
    );
    assert.equal(fake.calls.length, 2);
    assert.equal(ctx.db.all('SELECT 1 FROM content_revisions').length, 0);
  });

  test('the repair of a formatting problem is plain text too, and keeps what the writer wrote', async () => {
    seedOutline([['c1', ['s1']]]);
    fake.next(written({ markdown: 'Il valore è [?] ohm.\n\nCon $\\nu_1$ a riga:\n\n$$\ni_1 = 2\n$$' }), plain('Il valore è 5 ohm.\n\nCon $\\nu_1$ a riga:\n\n$$\ni_1 = 2\n$$'));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.status, 'current');
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].responseSchema, undefined);
    assert.match(`${fake.calls[1].system}\n${fake.calls[1].prompt}`, /Answer with the corrected section as plain text and nothing else/);
    assert.equal(current('s1'), 'Il valore è 5 ohm.\n\nCon $\\nu_1$ a riga:\n\n$$\ni_1 = 2\n$$');
  });
});

/** Finishes a task the way the queue does, so the writers of later sections can read its summary. */
const finish = (t: TaskContext, result: unknown) => ctx.db.run(`UPDATE tasks SET state = 'succeeded', result = ?, finished_at = ? WHERE id = ?`, JSON.stringify(result), now(), t.task.id);

describe('the draft prompt goes from what every section shares to what only this one has', () => {
  const ohm = ':::formula{key="legge-ohm" label="Legge di Ohm"}\n$$V = R\\,i$$\n:::';

  async function twoSections() {
    seedOutline([['c1', ['s1', 's2']]]);
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.notation', 'Tensioni $v$, correnti $i$.')`);
    fake.next(written({ markdown: `Una resistenza.\n\n${ohm}`, summary: 'Definita la resistenza e la legge di Ohm.' }), written({ markdown: 'Il partitore.', summary: 'Il partitore di tensione.' }));
    const t1 = startTask('section.draft', { nodeId: 's1' });
    finish(t1, await sectionDraft(ctx, t1));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: 's2' }));
    return fake.calls.slice(0, 2);
  }

  test('two sections of one chapter share the system prompt and the start of the user prompt, as far as the book and the chapter go', async () => {
    const [a, b] = await twoSections();
    assert.equal(a.system, b.system);
    const shared = (x: string, y: string) => { let n = 0; while (n < x.length && x[n] === y[n]) n++; return n; };
    // The book block (notation, section ids) and the chapter plan come before the first thing that differs between sections.
    const bookAndChapter = a.prompt.indexOf('Known formula keys');
    assert.ok(bookAndChapter > 0);
    assert.ok(shared(a.prompt, b.prompt) >= bookAndChapter, `the prompts first differ at ${shared(a.prompt, b.prompt)}, before "Known formula keys" at ${bookAndChapter}`);
    assert.match(a.prompt.slice(0, bookAndChapter), /Notation to follow:\nTensioni \$v\$, correnti \$i\$\.[\s\S]*Section ids you may link to:\ns1: Sezione 1\.1\ns2: Sezione 1\.2[\s\S]*Chapter plan/);
    assert.doesNotMatch(a.prompt.slice(0, bookAndChapter), /►/, 'the plan does not mark the section, so it is the same for every section');
    assert.match(a.system ?? '', /^You write one section[\s\S]*OUTPUT FORMAT[\s\S]*FIGURES[\s\S]*INSTRUCTIONS[\s\S]*<<<META>>>/);
  });

  test('the user prompt runs from the book to the chapter, the earlier sections, the evidence and the task', async () => {
    const [a] = await twoSections();
    const at = ['Notation to follow', 'Section ids you may link to', 'CHAPTER:', 'Known formula keys', 'Already written earlier', 'Topics and how often', 'EVIDENCE NOTES', 'SOURCE PAGES', 'Write the section "Sezione 1.1"'].map((h) => a.prompt.indexOf(h));
    assert.ok(at.every((n) => n >= 0), String(at));
    assert.deepEqual([...at].sort((x, y) => x - y), at);
    assert.match(a.prompt, /Write the section "Sezione 1\.1" \(section id s1\)\.\nObjectives:\n- Obiettivo 1\.1\n[\s\S]*Depth: standard \(about 800-1500 words\)$/);
  });

  test('section 2 reads the summary and the formula keys of section 1', async () => {
    const [, b] = await twoSections();
    assert.match(b.prompt, /Already written earlier in the book[^\n]*\n- Sezione 1\.1 \[s1\]: Definita la resistenza e la legge di Ohm\./);
    assert.match(b.prompt, /Known formula keys[^\n]*\nlegge-ohm: Legge di Ohm/);
  });

  test('the repair prompt has the static rules in the system prompt, then the section, then the problems', async () => {
    seedOutline([['c1', ['s1']]]);
    fake.next(written({ markdown: 'Il valore è [?] ohm.' }), plain('Il valore è 5 ohm.'));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    const repair = fake.calls[1];
    assert.match(repair.system ?? '', /^You fix formatting problems[\s\S]*OUTPUT FORMAT[\s\S]*Answer with the corrected section as plain text/);
    assert.match(repair.prompt, /^SECTION:\nIl valore è \[\?\] ohm\.\n\nThe section above has these problems \(rule: message, line, text\):\nplaceholder:/);
  });
});
