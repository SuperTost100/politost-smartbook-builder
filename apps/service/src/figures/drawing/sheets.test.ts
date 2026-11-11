// The cheat sheets are part of the product: a block that stops compiling would teach the model a broken example.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ensureFigurePackages, missingFigurePackages } from '../../../../../scripts/fetch-figure-packages.mjs';
import { renderDrawing, TYPST_ALLOWED } from './index.ts';
import { SHEET_FILES } from './prompt.ts';
import type { DrawingEngine } from './types.ts';

const privateTmp = mkdtempSync(join(tmpdir(), 'sb-sheetstest-'));
process.env.TMPDIR = privateTmp;
after(() => rmSync(privateTmp, { recursive: true, force: true }));

/** The fenced code blocks of a sheet, with the line they start at. */
function blocks(engine: DrawingEngine): { line: number; code: string }[] {
  const text = readFileSync(SHEET_FILES[engine], 'utf8');
  const lang = engine === 'typst' ? 'typ' : 'python';
  return [...text.matchAll(new RegExp('^```' + lang + '\\n([\\s\\S]*?)^```', 'gm'))].map((m) => ({ line: text.slice(0, m.index).split('\n').length, code: m[1] }));
}

before(async () => {
  if (missingFigurePackages().length) await ensureFigurePackages();
});

describe('cheat sheets', () => {
  for (const engine of ['typst', 'schemdraw'] as const) {
    it(`${engine}: has worked examples, and every one compiles`, async () => {
      const list = blocks(engine);
      assert.ok(list.length >= (engine === 'typst' ? 7 : 3), `${engine} sheet has ${list.length} code blocks`);
      const results = await Promise.all(list.map(async (b) => ({ b, r: await renderDrawing({ engine, source: b.code, symbols: 'european' }) })));
      for (const { b, r } of results) assert.ok(r.ok, `the block at line ${b.line} of the ${engine} sheet does not compile: ${r.ok ? '' : r.error}`);
    });
  }

  it('typst: names exactly the installed versions, and tells the model not to set the page', () => {
    const text = readFileSync(SHEET_FILES.typst, 'utf8');
    for (const [name, version] of Object.entries(TYPST_ALLOWED)) assert.match(text, new RegExp(`@preview/${name}:${version.replace(/\./g, '\\.')}`), name);
    for (const m of text.matchAll(/@preview\/([\w-]+):(\d+\.\d+\.\d+)/g)) assert.equal(TYPST_ALLOWED[m[1]], m[2], `${m[0]} is not the pinned version`);
    assert.doesNotMatch(blocks('typst').map((b) => b.code).join('\n'), /#set (page|text)/);
    assert.doesNotMatch(text, /wavy/i);
  });

  it('typst: a quantity of time or frequency has its argument after the subscript, and the sheet says so with an example that compiles', async () => {
    // The acceptance run drew the capacitor voltage as v with the subscript "C(t)": `$v_C(t)$` puts the whole call into the subscript.
    const width = async (math: string) => {
      const r = await renderDrawing({ engine: 'typst', source: `#import "@preview/cetz:0.5.2": canvas, draw\n#canvas({ draw.content((0, 0), ${math}) })`, symbols: 'european' });
      assert.ok(r.ok, r.ok ? '' : r.error);
      return Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) /.exec(r.svg)![1]);
    };
    const broken = await width('$v_C(t)$');
    for (const right of ['$v_C (t)$', '$v_(C)(t)$']) assert.ok((await width(right)) > broken * 1.1, `${right} sets the argument at full size, outside the subscript`);
    const sheet = readFileSync(SHEET_FILES.typst, 'utf8');
    assert.match(sheet, /argument after the subscript, outside it/);
    const code = blocks('typst').map((b) => b.code).join('\n');
    assert.match(code, /\$v_C \(t\) = /, 'a compiled example shows the right form');
    assert.doesNotMatch(code, /_(?:[A-Za-z0-9]|"[^"]*")\(/, 'no example writes the argument against the subscript');
  });

  it('keeps the sheets short enough to cache cheaply', () => {
    assert.ok(readFileSync(SHEET_FILES.typst, 'utf8').split('\n').length <= 130);
    assert.ok(readFileSync(SHEET_FILES.schemdraw, 'utf8').split('\n').length <= 80);
  });
});
