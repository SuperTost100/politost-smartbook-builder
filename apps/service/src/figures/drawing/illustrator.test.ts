// The illustrator step with scripted model answers (FakeFunnel) and the real renderers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES, DRAWING_FAMILIES } from '@smartbuilder/domain';
import { ensureFigurePackages, missingFigurePackages } from '../../../../../scripts/fetch-figure-packages.mjs';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from '../../llm/testkit.ts';
import { cleanSource, ENGINE_OF_FAMILY, illustrate, MAX_REPAIRS, saysOk, type IllustrateInput } from './illustrator.ts';
import { illustratorSystem } from './prompt.ts';

const fixture = (name: string) => readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', name), 'utf8');
const GOOD = '#circle(radius: 8pt)';
const GOOD_2 = '#circle(radius: 12pt)';
const BROKEN = '#circle(radius: 8pt';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
const say = (text: string) => () => ({ text, usage: usageOf(100, 10) });

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

const brief = (o: Partial<IllustrateInput> = {}): IllustrateInput => ({
  projectId: 'p1', language: 'it', symbols: 'european', caption: 'Un cerchio', shows: 'A circle with a radius of 8 pt.', family: 'sketch', ...o,
});

describe('engine and prompt', () => {
  test('one table picks the engine: logic, timing and Karnaugh go to schemdraw, everything else to Typst', () => {
    assert.deepEqual(Object.keys(ENGINE_OF_FAMILY).sort(), [...DRAWING_FAMILIES].sort());
    for (const f of DRAWING_FAMILIES) assert.equal(ENGINE_OF_FAMILY[f], ['logic', 'timing', 'karnaugh'].includes(f) ? 'schemdraw' : 'typst', f);
  });

  test('the system prompt holds the cheat sheet of its engine only, and is the same every time', () => {
    const typst = illustratorSystem('typst');
    const py = illustratorSystem('schemdraw');
    assert.match(typst, /@preview\/zap:0\.6\.0/);
    assert.doesNotMatch(typst, /TimingDiagram/);
    assert.match(py, /TimingDiagram/);
    assert.doesNotMatch(py, /@preview\/zap/);
    for (const s of [typst, py]) assert.match(s, /source only: no prose, no Markdown fence/);
    assert.equal(illustratorSystem('typst'), typst);
  });

  test('a fence is removed, and an answer that is not source is refused', () => {
    assert.deepEqual(cleanSource('typst', `\`\`\`typ\n${GOOD}\n\`\`\``), { ok: true, data: GOOD });
    assert.equal(cleanSource('typst', 'Sure, here is your circle.').ok, false);
    assert.equal(cleanSource('schemdraw', 'x = 1').ok, false);
    assert.equal(cleanSource('typst', '  \n').ok, false);
    assert.equal(saysOk('OK'), true);
    assert.equal(saysOk('ok.'), true);
    assert.equal(saysOk(`#let ok = 1\n${GOOD}`), false);
  });
});

