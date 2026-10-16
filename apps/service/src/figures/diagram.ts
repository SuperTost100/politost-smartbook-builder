import { z } from 'zod';
import { ELEMENTS, elementBySymbol, parseSpecies, suggestSymbol } from './elements.ts';

/**
 * Four chemistry diagram templates (energy levels, orbital boxes, electrochemical cells, periodic table). The writer
 * model sends JSON, validateDiagram checks it, renderDiagramSvg draws it the same way every time.
 */

// ---------------------------------------------------------------------------------------------
// Schemas (what the model sees: every field required, nullable instead of optional)
// ---------------------------------------------------------------------------------------------

export const levelsSchema = z.object({
  yLabel: z.string().nullable().describe('The energy on the vertical axis, e.g. "Energia", "H" or "S"; required'),
  columns: z
    .array(z.object({ label: z.string().nullable().describe('Text under the column, e.g. "O", "O_2", "Reagenti"') }))
    .describe('1 to 4 columns, left to right'),
  levels: z.array(
    z.object({
      key: z.string().describe('Short unique id that links refer to'),
      column: z.number().int().describe('0-based column index'),
      energy: z.number().describe('Height on the axis; only the order and the relative spacing matter'),
      label: z.string().describe('Name of the level, e.g. "σ_2p" or "H_2O(l)"'),
      boxes: z.number().int().nullable().describe('Degenerate orbitals drawn side by side, 1 to 7; null means 1'),
      electrons: z.number().int().nullable().describe('Electrons in the level, filled by Hund rule; null draws no arrows'),
    }),
  ),
  links: z.array(
    z.object({
      from: z.string().describe('Key of the first level'),
      to: z.string().describe('Key of the second level; an arrow points here'),
      style: z.enum(['dashed', 'arrow']).describe('dashed joins levels of different columns (MO correlation); arrow is a ΔH arrow'),
      label: z.string().nullable().describe('Text on an arrow, e.g. "ΔH = −286 kJ"'),
    }),
  ),
});

export const orbitalsSchema = z.object({
  species: z.string().describe('Atom or ion with its charge: "O", "Fe3+", "Cl-"'),
  core: z.string().nullable().describe('Noble-gas core "[He]", "[Ne]", "[Ar]", "[Kr]", "[Xe]" or "[Rn]"; null draws every subshell'),
  subshells: z
    .array(z.object({ label: z.string().describe('"1s", "2p", "3d", "4f"'), electrons: z.number().int() }))
    .describe('Subshells outside the core, in the order they are drawn'),
});

const electrodeSchema = z.object({
  electrode: z.string().describe('Electrode material, e.g. "Zn" or "Pt"'),
  solution: z.string().describe('Solution around it, e.g. "ZnSO_4 1 M"'),
  role: z.enum(['anode', 'cathode']),
  halfReaction: z.string().nullable().describe('Half-reaction in text markup, e.g. "Zn -> Zn^2+ + 2e^-"; null for none'),
});

export const cellSchema = z.object({
  type: z.enum(['galvanic', 'electrolytic']),
  left: electrodeSchema,
  right: electrodeSchema,
  saltBridge: z.string().nullable().describe('Salt bridge electrolyte, e.g. "KNO_3"; null means both electrodes share one vessel (a lead-acid battery, molten NaCl)'),
  meter: z.string().nullable().describe('Voltmeter reading such as "1,10 V"; galvanic only'),
});

export const periodicSchema = z.object({
  highlights: z
    .array(z.object({ elements: z.array(z.string()).describe('Element symbols such as "Na"'), label: z.string().describe('Legend text for the group') }))
    .describe('1 to 5 groups of elements, each in its own colour; an element is in one group at most'),
  trends: z
    .array(
      z.object({
        direction: z.enum(['right', 'left', 'up', 'down']).describe('right/left run along the top, up/down along the left side'),
        label: z.string().describe('What increases, e.g. "Energia di ionizzazione"'),
      }),
    )
    .describe('0 to 2 arrows, at most one horizontal and one vertical'),
});

export type LevelsSpec = z.infer<typeof levelsSchema>;
export type OrbitalsSpec = z.infer<typeof orbitalsSchema>;
export type CellSpec = z.infer<typeof cellSchema>;
export type PeriodicSpec = z.infer<typeof periodicSchema>;
export type DiagramSpec = LevelsSpec | OrbitalsSpec | CellSpec | PeriodicSpec;
export type DiagramKind = 'levels' | 'orbitals' | 'cell' | 'periodic';

const SCHEMAS = { levels: levelsSchema, orbitals: orbitalsSchema, cell: cellSchema, periodic: periodicSchema } as const;

// ---------------------------------------------------------------------------------------------
// Chemistry text markup
// ---------------------------------------------------------------------------------------------

export type RunKind = 'n' | 'sub' | 'sup';
export interface Run {
  text: string;
  kind: RunKind;
}

const MINUS = '−';
const SUB_RE = /^(?:\d+(?:[spdf][xyz]{0,2})?|[a-z]+|[A-Za-z0-9])/;
const SUP_RE = /^(?:\d+[+\-−]?|[+\-−]\d*|[A-Za-z*])/;
// An ion written without markup: Zn2+, Fe3+, Cl-, NH4+, OH-, [Cu(NH3)4]2+, e-.
const ION_RE = new RegExp(
  String.raw`(?<![A-Za-z])(?<f>(?:[A-Z][a-z]?\d*|\((?:[A-Z][a-z]?\d*)+\)\d*)+)(?<s>[+\-−])(?![A-Za-z0-9>])` +
    String.raw`|(?<b>\])(?<bs>\d*[+\-−])(?![A-Za-z0-9>])` +
    String.raw`|(?<![A-Za-z])(?<e>e)(?<es>[+\-−])(?![A-Za-z0-9>])`,
  'g',
);

const merge = (runs: Run[]): Run[] => {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === r.kind) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
};

/** Plain text between ions: arrows, minus signs before numbers, subscripts after element symbols, starred orbitals. */
function softRuns(s: string): Run[] {
  const t = s.replace(/<=>|<->/g, '⇌').replace(/-{1,2}>/g, '→').replace(/(?<=^|[\s(=])-(?=\d)/g, MINUS);
  const out: Run[] = [];
  let at = 0;
  for (const m of t.matchAll(/(?<=[σπδ])\*|(?<=[A-Z][a-z]?|\))\d+/g)) {
    out.push({ text: t.slice(at, m.index), kind: 'n' });
    out.push({ text: m[0], kind: m[0] === '*' ? 'sup' : 'sub' });
    at = m.index + m[0].length;
  }
  out.push({ text: t.slice(at), kind: 'n' });
  return out;
}

