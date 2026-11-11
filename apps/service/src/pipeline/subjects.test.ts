// Subject areas: inference, the profile table, and what the prompts and schemas built from it contain.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ALLOWED_FUNCTIONS, validatePlotSpec } from '@smartbuilder/content';
import { bookOptionsSchema, FIGURE_KINDS, inferSubjectArea, SUBJECT_AREAS, SUBJECT_PROFILES, subjectAreaOf, type SubjectArea } from '@smartbuilder/domain';
import { figureSchema, figureSchemaFor } from '../figures/materialize.ts';
import { toProviderSchema } from '../llm/schema.ts';
import { figurePlaces } from './figureCheck.ts';
import { draftPrompt, draftMetaSchemaFor, figureCheckPrompt, figureRules, graphPrompt, figureSetupOf, outlinePrompt, patchParser, patchPrompt, reviewPrompt, verifyPrompt } from './prompts.ts';

const book = (subject: string, title: string, options: Record<string, unknown> = {}) => ({ subject, title, options: bookOptionsSchema.parse(options) });
const setupOf = (area: SubjectArea, o: { photos?: boolean; policy?: 'helpful' | 'generous' } = {}) =>
  figureSetupOf(book('x', 'x', { subjectArea: area, figurePolicy: o.policy ?? 'helpful' }), o.photos ?? false);
const MOLECULE = /smiles|molecule|\bcell\b|salt bridge|orbital|periodic table|electrochemical/i;

describe('subject area inference', () => {
  const cases: [string, string, SubjectArea][] = [
    ['Analisi 1', 'Analisi Matematica 1', 'mathematics'],
    ['Fisica 1', 'Fisica 1', 'physics'],
    ['Chimica', 'Chimica di base', 'chemistry'],
    ['Algebra e Geometria', 'Calcolo Numerico (MATLAB)', 'mathematics'],
    ['Algebra e Geometria', 'Algebra Lineare e Geometria', 'mathematics'],
    ['Elettrotecnica', 'Elettrotecnica', 'electronics'],
    ['Elettronica digitale', 'Reti logiche', 'electronics'],
    ['Informatica', 'Fondamenti di informatica', 'computer-science'],
    ['Algoritmi e strutture dati', 'Algoritmi', 'computer-science'],
    ['Meccanica applicata', 'Meccanica', 'mechanics'],
    ['Meccanica quantistica', 'Meccanica quantistica', 'physics'],
    ['Chimica fisica', 'Chimica fisica', 'chemistry'],
    ['Calculus', 'Calculus I', 'mathematics'],
    ['Storia dell’arte', 'Storia dell’arte', 'other'],
  ];
  for (const [subject, title, area] of cases) test(`${subject} / ${title} is ${area}`, () => assert.equal(inferSubjectArea(subject, title), area));

  test('accents and case do not matter, and the same input always gives the same area', () => {
    assert.equal(inferSubjectArea('PROBABILITÀ E STATISTICA'), 'mathematics');
    assert.equal(inferSubjectArea('probabilita e statistica'), 'mathematics');
  });

  test('the area set in the options wins over the inferred one', () => {
    assert.equal(subjectAreaOf(book('Chimica', 'Chimica di base')), 'chemistry');
    assert.equal(subjectAreaOf(book('Chimica', 'Chimica di base', { subjectArea: 'other' })), 'other');
  });

  test('every area has a profile with plot, only known kinds, and text for each prompt', () => {
    assert.deepEqual([...SUBJECT_AREAS].sort(), Object.keys(SUBJECT_PROFILES).sort());
    for (const area of SUBJECT_AREAS) {
      const p = SUBJECT_PROFILES[area];
      assert.ok(p.figureKinds.includes('plot'), area);
      assert.ok(p.figureKinds.includes('drawing'), `${area} offers drawings`);
      assert.ok(p.figureKinds.every((k) => FIGURE_KINDS.includes(k)), area);
      for (const text of [p.notation, p.hypotheses, p.excluded, p.plotExamples, p.photoExamples]) assert.ok(text.length > 10, area);
    }
    assert.deepEqual([...SUBJECT_PROFILES.chemistry.figureKinds].sort(), [...FIGURE_KINDS].sort(), 'chemistry keeps every kind it has today');
  });

  test('Book setup offers circuit symbols for electronics and physics only', () => {
    assert.deepEqual(SUBJECT_AREAS.filter((a) => SUBJECT_PROFILES[a].hasCircuits), ['physics', 'electronics']);
  });

  test('options of an existing book parse with the new defaults and no area', () => {
    const o = bookOptionsSchema.parse({ outsideMaterial: false, ide: false, graphs: true, figures: true, chapterScope: [] });
    assert.equal(o.subjectArea, undefined);
    assert.equal(o.figurePolicy, 'helpful');
    assert.equal(o.circuitSymbols, 'american');
    assert.equal(o.figures, true);
  });
});

