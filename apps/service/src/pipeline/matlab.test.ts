import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMatlab } from './matlab.ts';

test('a course script runs: loops, a local function, matrices and the shims', async () => {
  const r = await runMatlab([
    's = 0;',
    'for k = 1:10',
    '  s = s + k^2;',
    'end',
    'A = [4 -1 0; -1 4 -1; 0 -1 4]; x = A \\ [1; 2; 3];',
    "fprintf('%d %.6f %.8f %.10f\\n', s, x(2), newton(@(t) t^2 - 2, @(t) 2*t, 1), fzero(@(t) cos(t) - t, 1));",
    'function x = newton(f, df, x)',
    '  for k = 1:8',
    '    x = x - f(x)/df(x);',
    '  end',
    'end',
  ].join('\n'), 20_000);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stdout.trim(), '385 0.857143 1.41421356 0.7390851332');
  assert.equal(r.figures, 0);
});

test('plots are counted per figure, and close all forgets the earlier ones', async () => {
  const r = await runMatlab("plot(1:3, [1 4 9]);\nclose all\nx = linspace(0, 1);\nplot(x, x.^2); hold on; plot(x, x.^3);\nfigure; semilogy(1:5, 10.^(1:5));", 20_000);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.figures, 2);
});

test('an error names its line and keeps the output printed before it', async () => {
  const r = await runMatlab("disp('prima')\nA = [1 2; 3 4];\nC = A * [1 2 3]", 20_000);
  assert.equal(r.ok, false);
  assert.equal(r.stdout.trim(), 'prima');
  assert.match(r.error ?? '', /^Error at line 3: /);
});

test('a function numbl lacks fails the check, so the example never reaches a reader where it cannot run', async () => {
  const r = await runMatlab("x = fminsearch(@(x) (x - 1)^2, 0)", 20_000);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /fminsearch/);
});

test('an endless loop is killed at the timeout', async () => {
  const r = await runMatlab('while true\nend', 3_000);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Timed out/);
});

test('the script cannot read host files', async () => {
  const r = await runMatlab("t = fileread('/etc/passwd');\ndisp(t(1:10))", 20_000);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.stdout, /root/);
});
