import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { bookOptionsSchema } from '@smartbuilder/domain';
import { FIGURE_PACKAGES_DIR, PYTHON_WHEELS, TYPST_PACKAGES, ensureFigurePackages, missingFigurePackages, untar } from '../../../../../scripts/fetch-figure-packages.mjs';
import { assertSafeSvg } from '../../repo/assets.ts';
import { INK, MAX_PARALLEL_RENDERS, MAX_SVG_BYTES, isInkDrawing, renderDrawing, rasterizeDrawing } from './index.ts';
import type { DrawingEngine, DrawingResult } from './index.ts';
import { readRssBytes } from './sandbox.ts';
import { normaliseSvg } from './svg.ts';
import { checkImports, describeDiagnostics } from './typst.ts';

// Every render makes its temp folders under TMPDIR. This file gets a folder of its own, so a render in another process at the
// same moment (another test file, a running service) cannot show up in the "no sb-draw-* folder is left" checks below.
const privateTmp = mkdtempSync(join(tmpdir(), 'sb-drawtest-'));
process.env.TMPDIR = privateTmp;
after(() => rmSync(privateTmp, { recursive: true, force: true }));

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtureDir = join(here, 'fixtures');
const snapshotFile = join(fixtureDir, 'snapshot.json');
const fixtureNames = readdirSync(fixtureDir).filter((f) => /\.(typ|py)$/.test(f)).sort();
const engineOf = (file: string): DrawingEngine => (file.endsWith('.typ') ? 'typst' : 'schemdraw');
const source = (file: string) => readFileSync(join(fixtureDir, file), 'utf8');

/** The render folders that exist now: only this file's renders can make them. */
const tempDirs = () => readdirSync(privateTmp).filter((n) => n.startsWith('sb-draw-'));
const typst = (src: string, extra: { timeoutMs?: number } = {}) => renderDrawing({ engine: 'typst', source: src, ...extra });
const python = (src: string, extra: { timeoutMs?: number } = {}) => renderDrawing({ engine: 'schemdraw', source: src, ...extra });
const failure = (r: DrawingResult) => {
  assert.equal(r.ok, false, 'expected a failure');
  return r as Extract<DrawingResult, { ok: false }>;
};

/** Counts of the elements that make a drawing, stable across machines and sensitive to renderer upgrades. */
function counts(svg: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tag of ['path', 'use', 'g', 'rect', 'circle', 'line', 'polygon', 'polyline', 'ellipse', 'clipPath']) out[tag] = (svg.match(new RegExp(`<${tag}[\\s>/]`, 'g')) ?? []).length;
  return out;
}

const rendered = new Map<string, DrawingResult>();

before(async () => {
  // Downloads only if something is missing (CI does this once and caches the folder).
  if (missingFigurePackages().length) await ensureFigurePackages();
  const queue = [...fixtureNames];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) rendered.set(f, await renderDrawing({ engine: engineOf(f), source: source(f), title: f }));
  }));
  // DRAWING_OUT=<folder> writes every fixture as SVG and PNG for a human to look at, like DIAGRAM_OUT in diagram.test.ts.
  const out = process.env.DRAWING_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const [f, r] of rendered) if (r.ok) {
      const name = f.replace(/\.\w+$/, '');
      writeFileSync(join(out, `${name}.svg`), r.svg);
      writeFileSync(join(out, `${name}.png`), rasterizeDrawing(r.svg));
    }
  }
});

