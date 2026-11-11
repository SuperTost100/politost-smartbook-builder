// The figure tasks: redraw a drawn figure and draw a new one, with scripted model answers and the real renderer.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { ensureFigurePackages, missingFigurePackages } from '../../../../scripts/fetch-figure-packages.mjs';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from '../llm/testkit.ts';
import { newId, now } from '../db/db.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { buildFigures, commitFigures, type FigureRequest } from '../figures/materialize.ts';
import { copyAsset, saveFigureDetails, swapSrc, writeFigureRevision } from '../figures/author.ts';
import { renderEditedDrawing } from '../figures/drawing/edit.ts';
import { currentHead, getAsset, listAssets, listRevisions, saveHuman } from '../repo/index.ts';
import { figureNotes } from '../figures/historyNote.ts';
import { activeRedraw, figureDraw, figureRedraw, startRedraw } from './figureEdit.ts';

const P = 'p1';
const N = 'n1node00';
const GOOD = '#circle(radius: 8pt)';
const GOOD_2 = '#rect(width: 20pt, height: 10pt)';
const say = (text: string) => () => ({ text, usage: usageOf(10, 10) });

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
const ctx = () => kit.ctx;

beforeEach(async () => {
  if (missingFigurePackages().length) await ensureFigurePackages();
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  kit.ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(kit.ctx, P);
});
afterEach(() => {
  setFunnel(null);
  kit.cleanup();
});

function task(kind: string, input: Record<string, unknown>, abort = new AbortController()): TaskContext {
  const runId = newId();
  ctx().db.insert('runs', { id: runId, project_id: P, kind: 'figure', status: 'running', snapshot: {}, created_at: now() });
  const id = newId();
  ctx().db.insert('tasks', { id, run_id: runId, project_id: P, kind, label: 'x', key: `${kind}:${id}`, input, state: 'running', pool: 'illustrator', attempts: 1, max_attempts: 2, created_at: now() });
  return { task: { id, runId, projectId: P, kind, key: `${kind}:${id}`, label: 'x', input, attempts: 1 }, signal: abort.signal, deps: {}, enqueue: () => [], progress: () => undefined, setProvider: () => undefined };
}

/** A section with a drawn figure made through the real build path, between two paragraphs. */
async function sectionWithDrawing() {
  fake.next(say(GOOD), say('OK'));
  const figure = { key: 'cerchio', kind: 'drawing', caption: 'Un cerchio', alt: 'Un cerchio', drawing: { shows: 'A circle.', family: 'sketch' } } as unknown as FigureRequest;
  const built = await buildFigures(ctx(), { projectId: P, nodeId: N, language: 'it', figures: [figure], photos: false });
  const file = built.renames.get('cerchio')!;
  const md = `Primo.\n\n:::image{src="assets/${file}" alt="Un cerchio" caption="Un cerchio"}\n:::\n\nSecondo.`;
  ctx().db.tx(() => { commitFigures(ctx(), { projectId: P, nodeId: N, built, markdown: md, replace: false, replaced: [] }); });
  const head = saveHuman(ctx(), P, N, md, null);
  fake.calls.length = 0;
  return { assetId: built.assets[0].id, file, head };
}

const sourceOf = (id: string) => (getAsset(ctx(), id).spec as { source: string }).source;

