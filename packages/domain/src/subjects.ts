// What a book's subject area decides: which figure kinds the writer may use, which notation the outline asks for and
// which hypotheses the verifier and the reviewer look for. One table, so a new subject or a new figure kind is one edit.

export const SUBJECT_AREAS = ['mathematics', 'physics', 'chemistry', 'electronics', 'computer-science', 'mechanics', 'other'] as const;
export type SubjectArea = (typeof SUBJECT_AREAS)[number];

/** Every kind a figure request can have. A kind added here also needs a block in the figure rules and a spec in the figure schema (service). */
export const FIGURE_KINDS = ['plot', 'structure', 'levels', 'orbitals', 'cell', 'periodic', 'drawing', 'photo'] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

/** What a `drawing` figure is of. It picks the drawing engine (see `ENGINE_OF_FAMILY` in the service) and tells the illustrator what to expect. */
export const DRAWING_FAMILIES = ['circuit', 'logic', 'timing', 'karnaugh', 'state-machine', 'block-diagram', 'plot', 'sketch', 'tree-graph', 'other'] as const;
export type DrawingFamily = (typeof DRAWING_FAMILIES)[number];

export interface SubjectProfile {
  /** Figure kinds offered to the writer, in the order their blocks appear in the rules. */
  figureKinds: readonly FigureKind[];
  /** Examples of plots for the plot block of the figure rules. */
  plotExamples: string;
  /** Examples of photos for the photo block. */
  photoExamples: string;
  /** What the outline's "notation" field should settle for this subject. */
  notation: string;
  /** Hypotheses a solution or a theorem can lack, as examples for the verifier and the reviewer. */
  hypotheses: string;
  /** Cases the setting rules out, so a reviewer does not report them as missing hypotheses. */
  excluded: string;
}

export const SUBJECT_PROFILES: Record<SubjectArea, SubjectProfile> = {
  mathematics: {
    figureKinds: ['plot', 'drawing'],
    plotExamples: 'a limit or an asymptote, a derivative as slope, the area under a curve, a family of curves for several values of a parameter, a sequence as points',
    photoExamples: 'a geometric object or a model the student should recognise',
    notation: 'how to write the domain, intervals, derivatives, limits, sets and vectors',
    hypotheses: 'domains, continuity, convergence, a denominator that may vanish',
    excluded: 'a positive angular frequency in a period, a nonzero quantity the text divides by, the origin in polar coordinates, a sign convention the text fixed, a function the text already assumes continuous',
  },
  physics: {
    figureKinds: ['plot', 'drawing', 'photo'],
    plotExamples: 'x(t) or v(t) of a motion, p(V) isotherms, a potential against distance, a wave profile, a decay curve',
    photoExamples: 'an experimental apparatus, a measuring instrument, a natural phenomenon',
    notation: 'the symbol and unit of each quantity, how vectors and components are written, the sign conventions and the axes',
    hypotheses: 'the system and its approximations, the frame of reference, the range where a law holds, the units',
    excluded: 'a positive angular frequency in a period, a frictionless or point-like model the text declared, a sign convention the text fixed',
  },
  chemistry: {
    figureKinds: ['plot', 'structure', 'levels', 'orbitals', 'cell', 'periodic', 'drawing', 'photo'],
    plotExamples: 'a heating curve (temperature against time), a titration curve, the Maxwell-Boltzmann distribution, ln k against 1/T, concentration against time, a periodic trend against atomic number (as points); write charges with Unicode superscripts ("Ca²⁺")',
    photoExamples: 'lab equipment, a precipitate, a flame test, crystals, minerals, corrosion, an industrial plant',
    notation: 'how to write species, charges, states of matter, concentrations, equilibrium constants and units',
    hypotheses: 'the conditions (temperature, pressure, standard state), closed or open system, ideal behaviour, the units',
    excluded: 'an open system in a chapter about closed ones, ideal behaviour the text declared, a standard state the text fixed',
  },
  electronics: {
    figureKinds: ['plot', 'drawing', 'photo'],
    plotExamples: 'a characteristic curve (diode, transistor), a transfer function, a response against time or frequency, a waveform, a load line',
    photoExamples: 'a component, a board, a measuring instrument, a laboratory setup',
    notation: 'units written in upright type with SI prefixes, the sign conventions for voltage and current, how phasors, small-signal quantities and logic levels are written',
    hypotheses: 'the operating region, the sign convention, linearity, ideal components, steady state, the logic family',
    excluded: 'an ideal component the text declared, steady state in a chapter about the steady state, a sign convention the text fixed',
  },
  'computer-science': {
    figureKinds: ['plot', 'drawing'],
    plotExamples: 'running time against input size, the growth of two complexity classes, a probability distribution',
    photoExamples: 'a piece of hardware the student should recognise',
    notation: 'how to write complexity bounds, sets, sequences, indices and pseudocode',
    hypotheses: 'preconditions on the input, the model of computation, loop invariants, termination',
    excluded: 'inputs the text restricts, a model of computation the text fixed, a sorted input where the algorithm requires one',
  },
  mechanics: {
    figureKinds: ['plot', 'drawing', 'photo'],
    plotExamples: 'a stress-strain curve, a bending moment diagram, a displacement against time, a force against displacement',
    photoExamples: 'a machine, a mechanism, a structure, a test specimen',
    notation: 'the symbol and unit of each quantity, how forces, vectors and components are written, the sign conventions and the reference frame',
    hypotheses: 'the model (rigid body, small deformation, linear elasticity), the reference frame, the sign convention, the units',
    excluded: 'a rigid body or small deformations the text declared, a sign convention the text fixed',
  },
  other: {
    figureKinds: ['plot', 'drawing', 'photo'],
    plotExamples: 'a relation between two quantities, a trend, a distribution',
    photoExamples: 'an object, an apparatus or a phenomenon the student should recognise',
    notation: 'the conventions to use throughout (symbols, units, how the main objects are written)',
    hypotheses: 'the assumptions a statement needs, the conditions of a method, the units',
    excluded: 'a case the text declared out of scope, a convention the text fixed',
  },
};