describe('figure rules per subject', () => {
  test('a mathematics book gets the plot block and no molecule, cell or periodic table text', () => {
    const rules = figureRules(setupOf('mathematics'));
    assert.match(rules, /- plot:/);
    assert.doesNotMatch(rules, MOLECULE);
    assert.doesNotMatch(rules, /- (structure|levels|orbitals|cell|periodic|photo):/);
    assert.doesNotMatch(rules, /titration|heating curve/);
  });

  test('the plot block explains log axes, the Bode pair and gives the low-pass example', () => {
    const rules = figureRules(setupOf('electronics'));
    assert.match(rules, /"xScale" or "yScale" set to "log"/);
    assert.match(rules, /needs a positive range/);
    assert.match(rules, /A Bode plot is two plot figures, magnitude and then phase, with the same xScale "log" and xRange/);
    assert.match(rules, /-10\*log10\(1\+\(x\/1000\)\^2\)/);
  });

  test('the graph prompt offers log axes and a pair for a Bode plot', () => {
    const { system, prompt } = graphPrompt({ language: 'it', purpose: 'Bode', section: 'testo' });
    assert.match(system, /"xScale" or "yScale" set to "log"/);
    assert.match(system, /A Bode plot is two graphs that share one log frequency axis/);
    assert.match(prompt, /xScale, yScale, xLabel, yLabel, pair/);
  });

  test('a chemistry book gets every chemistry kind, and photos only when they can be searched', () => {
    const rules = figureRules(setupOf('chemistry'));
    for (const kind of ['plot', 'structure', 'levels', 'orbitals', 'cell', 'periodic']) assert.match(rules, new RegExp(`- ${kind}:`));
    assert.match(rules, /SMILES/);
    assert.doesNotMatch(rules, /- photo:/);
    assert.match(figureRules(setupOf('chemistry', { photos: true })), /- photo:.*flame test/);
    assert.match(figureRules(setupOf('physics', { photos: true })), /- photo:.*experimental apparatus/);
    assert.doesNotMatch(figureRules(setupOf('mathematics', { photos: true })), /- photo:/, 'mathematics has no photo kind');
  });

  test('the helpful policy does not push: no quota, no reason for an empty list, no cap of one', () => {
    for (const area of SUBJECT_AREAS) {
      const rules = figureRules(setupOf(area));
      assert.match(rules, /A section with nothing to show gets no figure/);
      assert.doesNotMatch(rules, /Most sections|Find those places|noFigureReason|why no kind/);
      assert.doesNotMatch(rules, /at most one|at most 1 per section/i);
      assert.match(rules, /Never add a decorative figure/);
    }
  });

  test('the generous policy keeps the wording that most sections have a place for a figure, and still bans decoration', () => {
    const rules = figureRules(setupOf('physics', { policy: 'generous' }));
    assert.match(rules, /Most sections have at least one place where a figure shows something faster than words/);
    assert.match(rules, /Never add a decorative figure/);
    assert.doesNotMatch(rules, /noFigureReason/);
  });

  test('the plot block lists every function the evaluator allows', () => {
    const rules = figureRules(setupOf('electronics'));
    for (const fn of ALLOWED_FUNCTIONS) assert.match(rules, new RegExp(`\\b${fn}\\b`), fn);
    assert.equal(validatePlotSpec({ xRange: [1, 100], yRange: [0, 2], functions: [{ expr: 'log10(x)' }, { expr: 'sinh(x / 50)' }] }).ok, true);
  });

  test('the rules are shorter for a mathematics book than for a chemistry book', () => {
    // Both carry the drawing block, which is the same in every subject, so the ratio is a little above one half.
    assert.ok(figureRules(setupOf('mathematics')).length < figureRules(setupOf('chemistry')).length * 0.6);
    assert.doesNotMatch(figureRules(setupOf('mathematics')), /SMILES|salt bridge/);
  });
});