/** Text with no explicit markup: finds the ions first, then formats what is left. */
function autoRuns(s: string): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const m of s.matchAll(ION_RE)) {
    out.push(...softRuns(s.slice(at, m.index)));
    at = m.index + m[0].length;
    const g = m.groups!;
    if (g.f) {
      const sign = g.s === '-' ? MINUS : g.s;
      const single = /^([A-Z][a-z]?)(\d+)$/.exec(g.f);
      const split = /^(.*[A-Za-z]\d)([2-4])$/.exec(g.f);
      if (single) out.push({ text: single[1], kind: 'n' }, { text: single[2] + sign, kind: 'sup' });
      else if (split && sign === MINUS) out.push(...softRuns(split[1]), { text: split[2] + sign, kind: 'sup' });
      else out.push(...softRuns(g.f), { text: sign, kind: 'sup' });
    } else if (g.b) {
      out.push({ text: ']', kind: 'n' }, { text: g.bs.replace('-', MINUS), kind: 'sup' });
    } else {
      out.push({ text: 'e', kind: 'n' }, { text: g.es.replace('-', MINUS), kind: 'sup' });
    }
  }
  out.push(...softRuns(s.slice(at)));
  return out;
}

/**
 * Splits chemistry text into normal, subscript and superscript runs. `_` and `^` mark them (`H_2O`, `SO_4^2-`,
 * `σ*_2p`, `^{2-}`, `_{2p}`). Without markup the usual cases are found: digits after an element symbol or `)`
 * (`H2O`, `Ca(OH)2`) and ion charges (`Zn2+`, `Fe3+`, `Cl-`, `NH4+`). Digits that start a token (`1s`, `2p`, `1 M`,
 * `1,10 V`) stay as they are. Minus in a superscript is U+2212, `->` becomes an arrow.
 */
export function chemRuns(text: string): Run[] {
  const runs: Run[] = [];
  let plain = '';
  const flush = () => {
    if (plain) runs.push(...autoRuns(plain));
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '_' && ch !== '^') {
      plain += ch;
      i++;
      continue;
    }
    const kind: RunKind = ch === '_' ? 'sub' : 'sup';
    let body: string | null = null;
    let used = 0;
    if (text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      if (end > 0) {
        body = text.slice(i + 2, end);
        used = end - i + 1;
      }
    } else if (text[i + 1] === '(') {
      // A state or other group in parentheses keeps them: "S_(g)" is S with "(g)" lowered.
      const end = text.indexOf(')', i + 2);
      if (end > 0) {
        body = text.slice(i + 1, end + 1);
        used = end - i + 1;
      }
    } else {
      const m = (kind === 'sub' ? SUB_RE : SUP_RE).exec(text.slice(i + 1));
      if (m) {
        body = m[0];
        used = 1 + m[0].length;
      }
    }
    if (body === null) {
      plain += ch;
      i++;
      continue;
    }
    flush();
    runs.push({ text: kind === 'sup' ? body.replace(/-/g, MINUS) : body, kind });
    i += used;
  }
  flush();
  return merge(runs);
}

/** The text without markup, for alt text and aria labels: "H_2O" becomes "H2O". */
export const chemPlain = (text: string): string => chemRuns(text).map((r) => r.text).join('');

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const INK = '#111827';
const SOFT = '#374151';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const RULE = '#D1D5DB';
const ACCENT = ['#C2410C', '#1D4ED8', '#15803D'];
const PALETTE = [...ACCENT, '#7E22CE', '#BE185D'];
const SCRIPT = 0.72;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function f2(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Rough width of a string in the sans-serif font; enough to keep labels apart. */
function textWidth(s: string, fs: number): number {
  let w = 0;
  for (const ch of s) w += /[iltfjI.,;:'|()[\] ]/.test(ch) ? 0.34 : /[mwMW]/.test(ch) ? 0.88 : /[A-Z]/.test(ch) ? 0.68 : /[a-z0-9]/.test(ch) ? 0.58 : 0.7;
  return w * fs;
}

/** Width of chemistry text; sub- and superscripts are set smaller. */
export function chemWidth(text: string, fs: number): number {
  return chemRuns(text).reduce((w, r) => w + textWidth(r.text, r.kind === 'n' ? fs : fs * SCRIPT), 0);
}

function chemTspans(runs: Run[], fs: number): string {
  let offset = 0; // current baseline shift in px, positive down
  return runs
    .map((r) => {
      const target = r.kind === 'sub' ? fs * 0.22 : r.kind === 'sup' ? -fs * 0.38 : 0;
      const dy = target - offset;
      offset = target;
      const attrs = (dy ? ` dy="${f2(dy)}"` : '') + (r.kind !== 'n' ? ` font-size="${f2(fs * SCRIPT)}"` : '');
      return attrs ? `<tspan${attrs}>${esc(r.text)}</tspan>` : esc(r.text);
    })
    .join('');
}

interface TextOpts {
  fs?: number;
  anchor?: 'start' | 'middle' | 'end';
  fill?: string;
  weight?: number;
  rotate?: number;
}

/** A <text> element for chemistry text. */
function T(x: number, y: number, text: string, o: TextOpts = {}): string {
  const fs = o.fs ?? 13;
  const pos = o.rotate ? `transform="translate(${f2(x)} ${f2(y)}) rotate(${o.rotate})"` : `x="${f2(x)}" y="${f2(y)}"`;
  const anchor = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : '';
  const weight = o.weight ? ` font-weight="${o.weight}"` : '';
  return `<text ${pos} font-size="${f2(fs)}"${anchor} fill="${o.fill ?? INK}"${weight}>${chemTspans(chemRuns(text), fs)}</text>`;
}

/** The font size that makes the text fit `max` px, never above `fs` nor below `min`. */
const fitFs = (text: string, fs: number, max: number, min = 9): number => Math.max(min, Math.min(fs, (fs * max) / Math.max(chemWidth(text, fs), 1)));

function svgOpen(w: number, h: number, label: string): string[] {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" font-family="${FONT}">`,
    `<title>${esc(label)}</title>`,
    `<rect width="${w}" height="${h}" fill="#FFFFFF"/>`,
  ];
}

const finish = (parts: string[]): string => `${[...parts, '</svg>'].join('\n')}\n`;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const hit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function segHitsBox(s: Seg, b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, s.x0 - b.x0) && clip(dx, b.x1 - s.x0) && clip(-dy, s.y0 - b.y0) && clip(dy, b.y1 - s.y0);
}

/** A straight arrow with a filled head at (x1, y1). */
function arrow(x0: number, y0: number, x1: number, y1: number, color: string, sw = 1.8, head = 9): string {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1) return '';
  const h = Math.min(head, len * 0.6);
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const bx = x1 - ux * h;
  const by = y1 - uy * h;
  const px = -uy * h * 0.4;
  const py = ux * h * 0.4;
  return (
    `<line x1="${f2(x0)}" y1="${f2(y0)}" x2="${f2(bx + ux * 0.5)}" y2="${f2(by + uy * 0.5)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>` +
    `<polygon points="${f2(x1)},${f2(y1)} ${f2(bx + px)},${f2(by + py)} ${f2(bx - px)},${f2(by - py)}" fill="${color}"/>`
  );
}

/** Up and down arrows of each box when `electrons` fill `boxes` by Hund's rule: one up in every box first, then the downs. */
export function hundFill(boxes: number, electrons: number): { up: boolean; down: boolean }[] {
  return Array.from({ length: boxes }, (_, i) => ({ up: i < Math.min(electrons, boxes), down: i < electrons - boxes }));
}

