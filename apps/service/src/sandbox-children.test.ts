import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The four sandbox children answer with one JSON line on stdout and then exit. Exiting right after write() loses the answer
// when the parent reads late: with the parent's stream paused for 300 ms, a child that wrote 400,000 characters and called
// process.exit(0) delivered none of them, and CI saw it as "The renderer stopped without an answer (exit code 0)".
const CHILDREN = ['figures/drawing/child/typst-child.mjs', 'figures/drawing/child/python-child.mjs', 'pipeline/python.ts', 'pipeline/matlab.ts'];

test('every sandbox child waits for its answer to be written before it exits', () => {
  for (const file of CHILDREN) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    const exits = source.match(/process\.exit\(\d/g) ?? [];
    assert.equal(exits.length, 1, `${file} has one exit`);
    assert.match(source, /await sent;\s*process\.exit\(0\);/, `${file} waits for the write`);
    assert.match(source, /process\.stdout\.write\([^;]*, \(\) => done\(\)\)/, `${file} resolves on the write callback`);
  }
});
