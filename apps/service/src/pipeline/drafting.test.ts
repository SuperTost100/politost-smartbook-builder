// How a section is drafted: order inside a chapter, the answer format, the prompt layout and the writer's self-check.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { META_SEPARATOR } from '../llm/body.ts';
import { FakeFunnel, makeCtx, seedPage, seedProject, seedResource, usageOf, written } from '../llm/testkit.ts';
import { Queue, TaskError, type TaskContext } from '../queue/queue.ts';
import type { AppContext } from '../context.ts';
import { evidenceText, sectionDraft } from './draft.ts';
import { symbolsIn } from './exam.ts';
import { draftPrompt, selfCheckPrompt } from './prompts.ts';
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
    assert.match(a.prompt, /Write the section "Sezione 1\.1" \(section id s1\)\.\nObjectives:\n- Obiettivo 1\.1\n[\s\S]*Depth: standard \(about 800-1500 words\)\nAnswer in the format of the instructions: the section, a line holding only <<<META>>>, then the JSON object\.$/);
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

describe('a draft keeps its citations when an image block is removed', () => {
  test('the citation of a paragraph after a dropped figure stays on that paragraph', async () => {
    seedOutline([['c1', ['s1']]]);
    const body = 'Una resistenza vale $R = 2\\,\\mathrm{k\\Omega}$.\n\n:::image{src="assets/non-costruita.svg" alt="x"}\n:::\n\nCon $i = 3\\,\\mathrm{mA}$ si ha $V = 5\\,\\mathrm{V}$. [[n7]]';
    fake.next(written({ markdown: body }));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    const row = ctx.db.get<{ markdown: string; citations: string }>(`SELECT markdown, citations FROM content_revisions WHERE node_id = 's1' AND status = 'current'`)!;
    assert.ok(!row.markdown.includes(':::image'), 'the dangling image block is removed');
    assert.deepEqual(JSON.parse(row.citations), { '1': ['n7'] });
  });
});