describe('figure schema per subject', () => {
  const json = (area: SubjectArea) => JSON.stringify(toProviderSchema(figureSchemaFor(setupOf(area).kinds)));

  test('a mathematics schema carries the plot spec only; a chemistry schema carries the chemistry specs', () => {
    const maths = json('mathematics');
    assert.match(maths, /xRange/);
    assert.doesNotMatch(maths, /smiles|salt|subshells|highlights|columns/);
    const chem = json('chemistry');
    for (const word of ['xRange', 'smiles', 'subshells', 'highlights', 'saltBridge', 'columns']) assert.match(chem, new RegExp(word), word);
    assert.ok(maths.length < chem.length / 2);
  });

  test('the draft carries the smaller schema; a fix reads figures with the same one, and a fix without a figure problem reads none', () => {
    const maths = setupOf('mathematics');
    assert.doesNotMatch(JSON.stringify(toProviderSchema(draftMetaSchemaFor(maths))), /smiles/);
    const plot = { key: 'p', kind: 'plot', caption: 'c', alt: 'a', plot: { xRange: [0, 1], yRange: [0, 1], functions: [{ expr: 'x' }] } };
    const answer = `@@@ block 0\nTesto.\n@@@ figures\n${JSON.stringify([plot])}`;
    const read = patchParser(maths, { blocks: 1, issues: 1 })(answer);
    assert.ok(read.ok && read.data.figures.length === 1, 'a plot figure with its nullable fields left out parses');
    const structure = { ...plot, kind: 'structure', structure: { smiles: 'O', style: 'lewis', lonePairs: true, formula: 'H2O' } };
    assert.equal(patchParser(maths, { blocks: 1, issues: 1 })(`@@@ figures\n${JSON.stringify([structure])}`).ok, false, 'a maths book cannot add a structure');
    const none = patchParser(null, { blocks: 1, issues: 1 })(answer);
    assert.ok(none.ok && none.data.figures.length === 0, 'without figure rules a figures part is ignored');
  });

  test('a stored figure request of another kind still parses with the full schema', () => {
    const stored = { key: 'acqua', kind: 'structure', caption: 'c', alt: 'a', plot: null, structure: { smiles: 'O', style: 'lewis', lonePairs: true, formula: 'H2O' }, photo: null, levels: null, orbitals: null, cell: null, periodic: null };
    assert.equal(figureSchema.safeParse(stored).success, true);
    assert.equal(figureSchemaFor(['plot']).safeParse(stored).success, false, 'a maths writer cannot propose it');
  });
});

