import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertSafeSvg } from '../repo/assets.ts';
import { ELEMENTS, parseSpecies, suggestSymbol } from './elements.ts';
import {
  chemPlain,
  chemRuns,
  chemWidth,
  describeDiagram,
  hundFill,
  renderDiagramSvg,
  validateDiagram,
  type CellSpec,
  type DiagramKind,
  type DiagramSpec,
  type LevelsSpec,
  type OrbitalsSpec,
  type PeriodicSpec,
} from './diagram.ts';

// ---- Examples ---------------------------------------------------------------------------------

const o2: LevelsSpec = {
  yLabel: 'Energia',
  columns: [{ label: 'O' }, { label: 'O_2' }, { label: 'O' }],
  levels: [
    { key: 'a', column: 0, energy: 0, label: '2p', boxes: 3, electrons: 4 },
    { key: 'sg', column: 1, energy: -1.6, label: 'σ_2p', boxes: 1, electrons: 2 },
    { key: 'pi', column: 1, energy: -0.9, label: 'π_2p', boxes: 2, electrons: 4 },
    { key: 'pis', column: 1, energy: 0.9, label: 'π*_2p', boxes: 2, electrons: 2 },
    { key: 'sgs', column: 1, energy: 1.6, label: 'σ*_2p', boxes: 1, electrons: 0 },
    { key: 'b', column: 2, energy: 0, label: '2p', boxes: 3, electrons: 4 },
  ],
  links: [
    ...['sg', 'pi', 'pis', 'sgs'].map((to) => ({ from: 'a', to, style: 'dashed' as const, label: null })),
    ...['sg', 'pi', 'pis', 'sgs'].map((to) => ({ from: 'b', to, style: 'dashed' as const, label: null })),
  ],
};

const enthalpy: LevelsSpec = {
  yLabel: 'H',
  columns: [{ label: 'Reagenti' }, { label: 'Prodotti' }],
  levels: [
    { key: 'r', column: 0, energy: 0, label: 'H2(g) + 1/2 O2(g)', boxes: null, electrons: null },
    { key: 'p', column: 1, energy: -286, label: 'H2O(l)', boxes: null, electrons: null },
  ],
  links: [{ from: 'r', to: 'p', style: 'arrow', label: 'ΔH = −286 kJ' }],
};

const hess: LevelsSpec = {
  yLabel: 'H',
  columns: [{ label: null }],
  levels: [
    { key: 'a', column: 0, energy: 0, label: 'C(s) + O2(g)', boxes: null, electrons: null },
    { key: 'b', column: 0, energy: -110.5, label: 'CO(g) + 1/2 O2(g)', boxes: null, electrons: null },
    { key: 'c', column: 0, energy: -393.5, label: 'CO2(g)', boxes: null, electrons: null },
  ],
  links: [
    { from: 'a', to: 'b', style: 'arrow', label: 'ΔH_1 = −110,5 kJ' },
    { from: 'b', to: 'c', style: 'arrow', label: 'ΔH_2 = −283,0 kJ' },
    { from: 'a', to: 'c', style: 'arrow', label: 'ΔH = −393,5 kJ' },
  ],
};

const fe3: OrbitalsSpec = { species: 'Fe3+', core: '[Ar]', subshells: [{ label: '3d', electrons: 5 }] };
const oxygen: OrbitalsSpec = {
  species: 'O',
  core: null,
  subshells: [{ label: '1s', electrons: 2 }, { label: '2s', electrons: 2 }, { label: '2p', electrons: 4 }],
};
const krypton: OrbitalsSpec = {
  species: 'Kr',
  core: null,
  subshells: [
    { label: '1s', electrons: 2 }, { label: '2s', electrons: 2 }, { label: '2p', electrons: 6 }, { label: '3s', electrons: 2 },
    { label: '3p', electrons: 6 }, { label: '3d', electrons: 10 }, { label: '4s', electrons: 2 }, { label: '4p', electrons: 6 },
  ],
};
const copper: OrbitalsSpec = { species: 'Cu', core: '[Ar]', subshells: [{ label: '3d', electrons: 10 }, { label: '4s', electrons: 1 }] };

