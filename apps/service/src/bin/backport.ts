// Back-port hand edits from a published book folder into the builder:
//   npm run backport -- --project <id> --from <books checkout>/books/<slug> [--dry-run] [--accept-graph-lint] [--data-dir <dir>]
// The folder must have been published with npm run publish-book: its .builder.json names the export it came from. Each unit
// the folder changed against that export (a section, an exercise, a graph, a figure caption) is mapped to its source and
// written as an author edit, in one transaction for the book, but only if the builder did not change the same unit since,
// compiling the book again reproduces the books text, and no blocker or major finding is added (see pipeline/backport.ts).
// A graph the graph lint blocks is refused unless --accept-graph-lint is given. --dry-run prints the same table and writes nothing.
// A real run takes the data directory's service lock, so stop the service first (systemctl --user stop smartbuilder.service):
// the transaction holds the database while the book compiles again, and a save the service made meanwhile would wait or fail.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lockDataDir, parseArgs, paths } from '../config.ts';
import { createContext } from '../context.ts';
import { backportProject, type BackportResult, type UnitStatus } from '../pipeline/backport.ts';

const STATUSES: UnitStatus[] = ['mapped', 'refused', 'unmapped', 'compiler-owned'];

export function formatResult(r: BackportResult, dryRun: boolean): string {
  const lines: string[] = [];
  for (const status of STATUSES) {
    for (const u of r.units.filter((x) => x.status === status)) {
      lines.push([status.padEnd(14), u.kind.padEnd(8), u.unit, u.reason ? `  (${u.reason})` : ''].join(' '));
    }
  }
  lines.push('');
  for (const kind of ['section', 'caption', 'question', 'graph', 'file'] as const) {
    const of = r.units.filter((u) => u.kind === kind);
    if (of.length) lines.push(`${kind.padEnd(9)} ${STATUSES.map((s) => `${s} ${of.filter((u) => u.status === s).length}`).join(', ')}`);
  }
  const serious = (f: BackportResult['base']['findings']) => `${f.filter((x) => x.severity === 'blocker').length} blocker, ${f.filter((x) => x.severity === 'major').length} major`;
  lines.push(`Compile findings: ${serious(r.base.findings)} before, ${serious(r.after.findings)} after.`);
  lines.push(`Open blocker review issues: ${r.openBlockers.before} before, ${r.openBlockers.after} after.`);
  if (r.residual.length) {
    lines.push('', 'Files that still differ from the books folder:');
    for (const f of r.residual) lines.push(`  ${f.file}`, ...f.causes.map((c) => `    ${c}`));
  }
  if (r.bookRefusal) lines.push('', `Nothing written: ${r.bookRefusal}`);
  const n = r.units.filter((u) => u.status === 'mapped').length;
  lines.push('', dryRun ? `Dry run: ${n} units would be written.` : r.written ? `Wrote ${n} units.` : 'Nothing to write.');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(`--${name}`); const v = i >= 0 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
  const projectId = value('project');
  const from = value('from');
  if (!projectId || !from) {
    console.log('Usage: npm run backport -- --project <id> --from <books checkout>/books/<slug> [--dry-run] [--accept-graph-lint] [--data-dir dir]');
    process.exit(1);
  }
  const config = parseArgs(args);
  if (!existsSync(paths.db(config))) {
    console.error(`No database in ${config.dataDir}.`);
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const lock = dryRun ? null : lockDataDir(config);
  if (lock && 'heldBy' in lock) {
    console.error(`The Smart Builder service (process ${lock.heldBy}) is using ${config.dataDir}. Stop it first (systemctl --user stop smartbuilder.service), or use --dry-run.`);
    process.exit(1);
  }
  const ctx = createContext(config);
  try {
    const r = backportProject(ctx, projectId, resolve(from), { dryRun, acceptGraphLint: args.includes('--accept-graph-lint') });
    console.log(formatResult(r, dryRun));
    if (r.bookRefusal) process.exitCode = 2;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    ctx.db.close();
    if (lock && 'release' in lock) lock.release();
  }
}
