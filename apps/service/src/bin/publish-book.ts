// Publish a book into a politost-books checkout:
//   npm run publish-book -- --project <id> --books <books checkout> [--version x.y.z] [--dry-run] [--data-dir <dir>]
// It compiles the book through the same gate as "Approve and export" (a book with a failed check or an open review blocker
// is refused), stores the export, and writes books/<slug>/ with a .builder.json that names it (see pipeline/publish.ts).
// The version is the one after the folder's unless --version is given. It stops when a file of the folder matches neither
// the export the folder was published from nor the new one: an edit made outside the builder, to back-port first.
// It does not commit or push. --dry-run runs every check, lists the files that would change, and writes nothing.
// A real run takes the data folder's lock, so stop the service first (systemctl --user stop smartbuilder.service).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lockDataDir, parseArgs, paths } from '../config.ts';
import { createContext } from '../context.ts';
import { MANIFEST, planPublish, writePublish, type PublishPlan } from '../pipeline/publish.ts';

export function formatPlan(p: PublishPlan, dryRun: boolean): string {
  const lines: string[] = [`Book: books/${p.slug}, version ${p.previousVersion ?? 'none'} -> ${p.version}`];
  for (const n of p.notices) lines.push('', `Notice: ${n}`);
  lines.push('', `Files: ${p.diff.added.length} added, ${p.diff.changed.length} changed, ${p.diff.removed.length} removed.`);
  for (const [label, list] of [['added', p.diff.added], ['changed', p.diff.changed], ['removed', p.diff.removed]] as const) {
    for (const path of list) lines.push(`  ${label.padEnd(8)} ${path}`);
  }
  for (const r of p.refusals) lines.push('', `Refused: ${r}`);
  lines.push('');
  if (p.refusals.length) lines.push(dryRun ? 'Dry run: a real run would be refused.' : 'Nothing written.');
  else if (p.upToDate) lines.push(`books/${p.slug} already holds this book; nothing ${dryRun ? 'would be' : 'was'} written.`);
  else lines.push(dryRun ? `Dry run: nothing written. A real run stores the export and writes these files and ${MANIFEST}.` : `Stored the export and wrote books/${p.slug} with its ${MANIFEST}. Commit and open the pull request in the books repo.`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(`--${name}`); const v = i >= 0 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
  const projectId = value('project');
  const books = value('books');
  if (!projectId || !books) {
    console.log('Usage: npm run publish-book -- --project <id> --books <books checkout> [--version x.y.z] [--dry-run] [--data-dir dir]');
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
    const plan = planPublish(ctx, { projectId, booksDir: resolve(books), version: value('version') });
    if (!dryRun && !plan.refusals.length && !plan.upToDate) writePublish(ctx, plan);
    console.log(formatPlan(plan, dryRun));
    // 2 when the folder holds hand edits (back-port them), 1 for any other refusal.
    if (plan.refusals.length) process.exitCode = plan.handEdited.length ? 2 : 1;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    ctx.db.close();
    if (lock && 'release' in lock) lock.release();
  }
}