describe('pinned packages', () => {
  it('lists a SHA-256 for everything it downloads, and everything is installed', () => {
    for (const item of [...TYPST_PACKAGES, ...PYTHON_WHEELS]) assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(missingFigurePackages(), []);
  });

  it('only installs packages that the bundled Typst 0.14 accepts', () => {
    for (const p of TYPST_PACKAGES) {
      const toml = readFileSync(join(FIGURE_PACKAGES_DIR, 'typst', 'preview', p.name, p.version, 'typst.toml'), 'utf8');
      const needs = toml.match(/^compiler\s*=\s*"(\d+)\.(\d+)/m);
      if (needs) assert.ok(Number(needs[1]) === 0 && Number(needs[2]) <= 14, `${p.name} ${p.version} needs Typst ${needs[1]}.${needs[2]}`);
    }
  });

  it('has every package that an installed package imports, so no render reaches for the network', () => {
    const installed = new Set(TYPST_PACKAGES.map((p) => `${p.name}:${p.version}`));
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.typ') ? [join(dir, e.name)] : []));
    for (const p of TYPST_PACKAGES) {
      for (const file of walk(join(FIGURE_PACKAGES_DIR, 'typst', 'preview', p.name, p.version))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/@preview\/([\w-]+):(\d+\.\d+\.\d+)/g)) {
          assert.ok(installed.has(`${m[1]}:${m[2]}`), `${p.name} ${p.version} imports ${m[0]}, which is not installed`);
        }
      }
    }
  });

  it('reads gzip tar archives', () => {
    const block = (name: string, body: string) => {
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
      h.write('0', 156);
      return Buffer.concat([h, Buffer.from(body), Buffer.alloc((512 - (body.length % 512)) % 512)]);
    };
    const gz = gzipSync(Buffer.concat([block('typst.toml', 'name = "x"\n'), block('src/lib.typ', '#let a = 1'), Buffer.alloc(1024)]));
    assert.deepEqual(untar(gz).map(([n, b]) => [n, b.toString()]), [['typst.toml', 'name = "x"\n'], ['src/lib.typ', '#let a = 1']]);
  });
});

