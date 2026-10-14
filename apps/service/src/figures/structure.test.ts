import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeSvg } from '../repo/assets.ts';
import { nonbondingElectrons, renderStructureSvg, validateStructureSpec, type StructureSpec } from './structure.ts';

const lewis = (smiles: string, lonePairs = true): StructureSpec => ({ smiles, style: 'lewis', lonePairs });
const skeletal = (smiles: string): StructureSpec => ({ smiles, style: 'skeletal', lonePairs: false });
const dots = (svg: string) => (svg.match(/<circle /g) ?? []).length;
const labels = (svg: string) => [...svg.matchAll(/<text [^>]*>([^<]*)(?:<tspan[^>]*>[^<]*<\/tspan>)?<\/text>/g)].map((m) => m[1]);

test('validation rejects specs that cannot be drawn', () => {
  const errors = (spec: unknown) => {
    const r = validateStructureSpec(spec);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.errors.join(' | ');
  };
  assert.match(errors(null), /spec/);
  assert.match(errors('O'), /spec/);
  assert.match(errors({ style: 'lewis', lonePairs: true }), /smiles/);
  assert.match(errors({ smiles: '  ', style: 'lewis', lonePairs: true }), /smiles/);
  assert.match(errors({ smiles: 'C'.repeat(201), style: 'lewis', lonePairs: true }), /200/);
  assert.match(errors({ smiles: 'O', style: 'fancy', lonePairs: true }), /style/);
  assert.match(errors({ smiles: 'C1CC', style: 'lewis', lonePairs: true }), /not a valid SMILES/);
  assert.match(errors({ smiles: 'C'.repeat(61), style: 'skeletal', lonePairs: false }), /61 heavy atoms/);
  assert.match(errors({ smiles: '[Na+].[Cl-].O.O.C', style: 'lewis', lonePairs: false }), /5 separate fragments/);
});

test('a valid spec is accepted and trimmed', () => {
  const r = validateStructureSpec({ smiles: ' O ', style: 'lewis', lonePairs: true, title: 'Water' });
  assert.deepEqual(r, { ok: true, spec: { smiles: 'O', style: 'lewis', lonePairs: true, title: 'Water' } });
  const r2 = validateStructureSpec({ smiles: '[Na+].[Cl-].O.O', style: 'lewis', lonePairs: false });
  assert.equal(r2.ok, true);
});

test('nonbonding electrons follow valence, charge and bonds', () => {
  assert.equal(nonbondingElectrons(8, 0, 2), 4); // water O
  assert.equal(nonbondingElectrons(17, -1, 0), 8); // chloride
  assert.equal(nonbondingElectrons(7, 1, 4), 0); // ammonium N
  assert.equal(nonbondingElectrons(7, 0, 2), 3); // NO: one pair and a lone electron
  assert.equal(nonbondingElectrons(16, 0, 6), 0); // sulfate S
  assert.equal(nonbondingElectrons(1, 0, 1), 0);
  assert.equal(nonbondingElectrons(2, 0, 0), 2);
  assert.equal(nonbondingElectrons(6, 0, 7), 0); // never negative
  for (const [z, ve] of [[3, 1], [9, 7], [10, 8], [18, 8], [20, 2], [31, 3], [36, 8], [38, 2], [53, 7], [54, 8], [56, 2]]) {
    assert.equal(nonbondingElectrons(z, 0, 0), ve, `Z=${z}`);
  }
  assert.equal(nonbondingElectrons(26, 0, 0), null); // transition metals get no dots
});

test('lone pairs are drawn as two dots each', () => {
  assert.equal(dots(renderStructureSvg(lewis('O'))), 4); // water: 2 pairs on O
  assert.equal(dots(renderStructureSvg(lewis('N'))), 2); // ammonia: 1 pair
  assert.equal(dots(renderStructureSvg(lewis('O=C=O'))), 8); // 2 pairs on each O, none on C
  assert.equal(dots(renderStructureSvg(lewis('[Cl-]'))), 8); // chloride: 4 pairs
  assert.equal(dots(renderStructureSvg(lewis('[NH4+]'))), 0);
  assert.equal(dots(renderStructureSvg(lewis('[O-]S(=O)(=O)[O-]'))), 2 * 6 + 2 * 4); // 3 pairs on each O-, 2 on each =O, none on S
  assert.equal(dots(renderStructureSvg(lewis('[N]=O'))), 2 + 1 + 4); // radical N: one pair and one dot; O: 2 pairs
});