const daniell: CellSpec = {
  type: 'galvanic',
  left: { electrode: 'Zn', solution: 'ZnSO4 1 M', role: 'anode', halfReaction: 'Zn -> Zn2+ + 2e-' },
  right: { electrode: 'Cu', solution: 'CuSO4 1 M', role: 'cathode', halfReaction: 'Cu2+ + 2e- → Cu' },
  saltBridge: 'KNO3',
  meter: '1,10 V',
};
const nacl: CellSpec = {
  type: 'electrolytic',
  left: { electrode: 'C (grafite)', solution: 'NaCl fuso', role: 'anode', halfReaction: '2 Cl- -> Cl2 + 2e-' },
  right: { electrode: 'Fe', solution: 'NaCl fuso', role: 'cathode', halfReaction: 'Na+ + e- -> Na' },
  saltBridge: null,
  meter: null,
};

const alkali: PeriodicSpec = {
  highlights: [
    { elements: ['Li', 'Na', 'K', 'Rb', 'Cs', 'Fr'], label: 'Metalli alcalini' },
    { elements: ['F', 'Cl', 'Br', 'I', 'At'], label: 'Alogeni' },
  ],
  trends: [{ direction: 'right', label: 'Energia di ionizzazione' }, { direction: 'down', label: 'Raggio atomico' }],
};

const examples: [string, DiagramKind, DiagramSpec, string][] = [
  ['o2-mo', 'levels', o2, 'it'],
  ['enthalpy', 'levels', enthalpy, 'it'],
  ['hess', 'levels', hess, 'it'],
  ['fe3', 'orbitals', fe3, 'it'],
  ['oxygen', 'orbitals', oxygen, 'it'],
  ['krypton', 'orbitals', krypton, 'en'],
  ['copper', 'orbitals', copper, 'en'],
  ['daniell', 'cell', daniell, 'it'],
  ['daniell-en', 'cell', daniell, 'en'],
  ['nacl', 'cell', nacl, 'it'],
  ['alkali', 'periodic', alkali, 'it'],
];

const render = (kind: DiagramKind, spec: DiagramSpec, lang = 'it') => renderDiagramSvg(kind, spec, lang);
const errors = (kind: DiagramKind, spec: unknown) => {
  const r = validateDiagram(kind, spec);
  assert.equal(r.ok, false, 'expected the diagram to be rejected');
  return r.ok ? [] : r.errors;
};
const textOf = (svg: string) => [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
const with_ = <T extends object>(base: T, patch: Partial<T> | Record<string, unknown>): T => ({ ...base, ...patch }) as T;

// Set DIAGRAM_OUT=/some/dir to write the example SVGs for a visual check.
test('example figures render as safe SVG (and are written out for review when DIAGRAM_OUT is set)', () => {
  const dir = process.env.DIAGRAM_OUT;
  if (dir) mkdirSync(dir, { recursive: true });
  for (const [name, kind, spec, lang] of examples) {
    const checked = validateDiagram(kind, spec);
    assert.equal(checked.ok, true, `${name}: ${checked.ok ? '' : checked.errors.join('; ')}`);
    const svg = render(kind, spec, lang);
    assertSafeSvg(svg);
    assert.match(svg, /^<svg [^>]*role="img" aria-label="[^"]+"[^>]*font-family="system-ui/);
    assert.match(svg, /<title>[^<]+<\/title>\n<rect width="\d+" height="\d+" fill="#FFFFFF"\/>/);
    assert.equal(render(kind, spec, lang), svg, `${name}: rendering must be deterministic`);
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
    if (dir) writeFileSync(`${dir}/${name}.svg`, svg);
  }
});

// ---- Chemistry text markup --------------------------------------------------------------------

const marked = (text: string) => chemRuns(text).map((r) => (r.kind === 'n' ? r.text : r.kind === 'sub' ? `[${r.text}]` : `{${r.text}}`)).join('');

