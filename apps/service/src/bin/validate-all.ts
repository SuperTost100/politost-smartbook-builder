// Lint every book the builder published into a politost-books checkout with this builder's rules:
//   npm run validate-all -- --books <books checkout>
// For each book it lists the blocker and major findings that were not there when it was published (as recorded in its
// .builder.json; a book without one lists them all), so a rule added after a publish still reads the published text.
// Exits 1 when any book has one. It reads only the checkout, not the builder's database.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANIFEST, validatePublished, type PublishedCheck } from '../pipeline/publish.ts';

export function formatChecks(checks: PublishedCheck[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    const count = (s: string) => c.fresh.filter((f) => f.severity === s).length;
    lines.push('', `${c.slug}: ${count('blocker')} new blocker, ${count('major')} new major${c.manifest ? '' : ` (no ${MANIFEST}, so every finding is listed)`}`);
    for (const f of c.fresh) lines.push(`  ${f.severity.padEnd(7)} ${f.rule.padEnd(20)} ${f.file}${f.line !== undefined ? `:${f.line}` : ''}  ${f.message}`);
  }
  if (!checks.length) lines.push('', 'No book of this checkout was published by the builder.');
  return lines.join('\n').trimStart();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--books');
  const books = i >= 0 ? args[i + 1] : undefined;
  if (!books || books.startsWith('--')) {
    console.log('Usage: npm run validate-all -- --books <books checkout>');
    process.exit(1);
  }
  try {
    const checks = validatePublished(resolve(books));
    console.log(formatChecks(checks));
    if (checks.some((c) => c.fresh.length)) process.exitCode = 1;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
