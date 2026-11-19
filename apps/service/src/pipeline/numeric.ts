// Deterministic check of a numeric final answer. The checker model writes a short Python program that computes the final values
// from the statement, and lists the values the given solution states. The program runs in the Pyodide sandbox, and its printed
// values are compared with the stated ones within the precision the solution gives. Anything that cannot be compared is ignored,
// so the model's own verdict stands.
import { runPython, type PythonResult } from './python.ts';

export interface StatedValue { name: string; value: string }

/** A number as written in the solution: its value in SI base units, the unit, and how many significant figures it shows. */
interface Quantity { base: number; asWritten: number; factor: number; unit: string; digits: number; exponent: number; alt?: Quantity }
interface Printed { name: string; value: number; unit: string | null; text: string; step: number }

export interface Comparison { name: string; stated: string; computed: string }
/** `complete` is true when every stated value was compared with a printed one: none was left out for a unit this file cannot read. */
export interface NumericCheck { compared: Comparison[]; mismatches: Comparison[]; complete: boolean }

const MISMATCH_PREFIX = 'Recomputing the final values in Python gives a different result: ';
/** The text of the blocker the numeric check raises, one clause per value. `readMismatches` reads it back when the fix is recorded. */
export const mismatchMessage = (mismatches: Comparison[]) =>
  `${MISMATCH_PREFIX}${mismatches.map((m) => `${m.name} is ${m.computed} by the computation and ${m.stated} in the solution`).join('; ')}.`;
export function readMismatches(message: string): Comparison[] {
  if (!message.startsWith(MISMATCH_PREFIX)) return [];
  return message.slice(MISMATCH_PREFIX.length).replace(/\.$/, '').split('; ').flatMap((part) => {
    const m = /^(.+?) is (.+) by the computation and (.+) in the solution$/.exec(part);
    return m ? [{ name: m[1], computed: m[2], stated: m[3] }] : [];
  });
}