test('chemistry markup: automatic formatting of formulas and ions', () => {
  assert.equal(marked('H2O'), 'H[2]O');
  assert.equal(marked('Ca(OH)2'), 'Ca(OH)[2]');
  assert.equal(marked('ZnSO4'), 'ZnSO[4]');
  assert.equal(marked('Zn2+'), 'Zn{2+}');
  assert.equal(marked('Fe3+'), 'Fe{3+}');
  assert.equal(marked('Cl-'), 'Cl{−}');
  assert.equal(marked('Na+'), 'Na{+}');
  assert.equal(marked('NH4+'), 'NH[4]{+}');
  assert.equal(marked('SO42-'), 'SO[4]{2−}');
  assert.equal(marked('2 Cl- -> Cl2 + 2e-'), '2 Cl{−} → Cl[2] + 2e{−}');
  assert.equal(marked('Zn -> Zn2+ + 2e-'), 'Zn → Zn{2+} + 2e{−}');
  assert.equal(marked('[Cu(NH3)4]2+'), '[Cu(NH[3])[4]]{2+}');
  assert.equal(marked('ΔH = -286 kJ'), 'ΔH = −286 kJ');
});

test('chemistry markup: a group in parentheses after _ or ^ keeps its parentheses', () => {
  assert.deepEqual(chemRuns('S_(g)'), [{ text: 'S', kind: 'n' }, { text: '(g)', kind: 'sub' }]);
  assert.equal(chemPlain('S_(l)'), 'S(l)');
});

test('chemistry markup: explicit _ and ^', () => {
  assert.equal(marked('H_2O'), 'H[2]O');
  assert.equal(marked('σ*_2p'), 'σ{*}[2p]');
  assert.equal(marked('Zn^2+'), 'Zn{2+}');
  assert.equal(marked('SO_4^2-'), 'SO[4]{2−}');
  assert.equal(marked('MnO_4^-'), 'MnO[4]{−}');
  assert.equal(marked('S^{2-}'), 'S{2−}');
  assert.equal(marked('K_{sp}'), 'K[sp]');
  assert.equal(marked('K_sp'), 'K[sp]');
  assert.equal(marked('e^-'), 'e{−}');
  assert.equal(marked('x^2'), 'x{2}');
  assert.equal(marked('10^-3'), '10{−3}');
  assert.equal(marked('a_ b'), 'a_ b'); // a stray underscore stays text
  assert.equal(chemPlain('SO_4^2- e H2O'), 'SO42− e H2O');
});

test('chemistry markup leaves digits that start a token alone', () => {
  for (const text of ['1s', '2p', '3d5', '4s2', '1 M', '1,10 V', '0,76 V', 'sp3', '[Ar]3d5', 'T = 298 K', 'pH 7']) assert.equal(marked(text), text);
  assert.equal(marked('1s'), '1s');
  assert.equal(marked('2p'), '2p');
  assert.equal(marked('3d5'), '3d5');
  assert.equal(marked('1 M'), '1 M');
  assert.equal(marked('1,10 V'), '1,10 V');
  assert.equal(marked('sp3'), 'sp3');
  assert.equal(marked('[Ar]3d5'), '[Ar]3d5');
  assert.equal(marked('2 H2O'), '2 H[2]O');
  assert.equal(marked('Acido-base'), 'Acido-base');
  assert.equal(marked('e-mail'), 'e-mail');
});

test('the markup reaches the SVG as tspans', () => {
  const svg = render('levels', enthalpy);
  assert.match(svg, /H<tspan dy="[\d.]+" font-size="[\d.]+">2<\/tspan><tspan dy="-?[\d.]+">/);
  assert.ok(textOf(svg).includes('ΔH = −286 kJ'));
});

// ---- Elements ---------------------------------------------------------------------------------

