import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { isInkDrawing, renderPlotSvg } from '@smartbuilder/content';
import { paths, toDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { renderDiagramSvg } from '../figures/diagram.ts';
import { renderStructureSvg } from '../figures/structure.ts';
import { makeCtx, seedProject } from '../llm/testkit.ts';
import { redrawFigures } from './redraw-figures.ts';

let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
beforeEach(() => { kit = makeCtx(); ctx = kit.ctx; seedProject(ctx, 'p1'); });
afterEach(() => kit.cleanup());

const PLOT = { xRange: [-2, 2], yRange: [-1, 5], xLabel: 'x', yLabel: 'y', functions: [{ expr: 'x^2', label: 'x^2' }] };
const STRUCTURE = { smiles: 'O', style: 'lewis', lonePairs: true, formula: 'H2O' };
const PERIODIC = { kind: 'periodic', highlights: [{ elements: ['Li', 'Na', 'K'], label: 'Alkali metals' }], trends: [] };

/** What the drawers wrote before 0.4.0: the same figure with a white rectangle behind it and no marker. */
const old = (svg: string) => svg.replace(/ data-sb-ink="dark"/, '').replace(/(<title>.*<\/title>)/, '$1\n<rect width="640" height="400" fill="#FFFFFF"/>');

function addAsset(id: string, filename: string, origin: string, spec: unknown, bytes: string | Buffer, caption = `Caption of ${id}`) {
  const dir = paths.assets(ctx.config, 'p1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}${filename.slice(filename.lastIndexOf('.'))}`);
  writeFileSync(file, bytes);
  ctx.db.insert('assets', {
    id, project_id: 'p1', node_id: 's1', filename, mime: filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png', path: toDataPath(ctx.config, file),
    origin, spec, caption, alt: `Alt of ${id}`, checks: [], created_at: 'now',
  });
  return file;
}

test('stored plots, structures and diagrams are drawn again in place, and nothing else changes', () => {
  const plot = addAsset('a1', 'ab-plot.svg', 'plot', PLOT, old(renderPlotSvg(PLOT as never)));
  const structure = addAsset('a2', 'ab-water.svg', 'structure', STRUCTURE, old(renderStructureSvg(STRUCTURE as never)));
  const diagram = addAsset('a3', 'ab-periodic.svg', 'diagram', PERIODIC, old(renderDiagramSvg('periodic', { highlights: PERIODIC.highlights, trends: [] } as never, 'it')));
  const photo = addAsset('a4', 'ab-photo.png', 'stock', { provider: 'commons', id: 'x' }, Buffer.from([1, 2, 3]));
  const drawing = addAsset('a5', 'ab-circuit.svg', 'generated-svg', { language: 'typst', source: '' }, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  const broken = addAsset('a6', 'ab-broken.svg', 'plot', { xRange: [3, 1], yRange: [0, 1], functions: [] }, old(renderPlotSvg(PLOT as never)));
  const before = new Map([plot, structure, diagram, photo, drawing, broken].map((f) => [f, readFileSync(f)]));
  const rows = () => JSON.stringify(ctx.db.all('SELECT * FROM assets ORDER BY id'));
  const rowsBefore = rows();

  const dry = redrawFigures(ctx, 'p1', { dryRun: true });
  assert.deepEqual(dry.redrawn.sort(), ['ab-periodic.svg', 'ab-plot.svg', 'ab-water.svg']);
  assert.equal(dry.failed.length, 1);
  assert.equal(dry.failed[0].filename, 'ab-broken.svg');
  assert.equal(dry.skipped, 2);
  for (const [f, bytes] of before) assert.ok(readFileSync(f).equals(bytes), 'a dry run writes nothing');

  const done = redrawFigures(ctx, 'p1');
  assert.deepEqual(done.redrawn.sort(), dry.redrawn.sort());
  for (const f of [plot, structure, diagram]) {
    const svg = readFileSync(f, 'utf8');
    assert.ok(isInkDrawing(svg));
    assert.doesNotMatch(svg, /<rect width="\d+" height="\d+" fill="#FFFFFF"/);
  }
  for (const f of [photo, drawing, broken]) assert.ok(readFileSync(f).equals(before.get(f)!), `${f} stays as it was`);
  assert.equal(rows(), rowsBefore, 'asset rows keep their file name, caption, alt text and spec');

  const again = redrawFigures(ctx, 'p1');
  assert.deepEqual(again.redrawn, []);
  assert.equal(again.unchanged.length, 3);
});
