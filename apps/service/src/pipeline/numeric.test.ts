import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareValues, mismatchMessage, parseQuantity, readMismatches, recomputeFinalValues } from './numeric.ts';
import type { PythonResult } from './python.ts';

const ran = (stdout: string, ok = true): (() => Promise<PythonResult>) => async () => ({ ok, stdout, version: 'test' });

describe('parsing a stated value', () => {
  test('prefix, decimal comma, power of ten and significant figures', () => {
    assert.deepEqual(parseQuantity('4.7 kΩ') && { base: parseQuantity('4.7 kΩ')!.base, unit: parseQuantity('4.7 kΩ')!.unit, digits: parseQuantity('4.7 kΩ')!.digits }, { base: 4700, unit: 'Ω', digits: 2 });
    assert.equal(parseQuantity('3,2 mA')!.base, 0.0032);
    assert.equal(parseQuantity('$3.20 \\times 10^{-3}\\,\\mathrm{A}$')!.base, 0.0032);
    assert.equal(parseQuantity('3.20e-3 A')!.digits, 3);
    assert.equal(parseQuantity('4700 \\Omega')!.digits, 2, 'trailing zeros of a whole number do not count');
    assert.equal(parseQuantity('12 m/s')!.unit, 'm/s', 'a unit it does not know stays whole');
  });

  test('things that are not a plain number give nothing', () => {
    assert.equal(parseQuantity('x = 2\\pi k'), null);
    assert.equal(parseQuantity('(0, +\\infty)'), null);
    assert.equal(parseQuantity('3/4'), null, 'a fraction');
    assert.equal(parseQuantity('2π'), null, 'a multiple of pi');
    assert.equal(parseQuantity('760 mmHg'), null, 'a unit it does not know');
  });
});

describe('comparing recomputed values with the stated ones', () => {
  test('a matching answer, whatever the prefix', () => {
    const r = compareValues([{ name: 'R_eq', value: '4.7 kΩ' }], 'R_eq = 4700.0 ohm\n');
    assert.deepEqual(r, { compared: [{ name: 'R_eq', stated: '4.7 kΩ', computed: '4700.0 ohm' }], mismatches: [] });
    assert.equal(compareValues([{ name: 'R_eq', value: '4.7 kΩ' }], 'R_eq = 4.7 kohm')!.mismatches.length, 0, 'the program may print a prefixed unit too');
    assert.equal(compareValues([{ name: 'I', value: '3,2 mA' }], 'I = 0.0032 A')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'm', value: '2.5 g' }], 'm = 0.0025 kg')!.mismatches.length, 0);
  });

  test('a mismatch carries both numbers', () => {
    const r = compareValues([{ name: 'R_eq', value: '4.7 kΩ' }, { name: 'I', value: '2.0 mA' }], 'R_eq = 470.0 ohm\nI = 0.002 A');
    assert.equal(r!.compared.length, 2);
    assert.deepEqual(r!.mismatches, [{ name: 'R_eq', stated: '4.7 kΩ', computed: '470.0 ohm' }]);
  });

  test('the tolerance is one unit of the last stated digit', () => {
    assert.equal(compareValues([{ name: 'I', value: '3.2 mA' }], 'I = 0.003249 A')!.mismatches.length, 0, 'rounded intermediate steps differ by less than 0.1 mA');
    assert.equal(compareValues([{ name: 'I', value: '3.2 mA' }], 'I = 0.0035 A')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 'I', value: '3.200 mA' }], 'I = 0.003249 A')!.mismatches.length, 1, 'a more precise statement is held to more precision');
    assert.equal(compareValues([{ name: 'f', value: '4700 Hz' }], 'f = 4651')!.mismatches.length, 0);
  });

  test('a value that cannot be compared with confidence is left out', () => {
    assert.equal(compareValues([{ name: 'R', value: '4.7 kΩ' }], 'R = 4.7'), null, 'an unmarked 4.7 fits only the prefixed number');
    assert.equal(compareValues([{ name: 'v', value: '12 m/s' }], 'v = 43.2 km/h'), null, 'another unit');
    assert.equal(compareValues([{ name: 'v', value: '12 m/s' }], 'speed = 12 m/s')!.mismatches.length, 0, 'one value on each side needs no name');
    assert.equal(compareValues([{ name: 'a', value: '1 V' }, { name: 'b', value: '2 V' }], 'c = 5 V'), null);
    assert.equal(compareValues([{ name: 'x', value: '2\\pi k' }], 'x = 6.28'), null);
  });

  test('1,500 is read as one and a half and as fifteen hundred, and only a value that fits neither is a mismatch', () => {
    assert.equal(compareValues([{ name: 'F', value: '1,500 N' }], 'F = 1500 N')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'F', value: '1,500 N' }], 'F = 1.5 N')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'F', value: '1,500 N' }], 'F = 2000 N')!.mismatches.length, 1);
  });

  test('a stated zero keeps its decimal places and its prefix', () => {
    assert.equal(compareValues([{ name: 'I', value: '0.00 mA' }], 'I = 0.9 A')!.mismatches.length, 1, '0.00 mA is zero to a hundredth of a milliamp');
    assert.equal(compareValues([{ name: 'I', value: '0.00 mA' }], 'I = 0.000004 A')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'V', value: '0,0 V' }], 'V = 0.3 V')!.mismatches.length, 1);
  });

  test('a percentage and the same value as a fraction agree', () => {
    assert.equal(compareValues([{ name: 'p', value: '50%' }], 'p = 0.5')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'p', value: '50 %' }], 'p = 50 %')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'p', value: '50%' }], 'p = 0.8')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 'p', value: '50%' }], 'p = 50'), null, 'an unmarked 50 fits only the number as written');
  });

  test('a number without a unit is compared as it is', () => {
    assert.equal(compareValues([{ name: 'n', value: '0.25' }], 'n = 0.25')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'n', value: '0.25' }], 'n = 0.5')!.mismatches.length, 1);
  });
});