// Prefixes that are unambiguous next to the units below. T, P, E, d and h are left out because they are also units or rare.
// NFKC turns the micro sign (U+00B5) into the Greek mu (U+03BC) and the ohm sign (U+2126) into the Greek capital omega (U+03A9).
const MU = '\u03bc';
const OHM = '\u03a9';
const PREFIXES: Record<string, number> = { G: 1e9, M: 1e6, k: 1e3, c: 1e-2, m: 1e-3, [MU]: 1e-6, u: 1e-6, n: 1e-9, p: 1e-12 };
const BASE_UNITS = new Set([OHM, 'A', 'V', 'W', 'F', 'H', 'Hz', 'J', 'N', 'Pa', 'm', 's', 'g', 'mol', 'K', 'C', 'S', 'T', 'L', 'l', 'B', 'bar']);
// Units that take no prefix here. A unit with any other word in it (atm, mmHg, pi) is not compared.
const OTHER_UNITS = new Set(['rad', 'deg', 'min', 'h', 'eV', '%', '\u00b0', '\u00b0C']);
// Units whose value in the solution is the SI value once the prefix is applied. min, h, L, bar, deg, km/h and mol/L are not: an unmarked printed value cannot be read against them.
const SI_UNITS = new Set([OHM, 'A', 'V', 'W', 'F', 'H', 'Hz', 'J', 'N', 'Pa', 'm', 's', 'mol', 'K', 'C', 'S', 'T', 'rad', 'kg']);
const MAX_PRINTED_VALUES = 50;
// What a stated count is a count of ("9,02 × 10^23 atomi di ossigeno"): the value is a plain number. A count per unit (ioni/L,
// ions of sodium L⁻¹) is a density, so only "di …" or "of …" in words may follow the noun, and never "per".
const COUNT_NOUN = /^(?:atom[io]|molecol[ae]|ion[ei]|elettron[ei]|proton[ei]|neutron[ei]|foton[ei]|particell[ae]|nucle[io]|atoms?|molecules?|ions?|electrons?|protons?|neutrons?|photons?|particles?|nuclei|nucleus)(?:\s+(?:di|del|della|dello|dei|degli|delle|of)(?!.*\bper\b)(?:\s+[\p{L}']+)+)?$/iu;

/** Strips LaTeX the model may leave in a value and unifies the symbols that differ between sources. */
function plain(text: string): string {
  return text.normalize('NFKC')
    .replace(/\\(?:mathrm|text|operatorname)\{([^}]*)\}/g, '$1')
    .replace(/\\Omega|ohms?\b/gi, OHM).replace(/\\mu\b/g, MU)
    .replace(/\{,\}/g, ',').replace(/\\cdot|\\times|·|⋅|×|\*/g, '×')
    .replace(/\\[,;: !]|[$~{}]/g, '').replace(/[−–]/g, '-').replace(/\s+/g, ' ').trim();
}

const NUMBER = /^[≈=]?\s*([-+]?)(\d+(?:[.,]\d+)?|[.,]\d+)\s*(?:(?:×\s*10\s*\^\s*([-+]?\d+))|(?:[eE]([-+]?\d+)))?\s*(.*)$/;

/** Splits a unit into a prefix factor and a base unit. A unit this does not recognise (m/s, mol/L, kg·m²) stays whole with factor 1. */
function splitUnit(raw: string): { factor: number; unit: string } {
  if (COUNT_NOUN.test(raw.trim())) return { factor: 1, unit: '' };
  // Units written apart (kg m/s) are a product, as kg·m/s is: joined into one word they would read as an unknown unit.
  const unit = raw.trim().replace(/\.$/, '').replace(/\s*×\s*|\s+/g, '×');
  // A percentage is a plain number written a hundred times larger: 50% and 0.5 are the same value.
  if (unit === '%') return { factor: 0.01, unit: '' };
  if (BASE_UNITS.has(unit)) return { factor: 1, unit };
  const factor = PREFIXES[unit[0] ?? ''];
  if (factor !== undefined && BASE_UNITS.has(unit.slice(1))) return { factor, unit: unit.slice(1) };
  return { factor: 1, unit };
}

/** True for an empty unit and for units made only of the ones above, alone or combined (m/s, mol/L, kg·m2). */
function knownUnit(unit: string): boolean {
  // A sum or an equation is not a unit: "2+2+6+1 = 11" would otherwise read as 2.
  if (/[=+]|(?:^|[\s×/·*(])\d/.test(unit)) return false;
  return unit.split(/[^\p{L}\u00b0%]+/u).filter(Boolean).every((t) => BASE_UNITS.has(t) || OTHER_UNITS.has(t) || (PREFIXES[t[0] ?? ''] !== undefined && BASE_UNITS.has(t.slice(1))))
    && !/^[/^]/.test(unit);
}

/** Significant figures of the mantissa as written. Trailing zeros of a whole number are not counted: 4700 shows two. */
function sigFigs(mantissa: string): { digits: number; exponent: number } {
  const [whole = '', fraction] = mantissa.replace(',', '.').split('.');
  const all = `${whole}${fraction ?? ''}`.replace(/^0+/, '');
  const digits = Math.max(1, fraction === undefined ? all.replace(/0+$/, '').length : all.length);
  const value = Number(mantissa.replace(',', '.'));
  // Zero has no leading digit, so its precision is its decimal places: 0.00 is known to a hundredth.
  if (value === 0) return { digits: (fraction?.length ?? 0) + 1, exponent: 0 };
  return { digits, exponent: Math.floor(Math.log10(Math.abs(value))) };
}

export function parseQuantity(text: string): Quantity | null {
  // "2+2+6+1 = 11" states 11: the value is what follows the last equals sign.
  const m = NUMBER.exec(plain(text).split('=').at(-1)!.trim());
  if (!m) return null;
  const [, sign, mantissa, tenPower, ePower, rest] = m;
  const shift = Number(tenPower ?? ePower ?? 0);
  const asWritten = Number(`${sign}${mantissa!.replace(',', '.')}`) * 10 ** shift;
  if (!Number.isFinite(asWritten)) return null;
  const { factor, unit } = splitUnit(rest ?? '');
  if (!knownUnit(unit)) return null;
  const { digits, exponent } = sigFigs(mantissa!);
  const quantity: Quantity = { base: asWritten * factor, asWritten, factor, unit, digits, exponent: exponent + shift };
  // 1,500 and 1.500 are one and a half or fifteen hundred, depending on the language. Both readings are kept.
  if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(mantissa!)) quantity.alt = parseQuantity(text.replace(/(\d)[.,](\d{3})(?!\d)/, '$1$2')) ?? undefined;
  return quantity;
}

const NAME_VALUE = /^\s*(.+?)\s*[=:]\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*)$/;

function parsePrinted(stdout: string, rounded: boolean): Printed[] {
  const out: Printed[] = [];
  for (const line of stdout.split('\n').slice(0, MAX_PRINTED_VALUES)) {
    const m = NAME_VALUE.exec(plain(line));
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    const { factor, unit } = splitUnit(m[3] ?? '');
    if (!knownUnit(unit)) continue;
    out.push({ name: m[1]!, value: value * factor, unit: unit || null, text: line.trim(), step: rounded ? lastDigit(m[2]!) * factor : 0 });
  }
  return out;
}

/** The value of one unit in the last digit a number is printed with: 0.002801 gives 1e-6, 2.5e-3 gives 1e-4, 1500 gives 1. */
function lastDigit(printed: string): number {
  const [mantissa = '', power = '0'] = printed.toLowerCase().split('e');
  const decimals = mantissa.split('.')[1]?.length ?? 0;
  return 10 ** (Number(power) - decimals);
}

const key = (name: string) => plain(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * True when the printed value differs from the stated one by more than one unit of the stated last digit, or of the printed
 * one when the program printed fewer digits (0.002801 kg against 2.80068 g).
 */
function differs(stated: Quantity, computed: number, scale: number, printedStep = 0, relative = 0): boolean {
  const tolerance = Math.max(Math.abs(scale) * 10 ** (stated.exponent - stated.digits + 1), printedStep, relative * Math.abs(stated.base));
  return Math.abs(computed - stated.base) > Math.max(tolerance, 1e-12 * Math.abs(stated.base)) * (1 + 1e-9);
}

/** 'skip' means the two cannot be compared with confidence: another unit, or an unmarked value that fits only the number as written in a prefixed unit. */
function compare(stated: Quantity, printed: Printed, relative: number): 'match' | 'mismatch' | 'skip' {
  const verdicts = [compareReading(stated, printed, relative), ...(stated.alt ? [compareReading(stated.alt, printed, relative)] : [])];
  return verdicts.includes('match') ? 'match' : verdicts.every((v) => v === 'mismatch') ? 'mismatch' : 'skip';
}

/** The stated quantity is a pure number or made of SI units alone (m/s, kg·m2, kΩ), so the program's unmarked SI value is comparable with it. */
function inSiUnits(q: Quantity): boolean {
  if (q.unit === 'g') return q.factor === 1000;
  return q.unit.split(/[^\p{L}\u00b0%]+/u).filter(Boolean).every((t) => SI_UNITS.has(t));
}

function compareReading(stated: Quantity, printed: Printed, relative: number): 'match' | 'mismatch' | 'skip' {
  const scale = stated.factor;
  // The printed precision can only keep a value from being a mismatch, never make it a match: a value that agrees only
  // within the last printed digit of a rounding program may be a plain print of an exact value (0.5 for 0.55), so it is
  // left uncompared and the results are not settled by it.
  const verdict = (s: Quantity, sc: number) => !differs(s, printed.value, sc, 0, relative) ? 'match' : differs(s, printed.value, sc, printed.step, relative) ? 'mismatch' : 'skip';
  if (printed.unit !== null) return printed.unit !== stated.unit ? 'skip' : verdict(stated, scale);
  // The program was told to print SI base units, so an unmarked value is read as one.
  if (!inSiUnits(stated)) return 'skip';
  const first = verdict(stated, scale);
  if (first !== 'mismatch' || scale === 1) return first;
  return verdict({ ...stated, base: stated.asWritten, factor: 1 }, 1) === 'mismatch' ? 'mismatch' : 'skip';
}

function pair(stated: StatedValue[], printed: Printed[], byName: boolean): [StatedValue, Printed][] {
  const pairs: [StatedValue, Printed][] = [];
  // A name printed again with another value (a loop over three points printing "f = ..." each time) names no one value.
  const ambiguous = new Set(printed.filter((p) => printed.some((o) => key(o.name) === key(p.name) && o.value !== p.value)).map((p) => key(p.name)));
  const used = new Set<Printed>(printed.filter((p) => ambiguous.has(key(p.name))));
  for (const s of stated) {
    const p = printed.find((x) => !used.has(x) && key(x.name) === key(s.name) && key(s.name) !== '');
    if (p) { pairs.push([s, p]); used.add(p); }
  }
  // One value on each side needs no name to match.
  if (!byName && !pairs.length && stated.length === 1 && printed.length === 1) pairs.push([stated[0]!, printed[0]!]);
  return pairs;
}

/**
 * True when a program rounds or formats the numbers it prints (round(x, 4), "%.3f", f"{x:.4g}"), so a printed value is known
 * only to its last printed digit. A plain print shows the float in full, and a value that prints short (0.5, 3) is exact.
 */
export function roundsOutput(code: string | undefined): boolean {
  return /\bround\s*\(|%[-+ 0#]*\d*\.?\d*[fFgGeE]\b|:[^{}]*\.\d+[fFgGeE%]?\}|\bformat\s*\(/.test(code ?? '');
}

/**
 * Compares the printed values with the stated ones. Null when nothing could be compared. `relative` widens the tolerance to
 * that fraction of the value; `byName` pairs values only by name, never a lone stated value with a lone printed one;
 * `rounded` (see `roundsOutput`) widens it to the last printed digit.
 */
export function compareValues(stated: StatedValue[], stdout: string, opts: { relative?: number; byName?: boolean; rounded?: boolean } = {}): NumericCheck | null {
  const parsed = stated.flatMap((s) => { const q = parseQuantity(s.value); return q ? [{ s, q }] : []; });
  if (!parsed.length) return null;
  const printed = parsePrinted(stdout, !!opts.rounded);
  const compared: Comparison[] = [];
  const mismatches: Comparison[] = [];
  for (const [s, p] of pair(parsed.map((x) => x.s), printed, !!opts.byName)) {
    const q = parsed.find((x) => x.s === s)!.q;
    const verdict = compare(q, p, opts.relative ?? 0);
    if (verdict === 'skip') continue;
    const c = { name: s.name, stated: s.value.trim(), computed: p.text.replace(/^.*?[=:]\s*/, '') };
    compared.push(c);
    if (verdict === 'mismatch') mismatches.push(c);
  }
  return compared.length ? { compared, mismatches, complete: compared.length === stated.length } : null;
}

/**
 * Runs the checker's computation and compares its values with the stated ones. Null when there is nothing to compare: no
 * computation, no stated number, a program that fails or prints nothing, or values that cannot be paired. The program comes from
 * a model, so it only ever runs in the sandbox of `python.ts`.
 */
export async function recomputeFinalValues(computation: string | undefined, stated: StatedValue[] | undefined, run: (code: string, timeoutMs: number) => Promise<PythonResult> = runPython): Promise<NumericCheck | null> {
  if (!computation?.trim() || !stated?.length) return null;
  // Symbolic answers have nothing to parse, so the sandbox is not started for them.
  if (!stated.some((s) => parseQuantity(s.value))) return null;
  let result: PythonResult;
  try {
    result = await run(computation, 15_000);
  } catch {
    return null;
  }
  if (!result.ok || !result.stdout.trim()) return null;
  return compareValues(stated, result.stdout, { rounded: roundsOutput(computation) });
}

/** What a computation program printed, or '' when there is none or it failed. Its lines are read by `compareValues`. */
export async function printedValues(computation: string | undefined, run: (code: string, timeoutMs: number) => Promise<PythonResult> = runPython): Promise<string> {
  if (!computation?.trim()) return '';
  try {
    const result = await run(computation, 15_000);
    return result.ok ? result.stdout : '';
  } catch {
    return '';
  }
}

/**
 * What the checker's consistency program said about the statement's data. `failed` covers a program that crashed, timed out
 * or printed neither verdict: the data were not shown consistent, so it does not pass.
 */
export interface ConsistencyCheck { verdict: 'consistent' | 'inconsistent' | 'failed'; detail: string }

const CONSISTENCY_TIMEOUT_MS = 15_000;

/**
 * Runs the checker's consistency program in the sandbox of `python.ts` and reads its last printed line. Null when there is no
 * program, which the prompt allows only for a problem with no numeric data.
 */
export async function runConsistency(code: string | undefined, run: (code: string, timeoutMs: number) => Promise<PythonResult> = runPython): Promise<ConsistencyCheck | null> {
  if (!code?.trim()) return null;
  let result: PythonResult;
  try {
    result = await run(code, CONSISTENCY_TIMEOUT_MS);
  } catch (err) {
    return { verdict: 'failed', detail: `The consistency program could not run: ${(err as Error).message}` };
  }
  const last = result.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  // A program that found an inconsistency and then crashed still found it.
  if (/^INCONSISTENT\b/.test(last)) return { verdict: 'inconsistent', detail: truncateLine(last) };
  if (!result.ok) return { verdict: 'failed', detail: `The consistency program failed: ${truncateLine(errorLine(result.error ?? ''))}` };
  if (/^CONSISTENT\b/.test(last)) return { verdict: 'consistent', detail: truncateLine(last) };
  return { verdict: 'failed', detail: last ? `The consistency program printed neither CONSISTENT nor INCONSISTENT: ${truncateLine(last)}` : 'The consistency program printed nothing.' };
}

/** The line of a Python traceback that names the error ("ModuleNotFoundError: No module named 'sympy'"); Pyodide adds advice after it. */
function errorLine(error: string): string {
  const lines = error.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.findLast((l) => /^[\w.]*(Error|Exception|Interrupt|Exit)\b/.test(l)) ?? lines.pop() ?? 'no error message';
}

const truncateLine = (s: string) => (s.length > 400 ? `${s.slice(0, 399)}…` : s);