describe('the writer checks its own draft', () => {
  const ohm = ':::formula{key="legge-ohm" label="Legge di Ohm"}\n$$V = R\\,i$$\n:::';
  const first = `Una resistenza vale $R = 2\\,\\mathrm{k\\Omega}$.\n\n### La legge\n\n${ohm}\n\nCon $i = 3\\,\\mathrm{mA}$ si ha $V = 5\\,\\mathrm{V}$.`;
  const fixed = first.replace('$V = 5\\,\\mathrm{V}$', '$V = 6\\,\\mathrm{V}$');
  const live = (id: string, answer: () => { text: string; usage: ReturnType<typeof usageOf> }) => () => { fake.live.add(id); return { ...answer(), sessionId: id }; };
  const seed = () => { seedOutline([['c1', ['s1']]]); options({ selfCheck: true }); };

  test('on by default, and OK keeps the draft', async () => {
    seedOutline([['c1', ['s1']]]);
    ctx.db.run(`UPDATE projects SET options = '{}' WHERE id = ?`, P);
    fake.next(live('w1', written({ markdown: first, summary: 'Ohm.' })), plain('OK'));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.selfCheck, 'ok');
    assert.equal(r.status, 'current');
    assert.equal(current('s1'), first);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].sessionId, 'w1', 'the question goes to the conversation that wrote the draft');
    assert.match(fake.calls[1].prompt, /^Check the section you just wrote once more[\s\S]*every computation and numeric result with its unit and sign[\s\S]*every reference to a formula key[\s\S]*answer exactly OK/);
    assert.doesNotMatch(fake.calls[1].prompt, /OUTPUT FORMAT/, 'the live session already has the rules');
    assert.deepEqual(fake.closed, ['w1'], 'the conversation is closed afterwards');
  });

  test('a corrected answer in the same format replaces the draft, with its own summary', async () => {
    seed();
    fake.next(live('w1', written({ markdown: first, summary: 'Ohm.' })), written({ markdown: fixed, summary: 'Ohm, corretto.' }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.selfCheck, 'corrected');
    assert.equal(r.summary, 'Ohm, corretto.');
    assert.equal(current('s1'), fixed);
  });

  test('a correction that loses a formula key, a heading or a block is not used', async () => {
    for (const worse of [fixed.replace(ohm, '$$V = R\\,i$$'), fixed.replace('### La legge\n\n', ''), fixed.replace('legge-ohm', 'ohm')]) {
      ctx.db.run('DELETE FROM content_revisions');
      seed();
      fake.next(live('w1', written({ markdown: first })), written({ markdown: worse }));
      const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
      assert.equal(r.selfCheck, 'kept');
      assert.equal(current('s1'), first);
    }
  });

  test('a correction that deletes an uncited worked example from the middle of the draft is not used', async () => {
    const example = 'Esempio svolto: un resistore da cento ohm collegato a una pila da nove volt lascia passare una corrente di novanta milliampere.';
    const long = first.replace('Con $i = 3', `${example}\n\nCon $i = 3`);
    assert.notEqual(long, first);
    seed();
    fake.next(live('w1', written({ markdown: long })), written({ markdown: long.replace(`${example}\n\n`, '').replace('5\\,\\mathrm{V}', '6\\,\\mathrm{V}') }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.selfCheck, 'kept');
    assert.match(String(r.selfCheckNote), /Esempio svolto/);
    assert.equal(current('s1'), long);
  });

  test('a correction that opens with a note about itself is not used', async () => {
    seed();
    fake.next(live('w1', written({ markdown: first })), written({ markdown: `Ho corretto un passaggio e una forma grammaticale. Il resto torna.\n\n${fixed}` }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.selfCheck, 'kept');
    assert.equal(current('s1'), first);
  });

  test('a correction that loses a citation marker of the draft is not used, and the reason is recorded', async () => {
    const cited = first.replace('Una resistenza vale $R = 2\\,\\mathrm{k\\Omega}$.', 'Una resistenza vale $R = 2\\,\\mathrm{k\\Omega}$. [[n1]]').replace('si ha $V = 5\\,\\mathrm{V}$.', 'si ha $V = 5\\,\\mathrm{V}$. [[n2,n3]]');
    const citedFixed = cited.replace('$V = 5\\,\\mathrm{V}$', '$V = 6\\,\\mathrm{V}$');
    const withoutMarkers = citedFixed.replace(/ \[\[[^\]]+\]\]/g, '');
    seed();
    fake.next(live('w1', written({ markdown: cited })), written({ markdown: withoutMarkers }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.selfCheck, 'kept');
    assert.match(String(r.selfCheckNote), /citation/);
    assert.equal(current('s1'), first);
    const stored = ctx.db.get<{ citations: string }>(`SELECT citations FROM content_revisions WHERE node_id = 's1' AND status = 'current'`)!.citations;
    assert.deepEqual(JSON.parse(stored), { '0': ['n1'], '3': ['n2', 'n3'] });

    // The same correction with every marker kept is used, and so is one that rewrites a whole cited paragraph.
    ctx.db.run('DELETE FROM content_revisions');
    seed();
    fake.next(live('w2', written({ markdown: cited })), written({ markdown: citedFixed }));
    const kept = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(kept.selfCheck, 'corrected');
    assert.equal(current('s1'), fixed);

    ctx.db.run('DELETE FROM content_revisions');
    seed();
    const middle = (body: string) => `Una resistenza vale $R = 2\\,\\mathrm{k\\Omega}$.\n\n${body}\n\nCon $i = 3\\,\\mathrm{mA}$ si ha $V = 5\\,\\mathrm{V}$.`;
    const old = middle('Il rapporto tra tensione e corrente è costante per un conduttore ohmico, [[n4]]');
    const rewritten = middle('Un componente passivo oppone una resistenza costante al passaggio della corrente, misurata in ohm.');
    fake.next(live('w3', written({ markdown: old })), written({ markdown: rewritten }));
    const whole = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(whole.selfCheck, 'corrected', 'a paragraph rewritten whole may lose its marker');
  });

  test('the follow-up tells the writer to keep every citation marker where it is', () => {
    assert.match(selfCheckPrompt(), /Keep every \[\[n…\]\] marker where it is/);
  });

  test('the follow-up says that its answer goes into the book as it is', () => {
    assert.match(selfCheckPrompt(), /do not say what you checked or changed: no sentence before the section or after it/);
  });

  test('a correction that does not parse, or a failed follow-up, keeps the draft and the task still succeeds', async () => {
    seed();
    fake.next(live('w1', written({ markdown: first })), plain('Ho trovato un errore: la tensione è 6 V.'));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.selfCheck, 'kept');
    assert.equal(current('s1'), first);
    assert.equal(fake.calls.length, 2, 'no repair turn for a follow-up');

    ctx.db.run('DELETE FROM content_revisions');
    fake.next(live('w2', written({ markdown: first })), () => new TaskError('limit reached', 'quota', undefined, 60_000));
    const failed = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(failed.selfCheck, 'kept');
    assert.equal(current('s1'), first);
  });

  test('a task that is cancelled during the check stops instead of keeping the draft', async () => {
    seed();
    const abort = new AbortController();
    fake.next(live('w1', written({ markdown: first })), () => { abort.abort(new Error('cancelled')); throw new Error('cancelled'); });
    const t = { ...startTask('section.draft', { nodeId: 's1' }), signal: abort.signal };
    await assert.rejects(sectionDraft(ctx, t));
    assert.equal(ctx.db.all('SELECT 1 FROM content_revisions').length, 0);
  });

  test('the book option turns it off, and then the draft is the first answer', async () => {
    seedOutline([['c1', ['s1']]]);
    options({ selfCheck: false });
    fake.next(written({ markdown: first }));
    const r = await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    assert.equal(r.selfCheck, 'skipped');
    assert.equal(fake.calls.length, 1);
  });
});