/** An electron arrow centred on (cx, cy), with a full head so it never reads as the digit 1. */
function spin(cx: number, cy: number, h: number, up: boolean): string {
  const tip = up ? cy - h / 2 : cy + h / 2;
  const tail = up ? cy + h / 2 : cy - h / 2;
  const d = up ? 1 : -1;
  const base = tip + d * 6;
  return `<path d="M${f2(cx)} ${f2(tail)}V${f2(base)}"/><path d="M${f2(cx)} ${f2(tip)}L${f2(cx - 3.5)} ${f2(base)}H${f2(cx + 3.5)}Z" fill="currentColor" stroke-width="1"/>`;
}

/** The arrows of one box, centred in it. */
function spinsIn(cx: number, cy: number, h: number, s: { up: boolean; down: boolean }): string[] {
  const both = s.up && s.down;
  const out: string[] = [];
  if (s.up) out.push(spin(both ? cx - 5.5 : cx, cy, h, true));
  if (s.down) out.push(spin(both ? cx + 5.5 : cx, cy, h, false));
  return out;
}

const spinGroup = (paths: string[]): string =>
  paths.length ? `<g fill="none" stroke="${INK}" color="${INK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g>` : '';

const isItalian = (language: string) => language.trim().toLowerCase().startsWith('it');

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

type Result = { ok: true; spec: DiagramSpec } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fills nullable fields the model left out with null, so a missing "label" does not fail a whole figure. */
function fillNulls(schema: z.ZodType, v: unknown): unknown {
  if (schema instanceof z.ZodObject && isRecord(v)) {
    const out: Record<string, unknown> = { ...v };
    for (const [k, s] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      if (out[k] === undefined && s instanceof z.ZodNullable) out[k] = null;
      else out[k] = fillNulls(s, out[k]);
    }
    return out;
  }
  if (schema instanceof z.ZodArray && Array.isArray(v)) return v.map((x) => fillNulls(schema.element as z.ZodType, x));
  if (schema instanceof z.ZodNullable) return v == null ? v : fillNulls(schema.unwrap() as z.ZodType, v);
  return v;
}

const LIMITS = { label: 60, short: 40, columns: 4, levels: 24, links: 30, subshells: 24, highlights: 5, trends: 2 };

class Errors {
  list: string[] = [];
  add(path: string, message: string) {
    this.list.push(`${path}: ${message}`);
  }
  /** A required, non-blank string of at most `max` characters. */
  text(path: string, s: string, max: number) {
    if (!s.trim()) this.add(path, 'must not be empty');
    else if (s.length > max) this.add(path, `is ${s.length} characters, at most ${max} allowed`);
  }
  /** A string that may be null, otherwise at most `max` characters. */
  maybe(path: string, s: string | null, max: number) {
    if (s !== null && s.length > max) this.add(path, `is ${s.length} characters, at most ${max} allowed`);
  }
}

const CORES: Record<string, number> = { '[He]': 2, '[Ne]': 10, '[Ar]': 18, '[Kr]': 36, '[Xe]': 54, '[Rn]': 86 };
const CAPACITY: Record<string, number> = { s: 2, p: 6, d: 10, f: 14 };
const BOXES: Record<string, number> = { s: 1, p: 3, d: 5, f: 7 };
/** Lowest shell number that has each subshell type. */
const FIRST_SHELL: Record<string, number> = { s: 1, p: 2, d: 3, f: 4 };

const ARROW_H = 18;
const LV = { axisX: 46, left: 78, right: 616, top: 52, bottom: 356, width: 640, height: 420 };
const LEVEL_TOP_EXT = ARROW_H + 6; // room an electron arrow needs above a bar
const LEVEL_TEXT_EXT = 8; // half the height of a label beside a bar

/** Vertical position of every level; the energies are scaled linearly into the plot. */
function levelYs(levels: LevelsSpec['levels']): { ys: number[]; range: number } {
  const es = levels.map((l) => l.energy);
  const lo = Math.min(...es);
  const hi = Math.max(...es);
  const range = hi - lo;
  return { ys: es.map((e) => (range > 0 ? LV.top + ((hi - e) / range) * (LV.bottom - LV.top) : (LV.top + LV.bottom) / 2)), range };
}

function checkLevels(s: LevelsSpec, e: Errors) {
  // The vertical axis is an energy. Without one, the diagram is a flow chart in disguise, which this kind cannot show.
  if (!s.yLabel?.trim()) e.add('yLabel', 'name the energy on the vertical axis ("Energia", "H", "S"); an energy-level diagram is not a flow chart or a conversion scheme');
  else e.maybe('yLabel', s.yLabel, LIMITS.short);
  if (s.columns.length < 1 || s.columns.length > LIMITS.columns) e.add('columns', `has ${s.columns.length} columns, use 1 to ${LIMITS.columns}`);
  s.columns.forEach((c, i) => e.maybe(`columns.${i}.label`, c.label, LIMITS.short));
  if (s.levels.length < 1 || s.levels.length > LIMITS.levels) e.add('levels', `has ${s.levels.length} levels, use 1 to ${LIMITS.levels}`);
  const keys = new Map<string, number>();
  s.levels.forEach((l, i) => {
    const p = `levels.${i}`;
    e.text(`${p}.key`, l.key, 30);
    if (keys.has(l.key)) e.add(`${p}.key`, `"${l.key}" is already the key of levels.${keys.get(l.key)}`);
    else keys.set(l.key, i);
    if (l.column < 0 || l.column >= s.columns.length) e.add(`${p}.column`, `${l.column} is out of range; this diagram has ${s.columns.length} column(s), numbered 0 to ${s.columns.length - 1}`);
    if (!Number.isFinite(l.energy)) e.add(`${p}.energy`, 'must be a finite number');
    e.text(`${p}.label`, l.label, LIMITS.label);
    if (l.boxes !== null && (l.boxes < 1 || l.boxes > 7)) e.add(`${p}.boxes`, `${l.boxes} is out of range, use 1 to 7 or null`);
    const boxes = l.boxes ?? 1;
    if (l.electrons !== null && (l.electrons < 0 || l.electrons > 2 * boxes)) {
      e.add(`${p}.electrons`, `${l.electrons} electrons do not fit in ${boxes} box${boxes === 1 ? '' : 'es'} (0 to ${2 * boxes}), or use null for no arrows`);
    }
  });
  if (s.links.length > LIMITS.links) e.add('links', `has ${s.links.length} links, at most ${LIMITS.links} allowed`);
  s.links.forEach((k, i) => {
    const p = `links.${i}`;
    for (const end of ['from', 'to'] as const) if (!keys.has(k[end])) e.add(`${p}.${end}`, `"${k[end]}" is not the key of any level`);
    if (k.from === k.to) e.add(p, 'a link cannot join a level to itself');
    else if (k.style === 'dashed' && keys.has(k.from) && keys.has(k.to) && s.levels[keys.get(k.from)!].column === s.levels[keys.get(k.to)!].column) {
      e.add(p, 'a dashed link must join levels of different columns; use style "arrow" inside one column');
    }
    e.maybe(`${p}.label`, k.label, LIMITS.short);
  });
  if (e.list.length) return;
  // Levels of one column share a vertical line, so their bars (and the arrows or labels around them) must not overlap.
  const { ys, range } = levelYs(s.levels);
  s.columns.forEach((_, c) => {
    const inCol = s.levels.map((l, i) => i).filter((i) => s.levels[i].column === c).sort((a, b) => ys[a] - ys[b] || a - b);
    for (let k = 1; k < inCol.length; k++) {
      const upper = inCol[k - 1];
      const lower = inCol[k];
      const need = (s.levels[lower].electrons !== null ? LEVEL_TOP_EXT : LEVEL_TEXT_EXT) + LEVEL_TEXT_EXT;
      if (ys[lower] - ys[upper] < need - 1e-6) {
        const first = Math.min(upper, lower);
        const second = Math.max(upper, lower);
        const gap = range > 0 ? Number(((need / (LV.bottom - LV.top)) * range).toPrecision(2)) : 0;
        e.list.push(
          `levels.${first} and levels.${second} are too close in column ${c} (energies ${s.levels[first].energy} and ${s.levels[second].energy}); they need to differ by at least about ${gap || 'more than 0'} on this scale, or sit in different columns`,
        );
      }
    }
  });
}