describe('the compile, repair and look loop', () => {
  test('a source that compiles, and the look says OK: two calls, the picture goes with the second', async () => {
    fake.next(say(`\`\`\`typ\n${GOOD}\n\`\`\``), say('OK'));
    const r = await illustrate(kit.ctx, brief());
    assert.ok(r.ok);
    assert.equal(r.engine, 'typst');
    assert.equal(r.source, GOOD);
    assert.equal(r.compileAttempts, 1);
    assert.equal(r.look, 'ok');
    assert.deepEqual(r.first.source, GOOD);
    assert.match(r.svg, /<svg/);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].selection.model, 'gpt-6-sol');
    assert.equal(fake.calls[0].selection.effort, 'medium');
    assert.match(fake.calls[0].prompt, /Book language: Italian\. Circuit symbols: European/);
    assert.match(fake.calls[0].prompt, /Caption: Un cerchio\nFamily: sketch\nWhat the figure shows:\nA circle with a radius of 8 pt\./);
    assert.equal(fake.calls[0].attachments, undefined);
    assert.equal(fake.calls[1].attachments?.length, 1, 'the picture of the drawing');
    assert.equal(fake.calls[1].attachments?.[0].mediaType, 'image/png');
    assert.match(fake.calls[1].prompt, /Answer exactly OK/);
    assert.equal(r.usage.calls, 2);
    assert.equal(r.usage.inputTokens, 200);
    const rows = kit.ctx.db.all<{ role: string }>('SELECT role FROM usage');
    assert.deepEqual(rows.map((x) => x.role), ['illustrator', 'illustrator']);
  });

  test('the book language and the symbol style reach the prompt', async () => {
    fake.next(say(GOOD), say('OK'));
    await illustrate(kit.ctx, brief({ language: 'en', symbols: 'american' }));
    assert.match(fake.calls[0].prompt, /Book language: English\. Circuit symbols: American \(a zigzag resistor\)/);
  });

  test('a prose answer goes back for the source before anything is compiled', async () => {
    fake.next(say('Sure, here is the circle you asked for.'), say(GOOD), say('OK'));
    const r = await illustrate(kit.ctx, brief());
    assert.ok(r.ok);
    assert.equal(r.compileAttempts, 1);
    assert.equal(fake.calls.length, 3);
  });

  test('a compile error goes back in the same conversation, and the repaired source is used', async () => {
    fake.next(say(BROKEN), say(GOOD), say('OK'));
    const r = await illustrate(kit.ctx, brief());
    assert.ok(r.ok);
    assert.equal(r.compileAttempts, 2);
    assert.equal(r.source, GOOD);
    assert.match(fake.calls[1].prompt, /Your source did not compile\. Compiler output:\n\nerror at line 1/);
    assert.match(fake.calls[1].prompt, new RegExp(BROKEN.replace(/[()]/g, '\\$&')));
  });

  test(`no drawing after ${MAX_REPAIRS} repairs: the figure is dropped with the reason, and the look turn never runs`, async () => {
    fake.next(say(BROKEN), say(BROKEN), say(BROKEN));
    const r = await illustrate(kit.ctx, brief());
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /did not compile after 3 attempts/);
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.steps.length, 0);
  });

  test('a look that finds a flaw returns a corrected source, which replaces the drawing', async () => {
    fake.next(say(GOOD), say(GOOD_2));
    const r = await illustrate(kit.ctx, brief());
    assert.ok(r.ok);
    assert.equal(r.look, 'corrected');
    assert.equal(r.source, GOOD_2);
    assert.equal(r.first.source, GOOD, 'the first drawing stays available');
    assert.equal(fake.calls.length, 2, 'the look is done once');
  });

  test('a correction gets one repair, and one that still fails keeps the earlier drawing', async () => {
    fake.next(say(GOOD), say(BROKEN), say(BROKEN));
    const r = await illustrate(kit.ctx, brief());
    assert.ok(r.ok);
    assert.equal(r.look, 'kept');
    assert.equal(r.source, GOOD);
    assert.equal(fake.calls.length, 3, 'the look, then one repair');
  });

  test('a correction that compiles after its repair is used', async () => {
    fake.next(say(GOOD), say(BROKEN), say(GOOD_2));
    const r = await illustrate(kit.ctx, brief());
    assert.ok(r.ok);
    assert.equal(r.look, 'corrected');
    assert.equal(r.source, GOOD_2);
  });

  test('a follow-up that fails keeps what compiled', async () => {
    fake.next(say(GOOD), () => new Error('The connection dropped.'));
    const r = await illustrate(kit.ctx, brief());
    assert.ok(r.ok);
    assert.equal(r.look, 'skipped');
    assert.equal(r.source, GOOD);
  });

  test('a repair turn that fails ends without a drawing', async () => {
    fake.next(say(BROKEN), () => new Error('The connection dropped.'));
    const r = await illustrate(kit.ctx, brief());
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /stopped before the drawing compiled/);
  });

  test('a logic figure is drawn with schemdraw and its cheat sheet', async () => {
    fake.next(say(fixture('logic-circuit.py')), say('OK'));
    const r = await illustrate(kit.ctx, brief({ family: 'logic', shows: 'F = (A AND B) OR (NOT C).' }));
    assert.ok(r.ok);
    assert.equal(r.engine, 'schemdraw');
    assert.match(fake.calls[0].system ?? '', /TimingDiagram/);
    assert.doesNotMatch(fake.calls[0].system ?? '', /@preview\/zap/);
  });

  test('a redraw sends the current source and the instruction, and keeps the engine', async () => {
    fake.next(say(GOOD_2), say('OK'));
    const r = await illustrate(kit.ctx, brief({ engine: 'typst', family: 'logic', redraw: { source: GOOD, instruction: 'Make the circle bigger.' } }));
    assert.ok(r.ok);
    assert.equal(r.engine, 'typst');
    assert.match(fake.calls[0].prompt, /drawn by this source now:\n#circle\(radius: 8pt\)/);
    assert.match(fake.calls[0].prompt, /asks for this change: Make the circle bigger\./);
  });
});