describe('no padding, and examples only where they teach', () => {
  const input = (depth: string, language = 'it') => ({
    language, bookTitle: 'T', audience: '', notation: '', chapterTitle: 'C', chapterPlan: '', section: { id: 's', title: 'S', objectives: ['o'], depth, subsections: '' },
    topics: '', earlier: '', knownFormulas: '', sectionIds: '', evidence: '', pages: '', summary: '', figures: null, outside: false,
  });

  test('the worked example and the typical-mistake box are for sections that teach a method, and padding is forbidden once', () => {
    const p = draftPrompt(input('standard'));
    const all = `${p.system}\n${p.prompt}`;
    assert.match(p.system, /When the section teaches a method or a computation, add at least one fully worked example and a typical-mistake box \("Errore tipico"\); when it does not, leave both out/);
    assert.match(draftPrompt(input('standard', 'en')).system, /typical-mistake box \("Common mistake"\)/);
    assert.doesNotMatch(all, /at least one fully worked example, typical mistakes|give worked examples with every step, and point out the mistakes students usually make/);
    assert.equal(all.match(/Never add sentences to reach a length/g)?.length, 1);
  });

  test('the writer is told once, in the static part of the prompt, never to speak of its sources to the reader', () => {
    const rule = /The book never mentions its sources or what they contain: never write "the notes", "the material provided" or "the evidence", and never say that something is or is not in them\./;
    const a = draftPrompt(input('standard'));
    assert.match(a.system, rule);
    assert.equal(a.system.match(/never mentions its sources/g)?.length, 1);
    assert.doesNotMatch(a.prompt, /never mentions its sources/);
    assert.equal(draftPrompt({ ...input('brief', 'en'), outside: true, section: { id: 'x', title: 'Y', objectives: ['p'], depth: 'brief', subsections: '' } }).system.match(rule)?.length, 1, 'the same text for every section and book');
  });

  test('the length ranges are the same as before', () => {
    for (const [depth, range] of [['brief', '400-800'], ['standard', '800-1500'], ['deep', '1200-2200']]) assert.match(draftPrompt(input(depth)).prompt, new RegExp(`Depth: ${depth} \\(about ${range} words\\)`));
  });
});