function electronsOf(s: OrbitalsSpec): { total: number; core: number } | null {
  const sp = parseSpecies(s.species);
  if (!sp) return null;
  return { total: sp.z - sp.charge, core: s.core ? (CORES[s.core] ?? 0) : 0 };
}

function checkOrbitals(s: OrbitalsSpec, e: Errors) {
  const sp = parseSpecies(s.species);
  if (!sp) e.add('species', `"${s.species}" is not an element symbol with an optional charge (for example "O", "Fe3+", "Cl-")`);
  if (s.core !== null && !(s.core in CORES)) e.add('core', `"${s.core}" must be one of ${Object.keys(CORES).join(', ')}, or null`);
  if (s.subshells.length > LIMITS.subshells) e.add('subshells', `has ${s.subshells.length} subshells, at most ${LIMITS.subshells} allowed`);
  if (!s.subshells.length && s.core === null) e.add('subshells', 'needs at least one subshell when core is null');
  const seen = new Set<string>();
  let shown = s.core && s.core in CORES ? CORES[s.core] : 0;
  s.subshells.forEach((sub, i) => {
    const p = `subshells.${i}`;
    const m = /^([1-7])([spdf])$/.exec(sub.label);
    if (!m) {
      e.add(`${p}.label`, `"${sub.label}" must be a shell number 1 to 7 and one letter s, p, d or f, such as "3d"`);
      return;
    }
    if (Number(m[1]) < FIRST_SHELL[m[2]]) e.add(`${p}.label`, `"${sub.label}" does not exist; ${m[2]} subshells start at shell ${FIRST_SHELL[m[2]]}`);
    if (seen.has(sub.label)) e.add(`${p}.label`, `"${sub.label}" is listed twice`);
    seen.add(sub.label);
    if (sub.electrons < 0 || sub.electrons > CAPACITY[m[2]]) e.add(`${p}.electrons`, `${sub.electrons} electrons do not fit in ${sub.label} (0 to ${CAPACITY[m[2]]})`);
    else shown += sub.electrons;
  });
  if (!e.list.length && sp) {
    const want = sp.z - sp.charge;
    if (want !== shown) e.add('species', `${s.species} has ${want} electrons but the diagram shows ${shown}`);
  }
}

function checkCell(s: CellSpec, e: Errors) {
  for (const side of ['left', 'right'] as const) {
    const c = s[side];
    e.text(`${side}.electrode`, c.electrode, LIMITS.short);
    e.text(`${side}.solution`, c.solution, LIMITS.short);
    e.maybe(`${side}.halfReaction`, c.halfReaction, 80);
  }
  if (s.left.role === s.right.role) e.add('right.role', `left and right are both "${s.left.role}"; a cell has one anode and one cathode`);
  e.maybe('saltBridge', s.saltBridge, LIMITS.short);
  if (s.saltBridge !== null && !s.saltBridge.trim()) e.add('saltBridge', 'must not be blank; use null for none');
  if (s.meter !== null) {
    if (s.type !== 'galvanic') e.add('meter', 'only a galvanic cell has a voltmeter; use null');
    else e.maybe('meter', s.meter, 20);
  }
}

function checkPeriodic(s: PeriodicSpec, e: Errors) {
  if (s.highlights.length < 1 || s.highlights.length > LIMITS.highlights) e.add('highlights', `has ${s.highlights.length} groups, use 1 to ${LIMITS.highlights}`);
  const owner = new Map<string, number>();
  s.highlights.forEach((h, i) => {
    e.text(`highlights.${i}.label`, h.label, LIMITS.short);
    if (!h.elements.length) e.add(`highlights.${i}.elements`, 'must list at least one element');
    h.elements.forEach((sym, j) => {
      const p = `highlights.${i}.elements.${j}`;
      if (!elementBySymbol(sym)) {
        const fix = suggestSymbol(sym);
        e.add(p, `"${sym}" is not an element symbol${fix ? `; did you mean "${fix}"? Symbols are case-sensitive` : ''}`);
      } else if (owner.has(sym)) {
        e.add(p, `"${sym}" is already in highlights.${owner.get(sym)}; an element can be in one group only`);
      } else owner.set(sym, i);
    });
  });
  if (s.trends.length > LIMITS.trends) e.add('trends', `has ${s.trends.length} arrows, at most ${LIMITS.trends} allowed`);
  const horizontal = s.trends.filter((t) => t.direction === 'right' || t.direction === 'left').length;
  if (horizontal > 1) e.add('trends', 'has two horizontal arrows; use at most one "right" or "left"');
  if (s.trends.length - horizontal > 1) e.add('trends', 'has two vertical arrows; use at most one "up" or "down"');
  s.trends.forEach((t, i) => e.text(`trends.${i}.label`, t.label, 36));
}

export function validateDiagram(kind: DiagramKind, req: unknown): Result {
  const schema = SCHEMAS[kind];
  if (!schema) return { ok: false, errors: [`kind: "${String(kind)}" is not one of levels, orbitals, cell, periodic`] };
  const parsed = schema.safeParse(fillNulls(schema, req));
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(diagram)'}: ${i.message}`) };
  const e = new Errors();
  const spec = parsed.data;
  if (kind === 'levels') checkLevels(spec as LevelsSpec, e);
  else if (kind === 'orbitals') checkOrbitals(spec as OrbitalsSpec, e);
  else if (kind === 'cell') checkCell(spec as CellSpec, e);
  else checkPeriodic(spec as PeriodicSpec, e);
  return e.list.length ? { ok: false, errors: e.list } : { ok: true, spec };
}

// ---------------------------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------------------------

