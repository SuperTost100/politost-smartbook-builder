import * as OCL from 'openchemlib';
import { z } from 'zod';

/** A molecule drawn deterministically from a SMILES string, as Lewis-style or skeletal SVG. */
export interface StructureSpec {
  smiles: string;
  style: 'lewis' | 'skeletal';
  lonePairs: boolean;
  /** The formula as the text writes it, e.g. "NH4+", "NaCl", "SO4^2-". Checked against the SMILES. */
  formula?: string;
  title?: string;
}

const MAX_HEAVY_ATOMS = 60;
const MAX_FRAGMENTS = 4;

const specSchema = z.object({
  smiles: z.string().trim().min(1, 'must not be empty').max(200, 'must be at most 200 characters'),
  style: z.enum(['lewis', 'skeletal']),
  lonePairs: z.boolean().default(false),
  formula: z.string().trim().min(1).max(60).optional(),
  title: z.string().max(200).optional(),
});

function parseMolecule(smiles: string): OCL.Molecule {
  try {
    const m = OCL.Molecule.fromSmiles(smiles);
    if (m.getAllAtoms() === 0) throw new Error('no atoms');
    return m;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`smiles: "${smiles}" is not a valid SMILES string (${why})`);
  }
}

/** Connected components of the bond graph, as an atom -> component index map. */
function components(m: OCL.Molecule): { of: number[]; count: number } {
  const n = m.getAllAtoms();
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (let b = 0; b < m.getAllBonds(); b++) parent[find(m.getBondAtom(0, b))] = find(m.getBondAtom(1, b));
  const index = new Map<number, number>();
  const of = parent.map((_, i) => {
    const root = find(i);
    if (!index.has(root)) index.set(root, index.size);
    return index.get(root)!;
  });
  return { of, count: index.size };
}