test('lone pairs are left out when not asked for and in skeletal style', () => {
  assert.equal(dots(renderStructureSvg(lewis('O', false))), 0);
  assert.equal(dots(renderStructureSvg({ smiles: 'O', style: 'skeletal', lonePairs: true })), 0);
});

test('charges are drawn with a plus or a real minus sign', () => {
  assert.ok(labels(renderStructureSvg(lewis('[NH4+]'))).includes('+'));
  assert.ok(labels(renderStructureSvg(lewis('[Cl-]'))).includes('−'));
  assert.ok(labels(renderStructureSvg(lewis('[Ca+2]'))).includes('2+'));
  assert.ok(labels(renderStructureSvg(lewis('[O-2]'))).includes('2−'));
});

test('lewis style labels every atom including carbon and hydrogen', () => {
  const l = labels(renderStructureSvg(lewis('CC(=O)O')));
  assert.equal(l.filter((s) => s === 'C').length, 2);
  assert.equal(l.filter((s) => s === 'H').length, 4);
});

test('skeletal style hides carbon and hydrogen on a ring', () => {
  const svg = renderStructureSvg(skeletal('c1ccccc1'));
  const l = labels(svg);
  assert.ok(!l.includes('C') && !l.includes('H'), l.join(','));
  assert.equal((svg.match(/<line /g) ?? []).length, 9); // six bonds plus three inner double-bond lines
});

test('skeletal style shows hydrogens on heteroatoms and on a lone carbon', () => {
  assert.ok(labels(renderStructureSvg(skeletal('CCN'))).includes('H'));
  assert.ok(renderStructureSvg(skeletal('CCN')).includes('<tspan'));
  const methane = renderStructureSvg(skeletal('C'));
  assert.ok(methane.includes('>C</text>') && methane.includes('>4</tspan>'));
});

test('every figure passes the SVG safety check', () => {
  const smiles = ['O', 'O=C=O', '[NH4+]', '[O-]S(=O)(=O)[O-]', 'CCO', 'c1ccccc1', 'CC(=O)O', '[Na+].[Cl-]', 'C#N', 'CC(C)(C)c1ccc(cc1)O'];
  for (const s of smiles) {
    for (const style of ['lewis', 'skeletal'] as const) {
      const svg = renderStructureSvg({ smiles: s, style, lonePairs: true, title: 'Tricky <b>"title"</b> & more' });
      assert.doesNotThrow(() => assertSafeSvg(svg), `${style} ${s}`);
      assert.match(svg, /role="img"/);
      assert.ok(!svg.includes('<b>'));
      assert.match(svg, /viewBox="0 0 (\d+) (\d+)" width="\1" height="\2"/);
    }
  }
});

test('a figure is at least 160 px wide and its content stays inside the view box', () => {
  const svg = renderStructureSvg(lewis('O'));
  const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!.map(Number);
  assert.ok(w >= 160 && h > 0);
  const [, tx, ty] = svg.match(/translate\(([\d.-]+) ([\d.-]+)\)/)!.map(Number);
  for (const m of svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)"/g)) {
    assert.ok(+m[1] + tx > 0 && +m[1] + tx < w && +m[2] + ty > 0 && +m[2] + ty < h);
  }
});

test('separate fragments are laid out side by side without overlapping', () => {
  const svg = renderStructureSvg(lewis('CCO.CCO', false));
  const oxygens = [...svg.matchAll(/<text x="([\d.-]+)"[^>]*>O</g)].map((m) => +m[1]);
  assert.equal(oxygens.length, 2);
  assert.ok(Math.abs(oxygens[0] - oxygens[1]) > 3 * 40);
  const ion = renderStructureSvg(lewis('[Na+].[Cl-]'));
  const [na, cl] = [...ion.matchAll(/<text x="([\d.-]+)"[^>]*>(Na|Cl)</g)].map((m) => +m[1]);
  assert.ok(cl - na > 40);
});

test('the same spec always gives the same drawing', () => {
  assert.equal(renderStructureSvg(lewis('CCO')), renderStructureSvg(lewis('CCO')));
});