export function describeDiagram(kind: DiagramKind, spec: DiagramSpec): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (kind === 'levels') {
    const s = spec as LevelsSpec;
    const electrons = s.levels.reduce((n, l) => n + (l.electrons ?? 0), 0);
    return `Energy-level diagram with ${plural(s.levels.length, 'level')} in ${plural(s.columns.length, 'column')}, ${plural(s.links.length, 'link')}${electrons ? `, ${plural(electrons, 'electron')} drawn` : ''}.`;
  }
  if (kind === 'orbitals') {
    const s = spec as OrbitalsSpec;
    const have = electronsOf(s);
    const shown = have ? have.core + s.subshells.reduce((n, x) => n + x.electrons, 0) : 0;
    return `Orbital boxes for ${s.species}: ${plural(shown, 'electron')}, as the species has.`;
  }
  if (kind === 'cell') {
    const s = spec as CellSpec;
    const anode = s.left.role === 'anode' ? s.left : s.right;
    const cathode = s.left.role === 'anode' ? s.right : s.left;
    const where = (c: typeof anode) => (c === s.left ? 'left' : 'right');
    const extras = [s.saltBridge ? `salt bridge ${chemPlain(s.saltBridge)}` : 'one shared vessel', s.meter ? `voltmeter reading ${s.meter}` : ''].filter(Boolean);
    return `${s.type === 'galvanic' ? 'Galvanic' : 'Electrolytic'} cell with ${chemPlain(anode.electrode)} as the anode (${where(anode)}) and ${chemPlain(cathode.electrode)} as the cathode (${where(cathode)}), ${extras.join(', ')}.`;
  }
  const s = spec as PeriodicSpec;
  const n = s.highlights.reduce((a, h) => a + h.elements.length, 0);
  return `Periodic table with ${plural(s.highlights.length, 'highlighted group')} (${plural(n, 'element')})${s.trends.length ? ` and ${plural(s.trends.length, 'trend arrow')}` : ''}.`;
}

// ---------------------------------------------------------------------------------------------
// 1. Energy levels
// ---------------------------------------------------------------------------------------------

interface PlacedLevel {
  i: number;
  col: number;
  y: number;
  x0: number;
  x1: number;
  cx: number;
  boxes: number;
  bw: number;
  electrons: number | null;
  label: string;
}

