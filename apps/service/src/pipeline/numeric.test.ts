import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareValues, roundsOutput, mismatchMessage, parseQuantity, readMismatches, recomputeFinalValues, runConsistency } from './numeric.ts';
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
    assert.equal(parseQuantity('14 psi'), null, 'a unit it does not know');
    assert.equal(parseQuantity('760 mmHg')!.unit, 'mmHg', 'a pressure unit compared only with the same unit');
  });
});

describe('counts and last digits (the exercise re-check of 17 November)', () => {
  test('a count of atoms, molecules or ions is a plain number, also with what it counts after it', () => {
    for (const text of ['9,02 × 10^23 atomi', '9,02 \\times 10^{23} atomi di ossigeno', '9.02e23 atoms', '9,02 · 10^23 molecole']) {
      const q = parseQuantity(text);
      assert.ok(q, text);
      assert.equal(q.unit, '', text);
      assert.ok(Math.abs(q.base - 9.02e23) < 1e18, text);
    }
    assert.equal(parseQuantity('3 atomic units'), null, 'a word that only starts like a count noun is not one');
    assert.equal(parseQuantity('2,00 × 10^20 ions/L'), null, 'a count per litre is a density, not a plain number');
    assert.equal(parseQuantity('2,00 × 10^23 ioni/m^3'), null);
    assert.equal(parseQuantity('2.00e20 ions of sodium L⁻¹'), null);
    assert.equal(parseQuantity('2.00e20 ioni di sodio per litro'), null);
    // Chimica 2a682723: the solution's 9,02 is right; the model claimed 9,03 and no recompute ran.
    assert.equal(compareValues([{ name: 'N_atomi', value: '9,02 × 10^23 atomi' }], 'N_atomi = 9.02497780e23')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'N_atomi', value: '9,10 × 10^23 atomi' }], 'N_atomi = 9.02497780e23 atomi')!.mismatches.length, 1);
  });

  test('a last digit that rounding explains matches, a wrong value does not', () => {
    // Fisica 785e1c65, Chimica 4d3131a0 and fd4d6c96 were blocked on these; Fisica 6e84f71e had a real error.
    assert.equal(compareValues([{ name: 'R', value: '339 N' }], 'R = 339.702 N')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'resa', value: '79,9 %' }], 'resa = 79.9578 %')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'resa', value: '79,7 %' }], 'resa = 79.7585 %')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'p2', value: '140 kPa' }], 'p2 = 170000.0 Pa')!.mismatches.length, 1);
  });

  test('complete only when every stated number was compared', () => {
    assert.equal(compareValues([{ name: 'a', value: '1 V' }, { name: 'b', value: '2 V' }], 'a = 1 V\nb = 2 V')!.complete, true);
    assert.equal(compareValues([{ name: 'a', value: '1 V' }, { name: 'b', value: '2 V' }], 'a = 1 V')!.complete, false);
    assert.equal(compareValues([{ name: 'a', value: '1.00 V' }, { name: 'p', value: '2.00 psi' }], 'a = 1 V\np = 3 psi')!.complete, false, 'a unit it cannot read leaves that value unchecked');
  });
});