describe('redraw task', () => {
  test('the redrawn figure is a new asset the text points at, and the earlier revision still shows the earlier drawing', async () => {
    const { assetId, file, head } = await sectionWithDrawing();
    fake.next(say(GOOD_2), say('OK'));
    const out = await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'Use a rectangle.' })) as { assetId: string; revId: string };
    const now = currentHead(ctx(), P, N)!;
    assert.equal(now.id, out.revId);
    assert.equal(now.origin, 'ai');
    assert.ok(!now.markdown.includes(`assets/${file}"`));
    assert.equal(sourceOf(out.assetId), GOOD_2);
    assert.ok(now.markdown.includes(`assets/${getAsset(ctx(), out.assetId).filename}"`));
    // History: the first revision names the first asset, which still has its first source.
    const first = listRevisions(ctx(), P, N).find((r) => r.id === head.id)!;
    assert.ok(first.markdown.includes(`assets/${file}"`));
    assert.equal(sourceOf(assetId), GOOD);
    assert.match(fake.calls[0].prompt, /asks for this change: Use a rectangle\./);
  });

  test('a redraw of a figure the author rendered gets the rendered source, not the one the figure was first drawn with, and is told to keep the rest', async () => {
    const { assetId } = await sectionWithDrawing();
    // The author renders an edit in the figure dialog: a copy with the new source, and the text points at it (routes/figures.ts).
    const copy = copyAsset(ctx(), getAsset(ctx(), assetId));
    const rendered = await renderEditedDrawing(ctx(), copy.id, GOOD_2);
    assert.ok(rendered.ok);
    writeFigureRevision(ctx(), P, N, (md) => swapSrc(md, getAsset(ctx(), assetId).filename, copy.filename));
    fake.next(say(GOOD_2), say('OK'));
    // The dialog names the asset the text shows now, which is the copy.
    await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId: copy.id, instruction: 'Make it bigger.' }));
    const prompt = fake.calls[0].prompt;
    assert.ok(prompt.includes(`The figure is drawn by this source now:\n${GOOD_2}\n`), 'the prompt carries the rendered source');
    assert.ok(!prompt.includes(GOOD), 'and not the first one');
    assert.match(prompt, /Everything the instruction does not mention stays exactly as in the current source: the same elements, positions, labels and values\./);
  });

  test('a redraw tells the model that the source is the author\'s truth where the description is older, in the first prompt and in the look turn', async () => {
    const { assetId } = await sectionWithDrawing();
    fake.next(say(GOOD_2), say('OK'));
    await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'Make it bigger.' }));
    const [first, look] = fake.calls.map((c) => c.prompt);
    const rule = /where the description and the source disagree, the source is what the author wants/;
    assert.match(first, rule);
    assert.match(look, rule);
    assert.match(look, /Check it against the brief/);
  });

  test('the look turn of a new drawing has no such rule, because there is no author source to keep', async () => {
    fake.next(say(GOOD), say('OK'));
    const figure = { key: 'cerchio', kind: 'drawing', caption: 'Un cerchio', alt: 'Un cerchio', drawing: { shows: 'A circle.', family: 'sketch' } } as unknown as FigureRequest;
    await buildFigures(ctx(), { projectId: P, nodeId: N, language: 'it', figures: [figure], photos: false });
    assert.ok(!fake.calls.some((c) => /the source is what the author wants/.test(c.prompt)));
  });

  test('the usage rows of a redraw carry its run and task', async () => {
    const { assetId } = await sectionWithDrawing();
    ctx().db.run('DELETE FROM usage'); // the setup drew the first figure outside any run
    fake.next(say(GOOD_2), say('OK'));
    const t = task('figure.redraw', { nodeId: N, assetId, instruction: 'Use a rectangle.' });
    await figureRedraw(ctx(), t);
    const rows = ctx().db.all<{ role: string; run_id: string | null; task_id: string | null }>("SELECT role, run_id, task_id FROM usage WHERE role = 'illustrator'");
    assert.ok(rows.length >= 2, 'the drawing and the look turn');
    for (const r of rows) assert.deepEqual([r.run_id, r.task_id], [t.task.runId, t.task.id]);
  });

  test('History says what each figure action did: a caption, a render, a redraw with its instruction and model', async () => {
    const { assetId } = await sectionWithDrawing();
    const first = currentHead(ctx(), P, N)!;
    const caption = saveFigureDetails(ctx(), P, N, getAsset(ctx(), assetId), { caption: 'Un cerchio più grande' }, first.id)!;
    const shownNow = () => listAssets(ctx(), P).find((a) => currentHead(ctx(), P, N)!.markdown.includes(`assets/${a.filename}"`))!;
    const copy = copyAsset(ctx(), shownNow());
    assert.ok((await renderEditedDrawing(ctx(), copy.id, GOOD_2)).ok);
    const render = writeFigureRevision(ctx(), P, N, (md) => swapSrc(md, shownNow().filename, copy.filename))!;
    fake.next(say(GOOD), say('OK'));
    await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId: shownNow().id, instruction: 'Make the capacitor label C bigger' }));
    const redraw = currentHead(ctx(), P, N)!;
    const notes = figureNotes(ctx(), P, listRevisions(ctx(), P, N));
    assert.equal(notes.get(first.id), undefined);
    assert.equal(notes.get(caption.id), 'Figure "Un cerchio": caption changed to "Un cerchio più grande"');
    assert.equal(notes.get(render.id), 'Figure "Un cerchio più grande": source rendered');
    assert.equal(notes.get(redraw.id), 'Figure "Un cerchio più grande": redrawn: "Make the capacitor label C bigger"');
    assert.ok(redraw.model, 'the revision names the model that drew it');
  });

  test('a redraw that never compiles fails the task with the reason, keeps the figure and leaves no copy', async () => {
    const { assetId, head } = await sectionWithDrawing();
    fake.next(say('#circle('), say('#circle('), say('#circle('));
    await assert.rejects(figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'Make it smaller.' })), (e: unknown) => e instanceof TaskError && e.kind === 'input' && e.message.length > 0);
    assert.equal(currentHead(ctx(), P, N)!.id, head.id);
    assert.equal(listAssets(ctx(), P).length, 1);
  });

  test('text saved while the model worked is kept: the new picture goes into the head as it is then', async () => {
    const { assetId } = await sectionWithDrawing();
    fake.next((_input) => {
      const h = currentHead(ctx(), P, N)!;
      saveHuman(ctx(), P, N, `${h.markdown}\n\nTerzo, scritto dall'autore.`, h.id);
      return { text: GOOD_2, usage: usageOf(10, 10) };
    }, say('OK'));
    await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'Use a rectangle.' }));
    const now = currentHead(ctx(), P, N)!;
    assert.match(now.markdown, /Terzo, scritto dall'autore\./);
    assert.ok(now.markdown.includes('-r'), 'the figure points at the redrawn copy');
  });

  test('a figure removed while the model worked is not put back', async () => {
    const { assetId, file } = await sectionWithDrawing();
    fake.next((_input) => {
      const h = currentHead(ctx(), P, N)!;
      saveHuman(ctx(), P, N, h.markdown.replace(/:::image\{[^}]*\}\n:::\n\n/, ''), h.id);
      return { text: GOOD_2, usage: usageOf(10, 10) };
    }, say('OK'));
    const out = await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'x' })) as { skipped?: string };
    assert.match(out.skipped ?? '', /left the text/);
    assert.ok(!currentHead(ctx(), P, N)!.markdown.includes(':::image'));
    assert.equal(listAssets(ctx(), P).length, 1, 'the copy was deleted');
    assert.ok(file);
  });

  test('a caption saved while the model worked is kept: the redraw is dropped instead of putting the old caption back', async () => {
    const { assetId } = await sectionWithDrawing();
    let saved = '';
    fake.next((_input) => {
      const h = currentHead(ctx(), P, N)!;
      saved = saveFigureDetails(ctx(), P, N, getAsset(ctx(), assetId), { caption: 'Caption from another tab' }, h.id)!.id;
      return { text: GOOD_2, usage: usageOf(10, 10) };
    }, say('OK'));
    const out = await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'Use a rectangle.' })) as { skipped?: string };
    assert.match(out.skipped ?? '', /changed or left the text/);
    const now = currentHead(ctx(), P, N)!;
    assert.equal(now.id, saved);
    assert.match(now.markdown, /caption="Caption from another tab"/);
    assert.equal(listAssets(ctx(), P).length, 2, 'the original and the caption copy, no redraw copy');
  });

  test('an edited description is saved with the redraw and the model gets it', async () => {
    const { assetId } = await sectionWithDrawing();
    fake.next(say(GOOD_2), say('OK'));
    const out = await figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'Use a rectangle.', shows: 'A rectangle of 20 by 10 pt.' })) as { assetId: string };
    assert.equal((getAsset(ctx(), out.assetId).spec as { shows: string }).shows, 'A rectangle of 20 by 10 pt.');
    assert.equal((getAsset(ctx(), assetId).spec as { shows: string }).shows, 'A circle.', 'the earlier asset keeps its description');
    assert.match(fake.calls[0].prompt, /A rectangle of 20 by 10 pt\./);
  });

  test('a redraw cancelled during the look turn commits nothing and leaves no copy', async () => {
    const { assetId, head } = await sectionWithDrawing();
    const abort = new AbortController();
    fake.next(say(GOOD_2), (_input) => { abort.abort(new Error('cancelled')); return { text: GOOD, usage: usageOf(10, 10) }; });
    await assert.rejects(figureRedraw(ctx(), task('figure.redraw', { nodeId: N, assetId, instruction: 'x' }, abort)));
    assert.equal(currentHead(ctx(), P, N)!.id, head.id);
    assert.equal(listAssets(ctx(), P).length, 1);
  });

  test('a second request for the same figure joins the redraw that is running', async () => {
    const { assetId } = await sectionWithDrawing();
    const a = startRedraw(ctx(), P, { nodeId: N, assetId, caption: 'Un cerchio', instruction: 'one' });
    const b = startRedraw(ctx(), P, { nodeId: N, assetId, caption: 'Un cerchio', instruction: 'two' });
    assert.equal(a.id, b.id);
    assert.equal(activeRedraw(ctx(), P, assetId), a.id);
    await ctx().queue.stop();
  });
});

