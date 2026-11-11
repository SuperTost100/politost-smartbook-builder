// A figure of kind "drawing" going through buildFigures, as drafting, fixes and the figures pass call it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { ensureFigurePackages, missingFigurePackages } from '../../../../../scripts/fetch-figure-packages.mjs';
import { resolveDataPath } from '../../config.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from '../../llm/testkit.ts';
import { buildFigures, type FigureRequest } from '../materialize.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
const say = (text: string) => () => ({ text, usage: usageOf(10, 10) });
const GOOD = '#circle(radius: 8pt)';

const drawing = (key: string, shows = 'A circle with a radius of 8 pt.', family = 'sketch') =>
  ({ key, kind: 'drawing', caption: `Fig ${key}`, alt: 'Un cerchio', drawing: { shows, family } }) as unknown as FigureRequest;
const build = (figures: FigureRequest[]) => buildFigures(kit.ctx, { projectId: 'p1', nodeId: 'node0001', language: 'it', figures, photos: false });

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

describe('drawing figures', () => {
  test('the asset keeps the spec a redraw needs, with the origin generated-svg and a file the reader can show', async () => {
    kit.ctx.db.run(`UPDATE projects SET options = ? WHERE id = 'p1'`, JSON.stringify({ circuitSymbols: 'european' }));
    fake.next(say(GOOD), say('OK'));
    const built = await build([drawing('cerchio')]);
    assert.deepEqual(built.notes, []);
    const row = built.assets[0].row;
    assert.equal(row.origin, 'generated-svg');
    assert.equal(row.mime, 'image/svg+xml');
    assert.equal(row.filename, 'node0001-cerchio.svg');
    assert.deepEqual(row.spec, { kind: 'drawing', engine: 'typst', source: GOOD, shows: 'A circle with a radius of 8 pt.', family: 'sketch', symbols: 'european' });
    assert.match(String((row.checks as { detail: string }[])[0].detail), /Drawn by the illustrator in typst: compiled after 1 attempt, look turn: ok/);
    assert.match(readFileSync(resolveDataPath(kit.ctx.config, String(row.path)), 'utf8'), /<svg[^>]*data-sb-ink="dark"/);
    assert.equal(built.renames.get('cerchio'), 'node0001-cerchio.svg');
  });

  test('a drawing that never compiles is left out with a note', async () => {
    fake.next(say('#circle('), say('#circle('), say('#circle('));
    const built = await build([drawing('rotto')]);
    assert.equal(built.assets.length, 0);
    assert.match(built.notes[0], /^rotto: the drawing did not compile after 3 attempts/);
  });

  test('a drawing the illustrator cannot be asked for (a limit, a login) is left out, and the section goes on', async () => {
    kit.ctx.saveSettings({ routes: { ...DEFAULT_ROUTES, illustrator: { primary: { provider: 'codex', model: 'gpt-6-sol' } } } });
    fake.next(() => new Error('The login expired.'));
    const built = await build([drawing('login')]);
    assert.equal(built.assets.length, 0);
    assert.match(built.notes[0], /^login: the drawing could not be made/);
  });

  test('a second drawing with the same description in the same request is dropped before the model is called', async () => {
    fake.next(say(GOOD), say('OK'));
    const built = await build([drawing('uno'), drawing('due', 'a circle  with a RADIUS of 8 pt.')]);
    assert.equal(built.assets.length, 1);
    assert.match(built.notes[0], /^due: the same drawing is already in this section/);
    assert.equal(fake.calls.length, 2);
  });

  test('a drawing request without its spec is left out with a note', async () => {
    const built = await build([{ ...drawing('vuoto'), drawing: null } as unknown as FigureRequest]);
    assert.deepEqual(built.notes, ['vuoto: the drawing figure has no drawing spec']);
  });
});