describe('the writer gets the symbols the exam papers use for the section\'s topics', () => {
  const T = 'topic-filtri';
  const exam = (statement: string, o: Record<string, unknown> = {}) => ctx.db.insert('questions', {
    id: newId(), project_id: P, kind: 'exam', origin: 'authentic', resource_id: null, exam_group: 'Appello del 12 febbraio 2024', exam_date: '2024-02-12', number: '1',
    statement, hint: '', solution: '', difficulty: 'medio', topic_ids: [T], status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(), ...o,
  });
  const section = async () => {
    seedOutline([['c1', ['s1']]]);
    ctx.db.insert('topics', { id: T, project_id: P, name: 'Filtro RC', aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 1, priority: 'high' });
    ctx.db.run(`UPDATE outline_revisions SET outline = json_set(outline, '$.chapters[0].sections[0].topicIds', json_array(?))`, T);
    fake.next(written({ markdown: 'Il filtro.' }));
    await sectionDraft(ctx, startTask('section.draft', { nodeId: 's1' }));
    return fake.calls[0].prompt;
  };

  test('the symbols of the questions on the section\'s topics are in the section part of the prompt, with the rule for using them', async () => {
    // The two exam questions of the acceptance run use f_c where the writer had written f_t.
    exam('Calcolare la frequenza di taglio $f_c$ del filtro con $R_1 = 1\\,\\mathrm{k\\Omega}$.');
    exam('Calcolare $|H|$ alla frequenza di taglio $f_c$ e la tensione $v_{out}$.', { number: '2' });
    exam('Una domanda su un altro argomento con $q_p$.', { topic_ids: ['altro'], number: '3' });
    const prompt = await section();
    assert.match(prompt, /Topics and how often the exams test them:\n- Filtro RC: 1 of 1 exam sessions \(high priority\)\nSymbols used in the exam papers on these topics: f_c, R_1, v_\{out\}\. Use them for the same quantities, unless they conflict with the book's notation above\./);
    assert.doesNotMatch(prompt, /q_p/, 'a question of another topic does not count');
    assert.ok(prompt.indexOf('Symbols used in the exam papers') > prompt.indexOf('Known formula keys'), 'it is in the part that differs between sections');
  });

  test('without exam questions on the topics there is no such line, and a question of an excluded source does not count', async () => {
    seedResource(ctx, { id: 'r-ex', projectId: P, role: 'exams', included: 0 });
    exam('Calcolare $f_c$.', { resource_id: 'r-ex' });
    assert.doesNotMatch(await section(), /Symbols used in the exam papers/);
  });

  test('symbolsIn: LaTeX and plain subscripts, Unicode digits, counted once per question, most frequent first', () => {
    assert.deepEqual(symbolsIn([
      'Calcolare $f_c$ e $f_{c}$ e f_c.', 'Il valore $V_0 = 12$ e R₁ = 3 kΩ, poi v_C(t).', '$f_c$ e $v_C$ con $\\omega_c$ e $t_{90}$.', 'Nessun simbolo con pedice, solo $x + y$ e snake_case_word.',
    ]), ['f_c', 'v_C', 'V_0', 'R_1', '\\omega_c', 't_{90}']);
    assert.deepEqual(symbolsIn([]), []);
  });

  test('symbolsIn: a subscript of several Unicode digits is the same symbol as its LaTeX form', () => {
    assert.deepEqual(symbolsIn(['Il resistore R₁₀ = 3 kΩ e $R_{10}$.', 'Anche R₁₀ e V₀.']), ['R_{10}', 'V_0']);
  });
});

describe('the writer gets page text only where the quotes are not enough', () => {
  const note = (id: string, page: number) => ({ id, quote: `Citazione ${id}`, resourceId: 'r1', page, verified: true, claim: '' });
  const packet = (notes: ReturnType<typeof note>[]) => ({ id: 'e1', projectId: P, nodeId: 's1', provider: 'local' as const, query: '', answer: 'Sintesi.', notes, createdAt: '' });

  test('a page with a good text layer is not sent whole, and at most two transcribed pages are', () => {
    seedResource(ctx, { id: 'r1', projectId: P, filename: 'appunti.pdf' });
    seedPage(ctx, 'r1', 0, 'Testo buono della pagina 1.');
    seedPage(ctx, 'r1', 1, 'testo illeggibile', 'Trascrizione pulita della pagina 2.');
    seedPage(ctx, 'r1', 2, 'testo illeggibile', 'Trascrizione pulita della pagina 3.');
    seedPage(ctx, 'r1', 3, 'testo illeggibile', 'Trascrizione pulita della pagina 4.');
    // Page 1 is cited most, then 2, 3 and 4.
    const notes = [note('n1', 0), note('n2', 0), note('n3', 0), note('n4', 1), note('n5', 1), note('n6', 2), note('n7', 2), note('n8', 3)];
    const ev = evidenceText(ctx, packet(notes));
    assert.doesNotMatch(ev.pages, /Testo buono/);
    assert.match(ev.pages, /appunti\.pdf, page 2 ---\nTrascrizione pulita della pagina 2\./);
    assert.match(ev.pages, /page 3 ---\nTrascrizione pulita della pagina 3\./);
    assert.doesNotMatch(ev.pages, /pagina 4/);
    assert.match(ev.notes, /\[n1\] \(appunti\.pdf, p\. 1\) "Citazione n1"/, 'every verified quote is still sent');
    assert.equal(ev.summary, 'Sintesi.');
  });

  test('a source excluded after the evidence was gathered stays out of what the writer and the reviewer are sent', () => {
    seedResource(ctx, { id: 'r1', projectId: P, filename: 'appunti.pdf' });
    seedResource(ctx, { id: 'r2', projectId: P, filename: 'riservato.pdf', included: 0 });
    seedPage(ctx, 'r2', 0, 'testo illeggibile', 'Trascrizione della pagina riservata.');
    const web = { id: 'w1', quote: 'Citazione dal web', resourceId: null, page: null, url: 'https://example.org/a', verified: true, claim: '' };
    const notes = [note('n1', 0), { ...note('n2', 0), resourceId: 'r2' }, { ...note('n3', 0), resourceId: 'r2' }, web];
    const ev = evidenceText(ctx, packet(notes as never));
    assert.match(ev.notes, /\[n1\] \(appunti\.pdf, p\. 1\)/);
    assert.match(ev.notes, /\[w1\] \(https:\/\/example\.org\/a\)/, 'a note from the web has no source to exclude');
    assert.doesNotMatch(ev.notes, /n2|n3|riservato/);
    assert.equal(ev.pages, '', 'its transcribed page is not sent either');
    assert.equal(ev.summary, '', 'the reader\'s answer was written from that source too, so it is left out');
    // Included again, everything is back.
    ctx.db.run(`UPDATE resources SET included = 1 WHERE id = 'r2'`);
    const back = evidenceText(ctx, packet(notes as never));
    assert.match(back.notes, /\[n2\] \(riservato\.pdf, p\. 1\)/);
    assert.match(back.pages, /Trascrizione della pagina riservata\./);
    assert.equal(back.summary, 'Sintesi.');
  });

  test('the reader\'s answer is left out while a source that was in the book when the evidence was gathered is excluded, whatever its notes say', () => {
    seedResource(ctx, { id: 'r1', projectId: P, filename: 'appunti.pdf' });
    seedResource(ctx, { id: 'r2', projectId: P, filename: 'riservato.pdf', included: 0 });
    ctx.db.run(`UPDATE resources SET created_at = '2026-11-12T12:00:00.000Z' WHERE id = 'r2'`);
    const at = (createdAt: string) => ({ ...packet([note('n1', 0)]), createdAt });
    // The answer may draw on a page of the excluded source without any note saying so, and nothing records which sources it read.
    const after = evidenceText(ctx, at('2026-11-12T13:00:00.000Z'));
    assert.equal(after.summary, '');
    assert.match(after.notes, /\[n1\]/, 'the quotes of the other sources are still sent');
    assert.equal(evidenceText(ctx, at('')).summary, '', 'a packet without a date is not known to be older than the source');
    // Evidence gathered before the excluded source was uploaded cannot have read it.
    assert.equal(evidenceText(ctx, at('2026-11-12T10:00:00.000Z')).summary, 'Sintesi.');
    // With no excluded source there is nothing to keep out.
    ctx.db.run(`UPDATE resources SET included = 1 WHERE id = 'r2'`);
    assert.equal(evidenceText(ctx, at('2026-11-12T13:00:00.000Z')).summary, 'Sintesi.');
  });

  test('a packet whose pages have no transcript sends no page text', () => {
    seedResource(ctx, { id: 'r1', projectId: P });
    seedPage(ctx, 'r1', 0, 'Testo buono.');
    assert.equal(evidenceText(ctx, packet([note('n1', 0)])).pages, '');
  });
});