// Order matters: the first matching area wins, so the compound names ("Chimica fisica", "Meccanica quantistica") come first.
const AREA_PATTERNS: [SubjectArea, RegExp][] = [
  ['chemistry', /\b(chimic\w*|chemi\w*|stechiometri\w*|biochimic\w*)/],
  ['physics', /\b(meccanica (quantistica|statistica|ondulatoria)|quantum|statistical mechanics|fisic\w*|physic\w*|termodinamic\w*|thermodynamic\w*|ottic\w*|optics|elettromagnetism\w*|electromagnetis\w*)/],
  ['electronics', /\b(elettronic\w*|electronic\w*|elettrotecnic\w*|circuit\w*|reti logiche|digital logic|telecomunicazion\w*|segnali|signals)/],
  ['computer-science', /\b(informatic\w*|algoritm\w*|algorithm\w*|programmazion\w*|programming|computer|calcolatori|software|database|basi di dati|strutture dati|data structures)/],
  ['mechanics', /\b(meccanic\w*|mechanic\w*|statica|dinamica|dynamics|statics|scienza delle costruzioni|strength of materials|fluidodinamic\w*|fluid dynamics)/],
  ['mathematics', /\b(analisi|calcul\w*|algebra|geometri\w*|geometry|matematic\w*|mathematic\w*|math|statistic\w*|probabilit\w*|probability|aritmetic\w*|topologi\w*|equazioni|ricerca operativa|numerical|numerico|calculus)/],
];

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The area a book without one gets, from its free-text subject and its title. Deterministic: the first matching rule wins. */
export function inferSubjectArea(subject: string, title = ''): SubjectArea {
  const text = plain(`${subject} ${title}`);
  return AREA_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

/** The area of a book: the one set in its options, otherwise the one inferred from its subject and title. */
export function subjectAreaOf(book: { subject: string; title: string; options: { subjectArea?: SubjectArea } }): SubjectArea {
  return book.options.subjectArea ?? inferSubjectArea(book.subject, book.title);
}

export const subjectProfileOf = (book: Parameters<typeof subjectAreaOf>[0]): SubjectProfile => SUBJECT_PROFILES[subjectAreaOf(book)];