describe('draw task', () => {
  test('the new figure goes in after the block the author chose, found again by its text when the section changed', async () => {
    const head = saveHuman(ctx(), P, N, 'Primo.\n\nSecondo.\n\nTerzo.', null);
    fake.next(say(GOOD), say('OK'));
    const t = task('figure.draw', { nodeId: N, afterBlock: 1, anchor: 'Secondo.', description: 'A circle with a radius of 8 pt.', caption: 'Figura 9: Un cerchio' });
    // The author saves a new first paragraph while the illustrator draws: block 1 is now another block.
    fake.calls.length = 0;
    saveHuman(ctx(), P, N, 'Nuovo.\n\nPrimo.\n\nSecondo.\n\nTerzo.', head.id);
    const out = await figureDraw(ctx(), t) as { assetId: string };
    const blocks = currentHead(ctx(), P, N)!.markdown.split('\n\n');
    assert.deepEqual(blocks.map((b) => b.slice(0, 8)), ['Nuovo.', 'Primo.', 'Secondo.', ':::image', 'Terzo.']);
    const asset = getAsset(ctx(), out.assetId);
    assert.equal(asset.origin, 'generated-svg');
    assert.equal(asset.caption, 'Un cerchio', 'the number is the builder\'s');
    assert.equal((asset.spec as { shows: string }).shows, 'A circle with a radius of 8 pt.');
    assert.match(blocks[3], /caption="Un cerchio"/);
    assert.equal(currentHead(ctx(), P, N)!.origin, 'ai');
  });

  test('a drawing that never compiles fails the task with the illustrator\'s reason and adds nothing', async () => {
    const head = saveHuman(ctx(), P, N, 'Primo.', null);
    fake.next(say('#circle('), say('#circle('), say('#circle('));
    await assert.rejects(figureDraw(ctx(), task('figure.draw', { nodeId: N, afterBlock: 0, anchor: 'Primo.', description: 'x', caption: '' })), (e: unknown) => e instanceof TaskError && e.kind === 'input');
    assert.equal(currentHead(ctx(), P, N)!.id, head.id);
    assert.equal(listAssets(ctx(), P).length, 0);
  });

  test('a task that runs again after its revision was committed returns that revision and draws nothing', async () => {
    saveHuman(ctx(), P, N, 'Primo.', null);
    fake.next(say(GOOD), say('OK'));
    const t = task('figure.draw', { nodeId: N, afterBlock: 0, anchor: 'Primo.', description: 'A circle.', caption: '' });
    const first = await figureDraw(ctx(), t) as { revId: string };
    fake.calls.length = 0;
    const again = await figureDraw(ctx(), t) as { revId: string; reused?: boolean };
    assert.equal(again.revId, first.revId);
    assert.equal(fake.calls.length, 0);
    assert.equal(listAssets(ctx(), P).length, 1);
  });

  test('a usage limit of the illustrator reaches the queue as a quota error, so the task can wait', async () => {
    const head = saveHuman(ctx(), P, N, 'Primo.', null);
    fake.next(() => new Error('429 rate limit exceeded, try again later'));
    await assert.rejects(figureDraw(ctx(), task('figure.draw', { nodeId: N, afterBlock: 0, anchor: 'Primo.', description: 'x', caption: '' })), (e: unknown) => e instanceof TaskError && e.kind !== 'input');
    assert.equal(currentHead(ctx(), P, N)!.id, head.id);
  });

  test('a drawing cancelled during the look turn commits nothing and stores no file', async () => {
    const head = saveHuman(ctx(), P, N, 'Primo.', null);
    const abort = new AbortController();
    fake.next(say(GOOD), (_input) => { abort.abort(new Error('cancelled')); return { text: GOOD_2, usage: usageOf(10, 10) }; });
    await assert.rejects(figureDraw(ctx(), task('figure.draw', { nodeId: N, afterBlock: 0, anchor: 'Primo.', description: 'x', caption: '' }, abort)));
    assert.equal(currentHead(ctx(), P, N)!.id, head.id);
    assert.equal(listAssets(ctx(), P).length, 0);
  });
});