function renderLevels(s: LevelsSpec, it: boolean): string {
  const n = s.columns.length;
  const colW = (LV.right - LV.left) / n;
  const maxBoxes = Math.max(...s.levels.map((l) => l.boxes ?? 1));
  const withArrows = s.levels.some((l) => l.electrons !== null);
  const base = withArrows ? 34 : 64;
  const GAP = 5;
  const bw = Math.max(20, Math.min(base, (colW * 0.62 - (maxBoxes - 1) * GAP) / maxBoxes));
  const { ys } = levelYs(s.levels);
  // Arrows inside one column run beside its levels, so plain levels there are as wide as their labels and the labels can sit on top.
  const stacked = new Set(s.links.filter((k) => k.style === 'arrow').map((k) => [s.levels.find((l) => l.key === k.from)!, s.levels.find((l) => l.key === k.to)!]).filter(([a, b]) => a.column === b.column).map(([a]) => a.column));
  const placed: PlacedLevel[] = s.levels.map((l, i) => {
    const boxes = l.boxes ?? 1;
    const wide = stacked.has(l.column) && boxes === 1 && l.electrons === null;
    const barW = wide ? Math.min(Math.max(bw, ...s.levels.filter((o) => o.column === l.column).map((o) => chemWidth(o.label, 13) + 24)), colW * 0.85) : bw;
    const w = boxes * barW + (boxes - 1) * GAP;
    const cx = LV.left + colW * (l.column + 0.5);
    return { i, col: l.column, y: ys[i], x0: cx - w / 2, x1: cx + w / 2, cx, boxes, bw: barW, electrons: l.electrons, label: l.label };
  });
  const byKey = new Map(s.levels.map((l, i) => [l.key, placed[i]]));
  const bounds: Box = { x0: LV.left - 22, y0: 4, x1: LV.width - 4, y1: LV.bottom + 24 };
  const inside = (b: Box) => b.x0 >= bounds.x0 && b.x1 <= bounds.x1 && b.y0 >= bounds.y0 && b.y1 <= bounds.y1;

  const occ: Box[] = placed.map((p) => ({ x0: p.x0, x1: p.x1, y0: p.y - (p.electrons !== null ? ARROW_H + 4 : 5), y1: p.y + 5 }));
  const segs: Seg[] = [];
  const out: string[] = [];
  const label = it ? 'Diagramma dei livelli energetici' : 'Energy-level diagram';
  out.push(...svgOpen(LV.width, LV.height, `${label}: ${s.levels.map((l) => chemPlain(l.label)).join(', ')}`));

  // Energy axis
  out.push(`<line x1="${LV.axisX}" y1="${LV.bottom + 18}" x2="${LV.axisX}" y2="30" stroke="${SOFT}" stroke-width="1.6"/>`);
  out.push(`<polygon points="${LV.axisX},20 ${LV.axisX - 4.5},31 ${LV.axisX + 4.5},31" fill="${SOFT}"/>`);
  if (s.yLabel) {
    if (chemWidth(s.yLabel, 14) <= 70) out.push(T(LV.axisX, 13, s.yLabel, { fs: 14, anchor: 'middle', weight: 600 }));
    else out.push(T(20, (30 + LV.bottom + 18) / 2, s.yLabel, { fs: 14, anchor: 'middle', weight: 600, rotate: -90 }));
  }

  // Dashed correlation lines
  const lines: string[] = [];
  for (const k of s.links) {
    if (k.style !== 'dashed') continue;
    const a = byKey.get(k.from)!;
    const b = byKey.get(k.to)!;
    const [l, r] = a.col < b.col ? [a, b] : [b, a];
    segs.push({ x0: l.x1, y0: l.y, x1: r.x0, y1: r.y });
    lines.push(`<line x1="${f2(l.x1)}" y1="${f2(l.y)}" x2="${f2(r.x0)}" y2="${f2(r.y)}"/>`);
  }
  if (lines.length) out.push(`<g stroke="${FAINT}" stroke-width="1.2" stroke-dasharray="5 4">${lines.join('')}</g>`);

  // Bars and electrons
  const bars: string[] = [];
  const spins: string[] = [];
  for (const p of placed) {
    const fill = p.electrons !== null ? hundFill(p.boxes, p.electrons) : [];
    for (let b = 0; b < p.boxes; b++) {
      const x = p.x0 + b * (p.bw + GAP);
      bars.push(`<line x1="${f2(x)}" y1="${f2(p.y)}" x2="${f2(x + p.bw)}" y2="${f2(p.y)}"/>`);
      if (fill[b]) spins.push(...spinsIn(x + p.bw / 2, p.y - ARROW_H / 2 - 2, ARROW_H, fill[b]));
    }
  }
  out.push(`<g stroke="${INK}" stroke-width="2.6" stroke-linecap="round">${bars.join('')}</g>`);
  out.push(spinGroup(spins));

  // Arrows between levels (ΔH): placed before the level labels, which then keep clear of them
  const drawn: string[] = [];
  const free = (b: Box) => !occ.some((o) => hit(b, o));
  const labelSpots = (x: number, ymin: number, ymax: number, w: number, sides: number[]): Box | null => {
    if (!w) return null;
    for (const side of sides) {
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const ly = ymin + (ymax - ymin) * t;
        const box: Box = side > 0 ? { x0: x + 8, x1: x + 8 + w, y0: ly - 9, y1: ly + 9 } : { x0: x - 8 - w, x1: x - 8, y0: ly - 9, y1: ly + 9 };
        if (inside(box) && free(box) && !segs.some((sg) => segHitsBox(sg, box))) return box;
      }
    }
    return null;
  };
  const dotted = (x0: number, x1: number, y: number) => {
    segs.push({ x0, y0: y, x1, y1: y });
    return `<line x1="${f2(x0)}" y1="${f2(y)}" x2="${f2(x1)}" y2="${f2(y)}"/>`;
  };
  const guides: string[] = [];
  let arrowNo = 0;
  for (const k of s.links) {
    if (k.style !== 'arrow') continue;
    const color = ACCENT[arrowNo++ % ACCENT.length];
    const a = byKey.get(k.from)!;
    const b = byKey.get(k.to)!;
    // Arrow labels are bold, which the width estimate does not cover: 15% more keeps them inside the figure. A long label
    // gets a smaller font instead of running off the edge.
    const lfs = k.label ? fitFs(k.label, 12.5, 190) : 12.5;
    const w = k.label ? chemWidth(k.label, lfs) * 1.15 : 0;
    const ymin = Math.min(a.y, b.y);
    const ymax = Math.max(a.y, b.y);
    let x: number;
    let box: Box | null;
    if (a.col !== b.col && ymax - ymin < 10) {
      // Same height in different columns: a horizontal arrow
      const [l, r] = a.col < b.col ? [a, b] : [b, a];
      const [from, to] = a.col < b.col ? [l.x1 + 8, r.x0 - 8] : [r.x0 - 8, l.x1 + 8];
      drawn.push(arrow(from, a.y, to, a.y, color));
      if (k.label) {
        const mid = (l.x1 + r.x0) / 2;
        drawn.push(T(mid, a.y - 8, k.label, { fs: lfs, fill: color, anchor: 'middle', weight: 600 }));
        occ.push({ x0: mid - w / 2, x1: mid + w / 2, y0: a.y - 21, y1: a.y - 6 });
      }
      continue;
    }
    if (a.col !== b.col) {
      const [l, r] = a.col < b.col ? [a, b] : [b, a];
      const lo = l.x1 + 14;
      const hi = r.x0 - 14;
      const mid = (lo + hi) / 2;
      let found: { x: number; box: Box | null } | null = null;
      for (const off of [0, 14, -14, 28, -28, 42, -42, 56, -56]) {
        const cx = mid + off;
        if (cx < lo || cx > hi) continue;
        if (!free({ x0: cx - 3, x1: cx + 3, y0: ymin, y1: ymax })) continue;
        const spot = labelSpots(cx, ymin, ymax, w, [1, -1]);
        if (spot || !w) {
          found = { x: cx, box: spot };
          break;
        }
      }
      x = found?.x ?? mid;
      box = found ? found.box : labelSpots(mid, ymin, ymax, w, [1, -1]);
      guides.push(dotted(l.x1, x, l.y), dotted(x, r.x0, r.y));
    } else {
      const edgeR = Math.max(a.x1, b.x1);
      const edgeL = Math.min(a.x0, b.x0);
      let best: { cost: number; x: number; box: Box | null; side: number } | null = null;
      for (let d = 18; d <= 260; d += 8) {
        for (const side of [1, -1]) {
          const cx = side > 0 ? edgeR + d : edgeL - d;
          if (!free({ x0: cx - 3, x1: cx + 3, y0: ymin, y1: ymax })) continue;
          if (cx < bounds.x0 + 4 || cx > bounds.x1 - 4) continue;
          const spot = labelSpots(cx, ymin, ymax, w, [side]);
          if (w && !spot) continue;
          const cost = d + (side < 0 ? 6 : 0);
          if (!best || cost < best.cost) best = { cost, x: cx, box: spot, side };
        }
        if (best && d > best.cost) break;
      }
      const pick = best ?? { x: edgeR + 18, box: null, side: 1 };
      x = pick.x;
      box = pick.box;
      for (const p of [a, b]) guides.push(dotted(pick.side > 0 ? p.x1 : x, pick.side > 0 ? x : p.x0, p.y));
    }
    occ.push({ x0: x - 3, x1: x + 3, y0: ymin, y1: ymax });
    drawn.push(arrow(x, a.y, x, b.y, color));
    // A label that found no free spot still goes beside its arrow, on the roomier side and shrunk to fit: a ΔH value
    // must never disappear.
    let fs = lfs;
    if (k.label && !box) {
      const roomR = bounds.x1 - (x + 8);
      const roomL = x - 8 - bounds.x0;
      fs = fitFs(k.label, lfs, Math.max(roomR, roomL) / 1.15);
      const ww = chemWidth(k.label, fs) * 1.15;
      const ly = (ymin + ymax) / 2;
      box = roomR >= roomL ? { x0: x + 8, x1: x + 8 + ww, y0: ly - 9, y1: ly + 9 } : { x0: x - 8 - ww, x1: x - 8, y0: ly - 9, y1: ly + 9 };
    }
    if (k.label && box) {
      occ.push(box);
      const anchorEnd = box.x1 < x;
      drawn.push(T(anchorEnd ? box.x1 : box.x0, (box.y0 + box.y1) / 2 + 4.5, k.label, { fs, fill: color, anchor: anchorEnd ? 'end' : 'start', weight: 600 }));
    }
  }
  if (guides.length) out.push(`<g stroke="${FAINT}" stroke-width="1" stroke-dasharray="1.5 3" stroke-linecap="round">${guides.join('')}</g>`);
  out.push(...drawn);

  // Level labels, beside the bars on the side with the fewest collisions
  for (const p of placed) {
    const w = chemWidth(p.label, 13);
    const outward = p.col < (n - 1) / 2 ? -1 : 1;
    type Spot = { box: Box; x: number; y: number; anchor: 'start' | 'middle' | 'end' };
    const side = (dir: number): Spot =>
      dir > 0
        ? { box: { x0: p.x1 + 8, x1: p.x1 + 8 + w, y0: p.y - 9, y1: p.y + 9 }, x: p.x1 + 8, y: p.y + 4.5, anchor: 'start' }
        : { box: { x0: p.x0 - 8 - w, x1: p.x0 - 8, y0: p.y - 9, y1: p.y + 9 }, x: p.x0 - 8, y: p.y + 4.5, anchor: 'end' };
    const spots: Spot[] = [side(outward), side(-outward)];
    if (p.electrons === null) spots.push({ box: { x0: p.cx - w / 2, x1: p.cx + w / 2, y0: p.y - 24, y1: p.y - 6 }, x: p.cx, y: p.y - 10, anchor: 'middle' });
    spots.push({ box: { x0: p.cx - w / 2, x1: p.cx + w / 2, y0: p.y + 5, y1: p.y + 21 }, x: p.cx, y: p.y + 18, anchor: 'middle' });
    let best = spots[0];
    let bestCost = Infinity;
    spots.forEach((sp, rank) => {
      let cost = rank * 2;
      if (!inside(sp.box)) cost += 1000;
      cost += 500 * occ.filter((o) => hit(sp.box, o)).length;
      cost += 300 * segs.filter((sg) => segHitsBox(sg, sp.box)).length;
      if (cost < bestCost) {
        bestCost = cost;
        best = sp;
      }
    });
    occ.push(best.box);
    out.push(T(best.x, best.y, p.label, { fs: 13, anchor: best.anchor }));
  }

  // Column labels
  s.columns.forEach((c, i) => {
    if (c.label) out.push(T(LV.left + colW * (i + 0.5), LV.height - 22, c.label, { fs: 14, anchor: 'middle', weight: 600 }));
  });
  return finish(out);
}