describe('recomputeFinalValues', () => {
  test('runs the computation and compares', async () => {
    assert.equal((await recomputeFinalValues('print(1)', [{ name: 'R', value: '500 Ω' }], ran('R = 500.0 ohm')))!.mismatches.length, 0);
    assert.equal((await recomputeFinalValues('print(1)', [{ name: 'R', value: '5 kΩ' }], ran('R = 500.0 ohm')))!.mismatches.length, 1);
  });

  test('a computation that throws, prints nothing, or does not run is ignored', async () => {
    const stated = [{ name: 'R', value: '500 Ω' }];
    assert.equal(await recomputeFinalValues('1/0', stated, ran('R = 1 ohm', false)), null);
    assert.equal(await recomputeFinalValues('pass', stated, ran('  \n')), null);
    assert.equal(await recomputeFinalValues('pass', stated, async () => { throw new Error('no sandbox'); }), null);
    assert.equal(await recomputeFinalValues('print("done")', stated, ran('done')), null, 'a line without a value');
  });

  test('without a computation, or with a symbolic answer, the sandbox is not started', async () => {
    const never = async (): Promise<PythonResult> => { throw new Error('must not run'); };
    assert.equal(await recomputeFinalValues('', [{ name: 'R', value: '500 Ω' }], never), null);
    assert.equal(await recomputeFinalValues(undefined, [{ name: 'R', value: '500 Ω' }], never), null);
    assert.equal(await recomputeFinalValues('print(1)', [{ name: 'f', value: 'f(x) = x^2 + 1' }], never), null);
    assert.equal(await recomputeFinalValues('print(1)', [], never), null);
  });

  test('in the real sandbox', async () => {
    const code = 'import math\nr = 1 / (1 / 1000 + 1 / 1000)\nprint(f"R_eq = {r} ohm")\nprint(f"tau = {r * 2e-6:.6g} s")';
    const ok = await recomputeFinalValues(code, [{ name: 'R_eq', value: '0.50 kΩ' }, { name: 'tau', value: '1.0 ms' }]);
    assert.equal(ok!.compared.length, 2);
    assert.equal(ok!.mismatches.length, 0);
    const bad = await recomputeFinalValues(code, [{ name: 'R_eq', value: '5.0 kΩ' }]);
    assert.equal(bad!.mismatches.length, 1);
  });
});

test('the blocker text of a numeric mismatch can be read back value by value', () => {
  const found = [{ name: 'f_c', stated: '21,28 kHz', computed: '3386.2754 Hz' }, { name: 'G', stated: '-10', computed: '-9.9' }];
  assert.deepEqual(readMismatches(mismatchMessage(found)), found);
  assert.deepEqual(readMismatches('The independent solution reaches a different result: 2'), []);
});
