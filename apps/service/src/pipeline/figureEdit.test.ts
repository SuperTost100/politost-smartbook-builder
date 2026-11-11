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
import { currentHead, getAsset, listAssets, listRevisions, saveHuman } from '../repo/index.ts';
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

function task(kind: string, input: Record<string, unknown>): TaskContext {
  const runId = newId();
  ctx().db.insert('runs', { id: runId, project_id: P, kind: 'figure', status: 'running', snapshot: {}, created_at: now() });
  const id = newId();
  ctx().db.insert('tasks', { id, run_id: runId, project_id: P, kind, label: 'x', key: `${kind}:${id}`, input, state: 'running', pool: 'illustrator', attempts: 1, max_attempts: 2, created_at: now() });
  return { task: { id, runId, projectId: P, kind, key: `${kind}:${id}`, label: 'x', input, attempts: 1 }, signal: new AbortController().signal, deps: {}, enqueue: () => [], progress: () => undefined, setProvider: () => undefined };
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
});