// ---------------------------------------------------------------------------------------------
// 2. Orbital boxes
// ---------------------------------------------------------------------------------------------

function renderOrbitals(s: OrbitalsSpec, it: boolean): string {
  const W = 640;
  const S = 30;
  const GAP = 18;
  const MAX = 592;
  type Item = { w: number; core?: string; sub?: { label: string; boxes: number; electrons: number } };
  const items: Item[] = [];
  if (s.core) items.push({ w: chemWidth(s.core, 18) + 4, core: s.core });
  for (const sub of s.subshells) items.push({ w: BOXES[sub.label[1]] * S, sub: { label: sub.label, boxes: BOXES[sub.label[1]], electrons: sub.electrons } });
  const rows: Item[][] = [[]];
  let used = 0;
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (row.length && used + GAP + item.w > MAX) {
      rows.push([item]);
      used = item.w;
    } else {
      row.push(item);
      used += (row.length > 1 ? GAP : 0) + item.w;
    }
  }
  const rowTop = (r: number) => 58 + r * (S + 46);
  const H = rowTop(rows.length - 1) + S + 19 + 16;
  const label = it ? `Diagramma a caselle degli orbitali di ${chemPlain(s.species)}` : `Orbital box diagram of ${chemPlain(s.species)}`;
  const out = svgOpen(W, H, label);
  out.push(T(W / 2, 32, s.species, { fs: 20, anchor: 'middle', weight: 600 }));
  const frames: string[] = [];
  const spins: string[] = [];
  const names: string[] = [];
  rows.forEach((row, r) => {
    const width = row.reduce((a, x) => a + x.w, 0) + GAP * (row.length - 1);
    let x = (W - width) / 2;
    const y = rowTop(r);
    for (const item of row) {
      if (item.core) {
        names.push(T(x + item.w / 2, y + S / 2 + 6.5, item.core, { fs: 18, anchor: 'middle' }));
      } else if (item.sub) {
        const { boxes, electrons } = item.sub;
        const fill = hundFill(boxes, electrons);
        for (let b = 0; b < boxes; b++) {
          frames.push(`<rect x="${f2(x + b * S)}" y="${y}" width="${S}" height="${S}"/>`);
          spins.push(...spinsIn(x + b * S + S / 2, y + S / 2, 21, fill[b]));
        }
        names.push(T(x + item.w / 2, y + S + 19, item.sub.label, { fs: 14, anchor: 'middle', fill: SOFT }));
      }
      x += item.w + GAP;
    }
  });
  out.push(`<g fill="#FFFFFF" stroke="${INK}" stroke-width="1.6">${frames.join('')}</g>`);
  out.push(spinGroup(spins));
  out.push(...names);
  return finish(out);
}

// ---------------------------------------------------------------------------------------------
// 3. Electrochemical cell
// ---------------------------------------------------------------------------------------------

function renderCell(s: CellSpec, it: boolean): string {
  const W = 640;
  const H = 432;
  const wireY = 64;
  const rim = 196;
  const surface = 232;
  const floor = 346;
  const galvanic = s.type === 'galvanic';
  const shared = s.saltBridge === null;
  const anodeLeft = s.left.role === 'anode';
  const dir = anodeLeft ? 1 : -1; // electrons run left to right when the anode is on the left
  const mid = W / 2;
  const word = { anode: it ? 'Anodo' : 'Anode', cathode: it ? 'Catodo' : 'Cathode' };
  const sign = (role: 'anode' | 'cathode') => ((role === 'anode') === galvanic ? MINUS : '+');
  const rods = shared ? [230, 410] : [116, 524];
  const vessels = shared ? [{ x0: 130, x1: 510, tint: '#DBEAFE' }] : [{ x0: 76, x1: 252, tint: '#DBEAFE' }, { x0: 388, x1: 564, tint: '#DCFCE7' }];
  const sides = [s.left, s.right];
  const kind = galvanic ? (it ? 'Cella galvanica' : 'Galvanic cell') : it ? 'Cella elettrolitica' : 'Electrolytic cell';
  const out = svgOpen(W, H, `${kind}: ${chemPlain(s.left.electrode)} (${word[s.left.role]}), ${chemPlain(s.right.electrode)} (${word[s.right.role]})`);

  // Vessels with their solution
  for (const [i, v] of vessels.entries()) {
    const body = `${v.x0} ${rim}V${floor - 10}a10 10 0 0 0 10 10H${v.x1 - 10}a10 10 0 0 0 10 -10V${rim}`;
    out.push(`<path d="M${v.x0} ${surface}V${floor - 10}a10 10 0 0 0 10 10H${v.x1 - 10}a10 10 0 0 0 10 -10V${surface}Z" fill="${v.tint}"/>`);
    out.push(`<path d="M${body}" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>`);
    const sol = shared ? s.left.solution : sides[i].solution;
    out.push(T((v.x0 + v.x1) / 2, floor - 18, sol, { fs: fitFs(sol, 13.5, v.x1 - v.x0 - 24), anchor: 'middle' }));
  }

  // Wire with the voltmeter or the generator in the middle
  const gap = galvanic ? 20 : 7;
  out.push(`<path d="M${rods[0]} ${wireY}H${mid - gap}M${mid + gap} ${wireY}H${rods[1]}" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`);
  if (galvanic) {
    out.push(`<circle cx="${mid}" cy="${wireY}" r="20" fill="#FFFFFF" stroke="${INK}" stroke-width="2"/>`);
    out.push(T(mid, wireY + 6.5, 'V', { fs: 19, anchor: 'middle', weight: 600 }));
    if (s.meter) out.push(T(mid, wireY + 42, s.meter, { fs: 14, anchor: 'middle', weight: 600 }));
  } else {
    const plus = mid - dir * 7;
    const minus = mid + dir * 7;
    out.push(`<path d="M${plus} ${wireY - 16}V${wireY + 16}M${minus} ${wireY - 8}V${wireY + 8}" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`);
    out.push(T(plus, wireY - 22, '+', { fs: 14, anchor: 'middle', weight: 600 }));
    out.push(T(minus, wireY - 22, MINUS, { fs: 14, anchor: 'middle', weight: 600 }));
    out.push(T(mid, wireY + 38, it ? 'Generatore' : 'Generator', { fs: 12.5, anchor: 'middle', fill: MUTED }));
  }
  // Electron flow: from the anode to the cathode, through the meter or from the generator's minus terminal
  for (const [a, b] of [[rods[0], mid - gap], [mid + gap, rods[1]]]) {
    const cx = (a + b) / 2;
    out.push(arrow(cx - dir * 11, wireY, cx + dir * 11, wireY, SOFT, 2, 10));
    out.push(T(cx, wireY - 11, 'e^-', { fs: 13.5, anchor: 'middle', fill: SOFT }));
  }

  // Salt bridge: an inverted U whose legs dip into both solutions
  if (s.saltBridge !== null && !shared) {
    const top = 170;
    const d = `M224 292V${top + 20}Q224 ${top} 244 ${top}H396Q416 ${top} 416 ${top + 20}V292`;
    out.push(`<path d="${d}" fill="none" stroke="${MUTED}" stroke-width="15" stroke-linejoin="round"/>`);
    out.push(`<path d="${d}" fill="none" stroke="#F3F4F6" stroke-width="11" stroke-linejoin="round"/>`);
    const text = `${it ? 'Ponte salino' : 'Salt bridge'} (${s.saltBridge})`;
    out.push(T(mid, top - 14, text, { fs: fitFs(text, 13, 250), anchor: 'middle', fill: SOFT }));
  }

  // Electrodes, their names and the captions under the vessels
  sides.forEach((c, i) => {
    const x = rods[i];
    const left = i === 0;
    out.push(`<rect x="${x - 5}" y="${wireY - 1}" width="10" height="${surface + 74 - wireY}" rx="1.5" fill="#9CA3AF" stroke="#4B5563" stroke-width="1"/>`);
    const room = left ? x - 18 : W - x - 18;
    out.push(T(left ? x - 11 : x + 11, wireY + 5, c.electrode, { fs: fitFs(c.electrode, 14, room), anchor: left ? 'end' : 'start', weight: 600 }));
    const cx = shared ? x : (vessels[i].x0 + vessels[i].x1) / 2;
    const color = c.role === 'anode' ? ACCENT[0] : ACCENT[1];
    const caption = `${word[c.role]} (${sign(c.role)})`;
    out.push(T(cx, floor + 26, caption, { fs: 14, anchor: 'middle', fill: color, weight: 600 }));
    // With one vessel the electrodes are too close for two half-reactions side by side: they go on two centred lines, each
    // in the colour of its electrode's caption.
    if (c.halfReaction && shared) out.push(T(W / 2, floor + 46 + i * 18, c.halfReaction, { fs: fitFs(c.halfReaction, 12.5, 560), anchor: 'middle', fill: color }));
    else if (c.halfReaction) out.push(T(cx, floor + 46, c.halfReaction, { fs: fitFs(c.halfReaction, 12.5, 290), anchor: 'middle', fill: SOFT }));
  });
  return finish(out);
}

