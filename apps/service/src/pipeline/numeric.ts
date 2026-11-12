// Deterministic check of a numeric final answer. The checker model writes a short Python program that computes the final values
// from the statement, and lists the values the given solution states. The program runs in the Pyodide sandbox, and its printed
// values are compared with the stated ones within the precision the solution gives. Anything that cannot be compared is ignored,
// so the model's own verdict stands.
import { runPython, type PythonResult } from './python.ts';

export interface StatedValue { name: string; value: string }

/** A number as written in the solution: its value in SI base units, the unit, and how many significant figures it shows. */
interface Quantity { base: number; asWritten: number; factor: number; unit: string; digits: number; exponent: number; alt?: Quantity }
interface Printed { name: string; value: number; unit: string | null; text: string }

export interface Comparison { name: string; stated: string; computed: string }
export interface NumericCheck { compared: Comparison[]; mismatches: Comparison[] }

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
  const unit = raw.replace(/\s+/g, '').replace(/\.$/, '');
  // A percentage is a plain number written a hundred times larger: 50% and 0.5 are the same value.
  if (unit === '%') return { factor: 0.01, unit: '' };
  if (BASE_UNITS.has(unit)) return { factor: 1, unit };
  const factor = PREFIXES[unit[0] ?? ''];
  if (factor !== undefined && BASE_UNITS.has(unit.slice(1))) return { factor, unit: unit.slice(1) };
  return { factor: 1, unit };
}

/** True for an empty unit and for units made only of the ones above, alone or combined (m/s, mol/L, kg·m2). */
function knownUnit(unit: string): boolean {
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
  const m = NUMBER.exec(plain(text));
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

function parsePrinted(stdout: string): Printed[] {
  const out: Printed[] = [];
  for (const line of stdout.split('\n').slice(0, MAX_PRINTED_VALUES)) {
    const m = NAME_VALUE.exec(plain(line));
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    const { factor, unit } = splitUnit(m[3] ?? '');
    if (!knownUnit(unit)) continue;
    out.push({ name: m[1]!, value: value * factor, unit: unit || null, text: line.trim() });
  }
  return out;
}

const key = (name: string) => plain(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** True when the printed value differs from the stated one by more than one unit of the stated last digit. */
function differs(stated: Quantity, computed: number, scale: number): boolean {
  const tolerance = Math.abs(scale) * 10 ** (stated.exponent - stated.digits + 1);
  return Math.abs(computed - stated.base) > Math.max(tolerance, 1e-12 * Math.abs(stated.base)) * (1 + 1e-9);
}

/** 'skip' means the two cannot be compared with confidence: another unit, or an unmarked value that fits only the number as written in a prefixed unit. */
function compare(stated: Quantity, printed: Printed): 'match' | 'mismatch' | 'skip' {
  const verdicts = [compareReading(stated, printed), ...(stated.alt ? [compareReading(stated.alt, printed)] : [])];
  return verdicts.includes('match') ? 'match' : verdicts.every((v) => v === 'mismatch') ? 'mismatch' : 'skip';
}

/** The stated quantity is a pure number or made of SI units alone (m/s, kg·m2, kΩ), so the program's unmarked SI value is comparable with it. */
function inSiUnits(q: Quantity): boolean {
  if (q.unit === 'g') return q.factor === 1000;
  return q.unit.split(/[^\p{L}\u00b0%]+/u).filter(Boolean).every((t) => SI_UNITS.has(t));
}

function compareReading(stated: Quantity, printed: Printed): 'match' | 'mismatch' | 'skip' {
  const scale = stated.factor;
  if (printed.unit !== null) return printed.unit !== stated.unit ? 'skip' : differs(stated, printed.value, scale) ? 'mismatch' : 'match';
  // The program was told to print SI base units, so an unmarked value is read as one.
  if (!inSiUnits(stated)) return 'skip';
  if (!differs(stated, printed.value, scale)) return 'match';
  if (scale === 1) return 'mismatch';
  return differs({ ...stated, base: stated.asWritten, factor: 1 }, printed.value, 1) ? 'mismatch' : 'skip';
}

function pair(stated: StatedValue[], printed: Printed[]): [StatedValue, Printed][] {
  const pairs: [StatedValue, Printed][] = [];
  const used = new Set<Printed>();
  for (const s of stated) {
    const p = printed.find((x) => !used.has(x) && key(x.name) === key(s.name) && key(s.name) !== '');
    if (p) { pairs.push([s, p]); used.add(p); }
  }
  // One value on each side needs no name to match.
  if (!pairs.length && stated.length === 1 && printed.length === 1) pairs.push([stated[0]!, printed[0]!]);
  return pairs;
}

/** Compares the printed values with the stated ones. Null when nothing could be compared. */
export function compareValues(stated: StatedValue[], stdout: string): NumericCheck | null {
  const parsed = stated.flatMap((s) => { const q = parseQuantity(s.value); return q ? [{ s, q }] : []; });
  if (!parsed.length) return null;
  const printed = parsePrinted(stdout);
  const compared: Comparison[] = [];
  const mismatches: Comparison[] = [];
  for (const [s, p] of pair(parsed.map((x) => x.s), printed)) {
    const q = parsed.find((x) => x.s === s)!.q;
    const verdict = compare(q, p);
    if (verdict === 'skip') continue;
    const c = { name: s.name, stated: s.value.trim(), computed: p.text.replace(/^.*?[=:]\s*/, '') };
    compared.push(c);
    if (verdict === 'mismatch') mismatches.push(c);
  }
  return compared.length ? { compared, mismatches } : null;
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
  return compareValues(stated, result.stdout);
}
