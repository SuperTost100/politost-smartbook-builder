import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES_VERSION, rulesVersionOf } from './rulesVersion.ts';

test('rulesVersionOf changes with any rule, the compiler or content-core, and not with the order files are read in', () => {
  const base = rulesVersionOf({ 'lint.ts': 'rule A', 'compile.ts': 'compiler' }, '0.6.0');
  assert.equal(rulesVersionOf({ 'compile.ts': 'compiler', 'lint.ts': 'rule A' }, '0.6.0'), base);
  assert.notEqual(rulesVersionOf({ 'lint.ts': 'rule B', 'compile.ts': 'compiler' }, '0.6.0'), base);
  assert.notEqual(rulesVersionOf({ 'lint.ts': 'rule A', 'compile.ts': 'compiler 2' }, '0.6.0'), base);
  assert.notEqual(rulesVersionOf({ 'lint.ts': 'rule A', 'compile.ts': 'compiler' }, '0.6.1'), base);
  // Moving text from one file to the next is a change too.
  assert.notEqual(rulesVersionOf({ 'a.ts': 'xy', 'b.ts': 'z' }, '0.6.0'), rulesVersionOf({ 'a.ts': 'x', 'b.ts': 'yz' }, '0.6.0'));
  assert.match(RULES_VERSION, /^[0-9a-f]{16}$/);
});
