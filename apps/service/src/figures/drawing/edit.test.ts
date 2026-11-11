import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { ensureFigurePackages, missingFigurePackages } from '../../../../../scripts/fetch-figure-packages.mjs';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from '../../llm/testkit.ts';
import { assetFile } from '../../repo/assets.ts';
import { buildFigures, commitFigures, type FigureRequest } from '../materialize.ts';
import { redrawDrawing, renderEditedDrawing } from './edit.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
const say = (text: string) => () => ({ text, usage: usageOf(10, 10) });
const GOOD = '#circle(radius: 8pt)';
const GOOD_2 = '#rect(width: 20pt, height: 10pt)';

/** A stored drawn figure, made through the real build path. */
async function storedDrawing(): Promise<string> {
  fake.next(say(GOOD), say('OK'));
  const figure = { key: 'cerchio', kind: 'drawing', caption: 'Un cerchio', alt: 'Un cerchio', drawing: { shows: 'A circle.', family: 'sketch' } } as unknown as FigureRequest;
  const built = await buildFigures(kit.ctx, { projectId: 'p1', nodeId: 'n1node00', language: 'it', figures: [figure], photos: false });
  kit.ctx.db.tx(() => { commitFigures(kit.ctx, { projectId: 'p1', nodeId: 'n1node00', built, markdown: `:::image{src="assets/${built.renames.get('cerchio')}"}\n:::`, replace: false, replaced: [] }); });
  fake.calls.length = 0;
  return built.assets[0].id;
}

beforeEach(async () => {
  if (missingFigurePackages().length) await ensureFigurePackages();
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  kit.ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(kit.ctx, 'p1');
});
afterEach(() => {
  setFunnel(null);
  kit.cleanup();
});

const spec = (id: string) => JSON.parse(kit.ctx.db.get<{ spec: string }>('SELECT spec FROM assets WHERE id = ?', id)!.spec) as Record<string, unknown>;

describe('editing a drawn figure', () => {
  test('edited source that compiles replaces the file and the stored source', async () => {
    const id = await storedDrawing();
    const before = readFileSync(assetFile(kit.ctx, id).path, 'utf8');
    const r = await renderEditedDrawing(kit.ctx, id, GOOD_2);
    assert.ok(r.ok);
    const after = readFileSync(assetFile(kit.ctx, id).path, 'utf8');
    assert.notEqual(after, before);
    assert.match(after, /data-sb-ink="dark"/);
    assert.equal(spec(id).source, GOOD_2);
    assert.equal(spec(id).shows, 'A circle.');
    assert.equal(fake.calls.length, 0, 'no model is called');
    assert.equal(existsSync(`${assetFile(kit.ctx, id).path}.tmp`), false);
  });

  test('edited source that does not compile returns the error and changes nothing', async () => {
    const id = await storedDrawing();
    const before = readFileSync(assetFile(kit.ctx, id).path, 'utf8');
    const r = await renderEditedDrawing(kit.ctx, id, '#circle(radius: 8pt');
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : '', /error at line 1/);
    assert.equal(readFileSync(assetFile(kit.ctx, id).path, 'utf8'), before);
    assert.equal(spec(id).source, GOOD);
  });

  test('a figure that is not a drawing is refused', async () => {
    kit.ctx.db.insert('assets', { id: 'a-plot', project_id: 'p1', node_id: 'n1', filename: 'plot.svg', mime: 'image/svg+xml', path: 'x.svg', origin: 'plot', spec: { xRange: [0, 1] }, caption: '', alt: '', checks: [], created_at: 'now' });
    await assert.rejects(renderEditedDrawing(kit.ctx, 'a-plot', GOOD), /not drawn from source code/);
    await assert.rejects(redrawDrawing(kit.ctx, 'a-plot', 'bigger'), /not drawn from source code/);
  });

  test('a redraw gives the illustrator the current source, what the figure shows and the instruction, then replaces the figure', async () => {
    const id = await storedDrawing();
    fake.next(say(GOOD_2), say('OK'));
    const r = await redrawDrawing(kit.ctx, id, 'Use a rectangle instead.');
    assert.ok(r.ok);
    assert.equal(r.ok && r.look, 'ok');
    assert.equal(spec(id).source, GOOD_2);
    assert.match(fake.calls[0].prompt, /What the figure shows:\nA circle\./);
    assert.match(fake.calls[0].prompt, /drawn by this source now:\n#circle\(radius: 8pt\)/);
    assert.match(fake.calls[0].prompt, /asks for this change: Use a rectangle instead\./);
  });

  test('a redraw that never compiles leaves the figure as it was', async () => {
    const id = await storedDrawing();
    const before = readFileSync(assetFile(kit.ctx, id).path, 'utf8');
    fake.next(say('#circle('), say('#circle('), say('#circle('));
    const r = await redrawDrawing(kit.ctx, id, 'Make it smaller.');
    assert.equal(r.ok, false);
    assert.equal(readFileSync(assetFile(kit.ctx, id).path, 'utf8'), before);
    assert.equal(spec(id).source, GOOD);
  });

  test('an empty instruction is refused before any call', async () => {
    const id = await storedDrawing();
    await assert.rejects(redrawDrawing(kit.ctx, id, '  '), /Say what the drawing should change/);
    assert.equal(fake.calls.length, 0);
  });
});