export function validateStructureSpec(spec: unknown): { ok: true; spec: StructureSpec } | { ok: false; errors: string[] } {
  const parsed = specSchema.safeParse(spec);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(spec)'}: ${i.message}`) };
  }
  const value: StructureSpec = { ...parsed.data, smiles: parsed.data.smiles.trim() };
  let m: OCL.Molecule;
  try {
    m = parseMolecule(value.smiles);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  const errors: string[] = [];
  let heavy = 0;
  for (let i = 0; i < m.getAllAtoms(); i++) if (m.getAtomicNo(i) > 1) heavy++;
  if (heavy > MAX_HEAVY_ATOMS) errors.push(`smiles: ${heavy} heavy atoms is too many to draw readably (at most ${MAX_HEAVY_ATOMS})`);
  const fragments = components(m).count;
  if (fragments > MAX_FRAGMENTS) errors.push(`smiles: ${fragments} separate fragments is too many (at most ${MAX_FRAGMENTS})`);
  if (value.formula) {
    const drawn = composition(m);
    if (!formulaMatches(value.formula, drawn)) errors.push(`formula: "${value.formula}" does not match the SMILES, which draws ${describe(drawn)}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, spec: value };
}

// ---------------------------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------------------------

interface Composition { atoms: Map<string, number>; charge: number }

/** Atoms (implicit hydrogens included) and net charge of a parsed molecule. */
function composition(m: OCL.Molecule): Composition {
  const atoms = new Map<string, number>();
  let charge = 0;
  const add = (el: string, n: number) => atoms.set(el, (atoms.get(el) ?? 0) + n);
  for (let i = 0; i < m.getAllAtoms(); i++) {
    add(m.getAtomLabel(i), 1);
    const h = m.getImplicitHydrogens(i);
    if (h) add('H', h);
    charge += m.getAtomCharge(i);
  }
  return { atoms, charge };
}

function describe(c: Composition): string {
  const body = [...c.atoms].map(([el, n]) => `${el}${n > 1 ? n : ''}`).join('');
  return c.charge ? `${body} with charge ${c.charge > 0 ? '+' : ''}${c.charge}` : body;
}

const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** Element counts of a formula body such as "Ca(OH)2" or "CuSO4·5H2O"; null when it does not parse. */
function parseBody(body: string): Map<string, number> | null {
  const total = new Map<string, number>();
  for (const part of body.split(/[·.*]/)) {
    const m = /^(\d*)(.*)$/.exec(part)!;
    const times = m[1] ? Number(m[1]) : 1;
    const stack: Map<string, number>[] = [new Map()];
    const re = /([A-Z][a-z]?)(\d*)|([([])|([)\]])(\d*)/gy;
    let at = 0;
    let t: RegExpExecArray | null;
    while (at < m[2].length && (t = re.exec(m[2])) !== null) {
      at = re.lastIndex;
      if (t[1]) {
        const top = stack[stack.length - 1];
        top.set(t[1], (top.get(t[1]) ?? 0) + (t[2] ? Number(t[2]) : 1));
      } else if (t[3]) {
        stack.push(new Map());
      } else {
        if (stack.length < 2) return null;
        const group = stack.pop()!;
        const top = stack[stack.length - 1];
        for (const [el, n] of group) top.set(el, (top.get(el) ?? 0) + n * (t[5] ? Number(t[5]) : 1));
      }
    }
    if (at !== m[2].length || stack.length !== 1 || !stack[0].size) return null;
    for (const [el, n] of stack[0]) total.set(el, (total.get(el) ?? 0) + n * times);
  }
  return total;
}

const sameAtoms = (a: Map<string, number>, b: Map<string, number>) => a.size === b.size && [...a].every(([el, n]) => b.get(el) === n);

/**
 * True when a formula written in the text ("NH4+", "SO4^2-", "SO42-", "Na+ Cl-", "NaCl") has the same atoms and net
 * charge as the drawn species. Digits run together with a charge ("SO42-") are tried both ways.
 */
export function formulaMatches(formula: string, drawn: Composition): boolean {
  const plain = formula
    .replace(/[₀-₉]/g, (d) => String(SUBSCRIPTS.indexOf(d)))
    .replace(/[⁰-⁹¹²³]/g, (d) => String(SUPERSCRIPTS.indexOf(d)))
    .replace(/[⁺]/g, '+').replace(/[⁻−–]/g, '-')
    // Bonds in a condensed structural formula ("CH2=CH2", "HC≡CH", "CH3-CH2-OH") carry no atoms. A hyphen is a bond only
    // when an atom or group follows it; at the end it is a charge.
    .replace(/[=≡]/g, '').replace(/-(?=[A-Z(])/g, '');
  // Several ions ("Na+ Cl-") add up; each piece carries its own charge.
  const pieces = plain.trim().split(/\s+(?=[A-Z(])/);
  const options: { atoms: Map<string, number>; charge: number }[][] = [];
  for (const piece of pieces) {
    const m = /^(.*?)(?:\^|\s)*(\d*)([+-]?)$/.exec(piece.replace(/\s+/g, ' '))!;
    const [, head, digits, sign] = m;
    const here: { atoms: Map<string, number>; charge: number }[] = [];
    if (!sign) {
      const b = parseBody(piece.replace(/\s+/g, ''));
      if (b) here.push({ atoms: b, charge: 0 });
    } else {
      // Split the trailing digits between the last count and the charge: "SO42-" is SO4 2- or SO42 1-.
      for (let k = 0; k <= digits.length; k++) {
        const body = (head + digits.slice(0, k)).replace(/[\s^]+$/, '').replace(/\s+/g, '');
        const size = digits.slice(k) ? Number(digits.slice(k)) : 1;
        const b = parseBody(body);
        if (b && size > 0) here.push({ atoms: b, charge: sign === '+' ? size : -size });
      }
    }
    if (!here.length) return false;
    options.push(here);
  }
  // Pieces are few and readings per piece at most three, so trying every combination is cheap.
  const combos = options.reduce<{ atoms: Map<string, number>; charge: number }[]>((acc, opts) => acc.flatMap((a) => opts.map((o) => {
    const sum = new Map(a.atoms);
    for (const [el, n] of o.atoms) sum.set(el, (sum.get(el) ?? 0) + n);
    return { atoms: sum, charge: a.charge + o.charge };
  })), [{ atoms: new Map(), charge: 0 }]);
  return combos.some((c) => c.charge === drawn.charge && sameAtoms(c.atoms, drawn.atoms));
}

/** Atoms and net charge of a SMILES string, for formulaMatches. */
export function smilesComposition(smiles: string): Composition {
  return composition(parseMolecule(smiles.trim()));
}

// ---------------------------------------------------------------------------------------------
// Electrons
// ---------------------------------------------------------------------------------------------

/** Valence electrons of main-group elements by atomic number; other elements get no dots. */
function valenceElectrons(z: number): number | null {
  if (z === 1) return 1;
  if (z === 2) return 2;
  if (z >= 3 && z <= 10) return z === 10 ? 8 : z - 2;
  if (z >= 11 && z <= 18) return z - 10;
  if (z === 19 || z === 20) return z - 18;
  if (z >= 31 && z <= 36) return z - 28;
  if (z === 37 || z === 38) return z - 36;
  if (z >= 49 && z <= 54) return z - 46;
  if (z === 55 || z === 56) return z - 54;
  return null;
}

/** Nonbonding electrons on an atom, or null when the element is not drawn with dots. */
export function nonbondingElectrons(atomicNo: number, charge: number, bondOrderSum: number): number | null {
  const ve = valenceElectrons(atomicNo);
  if (ve === null) return null;
  return Math.max(0, ve - charge - bondOrderSum);
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const INK = '#111827';
const SOFT = '#374151';
const BOND = 40;
const MARGIN = 24;
const MIN_WIDTH = 160;
const FS = 17;
const SUB_FS = 12;
const CHARGE_FS = 12.5;
const LABEL_PAD = 3;
const DOT_R = 1.9;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function f2(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

function textWidth(s: string, fs: number): number {
  let w = 0;
  for (const ch of s) w += /[il1tfjI.]/.test(ch) ? 0.34 : /[a-z]/.test(ch) ? 0.58 : /[mw]/.test(ch) ? 0.85 : 0.7;
  return w * fs;
}

interface Box { l: number; r: number; t: number; b: number }

function angDist(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/** Where a line leaves and re-enters label boxes, as a clipped sub-segment (null if nothing is left). */
function clipSegment(p: [number, number], q: [number, number], a: Box | null, b: Box | null): [[number, number], [number, number]] | null {
  const span = (box: Box): [number, number] | null => {
    let lo = -Infinity;
    let hi = Infinity;
    const axes: [number, number, number, number][] = [
      [p[0], q[0] - p[0], box.l, box.r],
      [p[1], q[1] - p[1], box.t, box.b],
    ];
    for (const [o, d, min, max] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (o < min || o > max) return null;
        continue;
      }
      const t1 = (min - o) / d;
      const t2 = (max - o) / d;
      lo = Math.max(lo, Math.min(t1, t2));
      hi = Math.min(hi, Math.max(t1, t2));
    }
    return lo <= hi ? [lo, hi] : null;
  };
  let s = 0;
  let e = 1;
  const sa = a && span(a);
  if (sa && sa[1] > 0) s = Math.max(s, Math.min(1, sa[1]));
  const sb = b && span(b);
  if (sb && sb[0] < 1) e = Math.min(e, Math.max(0, sb[0]));
  if (e - s < 0.02) return null;
  const at = (t: number): [number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  return [at(s), at(e)];
}

interface Label { main: string; h: number; hBefore: boolean }

interface DrawAtom {
  x: number;
  y: number;
  z: number;
  charge: number;
  label: Label | null;
  box: Box | null;
  angles: number[];
  bondSum: number;
}

/** The axis-aligned label box around an atom, grown by the clearance bond lines keep. */
function labelBox(a: { x: number; y: number }, label: Label): Box {
  const wMain = textWidth(label.main, FS);
  const wH = label.h > 0 ? textWidth('H', FS) + (label.h > 1 ? textWidth(String(label.h), SUB_FS) : 0) : 0;
  const hh = FS * 0.36 + LABEL_PAD;
  return {
    l: a.x - wMain / 2 - (label.hBefore ? wH : 0) - LABEL_PAD,
    r: a.x + wMain / 2 + (label.hBefore ? 0 : wH) + LABEL_PAD,
    t: a.y - hh,
    b: a.y + hh,
  };
}

function boxEdge(box: Box, cx: number, cy: number, angle: number): number {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const tx = ux > 0 ? (box.r - cx) / ux : ux < 0 ? (box.l - cx) / ux : Infinity;
  const ty = uy > 0 ? (box.b - cy) / uy : uy < 0 ? (box.t - cy) / uy : Infinity;
  return Math.min(tx, ty);
}

const SAMPLES = 72;
const AXES = [-Math.PI / 2, Math.PI / 2, Math.PI, 0];

/** Directions for `count` lone pairs (and an odd electron last), far from bonds, charge and each other. */
function placeElectrons(count: number, fixed: number[]): number[] {
  if (!fixed.length && count <= AXES.length) return AXES.slice(0, count);
  const placed: number[] = [];
  const pick = (others: number[]): number => {
    let best = -Math.PI / 2;
    let bestScore = -1;
    for (let k = 0; k < SAMPLES; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / SAMPLES;
      let score = Infinity;
      for (const o of others) score = Math.min(score, angDist(a, o));
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  };
  for (let i = 0; i < count; i++) placed.push(pick([...fixed, ...placed]));
  // Re-pick each one with the rest held still so they settle into even spacing.
  for (let pass = 0; pass < 12; pass++) {
    for (let i = 0; i < count; i++) placed[i] = pick([...fixed, ...placed.filter((_, j) => j !== i)]);
  }
  return placed;
}

function chargeText(charge: number): string {
  const n = Math.abs(charge);
  return `${n > 1 ? n : ''}${charge > 0 ? '+' : '−'}`;
}

type Point = { x: number; y: number };

/**
 * Textbook layouts for small Lewis structures, which the generic layout draws at odd angles. A molecule whose inner
 * atoms (those with more than one neighbour) form a short chain becomes a straight line with the other atoms above, below
 * and at the ends: H-C-C-O-H, H-O-S-O-H. An atom with three outer neighbours and a lone pair (NH3, H3O+) becomes a T
 * with the pair on top. Other fragments keep the generic layout. Coordinates are in drawing units, y pointing down.
 */
function tidyLewis(m: OCL.Molecule, pos: Point[], comp: { of: number[]; count: number }) {
  const n = pos.length;
  const nbrs = Array.from({ length: n }, (_, i) => Array.from({ length: m.getAllConnAtoms(i) }, (_, k) => m.getConnAtom(i, k)));
  const bondSum = Array.from({ length: n }, () => 0);
  let total = 0;
  for (let b = 0; b < m.getAllBonds(); b++) {
    const [a0, a1] = [m.getBondAtom(0, b), m.getBondAtom(1, b)];
    bondSum[a0] += m.getBondOrder(b);
    bondSum[a1] += m.getBondOrder(b);
    total += Math.hypot(pos[a0].x - pos[a1].x, pos[a0].y - pos[a1].y);
  }
  const L = m.getAllBonds() ? total / m.getAllBonds() : 1;
  const UP = { x: 0, y: -1 };
  const DOWN = { x: 0, y: 1 };
  const turn = (d: Point, deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { x: d.x * Math.cos(r) - d.y * Math.sin(r), y: d.x * Math.sin(r) + d.y * Math.cos(r) };
  };
  // Heavier substituents first, so a C=O oxygen takes the top slot and hydrogens fill the rest.
  const order = (ids: number[]) => [...ids].sort((a, b) => m.getAtomicNo(b) - m.getAtomicNo(a) || a - b);

  for (let c = 0; c < comp.count; c++) {
    const ids = pos.map((_, i) => i).filter((i) => comp.of[i] === c);
    if (ids.some((i) => m.isRingAtom(i))) continue;
    const inner = ids.filter((i) => nbrs[i].length > 1);
    const place = new Map<number, Point>();

    if (inner.length === 1) {
      const center = inner[0];
      const outer = nbrs[center];
      const nb = nonbondingElectrons(m.getAtomicNo(center), m.getAtomCharge(center), bondSum[center]);
      if (outer.length !== 3 || !nb || nb < 2) continue;
      place.set(center, { x: 0, y: 0 });
      const [a, b, d] = order(outer);
      place.set(b, { x: -L, y: 0 });
      place.set(d, { x: L, y: 0 });
      place.set(a, { x: 0, y: L });
    } else if (inner.length >= 2 && inner.length <= 8) {
      const innerNbrs = (i: number) => nbrs[i].filter((j) => nbrs[j].length > 1);
      if (inner.some((i) => innerNbrs(i).length > 2)) continue;
      const ends = inner.filter((i) => innerNbrs(i).length === 1);
      if (ends.length !== 2) continue;
      const chain = [Math.min(...ends)];
      while (chain.length < inner.length) {
        const next = innerNbrs(chain[chain.length - 1]).find((j) => !chain.includes(j));
        if (next === undefined) break;
        chain.push(next);
      }
      if (chain.length !== inner.length) continue;
      let fits = true;
      chain.forEach((atom, k) => {
        const at = { x: k * L, y: 0 };
        place.set(atom, at);
        const subs = order(nbrs[atom].filter((j) => nbrs[j].length === 1));
        const end = k === 0 || k === chain.length - 1;
        const out = { x: k === 0 ? -1 : 1, y: 0 };
        const slots = !end ? [[], [UP], [UP, DOWN]][subs.length]
          : [[], [out], [turn(out, k === 0 ? 60 : -60), turn(out, k === 0 ? -60 : 60)], [out, UP, DOWN]][subs.length];
        if (!slots) { fits = false; return; }
        subs.forEach((s, j) => place.set(s, { x: at.x + slots[j].x * L, y: at.y + slots[j].y * L }));
      });
      if (!fits) continue;
    } else {
      continue;
    }
    for (const [i, p] of place) pos[i] = p;
  }
}

const CORNERS = [-Math.PI / 4, (-3 * Math.PI) / 4, Math.PI / 4, (3 * Math.PI) / 4];

/**
 * True when two atoms of one fragment sit closer than 0.6 bond lengths: the explicit-hydrogen layout of a branched
 * molecule can do that. Fragments are only set side by side later, so atoms of different fragments may still overlap.
 */
function crowded(m: OCL.Molecule, pos: Point[], comp: { of: number[] }): boolean {
  if (!m.getAllBonds()) return false;
  let total = 0;
  for (let b = 0; b < m.getAllBonds(); b++) {
    const [a0, a1] = [m.getBondAtom(0, b), m.getBondAtom(1, b)];
    total += Math.hypot(pos[a0].x - pos[a1].x, pos[a0].y - pos[a1].y);
  }
  const min = (0.6 * total) / m.getAllBonds();
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) if (comp.of[i] === comp.of[j] && Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y) < min) return true;
  }
  return false;
}

export function renderStructureSvg(spec: StructureSpec): string {
  const lewis = spec.style === 'lewis';
  // Lewis draws every hydrogen as an atom. When that layout crowds, it falls back to condensed labels (CH3, OH).
  let explicitH = lewis;
  let m = parseMolecule(spec.smiles.trim());
  if (lewis) {
    m.addImplicitHydrogens();
    m.inventCoordinates({ keepHydrogens: true });
  } else {
    m.inventCoordinates();
  }
  let comp = components(m);
  let pos = Array.from({ length: m.getAllAtoms() }, (_, i) => ({ x: m.getAtomX(i), y: m.getAtomY(i) }));
  if (lewis) tidyLewis(m, pos, comp);
  if (lewis && crowded(m, pos, comp)) {
    explicitH = false;
    m = parseMolecule(spec.smiles.trim());
    m.inventCoordinates();
    comp = components(m);
    pos = Array.from({ length: m.getAllAtoms() }, (_, i) => ({ x: m.getAtomX(i), y: m.getAtomY(i) }));
  }
  const n = m.getAllAtoms();

  // Lay each fragment out in its own box and set them side by side.
  let cursor = 0;
  for (let c = 0; c < comp.count; c++) {
    const ids = pos.map((_, i) => i).filter((i) => comp.of[i] === c);
    const minX = Math.min(...ids.map((i) => pos[i].x));
    const maxX = Math.max(...ids.map((i) => pos[i].x));
    const midY = (Math.min(...ids.map((i) => pos[i].y)) + Math.max(...ids.map((i) => pos[i].y))) / 2;
    for (const i of ids) {
      pos[i] = { x: pos[i].x - minX + cursor, y: pos[i].y - midY };
    }
    cursor += maxX - minX + 1.6;
  }

  const atoms: DrawAtom[] = pos.map((p, i) => {
    const z = m.getAtomicNo(i);
    const charge = m.getAtomCharge(i);
    const symbol = m.getAtomLabel(i);
    const hCount = explicitH ? 0 : m.getImplicitHydrogens(i);
    const bonded = m.getAllConnAtoms(i) > 0;
    let label: Label | null = null;
    if (lewis || z !== 6 || !bonded || charge !== 0 || m.getAtomRadical(i) !== 0) {
      label = { main: symbol, h: hCount, hBefore: false };
    }
    return { x: p.x * BOND, y: p.y * BOND, z, charge, label, box: null, angles: [], bondSum: 0 };
  });

  const bonds: { a: number; b: number; order: number; ring: boolean }[] = [];
  for (let b = 0; b < m.getAllBonds(); b++) {
    const a0 = m.getBondAtom(0, b);
    const a1 = m.getBondAtom(1, b);
    const order = Math.min(3, Math.max(1, m.getBondOrder(b)));
    bonds.push({ a: a0, b: a1, order, ring: m.isRingBond(b) });
    for (const [s, t] of [[a0, a1], [a1, a0]]) {
      atoms[s].bondSum += order;
      atoms[s].angles.push(Math.atan2(atoms[t].y - atoms[s].y, atoms[t].x - atoms[s].x));
    }
  }

  // A lone neighbour on the right puts the hydrogens in front: HO-, H2N-.
  for (const a of atoms) {
    if (a.label && a.label.h > 0 && a.angles.length === 1 && Math.cos(a.angles[0]) > 0.3) a.label.hBefore = true;
  }
  for (const a of atoms) if (a.label) a.box = labelBox(a, a.label);

  const out: string[] = [];
  const texts: string[] = [];
  const dots: string[] = [];
  const bounds = { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
  const grow = (x0: number, y0: number, x1 = x0, y1 = y0) => {
    bounds.l = Math.min(bounds.l, x0);
    bounds.r = Math.max(bounds.r, x1);
    bounds.t = Math.min(bounds.t, y0);
    bounds.b = Math.max(bounds.b, y1);
  };

  // Bonds
  const lines: string[] = [];
  const line = (p: [number, number], q: [number, number], a: Box | null, b: Box | null) => {
    const seg = clipSegment(p, q, a, b);
    if (!seg) return;
    lines.push(`<line x1="${f2(seg[0][0])}" y1="${f2(seg[0][1])}" x2="${f2(seg[1][0])}" y2="${f2(seg[1][1])}"/>`);
    grow(seg[0][0], seg[0][1]);
    grow(seg[1][0], seg[1][1]);
  };
  for (const bd of bonds) {
    const A = atoms[bd.a];
    const B = atoms[bd.b];
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const ux = (B.x - A.x) / len;
    const uy = (B.y - A.y) / len;
    const nx = -uy;
    const ny = ux;
    const at = (o: number, s = 0): { p: [number, number]; q: [number, number] } => ({
      p: [A.x + nx * o + ux * s, A.y + ny * o + uy * s],
      q: [B.x + nx * o - ux * s, B.y + ny * o - uy * s],
    });
    const draw = (o: number, s = 0) => {
      const { p, q } = at(o, s);
      line(p, q, A.box, B.box);
    };
    if (bd.order === 1) draw(0);
    else if (bd.order === 3) [-4.5, 0, 4.5].forEach((o) => draw(o));
    else if (!lewis && bd.ring) {
      // Ring double bond: one line on the bond, a shorter one toward the ring centre.
      let side = 0;
      for (const [self, other] of [[bd.a, bd.b], [bd.b, bd.a]]) {
        for (let k = 0; k < m.getConnAtoms(self); k++) {
          const t = m.getConnAtom(self, k);
          if (t === other || !m.isRingBond(m.getConnBond(self, k))) continue;
          side += (atoms[t].x - atoms[self].x) * nx + (atoms[t].y - atoms[self].y) * ny;
        }
      }
      if (Math.abs(side) < 1e-6) {
        draw(-2.5);
        draw(2.5);
      } else {
        draw(0);
        draw(Math.sign(side) * 5.5, 0.14 * len);
      }
    } else {
      draw(-2.5);
      draw(2.5);
    }
  }
  out.push(`<g stroke="${INK}" stroke-width="1.6" stroke-linecap="round" fill="none">${lines.join('')}</g>`);

  // Labels, charges and lone pairs
  for (const a of atoms) {
    let chargeAngle: number | null = null;
    if (a.label && a.box) {
      const { main, h, hBefore } = a.label;
      const base = a.y + FS * 0.36;
      texts.push(`<text x="${f2(a.x)}" y="${f2(base)}" text-anchor="middle">${esc(main)}</text>`);
      if (h > 0) {
        const sub = h > 1 ? `<tspan font-size="${SUB_FS}" dy="${f2(FS * 0.2)}">${h}</tspan>` : '';
        const wMain = textWidth(main, FS);
        const hx = hBefore ? a.x - wMain / 2 : a.x + wMain / 2;
        texts.push(`<text x="${f2(hx)}" y="${f2(base)}" text-anchor="${hBefore ? 'end' : 'start'}">H${sub}</text>`);
      }
      grow(a.box.l, a.box.t, a.box.r, a.box.b);
      if (a.charge !== 0) {
        chargeAngle = CORNERS.find((c) => a.angles.every((b) => angDist(b, c) >= 0.95)) ??
          CORNERS.reduce((best, c) => (Math.min(...a.angles.map((b) => angDist(b, c))) > Math.min(...a.angles.map((b) => angDist(b, best))) ? c : best));
        const right = Math.cos(chargeAngle) > 0;
        const top = Math.sin(chargeAngle) < 0;
        const cw = textWidth(chargeText(a.charge), CHARGE_FS);
        const cx = right ? a.box.r - LABEL_PAD + 1 : a.box.l + LABEL_PAD - 1;
        const cy = top ? a.y - FS * 0.3 : a.y + FS * 0.85;
        texts.push(`<text x="${f2(cx)}" y="${f2(cy)}" font-size="${CHARGE_FS}" text-anchor="${right ? 'start' : 'end'}">${chargeText(a.charge)}</text>`);
        grow(right ? cx : cx - cw, cy - CHARGE_FS, right ? cx + cw : cx, cy);
      }
    } else {
      grow(a.x - 2, a.y - 2, a.x + 2, a.y + 2);
    }

    if (lewis && spec.lonePairs && a.box) {
      const nb = nonbondingElectrons(a.z, a.charge, a.bondSum + (a.label?.h ?? 0));
      if (nb) {
        const pairs = Math.floor(nb / 2);
        const odd = nb % 2;
        const fixed = chargeAngle === null ? a.angles : [...a.angles, chargeAngle];
        const dirs = placeElectrons(pairs + odd, fixed);
        dirs.forEach((ang, k) => {
          const dist = boxEdge(a.box!, a.x, a.y, ang) + 4.5;
          const cx = a.x + Math.cos(ang) * dist;
          const cy = a.y + Math.sin(ang) * dist;
          const offsets = k < pairs ? [-2.6, 2.6] : [0];
          for (const o of offsets) {
            const dx = cx - Math.sin(ang) * o;
            const dy = cy + Math.cos(ang) * o;
            dots.push(`<circle cx="${f2(dx)}" cy="${f2(dy)}" r="${DOT_R}"/>`);
            grow(dx - DOT_R, dy - DOT_R, dx + DOT_R, dy + DOT_R);
          }
        });
      }
    }
  }

  const title = spec.title?.trim() ?? '';
  const contentW = bounds.r - bounds.l;
  const contentH = bounds.b - bounds.t;
  const titleW = title ? textWidth(title, 14) : 0;
  const W = Math.ceil(Math.max(MIN_WIDTH, contentW + 2 * MARGIN, titleW + 2 * MARGIN));
  const H = Math.ceil(contentH + 2 * MARGIN + (title ? 26 : 0));
  const ox = (W - contentW) / 2 - bounds.l;
  const oy = MARGIN - bounds.t;
  const label = title || `Structure of ${spec.smiles.trim()}`;

  const svg: string[] = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}" font-family="${FONT}">`);
  svg.push(`<title>${esc(label)}</title>`);
  svg.push(`<rect width="${W}" height="${H}" fill="#FFFFFF"/>`);
  svg.push(`<g transform="translate(${f2(ox)} ${f2(oy)})">`);
  svg.push(...out);
  svg.push(`<g fill="${INK}" font-size="${FS}">${texts.join('')}</g>`);
  if (dots.length) svg.push(`<g fill="${INK}">${dots.join('')}</g>`);
  svg.push('</g>');
  if (title) svg.push(`<text x="${f2(W / 2)}" y="${f2(H - MARGIN * 0.6)}" text-anchor="middle" font-size="14" fill="${SOFT}">${esc(title)}</text>`);
  svg.push('</svg>');
  return svg.join('\n');
}