test('the element table is complete and consistent', () => {
  assert.equal(ELEMENTS.length, 118);
  assert.equal(new Set(ELEMENTS.map((e) => e.symbol)).size, 118);
  const place = new Set(ELEMENTS.map((e) => (e.group ? `${e.period}/${e.group}` : `f${e.fRow}/${e.z}`)));
  assert.equal(place.size, 118, 'no two elements share a cell');
  const at = (sym: string) => ELEMENTS.find((e) => e.symbol === sym)!;
  assert.deepEqual([at('H').period, at('H').group, at('He').group], [1, 1, 18]);
  assert.deepEqual([at('Fe').period, at('Fe').group], [4, 8]);
  assert.deepEqual([at('Br').period, at('Br').group], [4, 17]);
  assert.deepEqual([at('Cs').period, at('Cs').group], [6, 1]);
  assert.deepEqual([at('Lu').period, at('Lu').group], [6, 3]);
  assert.deepEqual([at('Og').period, at('Og').group], [7, 18]);
  assert.deepEqual([at('La').group, at('La').fRow, at('Yb').fRow, at('Ac').fRow, at('No').fRow], [null, 1, 1, 2, 2]);
  assert.equal(at('Lr').group, 3);
});

test('species are parsed with their charge', () => {
  assert.deepEqual(parseSpecies('O'), { symbol: 'O', z: 8, charge: 0 });
  assert.deepEqual(parseSpecies('Fe3+'), { symbol: 'Fe', z: 26, charge: 3 });
  assert.deepEqual(parseSpecies('Fe^3+'), { symbol: 'Fe', z: 26, charge: 3 });
  assert.deepEqual(parseSpecies('Fe^{3+}'), { symbol: 'Fe', z: 26, charge: 3 });
  assert.deepEqual(parseSpecies('Cl-'), { symbol: 'Cl', z: 17, charge: -1 });
  assert.deepEqual(parseSpecies('Cu^2+'), { symbol: 'Cu', z: 29, charge: 2 });
  assert.deepEqual(parseSpecies('O2-'), { symbol: 'O', z: 8, charge: -2 });
  assert.deepEqual(parseSpecies('S^2−'), { symbol: 'S', z: 16, charge: -2 });
  assert.deepEqual(parseSpecies('Na+'), { symbol: 'Na', z: 11, charge: 1 });
  for (const bad of ['', 'Xx', 'fe', 'NA', 'H2O', 'Fe3', 'Fe 3+']) assert.equal(parseSpecies(bad), null, bad);
  assert.equal(suggestSymbol('NA'), 'Na');
  assert.equal(suggestSymbol('xx'), undefined);
});

test('Hund fill: an up arrow in each box first, then the down arrows', () => {
  const arrows = (b: number, e: number) => hundFill(b, e).map((x) => (x.up ? '^' : '') + (x.down ? 'v' : '') || '-').join(' ');
  assert.equal(arrows(3, 4), '^v ^ ^');
  assert.equal(arrows(5, 5), '^ ^ ^ ^ ^');
  assert.equal(arrows(5, 7), '^v ^v ^ ^ ^');
  assert.equal(arrows(3, 0), '- - -');
  assert.equal(arrows(1, 2), '^v');
});

// ---- 1. Energy levels -------------------------------------------------------------------------

