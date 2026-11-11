// Redraws the stored plot, diagram and structure figures of a project from their stored specs:
//   npm run redraw-figures -- --project <id> [--dry-run] [--data-dir <dir>]
// Figures drawn before 0.4.0 have a white background rectangle, so they stay white boxes on a dark page. The drawers now write
// transparent SVG with the dark-ink marker (see docs/ARCHITECTURE.md, "Dark mode"). This writes the new drawing over the old
// file: same asset row, same file name, same caption and alt text. Text, photos, uploaded images and drawings are not touched.
// A figure whose spec no longer validates is left as it is and listed. `--dry-run` lists what would change and writes nothing.
// Safe while the service runs: each file is replaced with one rename. A browser may show the old file for a minute (cache).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderPlotSvg, validatePlotSpec } from '@smartbuilder/content';
import { parseArgs, paths } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import { renderDiagramSvg, validateDiagram, type DiagramKind } from '../figures/diagram.ts';
import { renderStructureSvg, validateStructureSpec } from '../figures/structure.ts';
import { assertSafeSvg, assetPath, listAssets } from '../repo/assets.ts';
import { getProject } from '../repo/index.ts';

const DIAGRAM_KINDS: readonly string[] = ['levels', 'orbitals', 'cell', 'periodic'] satisfies DiagramKind[];

export interface RedrawReport {
  /** File names that were (or, in a dry run, would be) replaced. */
  redrawn: string[];
  /** Figures that already match what the drawer writes now. */
  unchanged: string[];
  /** Figures left as they are because the spec or the file could not be used, with the reason. */
  failed: { filename: string; reason: string }[];
  /** Photos, uploaded images and drawings: not redrawn from a spec here. */
  skipped: number;
}

/** The SVG the drawers write today for a stored spec, or the reason it cannot be drawn. */
function drawAgain(origin: string, spec: unknown, language: string): { ok: true; svg: string } | { ok: false; reason: string } {
  try {
    if (origin === 'plot') {
      const v = validatePlotSpec(spec);
      return v.ok ? { ok: true, svg: renderPlotSvg(v.spec) } : { ok: false, reason: v.errors.join('; ') };
    }
    if (origin === 'structure') {
      const v = validateStructureSpec(spec);
      return v.ok ? { ok: true, svg: renderStructureSvg(v.spec) } : { ok: false, reason: v.errors.join('; ') };
    }
    const { kind, ...rest } = (spec ?? {}) as Record<string, unknown>;
    if (typeof kind !== 'string' || !DIAGRAM_KINDS.includes(kind)) return { ok: false, reason: 'the stored spec has no diagram kind' };
    const v = validateDiagram(kind as DiagramKind, rest);
    return v.ok ? { ok: true, svg: renderDiagramSvg(kind as DiagramKind, v.spec, language) } : { ok: false, reason: v.errors.join('; ') };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function redrawFigures(ctx: AppContext, projectId: string, opts: { dryRun?: boolean } = {}): RedrawReport {
  const { language } = getProject(ctx, projectId);
  const report: RedrawReport = { redrawn: [], unchanged: [], failed: [], skipped: 0 };
  for (const a of listAssets(ctx, projectId)) {
    if (a.origin !== 'plot' && a.origin !== 'structure' && a.origin !== 'diagram') { report.skipped++; continue; }
    const row = ctx.db.get<{ path: string; project_id: string }>('SELECT path, project_id FROM assets WHERE id = ?', a.id)!;
    const file = assetPath(ctx, row);
    if (!existsSync(file)) { report.failed.push({ filename: a.filename, reason: 'the file is missing' }); continue; }
    const drawn = drawAgain(a.origin, a.spec, language);
    if (!drawn.ok) { report.failed.push({ filename: a.filename, reason: drawn.reason }); continue; }
    try { assertSafeSvg(drawn.svg); } catch (err) { report.failed.push({ filename: a.filename, reason: err instanceof Error ? err.message : String(err) }); continue; }
    if (readFileSync(file, 'utf8') === drawn.svg) { report.unchanged.push(a.filename); continue; }
    if (!opts.dryRun) {
      writeFileSync(`${file}.tmp`, drawn.svg);
      renameSync(`${file}.tmp`, file);
    }
    report.redrawn.push(a.filename);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const projectId = args[args.indexOf('--project') + 1];
  if (!args.includes('--project') || !projectId || projectId.startsWith('--')) {
    console.log('Usage: npm run redraw-figures -- --project <id> [--dry-run] [--data-dir dir]');
    process.exit(1);
  }
  const config = parseArgs(args);
  if (!existsSync(paths.db(config))) {
    console.error(`No database in ${config.dataDir}.`);
    process.exit(1);
  }
  const ctx = createContext(config);
  try {
    const dryRun = args.includes('--dry-run');
    const r = redrawFigures(ctx, projectId, { dryRun });
    console.log(`${dryRun ? 'Would redraw' : 'Redrew'} ${r.redrawn.length} figures, ${r.unchanged.length} already current, ${r.skipped} photos, uploads and drawings left alone.`);
    for (const f of r.redrawn) console.log(`  ${dryRun ? 'would redraw' : 'redrawn'}  ${f}`);
    for (const f of r.failed) console.log(`  LEFT AS IS  ${f.filename}: ${f.reason}`);
    if (r.failed.length) process.exitCode = 2;
  } finally {
    ctx.db.close();
  }
}