// ---------------------------------------------------------------------------------------------
// 4. Periodic table
// ---------------------------------------------------------------------------------------------

const tint = (hex: string, t: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
};

function renderPeriodic(s: PeriodicSpec, it: boolean): string {
  const W = 760;
  const C = 38;
  const horizontal = s.trends.find((t) => t.direction === 'right' || t.direction === 'left');
  const vertical = s.trends.find((t) => t.direction === 'up' || t.direction === 'down');
  const x0 = vertical ? 52 : (W - 18 * C) / 2;
  const y0 = horizontal ? 54 : 16;
  const fTop = y0 + 7 * C + 16;
  const tableBottom = fTop + 2 * C;
  const group = new Map<string, number>();
  s.highlights.forEach((h, i) => h.elements.forEach((sym) => group.set(sym, i)));

  // Legend rows
  const legend: { i: number; x: number; y: number }[] = [];
  let lx = x0;
  let ly = tableBottom + 30;
  s.highlights.forEach((h, i) => {
    const w = 24 + chemWidth(h.label, 13) + 28;
    if (lx > x0 && lx + w > x0 + 18 * C) {
      lx = x0;
      ly += 26;
    }
    legend.push({ i, x: lx, y: ly });
    lx += w;
  });
  const H = ly + 24;
  const label = `${it ? 'Tavola periodica' : 'Periodic table'}: ${s.highlights.map((h) => chemPlain(h.label)).join(', ')}`;
  const out = svgOpen(W, H, label);

  const cells: string[] = [];
  const names: string[] = [];
  for (const e of ELEMENTS) {
    const col = e.group ?? 3 + e.z - (e.fRow === 1 ? 57 : 89);
    const x = x0 + (col - 1) * C;
    const y = e.fRow ? fTop + (e.fRow - 1) * C : y0 + (e.period - 1) * C;
    const g = group.get(e.symbol);
    const color = g === undefined ? null : PALETTE[g];
    cells.push(
      `<rect x="${x + 1}" y="${y + 1}" width="${C - 2}" height="${C - 2}" rx="3" fill="${color ? tint(color, 0.8) : '#FFFFFF'}" stroke="${color ?? RULE}" stroke-width="${color ? 1.6 : 1}"/>`,
    );
    names.push(`<text x="${x + C / 2}" y="${y + C / 2 + 6}" text-anchor="middle" font-size="15" font-weight="${color ? 700 : 500}" fill="${color ? INK : MUTED}">${e.symbol}</text>`);
    names.push(`<text x="${x + 4.5}" y="${y + 11.5}" font-size="8.5" fill="${color ? SOFT : FAINT}">${e.z}</text>`);
  }
  out.push(...cells, ...names);
  // Which rows the f-block stands for
  [it ? 'Lantanidi' : 'Lanthanides', it ? 'Attinidi' : 'Actinides'].forEach((name, r) => {
    out.push(`<text x="${x0 + C}" y="${fTop + r * C + C / 2 - 1}" text-anchor="middle" font-size="9.5" fill="${MUTED}">${name}</text>`);
    out.push(`<text x="${x0 + C}" y="${fTop + r * C + C / 2 + 11}" text-anchor="middle" font-size="9.5" fill="${FAINT}">${r === 0 ? '57–70' : '89–102'}</text>`);
  });

  // Trends
  if (horizontal) {
    const right = horizontal.direction === 'right';
    out.push(arrow(right ? x0 : x0 + 18 * C, 40, right ? x0 + 18 * C : x0, 40, SOFT, 2, 10));
    out.push(T(x0 + 9 * C, 28, horizontal.label, { fs: fitFs(horizontal.label, 14, 18 * C - 20), anchor: 'middle', weight: 600 }));
  }
  if (vertical) {
    const up = vertical.direction === 'up';
    const ay0 = up ? y0 + 7 * C : y0;
    const ay1 = up ? y0 : y0 + 7 * C;
    out.push(arrow(32, ay0, 32, ay1, SOFT, 2, 10));
    out.push(T(16, y0 + 3.5 * C, vertical.label, { fs: fitFs(vertical.label, 14, 7 * C - 20), anchor: 'middle', weight: 600, rotate: -90 }));
  }

  // Legend
  for (const l of legend) {
    out.push(`<rect x="${l.x}" y="${l.y - 12}" width="16" height="16" rx="3" fill="${tint(PALETTE[l.i], 0.8)}" stroke="${PALETTE[l.i]}" stroke-width="1.6"/>`);
    out.push(T(l.x + 24, l.y + 1, s.highlights[l.i].label, { fs: 13 }));
  }
  return finish(out);
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function renderDiagramSvg(kind: DiagramKind, spec: DiagramSpec, language: string): string {
  const checked = validateDiagram(kind, spec);
  if (!checked.ok) throw new Error(`Invalid ${kind} diagram: ${checked.errors.join('; ')}`);
  const it = isItalian(language);
  switch (kind) {
    case 'levels':
      return renderLevels(checked.spec as LevelsSpec, it);
    case 'orbitals':
      return renderOrbitals(checked.spec as OrbitalsSpec, it);
    case 'cell':
      return renderCell(checked.spec as CellSpec, it);
    case 'periodic':
      return renderPeriodic(checked.spec as PeriodicSpec, it);
  }
}