describe('the step and final checks of the exercise check (18 November)', () => {
  test('a program that prints fewer digits than the solution is compared at its own precision', () => {
    // Chimica 01252ddb and 4d3131a0: the step program printed 0.002801 kg and 79.958 %.
    // A program that rounds what it prints: within the last printed digit is no mismatch, but proves nothing either.
    const rounded = { rounded: true };
    assert.equal(compareValues([{ name: 'm', value: '2.80068 g' }], 'm = 0.002801 kg', rounded), null);
    assert.equal(compareValues([{ name: 'resa', value: '79.9578 %' }], 'resa = 79.958 %', rounded), null);
    assert.equal(compareValues([{ name: 'x', value: '1.23' }], 'x = 1.2', rounded), null);
    assert.equal(compareValues([{ name: 'm', value: '0.55 kg' }], 'm = 0.5 kg\nother = 0.123', rounded), null, 'a plain print in a program that also rounds is not a match');
    assert.equal(compareValues([{ name: 'm', value: '2.80068 g' }], 'm = 0.002901 kg', rounded)!.mismatches.length, 1);
    const settled = compareValues([{ name: 'a', value: '1.000 V' }, { name: 'm', value: '2.80068 g' }], 'a = 1.0002 V\nm = 0.002801 kg', rounded)!;
    assert.deepEqual([settled.mismatches.length, settled.complete], [0, false], 'the uncompared value leaves the results unsettled');
    // PR #160 review: 1.0 printed by "{v:.1f}" may be 1.04, so it settles neither 1.00 V nor 1.000 V. A match needs every
    // value the printed digits allow to lie within the stated one's tolerance.
    assert.equal(compareValues([{ name: 'a', value: '1.00 V' }], 'a = 1.0 V', rounded), null);
    assert.equal(compareValues([{ name: 'a', value: '1.00 V' }], 'a = 1.00 V', rounded)!.mismatches.length, 0, 'the same precision still matches');
    assert.equal(compareValues([{ name: 'a', value: '1.00 V' }], 'a = 1.3 V', rounded)!.mismatches.length, 1);
    // A program that prints plainly shows a float in full: a short print is an exact value, with no room from its last digit.
    assert.equal(compareValues([{ name: 'm', value: '0.55 kg' }], 'm = 0.5 kg')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 'n', value: '3.4' }], 'n = 3')!.mismatches.length, 1);
    const step = (code: string, printed: number) => (roundsOutput(code) || (() => NaN))(printed);
    assert.equal(step('print(f"m = {m:.4g} kg")', 0.0123), 1e-5);
    assert.equal(step('print("resa = %.3f %%" % r)', 79.958), 1e-3);
    assert.equal(step('print("p =", round(p, 4), "Pa")', 2.5), Infinity, 'round() returns a number the program may still scale');
    assert.equal(step('print(f"x = {x:.2F}")', 1.5), 1e-2);
    assert.equal(step('print("x = %.3G" % x)', 123), 1);
    assert.equal(step('print(f"a = {a:.6g}")\nprint(f"b = {b:.1f}")', 1), 0.1, 'the coarsest format counts, whichever line it wrote');
    assert.equal(step('print(f"a = {a:.6g}")\nprint("I =", 1000 * round(i, 4), "mA")', 1.2), Infinity, 'one round() leaves the last printed digit for every line');
    assert.equal(step('print("N =", 1000 * float("%.3g" % n))', 1.2), Infinity, 'a format read back as a number may be scaled too');
    assert.equal(step('s = "%.4f" % i\nprint("I =", 1000 * float(s), "mA")', 1.2), Infinity, 'also through a variable');
    // PR #161 review: 1000 * round(0.00123456, 4) prints 1.2, known to 0.1 mA, so the right 1.23456 mA is no mismatch.
    assert.equal(compareValues([{ name: 'I', value: '1.23456 mA' }], 'I = 1.2 mA', { rounded: roundsOutput('print("I =", 1000 * round(i, 4), "mA")') }), null);
    assert.equal(step('print("J = %g N*s" % J)', 2), 1e-5, 'Python prints %g with six significant figures');
    assert.equal(compareValues([{ name: 'x', value: '1.23456' }], 'x = 1.23', { rounded: roundsOutput('print(f"x = {x:.2F}")') }), null, 'a rounded print of a right value is left unsettled');
    assert.equal(roundsOutput('print(f"m = {m} kg")\nprint("n =", n)'), false);
    // PR #160 review: Python drops the trailing zeros of {x:.6g}, so 0.001 is 0.00100000 and matches 1.0 ms, while 1.0
    // from {v:.1f} may be 1.04 and settles nothing. A plain 0.5 next to .4g prints differs from 0.55.
    const g6 = { rounded: roundsOutput('print(f"tau = {t:.6g} s")') };
    assert.equal(compareValues([{ name: 'tau', value: '1.0 ms' }], 'tau = 0.001 s', g6)!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'v', value: '1.00 V' }], 'v = 1.0 V', { rounded: roundsOutput('print(f"v = {v:.1f} V")') }), null);
    assert.equal(compareValues([{ name: 'm', value: '0.55 kg' }], 'm = 0.5 kg', { rounded: roundsOutput('print("m =", m, "kg")\nprint(f"x = {x:.4g}")') })!.mismatches.length, 1);
  });

  test('a sum written out states what follows its last equals sign', () => {
    // Chimica 81d43345: "2+2+6+1 = 11" was read as 2.
    assert.equal(parseQuantity('2+2+6+1 = 11')!.base, 11);
    assert.equal(compareValues([{ name: 'e', value: '2+2+6+1 = 11' }], 'e = 11')!.mismatches.length, 0);
    assert.equal(parseQuantity('2 +2+6+1'), null, 'a sum is not a unit');
  });

  test('a name printed again with another value is not compared, and by name no lone value is paired with another', () => {
    // Analisi 2 e7bc7a76: a loop printed "f = 0", "f = -8", "f = -8" for three points.
    assert.equal(compareValues([{ name: 'f', value: '-8' }], 'f = 0\nf = -8.0\nf = -8.0'), null);
    assert.equal(compareValues([{ name: 'f', value: '-8' }], 'f = -8.0\nf = -8.0')!.mismatches.length, 0, 'the same value printed twice is one value');
    // Analisi 2 08f04def: the volume was paired with the only line printed, the Jacobian.
    assert.equal(compareValues([{ name: 'volume', value: '25.13' }], 'jacobiano = 6', { byName: true }), null);
    assert.equal(compareValues([{ name: 'volume', value: '25.13' }], 'jacobiano = 6')!.mismatches.length, 1, 'without byName the old pairing stands');
  });

  test('a unit written apart is the same product as one written with a dot', () => {
    // Chimica bba65124 (#142 CH-5): p = 6,615e-24 kg m/s against 6,6165e-24 was never compared.
    assert.equal(compareValues([{ name: 'p', value: '6.615e-24 kg m/s' }], 'p = 6.6165e-24 kg m/s')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 'p', value: '6.6165e-24 kg·m/s' }], 'p = 6.61648e-24 kg m/s')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'c', value: '0.0154 mol L^-1' }], 'c = 0.0153846 mol/L'), null, 'mol L^-1 and mol/L are written differently, so not compared');
    // PR #160 review: spaces around a division sign are not a product.
    assert.equal(compareValues([{ name: 'v', value: '12.00 m / s' }], 'v = 10 m/s')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 'v', value: '12.00 m / s' }], 'v = 12.0 m/s')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'a', value: '9.81 m s ^ -2' }], 'a = 9.81 m s^-2')!.mismatches.length, 0);
  });

  test('a name stated with two different values is not compared, whatever the program printed', () => {
    const both = [{ name: 'm', value: '0.50 kg' }, { name: 'm', value: '0.55 kg' }];
    assert.equal(compareValues(both, 'm = 0.55 kg'), null, 'one printed line could belong to either listing');
    assert.equal(compareValues(both, 'm = 0.55 kg\nm = 0.55 kg'), null);
    const settled = compareValues([...both, { name: 'v', value: '2.0 m/s' }], 'm = 0.55 kg\nv = 2.0 m/s')!;
    assert.deepEqual([settled.mismatches.length, settled.complete], [0, false]);
  });

  test('a relative tolerance gives a final value the room of the rounding the solution carried', () => {
    // Chimica 4d3131a0: 79,94 % from the rounded 14,01 g, against 79,958 % computed without rounding.
    assert.equal(compareValues([{ name: 'resa', value: '79,94 %' }], 'resa = 79.9578 %')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 'resa', value: '79,94 %' }], 'resa = 79.9578 %', { relative: 1e-3 })!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'resa', value: '79,74 %' }], 'resa = 79.9578 %', { relative: 1e-3 })!.mismatches.length, 1);
  });
});