describe('fixtures', () => {
  it('cover both engines and the figure kinds the book needs', () => {
    assert.ok(fixtureNames.length >= 12);
    assert.ok(fixtureNames.some((f) => f.endsWith('.typ')) && fixtureNames.some((f) => f.endsWith('.py')));
  });

  for (const f of fixtureNames) {
    it(`${f} renders to a clean SVG`, () => {
      const r = rendered.get(f)!;
      assert.ok(r.ok, r.ok ? '' : r.error);
      assert.doesNotThrow(() => assertSafeSvg(r.svg));
      assert.ok(isInkDrawing(r.svg));
      assert.ok(Buffer.byteLength(r.svg) < MAX_SVG_BYTES);
      assert.deepEqual(r.warnings, [], 'every fixture stays under the 300 KB aim');
      assert.doesNotMatch(r.svg, /<(text|tspan|image|script|foreignObject|style)[\s>]/i, 'no fonts, no raster, no scripts');
      assert.doesNotMatch(r.svg, /\b(?:font-family|font-size)\b/i);
      assert.doesNotMatch(r.svg.replace(/\sxmlns(?::\w+)?="[^"]*"/g, ''), /url\(\s*['"]?(?!#)|@import|data:|https?:|javascript:/i, 'no external references');
      const img = new Resvg(r.svg).render();
      const alphaAt = (x: number, y: number) => img.pixels[(y * img.width + x) * 4 + 3];
      assert.equal(alphaAt(0, 0), 0, 'the background is transparent');
      assert.equal(alphaAt(img.width - 1, img.height - 1), 0);
      assert.doesNotMatch(r.svg, /(?:fill|stroke)="(?:#000000|#000|black)"|(?:fill|stroke):(?:#000000|#000|black)\b/i, 'black ink is replaced by the shared ink');
      assert.ok(r.svg.includes(INK));
    });

    it(`${f} has a tight viewBox with a small margin`, () => {
      const r = rendered.get(f)!;
      assert.ok(r.ok);
      const vb = r.svg.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
      const box = new Resvg(r.svg).getBBox()!;
      for (const margin of [box.x - vb[0], box.y - vb[1], vb[0] + vb[2] - (box.x + box.width), vb[1] + vb[3] - (box.y + box.height)]) {
        assert.ok(margin > 3 && margin < 5, `margin ${margin}`);
      }
      assert.ok(r.width > 100 && r.width < 700, `width ${r.width}`);
    });
  }

  it('a timing diagram writes its signal names in the ink, not in schemdraw\'s blue', () => {
    const r = rendered.get('timing-diagram.py')!;
    assert.ok(r.ok);
    assert.doesNotMatch(r.svg, /(?:fill|stroke)(?:="|:)\s*(?:blue|#0000ff|#00f\b|rgb\(0, ?0, ?255\))/i);
  });

  it('match the stored snapshot (run with UPDATE_DRAWING_SNAPSHOTS=1 after a deliberate renderer upgrade)', () => {
    const now: Record<string, { counts: Record<string, number>; width: number; height: number }> = {};
    for (const f of fixtureNames) {
      const r = rendered.get(f)!;
      assert.ok(r.ok);
      now[f] = { counts: counts(r.svg), width: Math.round(r.width), height: Math.round(r.height) };
    }
    if (process.env.UPDATE_DRAWING_SNAPSHOTS) {
      writeFileSync(snapshotFile, `${JSON.stringify(now, null, 1)}\n`);
      return;
    }
    const stored = JSON.parse(readFileSync(snapshotFile, 'utf8')) as typeof now;
    assert.deepEqual(Object.keys(now), Object.keys(stored), 'fixture list changed, update the snapshot');
    for (const f of fixtureNames) {
      assert.deepEqual(now[f].counts, stored[f].counts, `${f}: element counts changed`);
      assert.ok(Math.abs(now[f].width - stored[f].width) <= Math.max(3, stored[f].width * 0.02), `${f}: width ${now[f].width} against ${stored[f].width}`);
      assert.ok(Math.abs(now[f].height - stored[f].height) <= Math.max(3, stored[f].height * 0.02), `${f}: height ${now[f].height} against ${stored[f].height}`);
    }
  });

  it('rasterise to a PNG about 1000 px wide', () => {
    const r = rendered.get('opamp-inverting.typ')!;
    assert.ok(r.ok);
    const png = rasterizeDrawing(r.svg);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1000);
    assert.equal(rasterizeDrawing(r.svg, 500).readUInt32BE(16), 500);
  });
});

describe('symbol style', () => {
  for (const [file, engine] of [['rc-filter.typ', 'typst'], ['rc-schemdraw.py', 'schemdraw']] as const) {
    it(`${engine} draws a zigzag for american and a rectangle for european`, async () => {
      const [us, eu] = await Promise.all((['american', 'european'] as const).map((symbols) => renderDrawing({ engine, source: source(file), symbols })));
      assert.ok(us.ok && eu.ok);
      assert.notEqual(us.svg, eu.svg);
      // A rectangle resistor is 4 corners, a zigzag 8 or more.
      const vertices = (svg: string) => Math.max(...(svg.match(/\sd="[^"]*"/g) ?? []).map((d) => (d.match(/[LlHhVv]/g) ?? []).length));
      assert.ok(vertices(us.svg) >= vertices(eu.svg), 'the zigzag path has at least as many segments');
    });
  }
});

describe('default symbol style', () => {
  for (const [file, engine] of [['rc-filter.typ', 'typst'], ['rc-schemdraw.py', 'schemdraw']] as const) {
    it(`${engine} draws what a book without the option gets`, async () => {
      const [direct, book, european] = await Promise.all([undefined, bookOptionsSchema.parse({}).circuitSymbols, 'european' as const].map((symbols) => renderDrawing({ engine, source: source(file), symbols })));
      assert.ok(direct.ok && book.ok && european.ok);
      assert.equal(direct.svg, book.svg);
      assert.notEqual(direct.svg, european.svg);
    });
  }
});

describe('errors written for a repair turn', () => {
  it('Typst: a syntax error names its line and quotes it', async () => {
    const r = failure(await typst('#let a = 1\n#let b = (1, 2\n#a'));
    assert.equal(r.kind, 'compile');
    assert.equal(r.line, 2);
    assert.match(r.error, /^error at line 2, column \d+: unclosed delimiter/);
    assert.match(r.error, /2 \| #let b = \(1, 2/);
  });

  it('Typst: an error inside a package points at the call in the model source', async () => {
    const r = failure(await typst('#import "@preview/zap:0.6.0": *\n#circuit({\n  opamp("U1", (0, 0), (1, 1))\n})'));
    assert.equal(r.line, 3);
    assert.match(r.error, /inside package @preview\/zap:0\.6\.0: assertion failed: opamp supports only one node/);
    assert.match(r.error, /3 \|\s+opamp\("U1"/);
  });

  it('Typst: the three error texts that had no line now carry what the engine exposes', async () => {
    // Raised while the page is laid out, so the stack has no line of the model source: lilaq with ticks written as an empty array.
    const bad = source('pv-cycle.typ').replace('ticks: none', 'ticks: ()');
    const r = failure(await typst(bad));
    assert.equal(r.line, undefined);
    assert.match(r.error, /inside package @preview\/lilaq:0\.6\.0: expected at least one value/);
    assert.match(r.error, /Package code \(src\/logic\/tick-locate\.typ, line \d+\): .*calc\.m/);
    assert.match(r.error, /call chain, innermost first: .*_axis-generate-ticks/);
  });

  it('Typst: zap\'s content shadow gets a hint', async () => {
    const r = failure(await typst('#import "@preview/zap:0.6.0": *\n#circuit({\n  content((0, 0), $V$)\n})'));
    assert.match(r.error, /error at line 3/);
    assert.match(r.error, /draw\.content/);
  });

  it('Typst: multi-letter names in math carry the compiler hint', async () => {
    const r = failure(await typst('$AB kHz$'));
    assert.match(r.error, /error at line 1.*unknown variable: AB.*try placing it in quotes/s);
  });

  it('describeDiagnostics reports lines relative to the model source', () => {
    const d = describeDiagnostics([{ severity: 1, message: 'nope', package: '', path: '/x/main.typ', range: { start: { line: 4, character: 2 } } }], 'a\nb\nc\nd');
    assert.equal(d.line, 4);
    assert.match(d.message, /error at line 4, column 3: nope\n {2}4 \| d/);
  });

  it('Python: reports the line in the model code and no framework frames', async () => {
    const r = failure(await python('import schemdraw\nimport schemdraw.elements as elm\nwith schemdraw.Drawing(show=False) as d:\n    elm.Circle()\n'));
    assert.equal(r.kind, 'compile');
    assert.equal(r.line, 4);
    assert.match(r.error, /^error at line 4: AttributeError: module 'schemdraw\.elements' has no attribute 'Circle'/);
    assert.match(r.error, /4 \| elm\.Circle\(\)/);
    assert.doesNotMatch(r.error, /Traceback|File "/);
  });

  it('Python: a syntax error and a missing drawing are explained', async () => {
    const syntax = failure(await python('import schemdraw\nx = (1,\n'));
    assert.equal(syntax.kind, 'compile');
    assert.match(syntax.error, /SyntaxError/);
    const none = failure(await python('x = 1'));
    assert.match(none.error, /did not create a schemdraw\.Drawing/);
  });
});

describe('sandbox', () => {
  it('Typst refuses an import outside the allow-list before compiling, with its line', async () => {
    const started = Date.now();
    const r = failure(await typst('#let x = 1\n#import "@preview/tablex:0.0.9": *\n'));
    assert.equal(r.kind, 'compile');
    assert.equal(r.line, 2);
    assert.match(r.error, /package "@preview\/tablex:0\.0\.9" is not available.*@preview\/cetz:0\.5\.2/s);
    assert.ok(Date.now() - started < 1000, 'refused without starting the compiler');
    assert.match(failure(await typst('#import "@preview/cetz:0.5.3": canvas')).error, /Version 0\.5\.3 is not installed, use 0\.5\.2/);
    assert.match(failure(await typst('#import "@local/mine:1.0.0": *')).error, /not available/);
    assert.equal(checkImports('#import "@preview/zap:0.6.0": *\n#import "@preview/lilaq:0.6.0" as lq'), null);
    // wavy is not offered: its SVG keeps text as a font name. Timing diagrams go through schemdraw.
    assert.match(checkImports('#import "@preview/wavy:0.1.3"')?.message ?? '', /not available/);
  });

  it('Typst cannot be sent to the network by an import path built at run time', async () => {
    const cached = join(homedir(), '.cache', 'typst', 'packages', 'preview', 'tablex');
    const r = failure(await typst('#import ("@pre" + "view/tablex:0.0.9"): *'));
    assert.match(r.error, /not available offline/);
    assert.equal(existsSync(cached), false, 'nothing was downloaded into the user cache');
  });

  it('Typst cannot read /etc/passwd or anything outside its folder', async () => {
    for (const src of ['#read("/etc/passwd")', '#read("../../../../etc/passwd")', '#image("/etc/passwd")', '#csv("/etc/hostname")']) {
      const r = failure(await typst(src));
      assert.equal(r.kind, 'compile', src);
      assert.doesNotMatch(r.error, /root:/);
    }
  });

  it('Typst stops a loop that never ends and the service goes on', async () => {
    const before = tempDirs();
    const started = Date.now();
    const r = failure(await typst('#let n = 0\n#for i in range(100000) { for j in range(100000) { n = n + 1 } }\n#n', { timeoutMs: 2500 }));
    assert.equal(r.kind, 'timeout');
    assert.ok(Date.now() - started < 6000);
    assert.deepEqual(tempDirs(), before, 'the temp folder is removed');
    assert.ok((await typst('#circle(radius: 5pt)')).ok, 'the next render works');
  });

  it('Typst stops an allocation without bound', async () => {
    const r = failure(await typst('#let a = range(2000000000)\n#a.len()', { timeoutMs: 15000 }));
    // Where the resident size can be read (Linux) the cap fires first. Elsewhere the allocation fails or the timeout ends it.
    if (readRssBytes(process.pid) !== null) assert.equal(r.kind, 'memory');
    else assert.ok(['memory', 'crash', 'timeout'].includes(r.kind));
    assert.ok((await typst('#circle(radius: 5pt)')).ok);
  });

  it('Python cannot read the host file system', async () => {
    const r = failure(await python("print(open('/etc/passwd').read())"));
    assert.equal(r.kind, 'compile');
    assert.doesNotMatch(r.error, /root:/);
    assert.match(r.error, /FileNotFoundError|No such file/);
    const js = failure(await python("import js\nraise RuntimeError(str(dir(js)) + str(js.process))"));
    assert.doesNotMatch(js.error, /argv|env|cwd/, 'import js exposes nothing');
  });

  it('Python stops a loop that never ends and an allocation without bound', async () => {
    const before = tempDirs();
    const loop = failure(await python('while True:\n    pass', { timeoutMs: 6000 }));
    assert.equal(loop.kind, 'timeout');
    const big = failure(await python('chunks = []\nwhile True:\n    chunks.append(bytearray(50_000_000))', { timeoutMs: 15000 }));
    assert.ok(['memory', 'compile', 'crash'].includes(big.kind), big.kind);
    assert.deepEqual(tempDirs(), before);
    assert.ok((await python(source('rc-schemdraw.py'))).ok, 'the next render works');
  });
});

describe('parallel renders', () => {
  it('never has more renders running at once than the limit, whoever asks', async () => {
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, tempDirs().length); }, 3);
    const results = await Promise.all(Array.from({ length: 8 }, () => typst('#circle(radius: 5pt)')));
    clearInterval(timer);
    assert.ok(results.every((r) => r.ok));
    assert.ok(peak >= 1, 'the sampling saw renders in flight');
    assert.ok(peak <= MAX_PARALLEL_RENDERS, `${peak} renders ran at once, the limit is ${MAX_PARALLEL_RENDERS}`);
    assert.deepEqual(tempDirs(), []);
  });
});

describe('svg rules', () => {
  const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

  it('rejects text, embedded images and empty drawings', () => {
    assert.match((normaliseSvg(wrap('<text x="1" y="9">R</text>')) as { error: string }).error, /<text>/);
    assert.match((normaliseSvg(wrap('<image href="#a"/>')) as { error: string }).error, /embeds an image/);
    assert.match((normaliseSvg(wrap('<use href="data:image/png;base64,AAAA"/>')) as { error: string }).error, /image/);
    assert.match((normaliseSvg(wrap('')) as { error: string }).error, /empty/);
  });

  it('rejects what assertSafeSvg rejects', () => {
    const r = normaliseSvg(wrap('<path d="M0 0L9 9" stroke="red"/><a href="https://example.com"><path d="M1 1L5 5"/></a>'));
    assert.equal(r.ok, false);
  });

  it('refuses a file above the 2 MB format limit', () => {
    const path = `<path d="M0 0 L${'1 2 L3 4 '.repeat(300000)}" stroke="#123"/>`;
    const r = normaliseSvg(wrap(path));
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /2 MB/);
  });

  it('refuses a strip too tall or too wide for a page, and never rasterises one to more than three times its width', () => {
    const tall = normaliseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 100000"><rect width="1" height="100000" fill="#000"/></svg>');
    assert.match((tall as { error: string }).error, /tall and narrow/);
    const wide = normaliseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 10"><rect width="100000" height="1" fill="#000"/></svg>');
    assert.match((wide as { error: string }).error, /wide and flat/);
    assert.ok(normaliseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 100"><rect width="800" height="100" fill="#000"/></svg>').ok, 'a timing diagram is wide');
    const strip = (h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="${h}" viewBox="0 0 10 ${h}"><rect width="10" height="${h}" fill="#000"/></svg>`;
    assert.equal(rasterizeDrawing(strip(1000), 200).readUInt32BE(20), 600, 'the height is capped');
    assert.throws(() => rasterizeDrawing(strip(10_000_000), 200), /size is zero/, 'an extreme strip fails without allocating its pixels');
  });

  it('turns black into the ink, scales strokes and rounds numbers', () => {
    const r = normaliseSvg(wrap('<path d="M 1.23456789 2 L 50 50" stroke="#000000" stroke-width="1" fill="none"/><path d="M 5 5 L 9 9" style="stroke:black;fill:none"/>'), { strokeScale: 2, title: 'A & B' });
    assert.ok(r.ok);
    assert.match(r.svg, /stroke="#111827" stroke-width="2"/);
    assert.match(r.svg, /style="stroke:#111827;fill:none"/);
    assert.match(r.svg, /d="M 1\.234 2 L 50 50"/);
    assert.match(r.svg, /<title>A &amp; B<\/title>/);
  });

  it('marks its output and nothing else', () => {
    assert.equal(isInkDrawing(wrap('<path d="M0 0L9 9"/>')), false);
    const r = normaliseSvg(wrap('<path d="M0 0L9 9" stroke="#000"/>'));
    assert.ok(r.ok && isInkDrawing(r.svg));
    assert.equal(isInkDrawing('<svg data-sb-ink="dark"></svg>'), true);
    assert.equal(isInkDrawing('<svg><g data-sb-ink="dark"/></svg>'), false, 'only the root counts');
  });
});