test('levels: the O2 MO diagram has every label, 8 electrons in the molecule and dashed links', () => {
  const svg = render('levels', o2);
  const t = textOf(svg);
  for (const label of ['Energia', 'O', 'O2', '2p', 'σ2p', 'π2p', 'π*2p', 'σ*2p']) assert.ok(t.includes(label), label);
  assert.equal((svg.match(/stroke-dasharray="5 4"/g) ?? []).length, 1);
  // 4 + 4 electrons in the atoms and 2 + 4 + 2 in the molecule: 16 half-headed arrows, one path each
  assert.equal((svg.match(/<path d="[^"]*Z" fill="currentColor"/g) ?? []).length, 16);
  assert.equal(describeDiagram('levels', o2), 'Energy-level diagram with 6 levels in 3 columns, 8 links, 16 electrons drawn.');
});

test('levels: the enthalpy diagram draws a ΔH arrow with its label', () => {
  const svg = render('levels', enthalpy);
  const t = textOf(svg);
  for (const label of ['H', 'Reagenti', 'Prodotti', 'H2(g) + 1/2 O2(g)', 'H2O(l)', 'ΔH = −286 kJ']) assert.ok(t.includes(label), label);
  assert.match(svg, /<polygon points=/);
});

test('levels: a Hess cycle puts three levels and three arrows in one column', () => {
  const svg = render('levels', hess);
  const t = textOf(svg);
  for (const label of ['C(s) + O2(g)', 'CO(g) + 1/2 O2(g)', 'CO2(g)', 'ΔH1 = −110,5 kJ', 'ΔH2 = −283,0 kJ', 'ΔH = −393,5 kJ']) assert.ok(t.includes(label), label);
  assert.equal((svg.match(/<polygon points=/g) ?? []).length, 3 + 1, 'three arrowheads and the axis head');
});

test('levels: validation rules', () => {
  const lv = (i: number, patch: object) => o2.levels.map((l, k) => (k === i ? { ...l, ...patch } : l));
  const bad = (patch: object) => errors('levels', with_(o2, patch)).join(' | ');
  assert.match(bad({ levels: lv(1, { key: 'a' }) }), /levels\.1\.key: "a" is already the key of levels\.0/);
  assert.match(bad({ levels: lv(1, { column: 3 }) }), /levels\.1\.column: 3 is out of range.*0 to 2/);
  assert.match(bad({ levels: lv(1, { electrons: 3 }) }), /levels\.1\.electrons: 3 electrons do not fit in 1 box/);
  assert.match(bad({ levels: lv(1, { boxes: 8 }) }), /levels\.1\.boxes/);
  assert.match(bad({ levels: lv(1, { label: ' ' }) }), /levels\.1\.label: must not be empty/);
  assert.match(bad({ links: [{ from: 'a', to: 'zz', style: 'dashed', label: null }] }), /links\.0\.to: "zz" is not the key of any level/);
  assert.match(bad({ links: [{ from: 'a', to: 'a', style: 'arrow', label: null }] }), /links\.0: a link cannot join a level to itself/);
  assert.match(bad({ links: [{ from: 'sg', to: 'pi', style: 'dashed', label: null }] }), /links\.0: a dashed link must join levels of different columns/);
  assert.match(bad({ columns: [] }), /columns: has 0 columns/);
  assert.match(bad({ columns: Array.from({ length: 5 }, () => ({ label: null })) }), /columns: has 5 columns/);
  assert.match(bad({ levels: [] }), /levels: has 0 levels/);
  assert.match(bad({ levels: lv(3, { energy: -1.5 }) }), /levels\.1 and levels\.3 are too close in column 1 \(energies -1\.6 and -1\.5\)/);
  assert.match(bad({ links: [{ from: 'a', to: 'sg', style: 'solid', label: null }] }), /links\.0\.style/);
  assert.match(errors('levels', { yLabel: null }).join(' | '), /columns/);
  assert.match(errors('levels', 'nope').join(' | '), /diagram/);
});

test('levels: fields left out count as null, and levels need room in their column', () => {
  const sparse = {
    yLabel: 'Energia',
    columns: [{}],
    levels: [{ key: 'a', column: 0, energy: 0, label: 'A' }, { key: 'b', column: 0, energy: 0.07, label: 'B' }, { key: 'c', column: 0, energy: 10, label: 'C' }],
    links: [],
  };
  assert.match(errors('levels', sparse).join(' | '), /too close in column 0/);
  const ok = validateDiagram('levels', { yLabel: 'H', columns: [{}], levels: [{ key: 'a', column: 0, energy: 0, label: 'A' }, { key: 'b', column: 0, energy: 1, label: 'B' }], links: [] });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && (ok.spec as LevelsSpec).columns[0].label, null);
});

test('levels: an arrow label is never dropped, even with one column and no free spot', () => {
  const one: LevelsSpec = { yLabel: 'Energia', columns: [{ label: null }],
    levels: [{ key: 'r', column: 0, energy: 0, label: 'CH4 + 2 O2', boxes: null, electrons: null }, { key: 'p', column: 0, energy: -890, label: 'CO2 + 2 H2O', boxes: null, electrons: null }],
    links: [{ from: 'r', to: 'p', style: 'arrow', label: 'ΔH < 0 (fortemente esotermica)' }] };
  assert.ok(textOf(render('levels', one)).includes('ΔH &lt; 0 (fortemente esotermica)'));
});

test('levels: the vertical axis must name an energy, so a conversion scheme is refused', () => {
  const scheme = {
    yLabel: null, columns: [{ label: 'Massa (g)' }, { label: 'Moli (mol)' }],
    levels: [{ key: 'm', column: 0, energy: 0, label: 'm', boxes: null, electrons: null }, { key: 'n', column: 1, energy: 0, label: 'n', boxes: null, electrons: null }],
    links: [{ from: 'm', to: 'n', style: 'arrow', label: 'n = m/M' }],
  };
  assert.match(errors('levels', scheme).join(' | '), /yLabel: name the energy on the vertical axis/);
  assert.match(errors('levels', { ...scheme, yLabel: '  ' }).join(' | '), /yLabel: name the energy/);
});

test('levels: a long arrow label shrinks to stay inside the figure', () => {
  const svg = render('levels', with_(enthalpy, { links: [{ ...enthalpy.links[0], label: 'ΔH < 0 (fortemente esotermica, -890 kJ)' }] }));
  const m = /<text x="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*text-anchor="start"[^>]*font-weight="600"[^>]*>ΔH &lt; 0/.exec(svg) ?? /<text x="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>ΔH &lt; 0/.exec(svg);
  assert.ok(m, 'the label is drawn');
  const [x, fs] = [Number(m[1]), Number(m[2])];
  assert.ok(fs < 12.5);
  assert.ok(x + chemWidth('ΔH < 0 (fortemente esotermica, -890 kJ)', fs) * 1.1 <= 640, 'inside the 640 px width');
});

// ---- 2. Orbital boxes -------------------------------------------------------------------------

test('orbitals: Fe3+ shows [Ar] and five parallel arrows in 3d', () => {
  const svg = render('orbitals', fe3);
  const t = textOf(svg);
  assert.deepEqual(t, ['Fe3+', '[Ar]', '3d']);
  assert.equal((svg.match(/<rect x=/g) ?? []).length, 5);
  assert.equal((svg.match(/Z" fill="currentColor"/g) ?? []).length, 5);
  assert.equal(describeDiagram('orbitals', fe3), 'Orbital boxes for Fe3+: 23 electrons, as the species has.');
});

test('orbitals: the full configuration of oxygen, krypton wrapped in two rows, a promoted state', () => {
  const o = render('orbitals', oxygen);
  assert.deepEqual(textOf(o), ['O', '1s', '2s', '2p']);
  assert.equal((o.match(/<rect x=/g) ?? []).length, 5);
  assert.equal((o.match(/Z" fill="currentColor"/g) ?? []).length, 8);
  const kr = render('orbitals', krypton, 'en');
  assert.equal((kr.match(/<rect x=/g) ?? []).length, 18);
  assert.match(kr, /viewBox="0 0 640 (1\d\d|2\d\d)"/);
  const rows = new Set([...kr.matchAll(/<rect x="[\d.]+" y="(\d+)"/g)].map((m) => m[1]));
  assert.equal(rows.size, 2, 'wraps into two rows');
  const carbon = validateDiagram('orbitals', { species: 'C', core: '[He]', subshells: [{ label: '2s', electrons: 1 }, { label: '2p', electrons: 3 }] });
  assert.equal(carbon.ok, true, 'promoted states are allowed');
});

test('orbitals: validation rules', () => {
  const bad = (patch: object) => errors('orbitals', with_(fe3, patch)).join(' | ');
  assert.match(bad({ species: 'Xx' }), /species: "Xx" is not an element symbol/);
  assert.match(bad({ core: '[Ar' }), /core: "\[Ar" must be one of \[He\]/);
  assert.match(bad({ core: 'Ar' }), /core/);
  assert.match(bad({ subshells: [{ label: '3d', electrons: 6 }] }), /species: Fe3\+ has 23 electrons but the diagram shows 24/);
  assert.match(bad({ subshells: [{ label: '3d', electrons: 11 }] }), /subshells\.0\.electrons: 11 electrons do not fit in 3d \(0 to 10\)/);
  assert.match(bad({ subshells: [{ label: '1p', electrons: 1 }] }), /subshells\.0\.label: "1p" does not exist/);
  assert.match(bad({ subshells: [{ label: '2d', electrons: 1 }] }), /does not exist/);
  assert.match(bad({ subshells: [{ label: '3f', electrons: 1 }] }), /does not exist/);
  assert.match(bad({ subshells: [{ label: 'd3', electrons: 1 }] }), /subshells\.0\.label: "d3" must be a shell number/);
  assert.match(bad({ subshells: [{ label: '3d', electrons: 3 }, { label: '3d', electrons: 2 }] }), /subshells\.1\.label: "3d" is listed twice/);
  assert.match(bad({ subshells: [], core: null }), /subshells: needs at least one subshell/);
  assert.match(errors('orbitals', { core: null, subshells: [] }).join(' | '), /species/);
});

// ---- 3. Electrochemical cell ------------------------------------------------------------------

test('cell: the Daniell cell has two beakers, a salt bridge, a voltmeter and the Italian captions', () => {
  const svg = render('cell', daniell);
  const t = textOf(svg);
  for (const label of ['Anodo (−)', 'Catodo (+)', 'Ponte salino (KNO3)', '1,10 V', 'V', 'Zn', 'Cu', 'ZnSO4 1 M', 'CuSO4 1 M', 'Zn → Zn2+ + 2e−', 'Cu2+ + 2e− → Cu']) assert.ok(t.includes(label), label);
  assert.equal(t.filter((x) => x === 'e−').length, 2);
  assert.equal((svg.match(/<circle /g) ?? []).length, 1);
  const en = textOf(render('cell', daniell, 'en'));
  for (const label of ['Anode (−)', 'Cathode (+)', 'Salt bridge (KNO3)']) assert.ok(en.includes(label), label);
  assert.equal(describeDiagram('cell', daniell), 'Galvanic cell with Zn as the anode (left) and Cu as the cathode (right), salt bridge KNO3, voltmeter reading 1,10 V.');
});

test('cell: electrolysis of molten NaCl uses one vessel and a generator; the generator polarity follows the anode', () => {
  const svg = render('cell', nacl);
  const t = textOf(svg);
  for (const label of ['Anodo (+)', 'Catodo (−)', 'Generatore', 'NaCl fuso', 'C (grafite)', 'Fe', '2 Cl− → Cl2 + 2e−', 'Na+ + e− → Na']) assert.ok(t.includes(label), label);
  assert.equal(t.filter((x) => x === 'NaCl fuso').length, 1, 'one shared vessel');
  assert.equal((svg.match(/<circle /g) ?? []).length, 0);
  assert.ok(!t.includes('V'));
  const mirrored = render('cell', with_(nacl, { left: nacl.right, right: nacl.left }));
  assert.notEqual(mirrored, svg);
  assert.match(describeDiagram('cell', nacl), /^Electrolytic cell .* one shared vessel\.$/);
  const twoVessels = textOf(render('cell', with_(nacl, { saltBridge: 'KNO3', right: { ...nacl.right, solution: 'NaCl' } })));
  assert.ok(twoVessels.includes('Ponte salino (KNO3)') && twoVessels.includes('Generatore'));
});

test('cell: a galvanic cell without a salt bridge has one shared vessel, like a lead-acid battery', () => {
  const lead: CellSpec = { type: 'galvanic', saltBridge: null, meter: '2,0 V',
    left: { electrode: 'Pb', solution: 'H2SO4', role: 'anode', halfReaction: 'Pb + SO4^2- -> PbSO4 + 2e^-' },
    right: { electrode: 'PbO2', solution: 'H2SO4', role: 'cathode', halfReaction: null } };
  const t = textOf(render('cell', lead));
  assert.ok(t.includes('Anodo (−)') && t.includes('Catodo (+)') && t.includes('V'));
  assert.ok(!t.some((x) => x.startsWith('Ponte salino')));
  assert.match(describeDiagram('cell', lead), /one shared vessel/);
});

test('cell: validation rules', () => {
  const bad = (patch: object) => errors('cell', with_(daniell, patch)).join(' | ');
  assert.match(bad({ right: { ...daniell.right, role: 'anode' } }), /right\.role: left and right are both "anode"/);
  assert.match(bad({ left: { ...daniell.left, role: 'cathode' } }), /both "cathode"/);
  assert.match(bad({ type: 'electrolytic' }), /meter: only a galvanic cell has a voltmeter/);
  assert.match(bad({ type: 'sideways' }), /type/);
  assert.match(bad({ left: { ...daniell.left, electrode: '' } }), /left\.electrode: must not be empty/);
  assert.match(bad({ left: { ...daniell.left, halfReaction: 'x'.repeat(81) } }), /left\.halfReaction: is 81 characters/);
  assert.match(errors('cell', { type: 'galvanic' }).join(' | '), /left/);
});

// ---- 4. Periodic table ------------------------------------------------------------------------

test('periodic: alkali metals and halogens with an ionization energy trend', () => {
  const svg = render('periodic', alkali);
  const t = textOf(svg);
  for (const label of ['Metalli alcalini', 'Alogeni', 'Energia di ionizzazione', 'Raggio atomico', 'Lantanidi', 'Attinidi', 'Og', 'Fr', 'Lu']) assert.ok(t.includes(label), label);
  assert.equal((svg.match(/<rect x="\d+" y="\d+" width="36" height="36"/g) ?? []).length, 118);
  assert.equal((svg.match(/stroke="#C2410C"/g) ?? []).length, 6 + 1, 'six alkali metals and the legend swatch');
  assert.match(svg, /viewBox="0 0 760 \d+"/);
  assert.equal(describeDiagram('periodic', alkali), 'Periodic table with 2 highlighted groups (11 elements) and 2 trend arrows.');
  assert.ok(textOf(render('periodic', alkali, 'en')).includes('Lanthanides'));
});

test('periodic: validation rules', () => {
  const bad = (patch: object) => errors('periodic', with_(alkali, patch)).join(' | ');
  assert.match(bad({ highlights: [{ elements: ['NA'], label: 'x' }] }), /highlights\.0\.elements\.0: "NA" is not an element symbol; did you mean "Na"\?/);
  assert.match(bad({ highlights: [{ elements: ['Xx'], label: 'x' }] }), /"Xx" is not an element symbol$/);
  assert.match(bad({ highlights: [{ elements: ['Na'], label: 'a' }, { elements: ['K', 'Na'], label: 'b' }] }), /highlights\.1\.elements\.1: "Na" is already in highlights\.0/);
  assert.match(bad({ highlights: [{ elements: ['Na', 'Na'], label: 'a' }] }), /already in highlights\.0/);
  assert.match(bad({ highlights: [] }), /highlights: has 0 groups/);
  assert.match(bad({ highlights: Array.from({ length: 6 }, (_, i) => ({ elements: [ELEMENTS[i].symbol], label: 'g' })) }), /highlights: has 6 groups/);
  assert.match(bad({ highlights: [{ elements: [], label: 'a' }] }), /elements: must list at least one/);
  assert.match(bad({ highlights: [{ elements: ['Na'], label: '' }] }), /label: must not be empty/);
  const t = (direction: string) => ({ direction, label: 'x' });
  assert.match(bad({ trends: [t('right'), t('left')] }), /trends: has two horizontal arrows/);
  assert.match(bad({ trends: [t('up'), t('down')] }), /trends: has two vertical arrows/);
  assert.match(bad({ trends: [t('up'), t('right'), t('down')] }), /trends: has 3 arrows/);
  assert.match(bad({ trends: [t('diagonal')] }), /trends\.0\.direction/);
  assert.equal(validateDiagram('periodic', with_(alkali, { trends: [] })).ok, true);
});

test('rendering an invalid diagram throws with the reasons', () => {
  assert.throws(() => render('periodic', with_(alkali, { highlights: [] })), /Invalid periodic diagram: highlights: has 0 groups/);
});