describe('prompts that name the subject', () => {
  const base = { language: 'it', blocks: '[B0]\nx', requests: '1. y', evidence: '', knownFormulas: '', sectionIds: '' };

  test('a fix gets the figure rules only when it may add a figure', () => {
    const without = patchPrompt(base);
    assert.doesNotMatch(without.system, /FIGURES|:::image blocks? in the block|Kinds \(/);
    assert.doesNotMatch(without.prompt, /@@@ figures/);
    const withRules = patchPrompt({ ...base, figures: setupOf('mathematics') });
    assert.match(withRules.system, /Add a figure only when a problem or the author's instruction asks for one/);
    assert.match(withRules.system, /- plot:/);
    assert.match(withRules.prompt, /@@@ figures\n<a JSON array/);
    assert.doesNotMatch(withRules.system, /Find those places|Most sections/);
  });

  test('the draft prompt of a book without figures carries no figure rules', () => {
    const p = draftPrompt({
      language: 'it', bookTitle: 'T', audience: '', notation: '', chapterTitle: 'C', chapterPlan: '', section: { id: 's', title: 'S', objectives: [], depth: 'standard', subsections: '' },
      topics: '', earlier: '', knownFormulas: '', sectionIds: '', evidence: '', pages: '', summary: '', figures: null, outside: false,
    });
    assert.match(p.system, /Do not add figures/);
    assert.doesNotMatch(p.system, /Kinds \(/);
  });

  test('the reviewer does not ask for missing figures and takes its excluded cases from the subject', () => {
    const r = reviewPrompt({ language: 'it', chapterTitle: 'C', chapter: 'x', evidence: '', objectives: '', profile: SUBJECT_PROFILES.electronics });
    assert.doesNotMatch(r.system, /figure is clearly missing|missing because the text describes/);
    assert.match(r.system, /Never report a missing figure/);
    assert.match(r.system, /does not match the text/);
    assert.match(r.system, new RegExp(SUBJECT_PROFILES.electronics.excluded.slice(0, 30)));
    assert.doesNotMatch(r.system, /origin in polar coordinates/);
    assert.match(reviewPrompt({ language: 'it', chapterTitle: 'C', chapter: 'x', evidence: '', objectives: '', profile: SUBJECT_PROFILES.mathematics }).system, /origin in polar coordinates/);
  });

  test('the verifier names the hypotheses of the subject, and the outline asks for its notation', () => {
    assert.match(verifyPrompt({ language: 'it', statement: 's', solution: 'v', profile: SUBJECT_PROFILES.mathematics }).system, /domains, continuity, convergence/);
    const electronics = verifyPrompt({ language: 'it', statement: 's', solution: 'v', profile: SUBJECT_PROFILES.electronics }).system;
    assert.match(electronics, /operating region/);
    assert.doesNotMatch(electronics, /continuity/);
    const outline = (profile: (typeof SUBJECT_PROFILES)[SubjectArea]) => outlinePrompt({ title: 'T', subject: 'S', language: 'it', audience: '', goals: '', topics: '', indexes: '', sessions: 1, profile }).prompt;
    assert.match(outline(SUBJECT_PROFILES.electronics), /sign conventions for voltage and current/);
    assert.doesNotMatch(outline(SUBJECT_PROFILES.electronics), /intervals, derivatives, limits/);
    assert.match(outline(SUBJECT_PROFILES.mathematics), /domain, intervals, derivatives, limits/);
  });

  test('an indented image block still gives its figure a place, so the figure is checked', () => {
    const fig = { key: 'retta', kind: 'plot', caption: 'c' } as never;
    const { text, afterBlock } = figurePlaces(['Testo prima.', '  :::image{src="assets/retta.svg" alt="a"}\n  c\n  :::', 'Testo dopo.'], [fig]);
    assert.equal(afterBlock.get(fig), 1);
    assert.deepEqual(text, ['Testo prima.', 'Testo dopo.']);
  });

  test('the figure check names the kinds of the book', () => {
    const maths = figureCheckPrompt({ language: 'it', items: 'x', kinds: ['plot'] }).system;
    assert.match(maths, /relation that is easier to see as a graph/);
    assert.doesNotMatch(maths, /molecule|electron configuration/);
    assert.match(figureCheckPrompt({ language: 'it', items: 'x' }).system, /electron configuration/);
  });
});