describe('comparing recomputed values with the stated ones', () => {
  test('a matching answer, whatever the prefix', () => {
    const r = compareValues([{ name: 'R_eq', value: '4.7 kΩ' }], 'R_eq = 4700.0 ohm\n');
    assert.deepEqual(r, { compared: [{ name: 'R_eq', stated: '4.7 kΩ', computed: '4700.0 ohm' }], mismatches: [], complete: true });
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
    // PR #160 review: the second reading is built from the normalised value, so markup or full-width digits that the raw
    // text keeps cannot make it parse the same text again without end.
    for (const written of ['$1{,}500$ N', 'F = １.５００ N']) {
      const q = parseQuantity(written)!;
      assert.deepEqual([q.base, q.alt.map((a) => a.base)], [1.5, [1500]], written);
    }
  });

  test('2e-3 is read as 0,002 and as 2·e − 3 (the Analisi 1 minimum of 20 November), and only a value that fits neither is a mismatch', () => {
    const fMin = (printed: string) => compareValues([{ name: 'f_min', value: '2e-3' }], `f_min = ${printed}`)!;
    assert.equal(fMin('2.43656365691809').mismatches.length, 0);
    assert.equal(fMin('0.002').mismatches.length, 0);
    assert.deepEqual(fMin('5').mismatches, [{ name: 'f_min', stated: '2e-3', computed: '5' }]);
    assert.equal(compareValues([{ name: 'x', value: '-2e+1' }], `x = ${-2 * Math.E + 1}`)!.mismatches.length, 0, 'the sign belongs to the mantissa');
    assert.equal(compareValues([{ name: 'n', value: '6.02e23 mol' }], 'n = 6.02e23 mol')!.mismatches.length, 0);
    assert.equal(compareValues([{ name: 'n', value: '6.02e23 mol' }], 'n = 7e23 mol')!.mismatches.length, 1);
    assert.deepEqual(parseQuantity('6.02e23 mol')!.alt, [], 'without a sign after it, e is only a power of ten');
    assert.deepEqual(parseQuantity('2E-3')!.alt, [], 'a capital E is only a power of ten');
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

  test('an unmarked value is not held against a stated unit that is not an SI unit', () => {
    // 36 km/h is 10 m/s: the program printed the SI value, and the solution states another unit.
    for (const [value, other] of [['36 km/h', 'v = 10'], ['90 min', 't = 5400'], ['2 L', 'V = 0.002'], ['30 deg', 'a = 0.5236'], ['5 mm/s', 'v = 0.005']]) {
      assert.equal(compareValues([{ name: other.split(' ')[0], value }], other), null, `${value} against ${other}`);
    }
    // The same number is no agreement either: an unmarked 36 is 36 m/s, and whether the program meant km/h cannot be known.
    assert.equal(compareValues([{ name: 'v', value: '36 km/h' }], 'v = 36'), null);
    // Stated in SI units, an unmarked value that differs is still a mismatch.
    assert.equal(compareValues([{ name: 'v', value: '12 m/s' }], 'v = 10')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 'J', value: '3 kg·m²' }], 'J = 9')!.mismatches.length, 1);
    assert.equal(compareValues([{ name: 't', value: '5 s' }], 't = 7')!.mismatches.length, 1);
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

describe('runConsistency', () => {
  test('in the real sandbox: CONSISTENT passes, INCONSISTENT names the problem, a crash is a failed check', async () => {
    // Chimica E17.6: the formula C3H6O has M = 58.08 g/mol, the statement says 60.
    const molar = (m: number) => `M_formula = 3 * 12.011 + 6 * 1.008 + 15.999\nprint("CONSISTENT" if abs(M_formula - ${m}) < 0.5 else f"INCONSISTENT: C3H6O has M={M_formula:.2f}, not ${m}")`;
    assert.deepEqual(await runConsistency(molar(58)), { verdict: 'consistent', detail: 'CONSISTENT' });
    assert.deepEqual(await runConsistency(molar(60)), { verdict: 'inconsistent', detail: 'INCONSISTENT: C3H6O has M=58.08, not 60' });
    const crashed = await runConsistency('from sympy import Rational\nprint("CONSISTENT")');
    assert.equal(crashed!.verdict, 'failed');
    assert.match(crashed!.detail, /^The consistency program failed: .*ModuleNotFoundError/);
  });

  test('a timeout, a program that prints no verdict and a sandbox that does not start are failed checks; no program is no check', async () => {
    assert.deepEqual(await runConsistency('while True: pass', async () => ({ ok: false, stdout: '', error: 'Timed out after 15 s', version: '?' })),
      { verdict: 'failed', detail: 'The consistency program failed: Timed out after 15 s' });
    assert.equal((await runConsistency('print(1)', ran('1')))!.verdict, 'failed');
    assert.equal((await runConsistency('pass', ran('')))!.detail, 'The consistency program printed nothing.');
    assert.equal((await runConsistency('pass', async () => { throw new Error('no sandbox'); }))!.verdict, 'failed');
    // Only the last line counts, and a crash after INCONSISTENT keeps the finding.
    assert.equal((await runConsistency('pass', ran('CONSISTENT\nINCONSISTENT: x')))!.verdict, 'inconsistent');
    assert.equal((await runConsistency('pass', ran('INCONSISTENT: x\nCONSISTENT')))!.verdict, 'consistent');
    assert.equal((await runConsistency('pass', ran('INCONSISTENT: r', false)))!.verdict, 'inconsistent');
    assert.equal((await runConsistency('pass', ran('CONSISTENT', false)))!.verdict, 'failed');
    assert.equal(await runConsistency('  ', ran('CONSISTENT')), null);
    assert.equal(await runConsistency(undefined, ran('CONSISTENT')), null);
  });
});
