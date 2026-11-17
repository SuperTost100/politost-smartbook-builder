// The version of the rules a book is checked and compiled with. Node only (it reads this package's sources), so it is not
// exported from index.ts, which the web app bundles: import it from '@smartbuilder/content/rules-version'.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A hash of the lint rules, the compiler and the content-core version: the sources of this package (every `.ts` file but
 * tests and test fixtures) and content-core's version. Any change to a rule or to the compiler changes it, so an export
 * stored with another value was checked with other rules. A hash has no order: "older" means "different from the code now".
 */
export function rulesVersionOf(sources: Record<string, string>, coreVersion: string): string {
  const h = createHash('sha256').update(`content-core ${coreVersion}\n`);
  for (const name of Object.keys(sources).sort()) h.update(`${name}\n${sources[name].length}\n${sources[name]}`);
  return h.digest('hex').slice(0, 16);
}

function packageSources(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'fixtures.ts') out[name] = readFileSync(join(dir, name), 'utf8');
  }
  return out;
}

function contentCoreVersion(): string {
  // content-core exports only its entry point, so its package.json is found from there.
  let dir = dirname(fileURLToPath(import.meta.resolve('@politost/content-core')));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('The package.json of @politost/content-core was not found.');
    dir = up;
  }
  return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version);
}

export const RULES_VERSION = rulesVersionOf(packageSources(dirname(fileURLToPath(import.meta.url))), contentCoreVersion());
