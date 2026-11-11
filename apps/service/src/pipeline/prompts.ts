// Prompt templates. Instructions are in English; generated book text is always in the book language.
// Bump PROMPT_VERSION when a template changes meaning, so cached results can be told apart.
import { z } from 'zod';
import { ALLOWED_FUNCTIONS } from '@smartbuilder/content';
import { FIGURE_KINDS, SUBJECT_PROFILES, subjectProfileOf, type ExamFormat, type FigureKind, type ProgramItem, type SubjectProfile } from '@smartbuilder/domain';
import { codeString } from '../llm/schema.ts';
import { figureSchemaFor } from '../figures/materialize.ts';

export const PROMPT_VERSION = 17;

const LANGUAGE_NAMES: Record<string, string> = { it: 'Italian', en: 'English', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese' };
export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code;

/** The writing rules every content-producing prompt shares. Each rule prevents a defect seen in earlier books. */
export function formatRules(language: string) {
  const lang = languageName(language);
  const label = language === 'it' ? '**Teorema** (di Weierstrass)' : '**Theorem** (Weierstrass)';
  return `OUTPUT FORMAT: PoliTost source Markdown. Follow every rule; the text is parsed by a strict parser.
- Write all reader-facing text in ${lang}. Keep the syntax below exactly as shown (attribute names stay in English).
- Paragraphs are separated by one blank line. Subsection headings use "### Title" only. Never use #, ## or ####.
- Inline math always inside $...$, display math inside $$...$$ on its own lines. Every mathematical symbol, Greek letter, arrow, inequality or set symbol goes inside math; never write Δ, θ, ≤, →, ∈, ∞ as plain text.
- LaTeX must compile with KaTeX: use \\lim_{x\\to 0}, \\frac{}{}, \\sqrt{}, \\mathbb{R}, \\operatorname{dom}, \\left( \\right). No \\begin{align}; use \\begin{aligned} inside $$ when you need several aligned lines. Matrices use \\begin{pmatrix} or \\begin{bmatrix}.
- Important numbered formulas use a formula block, with a short unique kebab-case key and a label in ${lang}:
:::formula{key="limite-notevole-seno" label="Limite notevole del seno"}
$$\\lim_{x\\to 0}\\frac{\\sin x}{x} = 1$$
:::
- Refer to a numbered formula with {{formula:@its-key}}, with a space before and after. Only reference keys that exist in this text or in the list of known keys you are given.
- Link to another section with [testo](ref:section/<sectionId>) using the section ids you are given. No external links.
- Write statement labels (${language === 'it' ? 'Definizione, Teorema, Esempio, Errore tipico, ...' : 'Definition, Theorem, Example, Common mistake, ...'}) without numbers, e.g. ${label}. The builder numbers them per chapter, so never cite a statement by its number; name it instead.
- Bold with **word**, with a space or punctuation outside the asterisks. Never leave an unmatched **.
- Lists with "- " or "1. ". Markdown tables are forbidden (the reader cannot show them): turn tabular data into a list or prose. The one exception is a truth table or a small table of values, which you write as a KaTeX array in display math, with | for column rules, \\\\ at the end of each row and \\hline under the header:
$$
\\begin{array}{cc|c}
A & B & A \\cdot B \\\\
\\hline
0 & 0 & 0 \\\\
0 & 1 & 0 \\\\
1 & 0 & 0 \\\\
1 & 1 & 1
\\end{array}
$$
- Units go inside math in upright type, with a thin space after the number and the usual SI prefixes: $5\\,\\mathrm{m/s}$, $10\\,\\mathrm{k\\Omega}$, $2\\,\\mu\\mathrm{F}$. No code fences, no HTML, no images except the figure blocks described below.
- Never end a paragraph with ":" unless a formula, a display math block or a list follows immediately.
- Never write about the writing process, the sources, the prompt or yourself ("ecco", "ho riscritto", "di seguito", "here is", "as requested", "nota:", summaries of what you did). Write only the book.`;
}

// ---------- topic map ----------

export const topicsSchema = z.object({
  topics: z.array(z.object({
    key: z.string().describe('kebab-case id, unique'),
    name: z.string(),
    aliases: z.array(z.string()),
    description: z.string(),
    prerequisites: z.array(z.string()).describe('keys of other topics'),
    sources: z.array(z.object({ resource: z.string().describe('resource label like R1'), pageFrom: z.number().int(), pageTo: z.number().int() })),
  })),
});

export function topicsPrompt(p: { subject: string; language: string; goals: string; indexes: string }) {
  return {
    system: `You build the topic map of a university course from the tables of contents of its sources. You merge duplicates across sources and keep each topic small enough to be taught in one section (roughly 3-10 pages of a textbook). Topic names are in ${languageName(p.language)}.`,
    prompt: `Course: ${p.subject}
Author's goals: ${p.goals || '(none given)'}

Source indexes (resource label, then entries "level | title | first page" with 1-based pages; "inferred" means reconstructed from page headings):
${p.indexes}

Return every topic the course covers. For each: a kebab-case key, the name, aliases used by other sources, a one-sentence description, prerequisite topic keys, and the page ranges (1-based, inclusive) where each source treats it. Order topics in a sensible teaching order. Do not invent topics the sources do not cover.`,
  };
}

// ---------- index inference for sources without bookmarks ----------

export const inferredIndexSchema = z.object({
  entries: z.array(z.object({ title: z.string(), level: z.number().int().min(1).max(3), page: z.number().int().min(1) })),
});

export function inferIndexPrompt(p: { filename: string; heads: string }) {
  return {
    system: 'You reconstruct the table of contents of a document from the first lines of each page. Keep the original wording and language of the titles.',
    prompt: `Document: ${p.filename}
First lines of each page ("page N:" is 1-based):
${p.heads}

Return the chapter (level 1), section (level 2) and, where clear, subsection (level 3) headings with the page where each starts. Skip running headers, page numbers and exercise numbers.`,
  };
}

// ---------- question classification ----------

export const classifySchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    topics: z.array(z.string()).describe('topic keys, most relevant first'),
    difficulty: z.enum(['facile', 'medio', 'difficile']),
  })),
});

export function classifyPrompt(p: { topics: string; questions: string }) {
  return {
    system: 'You map exercises and exam questions to the topics they test. A question can test several topics; list the main one first. Use only the given topic keys.',
    prompt: `Topics (key: name):
${p.topics}

Questions (id, then the text; the math may be garbled by PDF extraction, read through it):
${p.questions}

For every question id, return its topic keys and a difficulty (facile, medio, difficile).`,
  };
}

// ---------- course program ----------

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** The program items as the planner and the checker read them: key | title | details | proofs. */
export function programItemsText(items: ProgramItem[], detailChars = 500) {
  return items.map((i) => `${i.key} | ${i.title} | ${clip(i.details.replace(/\s+/g, ' '), detailChars) || '-'} | ${i.proofs.join('; ') || '-'}`).join('\n');
}

export function examFormatText(f: ExamFormat) {
  const proofs = f.proofs === 'required' ? 'proofs of theorems are asked' : f.proofs === 'none' ? 'no proofs are asked' : 'only the proofs the program lists are asked';
  return `${[f.written ? 'written exam' : '', f.oral ? 'oral exam' : ''].filter(Boolean).join(' and ') || 'exam format not given'}; ${proofs}.${f.summary ? ` ${f.summary}` : ''}`;
}

export const programSchema = z.object({
  items: z.array(z.object({
    key: z.string().describe('kebab-case ASCII key from the title, unique'),
    title: z.string().describe('short title of the topic, in the program\'s wording'),
    details: z.string().describe('what the program says about it, verbatim where possible; empty if nothing more'),
    proofs: z.array(z.string()).describe('theorems or results whose proof is asked, as the program names them'),
  })),
  examFormat: z.object({
    written: z.boolean(),
    oral: z.boolean().describe('true when an oral exam is part of the exam, even if optional'),
    proofs: z.enum(['required', 'some', 'none']),
    summary: z.string().describe('2-4 sentences in the book language: the parts of the exam, their length and weight, what is allowed'),
  }),
});

export function programPrompt(p: { language: string; text: string }) {
  const lang = languageName(p.language);
  return {
    system: `You read the official program of a university course (a PoliTo course guide, usually in Italian) and turn it into a list of program items and the exam format. You copy what the program says; you never add topics, merge topics or leave one out.`,
    prompt: `COURSE GUIDE TEXT:
${p.text}

Return JSON {"items": [...], "examFormat": {...}}.

ITEMS
- One item for each topic the program lists, in the program's order. A paragraph of the program usually names several topics separated by full stops, semicolons or commas; each listed topic is its own item ("Limiti di funzioni e successioni" and "Teoremi sui limiti: unicità, permanenza del segno, confronto" are two items). Do not merge things the program lists separately and do not split one listed topic into smaller ones. A heading that only introduces a list ("Limiti e continuità:") is not an item by itself.
- title: short, in the program's own words. details: the program's sentence or clause for this item, verbatim, including its sub-topics; put the hours ("Circa 15 ore") on the last item of their group only if they help, otherwise leave them out.
- key: lower-case ASCII with hyphens, at most 50 characters, derived from the title, different for every item.
- proofs: theorems or results whose proof the program says is asked or taught ("con dimostrazione", "dim."). An empty list when the program does not say.
- Only the program of the course. Leave out prerequisites, organization of the lessons, bibliography, grading rules.

EXAM FORMAT (from the part about the exam, "Modalità di verifica / esame")
- written: a written test or written paper is part of the exam. oral: an oral exam is part of it, also when it is optional.
- proofs: "required" when the guide says the exam asks the theory, theorems and their proofs; "none" when it says the exam is only exercises or multiple-choice questions and does not ask proofs; "some" otherwise (only the proofs the program names).
- summary: ${lang}, 2-4 sentences: the parts of the exam (test, written paper, oral), their duration and points, what is allowed. Facts from the text only.`,
  };
}

// ---------- outline ----------

export const plannedOutlineSchema = z.object({
  notation: z.string().describe('notation and conventions every writer must follow, in the book language'),
  chapters: z.array(z.object({
    slug: z.string(),
    title: z.string(),
    objectives: z.array(z.string()),
    prerequisites: z.array(z.string()),
    sections: z.array(z.object({
      title: z.string(),
      objectives: z.array(z.string()),
      topics: z.array(z.string()).describe('topic keys'),
      depth: z.enum(['brief', 'standard', 'deep']),
      programItems: z.array(z.string()).describe('keys of the course program items this section teaches; empty when there is no program'),
      subsections: z.array(z.object({ title: z.string(), objectives: z.array(z.string()) })),
    })),
  })),
  exclusions: z.array(z.object({ topic: z.string(), reason: z.string() })),
  programExclusions: z.array(z.object({ item: z.string(), reason: z.string() })).describe('program items left out of the book, with the reason; empty when there is no program'),
});

export function outlinePrompt(p: { title: string; subject: string; language: string; audience: string; goals: string; topics: string; indexes: string; sessions: number; program?: { items: ProgramItem[]; exam: ExamFormat }; profile?: SubjectProfile }) {
  const lang = languageName(p.language);
  const profile = p.profile ?? SUBJECT_PROFILES.other;
  return {
    system: `You are the editor of a university textbook written in ${lang}. You design the book's common index from the course's sources and its exam history. The index must respect prerequisites, cover every topic the course needs, and give more depth to topics that the exams test often, without dropping topics the exams never test.`,
    prompt: `Book: ${p.title} (${p.subject})
Audience: ${p.audience || 'university students preparing the exam'}
Author's goals: ${p.goals || '(none given)'}

Topics (key | name | exam sessions where it appears, out of ${p.sessions} | prerequisites):
${p.topics}

Source indexes, for reference (the book may reorganize them):
${p.indexes}
${p.program ? `
COURSE PROGRAM (official; key | title | what the program says | proofs asked):
${programItemsText(p.program.items)}

EXAM: ${examFormatText(p.program.exam)}
` : ''}
Design the book:
- Chapters in teaching order; each chapter has 3-8 sections; each section covers one or a few closely related topic keys and has 1-4 concrete learning objectives (what the student can do afterwards).
- depth: "deep" for topics in many exam sessions or that are hard, "brief" for background, "standard" otherwise.
- Subsections only where a section clearly has distinct parts.
- Every topic key appears in some section, or in exclusions with a reason.
- notation: the conventions to use throughout (e.g. ${profile.notation}), in ${lang}.
- Titles in ${lang}, short, without numbering. slug: kebab-case from the chapter title.${p.program ? `
- The course program decides the scope; the exam frequency only decides the depth. Every program item key goes in "programItems" of the section that teaches it (a section can teach several items, an item can be taught across sections), or in "programExclusions" with a reason when the book leaves it out. An item must not appear in both. Use only the keys listed above.
- A source topic the program does not cover (and the exams do not need as a prerequisite) goes in "exclusions" with a reason such as "not in the course program"; a short recap of a prerequisite may stay inside a related section, it does not get a section of its own. Do not drop a program item because the sources are thin on it: keep the section.
- Do not add the final exam-guide section of a chapter: the builder adds it.` : `
- There is no course program: leave "programItems" and "programExclusions" empty.`}`,
  };
}

// ---------- section drafting ----------

/**
 * What the writer of a book may draw: the kinds of its subject and how freely to add them. The schema carries every kind of
 * the subject, but the rules offer a photo only when photos can be searched (a photo the builder cannot fetch is dropped with a note).
 */
export interface FigureSetup {
  kinds: readonly FigureKind[];
  photos: boolean;
  policy: 'helpful' | 'generous';
  profile: SubjectProfile;
}

export function figureSetupOf(book: Parameters<typeof subjectProfileOf>[0] & { options: { figurePolicy: 'helpful' | 'generous' } }, photos: boolean): FigureSetup {
  const profile = subjectProfileOf(book);
  return { kinds: profile.figureKinds, photos, policy: book.options.figurePolicy, profile };
}

/** The kinds a schema is built for. A book that draws no figures gets the smallest schema, with the field the answer needs. */
const schemaKinds = (figures: FigureSetup | null): readonly FigureKind[] => figures?.kinds ?? ['plot'];

export const draftSchemaFor = (figures: FigureSetup | null) => z.object({
  markdown: z.string().describe('the section body in PoliTost source Markdown, with [[nX]] citation markers'),
  figures: z.array(figureSchemaFor(schemaKinds(figures))),
  noFigureReason: z.string().nullable().optional().describe('leave null'),
  summary: z.string().describe('2-3 sentences: what this section defined and which notation it fixed, for the writers of later sections'),
});

export interface DraftPromptInput {
  language: string;
  bookTitle: string;
  audience: string;
  notation: string;
  chapterTitle: string;
  chapterPlan: string;
  section: { id: string; title: string; objectives: string[]; depth: string; subsections: string };
  topics: string;
  earlier: string;
  knownFormulas: string;
  sectionIds: string;
  evidence: string;
  pages: string;
  /** The evidence reader's answer: clean formulas, unverified wording. */
  summary: string;
  /** The figures the writer may add; null when the book has none. */
  figures: FigureSetup | null;
  outside: boolean;
  /** Figures other sections already show, one per line; empty when there are none. */
  bookFigures?: string;
  /** The book teaches this programming language; its lab examples are added separately. */
  teaches?: 'matlab';
  /** The course program items this section teaches and the exam format; absent when the book has no program. */
  program?: { items: ProgramItem[]; exam: ExamFormat };
}

/** How the exam format steers the writing of a section. */
function examFocus(p: NonNullable<DraftPromptInput['program']>, language: string) {
  const mark = language === 'it' ? "**Dimostrazione richiesta all'esame.**" : '**Proof asked at the exam.**';
  // Only program content is asked at the exam, so a section without program items marks no proof as asked.
  const proofs = !p.items.length
    ? `This section teaches no program item of its own (a recap or a bridge): give proofs only as far as the explanation needs them, and never use the line ${mark}.`
    : p.exam.proofs === 'required'
      ? `The exam asks for proofs. For every theorem of this section that has a standard proof, give the complete proof. Put the line ${mark} on its own immediately before each such proof.`
      : p.exam.proofs === 'none' && !p.exam.oral
        ? 'The exam is written and asks for no proofs: put the weight on methods and fully worked exercises; keep proofs brief (the idea in a few lines), and mark none of them.'
        : `Give the complete proof, with the line ${mark} on its own immediately before it, only for the results listed under "proofs asked" below; other proofs stay brief.`;
  // A section with no program item (a prerequisite recap, say) still follows the exam format, but gets no scope to stay inside.
  const items = p.items.length ? `COURSE PROGRAM ITEMS this section teaches (title | what the program says | proofs asked):
${p.items.map((i) => `- ${i.title} | ${clip(i.details.replace(/\s+/g, ' '), 800) || '-'} | ${i.proofs.join('; ') || '-'}`).join('\n')}
` : '';
  return `${items}EXAM: ${examFormatText(p.exam)}
${proofs}${p.items.length ? '\nCover every program item above and stay inside what the program lists: no extra theory the exam never asks.' : ''}`;
}

const KIND_SEEING: Record<FigureKind, string> = {
  plot: 'a relation that is easier to see as a graph',
  structure: 'the structure of a molecule or ion',
  levels: 'energy levels',
  orbitals: 'an electron configuration',
  cell: 'an electrochemical cell',
  periodic: 'a pattern across the periodic table',
  photo: 'a real object or phenomenon the student should recognise',
};

/** One block per kind. A new kind adds its block here and its name to the subject profiles (domain). */
const KIND_BLOCKS: Record<FigureKind, (f: FigureSetup) => string> = {
  plot: (f) => `  - plot: a function graph. Expressions use x, the constants e and pi, + - * / ^, and the functions ${[...ALLOWED_FUNCTIONS].join(' ')}; a piecewise curve is several functions with a domain each. The plot must match the text exactly; its labels are plain text, so write powers with Unicode superscripts ("x²"). Examples: ${f.profile.plotExamples}.`,
  structure: () => `  - structure: a molecule or ion as an exact SMILES string, drawn by the builder. style "lewis" shows every atom, the bonds, lone pairs (set lonePairs true) and formal charges: use it for general chemistry (H2O as "O", NH4+ as "[NH4+]", CO2 as "O=C=O", sulfate as "[O-]S(=O)(=O)[O-]"). style "skeletal" is for organic molecules with more than about six carbons. "formula" is the formula exactly as the text writes it ("NH4+", "SO4^2-", "NaCl"); the builder checks it against the SMILES and drops the figure if they differ. One species, or one resonance form, per figure; check every atom and charge.`,
  levels: () => `  - levels: an energy-level diagram: a molecular orbital diagram, the enthalpy of reactants and products with a ΔH arrow, a Hess cycle, the energy order of orbitals. The vertical axis is an energy (or enthalpy, entropy), named in "yLabel"; never use it for a flow chart, a conversion scheme or a classification. "columns" are the vertical groups from left to right (an MO diagram has three: atom, molecule, atom). Each level has a unique key, its column (from 0), an energy (only order and spacing matter), a label, "boxes" for degenerate orbitals (π2p has 2) and "electrons" (null to draw no arrows). "links" join levels by key: "dashed" for MO correlation lines, "arrow" for an energy change, labelled like "ΔH = −286 kJ".`,
  orbitals: () => `  - orbitals: orbital boxes for the electron configuration of one atom or ion. "species" as the text writes it ("O", "Fe3+"), "core" a noble-gas core like "[Ar]" or null, "subshells" in the order the text writes them, each with its electrons ("3d" with 5). The builder checks that the electrons add up to the species and drops the figure if they do not.`,
  cell: () => `  - cell: an electrochemical cell. "galvanic": two half-cells, a salt bridge (its electrolyte, e.g. "KNO3") and a voltmeter reading or null. "electrolytic": a generator; with saltBridge null both electrodes share one vessel (a lead-acid battery, molten NaCl), whose solution or melt is left.solution. Each side has its electrode, solution ("ZnSO4 1 M"), role (anode or cathode) and half-reaction or null. Do not draw a fuel cell or a dry cell as beakers.`,
  periodic: () => `  - periodic: the periodic table with up to 5 groups of elements highlighted, each with its label ("Metalli alcalini"), and up to two trend arrows: "right" or "left" across a period, "up" or "down" along a group, labelled with what increases that way.`,
  photo: (f) => `  - photo: a real photo from Wikimedia Commons, Pixabay or Pexels: ${f.profile.photoExamples}. "query" is 2-5 English search words, "mustShow" says precisely what the photo must show. The builder keeps a photo only if it shows exactly that, otherwise the figure is dropped.`,
};

const MARKUP_KINDS: readonly FigureKind[] = ['levels', 'orbitals', 'cell', 'periodic'];

const listOf = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);

/** What the writer may draw: a policy paragraph, one block per kind of the book's subject, and the rule for placing the image block. */
export function figureRules(setup: FigureSetup) {
  const f = { ...setup, kinds: setup.kinds.filter((k) => k !== 'photo' || setup.photos) };
  const seeing = f.kinds.map((k) => KIND_SEEING[k]);
  const limit = `At most 3 figures${f.kinds.includes('photo') ? ', at most 1 of them a photo' : ''}.`;
  const policy = f.policy === 'generous'
    ? `FIGURES. Students study from these pages, and a page of plain text is harder to learn from. Most sections have at least one place where a figure shows something faster than words: ${seeing.join(', ')}. Find those places and put a figure there. Never add a decorative figure or one that only repeats a sentence. Return an empty "figures" array only when nothing the section discusses fits any kind below. ${limit}`
    : `FIGURES. Add a figure where the student has to see a relation, a structure or an object to follow the text: ${listOf(seeing)}. Where the text is built around one of these, a figure belongs there. A section with nothing to show gets no figure and an empty "figures" array: most definitions, proofs and worked computations need none, and you do not have to find one. Never add a decorative figure or one that only repeats a sentence. ${limit}`;
  const diagrams = MARKUP_KINDS.filter((k) => f.kinds.includes(k));
  const markup = diagrams.length
    ? `\n  Labels inside ${listOf(diagrams)} diagrams are plain text with light markup: digits after a symbol become subscripts and a trailing charge a superscript ("H2O", "ZnSO4", "Zn2+"); write "SO4^2-" for a polyatomic charge and "_" for other subscripts ("σ*_2p", "S_(g)").`
    : '';
  return `${policy}
  Kinds (set "kind" and fill the matching spec; any other spec is null):
${f.kinds.map((k) => KIND_BLOCKS[k](f)).join('\n')}${markup}
  Place each figure in the text where it belongs with :::image{src="assets/<key>.svg" alt="<alt>" caption="<caption>"} followed by a line with ::: on its own (always write .svg; the builder sets the real file type). Captions and alt text are plain text without $ or LaTeX (write "sin(x)/x", "x → 0"${f.kinds.includes('structure') ? ', "H2O"' : ''}); do not number figures, the builder does. The text must read correctly without the figure: never write "as the figure shows"; the caption says what to look at.`;
}

export function draftPrompt(p: DraftPromptInput) {
  const lang = languageName(p.language);
  const length = p.section.depth === 'deep' ? '1200-2200' : p.section.depth === 'brief' ? '400-800' : '800-1500';
  return {
    system: `You write one section of a university textbook in ${lang}: "${p.bookTitle}". Audience: ${p.audience || 'university students preparing the exam'}. You explain clearly and rigorously, state definitions and theorems with all hypotheses, give worked examples with every step, and point out the mistakes students usually make. You rely on the evidence provided; you never invent results the evidence does not support.

${formatRules(p.language)}`,
    prompt: `CHAPTER: ${p.chapterTitle}
Chapter plan (sections in order; yours is marked ►):
${p.chapterPlan}

YOUR SECTION: ${p.section.title}  (section id ${p.section.id})
Objectives:
${p.section.objectives.map((o) => `- ${o}`).join('\n') || '- (none given)'}
Planned subsections: ${p.section.subsections || '(choose 0-4 yourself)'}
Depth: ${p.section.depth} (about ${length} words)
Topics and how often the exams test them:
${p.topics}
${p.program ? `\n${examFocus(p.program, p.language)}\n` : ''}
Notation to follow:
${p.notation || '(standard notation of the field)'}

Already written earlier in the book (do not repeat, refer back with links when useful):
${p.earlier || '(nothing yet)'}

Known formula keys from other sections (reference them with {{formula:@key}}; never define a formula block with one of these keys again):
${p.knownFormulas || '(none)'}

Section ids you may link to:
${p.sectionIds}

EVIDENCE NOTES (verbatim passages from the course sources; cite them):
${p.evidence || '(no notes)'}

SOURCE SUMMARY (the evidence reader's synthesis of the notes; its LaTeX is usually cleaner than the quotes, but it is not itself evidence — cite the notes, never this summary):
${p.summary || '(none)'}

SOURCE PAGES (clean transcriptions of the pages the notes come from; use them for exact formulas and statements):
${p.pages || '(none)'}

INSTRUCTIONS
- Cover the objectives in a logical order: motivation, definitions, results with hypotheses, at least one fully worked example, typical mistakes. Use ### subsections for the planned subsections.
- After each paragraph or block that relies on a note, add its marker, e.g. [[n3]] or [[n3,n7]], at the end of the paragraph. Every definition, theorem and formula taken from the sources needs a marker.
- ${p.outside ? 'You may add standard material the notes do not contain (e.g. a classical counterexample), but never contradict the notes.' : 'Stay within what the evidence supports. If something needed for the objectives is missing from the evidence, write the standard, uncontroversial version and do not add a marker to that paragraph.'}
- Where the sources disagree, follow the course notes and mention the other convention in one sentence.${p.teaches === 'matlab' ? `
- This book teaches MATLAB. Write every command, expression, function name and short statement as inline code with backticks (\`x = linspace(0, 1, 5);\`, \`A(2, :)\`, \`format long\`). Show a short sequence of commands as a list, one command per item, each followed by what it does or prints. There are no code blocks: describe longer programs in words, step by step, because the builder adds runnable MATLAB scripts to the lab separately. Math still goes in $...$.` : ''}
- ${p.figures ? figureRules(p.figures) : 'Do not add figures; return an empty "figures" array and null "noFigureReason".'}${p.figures && p.bookFigures ? `\n- Figures other sections already show. The book never repeats a picture: do not propose any of these again, nor the same species, photo or diagram with another caption.\n${p.bookFigures}` : ''}
- Return JSON: markdown (the section body, without the section title), figures, noFigureReason, summary.`,
  };
}

// ---------- exam guide ----------

/** Title and objectives of the closing section of a chapter. English is used for every language but Italian. */
export function examGuideText(language: string) {
  return language === 'it'
    ? { title: "Come viene chiesto all'esame", objectives: ["Riconoscere i tipi di esercizio che l'esame propone su questo capitolo", 'Applicare un metodo passo per passo a ciascun tipo', 'Evitare gli errori tipici'] }
    : { title: 'How the exam asks it', objectives: ['Recognise the kinds of exercise the exam sets on this chapter', 'Apply a step-by-step method to each kind', 'Avoid the typical mistakes'] };
}

export interface ExamGuidePromptInput {
  language: string;
  bookTitle: string;
  audience: string;
  notation: string;
  chapterTitle: string;
  chapterPlan: string;
  section: { id: string; title: string };
  /** Computed by the builder: how many of the sessions asked about the chapter's topics. */
  sessions: { asked: number; total: number };
  /** Exam questions of the chapter, one block each, already cut to a readable length. */
  questions: string;
  /** What the sections of the chapter say, for linking and for not repeating them. */
  sectionSummaries: string;
  knownFormulas: string;
  sectionIds: string;
  exam?: ExamFormat;
}

export function examGuidePrompt(p: ExamGuidePromptInput) {
  const lang = languageName(p.language);
  const it = p.language === 'it';
  return {
    system: `You write the closing section of a chapter of a university textbook in ${lang}: "${p.bookTitle}". Audience: ${p.audience || 'university students preparing the exam'}. The section tells the student how the exam really asks the chapter's topics, using the past exam questions you are given. You describe only what those questions show; you never invent sessions, dates or exercises.

${formatRules(p.language)}`,
    prompt: `CHAPTER: ${p.chapterTitle}
Chapter plan (sections in order; yours is marked ►):
${p.chapterPlan}

YOUR SECTION: ${p.section.title}  (section id ${p.section.id})
${p.exam ? `Exam format: ${examFormatText(p.exam)}
` : ''}
FACT, computed by the builder (state it exactly, in your own words): ${p.sessions.asked} of the ${p.sessions.total} past exam sessions included questions on this chapter's topics.

Notation to follow:
${p.notation || '(standard notation of the field)'}

What the chapter's sections contain (link to them, do not repeat them):
${p.sectionSummaries || '(not available)'}

Known formula keys (reference them with {{formula:@key}}; never define a formula block with one of these keys again):
${p.knownFormulas || '(none)'}

Section ids you may link to:
${p.sectionIds}

PAST EXAM QUESTIONS ON THIS CHAPTER (session | date | number | topics | statement):
${p.questions}

INSTRUCTIONS
- Open with the fact above in one or two sentences: in how many sessions the chapter came up, and which kind of exercise comes up most.
- Group the questions into the recurring types of exercise (3-6 types). For each type, a ### subsection with: what the exam asks, a step-by-step method as a numbered list, the typical mistakes, and one or two named examples. Name an example by its session and number exactly as the list gives them, e.g. ${it ? '"Esame del 25 gennaio 2023, esercizio 2"' : '"Exam of 25 January 2023, exercise 2"'}, and say in one sentence what it asks and how the method solves it. Do not copy the full statement.
- Link each method to the chapter section that teaches the underlying result with [testo](ref:section/<sectionId>), using only the ids above.
- A type that appears in one session only is mentioned briefly, not given a subsection.
- Do not add figures. Return an empty "figures" array and null "noFigureReason".
- Return JSON: markdown (the section body, without the section title), figures, noFigureReason, summary.`,
  };
}

// ---------- alignment with the course program ----------

export const alignSchema = z.object({
  coverage: z.array(z.object({ item: z.string(), nodeIds: z.array(z.string()) })).describe('for every program item key, the ids of the sections that teach it (empty when none does)'),
  findings: z.array(z.object({
    kind: z.enum(['missing', 'thin', 'proof', 'off-program', 'order']),
    item: z.string().nullable().describe('program item key; for missing, thin and proof'),
    nodeId: z.string().nullable().describe('section id; for thin, proof, off-program and order'),
    whole: z.boolean().nullable().describe('off-program only: true when the entire section is outside the program'),
    quote: z.string().nullable().describe('off-program, not whole: the heading or statement line, verbatim from the section digest, where the off-program passage starts'),
    message: z.string().describe('English, one or two sentences for the author'),
    chapterId: z.string().nullable().describe('missing only: chapter id for the new section'),
    afterSectionId: z.string().nullable().describe('missing only: the section the new one follows; null puts it at the start of the chapter'),
    title: z.string().nullable().describe('missing only: title of the new section, in the book language'),
    objectives: z.array(z.string()).describe('missing only: 1-4 objectives in the book language; otherwise empty'),
    depth: z.enum(['brief', 'standard', 'deep']).nullable().describe('missing only'),
  })),
});

export function alignPrompt(p: { language: string; program: string; exam: string; outline: string; sessions: number }) {
  const lang = languageName(p.language);
  return {
    system: `You check a university textbook against the official program of its course. You are given the program, the exam format and a digest of every section (title, objectives, headings, statement labels, whether it contains a proof, length, how often the exam tests its topics). You decide what the book misses, what it covers too thinly for its exam weight, which required proofs are absent, and which material is outside the program. You work from the digest only; you never invent what a section contains.`,
    prompt: `COURSE PROGRAM (key | title | what the program says | proofs asked):
${p.program}

EXAM: ${p.exam}
Past exam sessions in the book's archive: ${p.sessions}.

BOOK DIGEST (chapters in order; each section: [id] title | depth | length | proof | program items assigned | exam sessions of its topics):
${p.outline}

Return JSON {"coverage": [...], "findings": [...]}.

COVERAGE: one entry per program item key, with the ids of the sections that teach it substantially (empty when none does).

FINDINGS (every finding is about one place. Be selective only with thin and proof, which are judgement calls: a few solid findings beat a long list of doubtful ones. Report every off-program section or passage you find, in full)
- missing: a program item that no section teaches. Give item, chapterId, afterSectionId (the section it should follow so prerequisites come first; null for the start of the chapter), title, 1-4 objectives and depth, all in ${lang} for title and objectives. Never suggest a position after an exam-guide section.
- thin: a section teaches a program item but too briefly for what the exam asks (many sessions test it, yet the section is brief or short and has few statements). Give item and nodeId.
- proof: the program or the exam format asks for a proof ("proofs asked", or the exam format says proofs are asked) that the section does not contain (its digest shows no proof or no matching statement). Give item and nodeId.
- off-program: material that is not in the program and that no in-program part of the book needs to be understood. The book should be as short as the program allows, so report every such section or passage, also when it is already marked as beyond the program. "used by" lists the sections that link to it or use its formulas: a section that in-program sections need in order to be understood is a prerequisite and stays, even when the program does not list it, while a link that only mentions it in passing does not make it needed. whole=true when the section's whole subject is not needed (nodeId only). whole=false for a passage inside an otherwise needed section, such as a digression, a curiosity or an extension the program does not ask for, that starts at one of the headings or statement lines the digest shows: give that line verbatim as quote. Passages the digest does not show are left to the chapter review. Sections whose title is an exam guide are never off-program.
- order: a section relies on something that a later section teaches. Give nodeId.
- Do not report exam guides (missing chapter closers); the builder checks those itself.
- message: English, one or two sentences, naming the item or section by its title.`,
  };
}

/** One repair round after lint findings. */
export function repairPrompt(p: { language: string; markdown: string; findings: string }) {
  return {
    system: `You fix formatting problems in a textbook section written in ${languageName(p.language)} without changing its content or its [[nX]] markers.\n\n${formatRules(p.language)}`,
    prompt: `The section below has these problems (rule: message, line, text):
${p.findings}

Return the full corrected section as JSON {"markdown": "..."}; change only what the problems require.

SECTION:
${p.markdown}`,
  };
}
export const repairSchema = z.object({ markdown: z.string() });

// ---------- chapter introduction ----------

export function introPrompt(p: { language: string; chapterTitle: string; objectives: string[]; prerequisites: string[]; summaries: string }) {
  return {
    system: `You write the short introduction of a textbook chapter in ${languageName(p.language)}.\n\n${formatRules(p.language)}`,
    prompt: `Chapter: ${p.chapterTitle}
Objectives: ${p.objectives.join('; ') || '(none)'}
Prerequisites: ${p.prerequisites.join('; ') || '(none)'}
What each section actually contains:
${p.summaries}

Write 120-250 words: why the chapter matters, what the student needs to know already, and what they will be able to do at the end. No headings, no formulas blocks, no list of section titles. Return JSON {"markdown": "..."}.`,
  };
}

// ---------- practice ----------

export const generatedQuestionsSchema = z.object({
  questions: z.array(z.object({
    topics: z.array(z.string()),
    difficulty: z.enum(['facile', 'medio', 'difficile']),
    statement: z.string(),
    hint: z.string(),
    solution: z.string(),
    finalAnswer: z.string().describe('the final result in one line, LaTeX allowed'),
  })),
});

export function exercisesPrompt(p: { language: string; kind: 'exercise' | 'exam'; chapterTitle: string; topics: string; count: number; examples: string; collection?: string; knownFormulas: string }) {
  const lang = languageName(p.language);
  const style = p.kind === 'exam'
    ? 'exam-style problems modeled on the real exam questions shown, with the same structure (multi-part a), b), c) where the originals have it) and comparable length'
    : 'exercises for practice, progressing from direct application to harder reasoning';
  return {
    system: `You write ${style} for a university textbook in ${lang}. Every problem is fully specified, solvable with the chapter's content, and has a complete, correct worked solution.\n\n${formatRules(p.language)}`,
    prompt: `Chapter: ${p.chapterTitle}
Topics to cover (key: name, and how many problems each needs):
${p.topics}

${p.examples ? `Real questions from past exams on these topics, for level and style (do not copy them):\n${p.examples}\n` : ''}
${p.collection ? `Items from the exercise collections students practise with, on these topics. They show what students practise: match their level and style, do not copy them:\n${p.collection}\n` : ''}
Known formula keys you may cite in hints and solutions with {{formula:@key}}:
${p.knownFormulas || '(none)'}

Write ${p.count} problems in total, distributing them as requested across topics and difficulties (facile, medio, difficile). Statement, hint (${p.kind === 'exam' ? 'always empty: exams have no hints' : 'one or two sentences that point the way without solving'}) and solution (every step, with the final result clearly stated) are separate fields in source Markdown without headings. Difficulty goes only in its own field: never write stars or labels such as (**) or (facile) in a statement. Check every computation; prefer problems whose answer can be checked (a number, a limit, an interval, a function). Return JSON.`,
  };
}

export const authenticExtractSchema = z.object({
  statement: z.string(),
  solution: z.string(),
  readable: z.boolean().describe('false if the pages do not contain this exercise or it cannot be read'),
});

export function authenticExtractPrompt(p: { language: string; examGroup: string; number: string; statementPages: string; solutionPages: string }) {
  return {
    system: `You copy one exercise and its official solution from transcribed exam pages, faithfully, in the original language. You fix only obvious transcription glitches.\n\n${formatRules(p.language)}`,
    prompt: `Session: ${p.examGroup}
Exercise number: ${p.number}

Pages with the statement:
${p.statementPages}

Pages with the solution (SVOLGIMENTO), may be the same pages:
${p.solutionPages}

Return JSON with the statement of "Esercizio ${p.number}" of this session (all its parts, without the points), the official solution of that exercise, and readable=true; readable=false if it is not there.`,
  };
}

export const sessionExtractSchema = z.object({
  exercises: z.array(z.object({
    number: z.string().describe('the exercise number exactly as listed'),
    statement: z.string(),
    solution: z.string().describe('empty when the pages print no official solution for it'),
    readable: z.boolean().describe('false if the pages do not contain this exercise or it cannot be read'),
  })),
});

/** All the listed exercises of one exam session in a single call, from the same pages. `exercises` carries each stored question's number and its text-layer solution, if any. */
export function sessionExtractPrompt(p: { language: string; examGroup: string; exercises: { number: string; solutionText: string }[]; pages: string }) {
  const layer = p.exercises.filter((e) => e.solutionText.trim()).map((e) => `Esercizio ${e.number} (text layer, math may be garbled):\n${e.solutionText}`).join('\n\n');
  return {
    system: `You copy the exercises of one exam session and their official solutions from transcribed exam pages, faithfully, in the original language. You fix only obvious transcription glitches.\n\n${formatRules(p.language)}`,
    prompt: `Session: ${p.examGroup}
Exercises to copy: ${p.exercises.map((e) => e.number).join(', ')}

Pages of the session (statements and solutions):
${p.pages}
${layer ? `\nText layer of the official solutions, which may help where the page transcription is unclear:\n${layer}\n` : ''}
Return JSON {"exercises": [...]} with exactly one entry for each listed exercise number, in that order and with the number exactly as listed. Each entry has the statement of "Esercizio <number>" of this session (all its parts, without the points), its official solution (empty when the pages print none), and readable=true; readable=false if the exercise is not on the pages. Never add an exercise that is not listed.`,
  };
}

export const verifySchema = z.object({
  independentAnswer: z.string(),
  resultsAgree: z.boolean().describe('the final results of the given solution match yours'),
  agrees: z.boolean().describe('results match and the reasoning has no major gap'),
  problems: z.array(z.object({ severity: z.enum(['blocker', 'major', 'minor']), message: z.string(), suggestion: z.string() })),
  computation: codeString().optional().describe('Python that recomputes numeric final results, or empty'),
  statedValues: z.array(z.object({ name: z.string(), value: z.string() })).optional().describe('the final numeric results the given solution states, one per printed line of the computation'),
});

export function verifyPrompt(p: { language: string; statement: string; solution: string; profile?: SubjectProfile }) {
  const profile = p.profile ?? SUBJECT_PROFILES.other;
  return {
    system: `You are an independent examiner checking a textbook problem. First solve it yourself from the statement alone, then compare with the given solution. Be strict about wrong results, missing hypotheses (${profile.hypotheses}), unjustified steps and statements that lack information. Do not complain about style.`,
    prompt: `STATEMENT:
${p.statement}

GIVEN SOLUTION:
${p.solution}

Return JSON: independentAnswer (your final results, concise), resultsAgree (true when every final result of the given solution equals yours, regardless of how it is argued), agrees (true only if additionally the reasoning has no major gap), problems (each with severity, message and a concrete suggested correction, written in ${languageName(p.language)}). Empty problems when everything is right.

Also, only when the final answer is one or more numbers with a unit or a plain number (circuits, kinematics, stoichiometry and the like): computation is a short Python program, math module only, no input and no files, that computes those final values from the data in the STATEMENT, not from the given solution. It prints one line per final value, "name = value unit", with the value as a plain number in SI base units (4700 ohm, not 4.7 kohm; 0.0032 A, not 3.2 mA; kg, m, s) and the unit symbol after it. statedValues lists the same values as the GIVEN SOLUTION states them, each with the name used in the printed line and the value as written, in plain text with its unit and without LaTeX (for example "4.7 kΩ"). For every other answer (an expression, a function, an interval, a limit, a proof, a choice among options) leave computation empty and statedValues an empty list.`,
  };
}

// ---------- enrichment ----------

export const enrichPickSchema = z.object({
  graphs: z.array(z.object({ sectionId: z.string(), purpose: z.string() })),
  ide: z.array(z.object({ sectionId: z.string(), purpose: z.string() })),
});

export function enrichPickPrompt(p: { sections: string; graphs: boolean; ide: boolean; lab: 'python' | 'matlab'; maxIde: number }) {
  const ide = p.lab === 'matlab'
    ? `at most ${p.maxIde} sections for a MATLAB example. The book teaches MATLAB, so give a script to every section whose commands, functions or methods a student should try (most of them); skip only sections with nothing to run`
    : `at most ${p.maxIde} section${p.maxIde === 1 ? '' : 's'} for a Python example`;
  return {
    system: `You decide where interactive material helps students learn. Interactive graphs fit concepts students understand by exploring a function. ${p.lab === 'matlab' ? 'MATLAB examples fit commands and functions worth trying, numerical methods, matrices, plots and computations worth running.' : 'Python examples fit numerical methods, sequences and series, approximations and computations worth running.'} Choose high-value places; it is fine to choose none.`,
    prompt: `Sections (id | title | summary):
${p.sections}

Pick ${p.graphs ? 'at most 2 sections for interactive function graphs' : 'no graphs'} and ${p.ide ? ide : `no ${p.lab === 'matlab' ? 'MATLAB' : 'Python'} examples`}. Return JSON with sectionId and purpose for each.`,
  };
}

export const graphSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  functions: z.array(z.object({ fn: codeString(), label: z.string() })),
  xDomain: z.tuple([z.number(), z.number()]),
  yDomain: z.tuple([z.number(), z.number()]),
  xLabel: z.string(),
  yLabel: z.string(),
});

export function graphPrompt(p: { language: string; purpose: string; section: string }) {
  return {
    system: `You design an interactive function graph for a textbook in ${languageName(p.language)}. Expressions use the variable x, numbers, + - * / ^, parentheses, the constants e and pi, and the functions sin cos tan asin acos atan sinh cosh tanh exp log log10 sqrt cbrt abs sign floor ceil; write every multiplication with * (2*x, not 2x). The builder samples the curves, so the graph shows exactly these expressions. Choose domains that show the behaviour the text discusses.`,
    prompt: `Purpose: ${p.purpose}
Section text:
${p.section}

Return JSON: id (kebab-case), title and description in ${languageName(p.language)} (the description tells the student what to look at), functions (fn and label), xDomain, yDomain, xLabel, yLabel.`,
  };
}

export const ideSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  code: codeString(),
  expectedOutput: z.string().describe('what the program prints, exactly or approximately'),
});

/** What the MATLAB lab (numbl in the reader) can run. Functions it lacks make the check fail, so the writer avoids them. */
const MATLAB_LAB_RULES = `It runs in numbl, a MATLAB-compatible interpreter in the browser: core MATLAB only, no toolboxes (no syms, no Optimization or Statistics toolbox), no input(), no files, no network. Available: scalars, vectors and matrices, : and end indexing, element-wise operators, A\\b, lu, qr, chol, inv, det, norm, cond, eig, rank, linspace, zeros, ones, eye, diag, triu, tril, rand, size, length, numel, sum, cumsum, prod, max, min, abs, sort, find, any, all, mod, floor, round, the elementary functions, polyval, polyfit, roots, interp1, trapz, diff, meshgrid, fzero, integral, hilb, vander, magic, anonymous functions with @, for, while, if/elseif/else, switch, break, logical operators, fprintf, disp, sprintf, num2str, error, tic/toc, and 2-D plots (plot, semilogy, semilogx, loglog, bar, subplot, hold on, figure, xlabel, ylabel, title, legend, grid on, axis). Not available: format long or format short (print digits with fprintf instead), eval, fminsearch, fminbnd, spline, pchip, ode45, quad, 3-D plots (surf, mesh, plot3, contour), text annotations, input(). Define your own functions as local functions at the end of the script, after the code that calls them; a script never starts with a function. Do not rely on how MATLAB displays a value without a semicolon beyond the variable name and its value: show results with fprintf or disp.`;

export function idePrompt(p: { language: string; purpose: string; section: string; lab: 'python' | 'matlab' }) {
  const lang = languageName(p.language);
  return {
    system: p.lab === 'matlab'
      ? `You write a short MATLAB script for a textbook in ${lang} that teaches MATLAB. ${MATLAB_LAB_RULES} Under 60 lines; it prints its results (and may draw at most 2 figures). Comments, printed labels, plot titles and labels in ${lang}. Use the commands and functions the section explains, in the way it explains them.`
      : `You write a short Python 3 example for a textbook in ${lang}. It runs in Pyodide in the browser: standard library only (math, fractions, decimal, itertools, statistics), no numpy, no matplotlib, no input(), no files, no network, under 40 lines, prints its results. Comments and printed labels in ${lang}.`,
    prompt: `Purpose: ${p.purpose}
Section text:
${p.section}

Return JSON: id (kebab-case), title, description (what the student should try changing), code, expectedOutput.`,
  };
}

// ---------- review ----------

export const reviewSchema = z.object({
  issues: z.array(z.object({
    sectionId: z.string(),
    quote: z.string().describe('verbatim text from the chapter that the issue points at, max 200 chars'),
    severity: z.enum(['blocker', 'major', 'minor']),
    category: z.enum(['correctness', 'missing-hypothesis', 'unsupported', 'coverage', 'notation', 'clarity', 'repetition', 'figure', 'language']),
    message: z.string(),
    suggestion: z.string(),
  })),
});

export function reviewPrompt(p: { language: string; chapterTitle: string; chapter: string; evidence: string; objectives: string; notation?: string; handled?: string; changes?: string; program?: string; profile?: SubjectProfile }) {
  const lang = languageName(p.language);
  const profile = p.profile ?? SUBJECT_PROFILES.other;
  return {
    system: `You are an independent reviewer of a university textbook chapter written in ${lang}. You did not write it. Find real problems: wrong statements or computations, theorems missing hypotheses, claims the evidence does not support, objectives not covered, inconsistent notation, unclear explanations, repetition, figures that do not match the text, text not in ${lang}. Quote the exact text each issue refers to.

Figures (:::image blocks; a structure's alt text ends with the formula of the species drawn): report a figure whose caption, alt text or formula does not match the text, a figure that shows something wrong and a figure that adds nothing the text does not already say plainly. Use category "figure" and severity minor, or major for a figure that shows something wrong. Never report a missing figure: whether the section needs one is the writer's choice.

Statement labels (Teorema, Definizione, ...) are numbered automatically per chapter when the book is compiled; ignore their numbers in this source text.

A chapter's last section may be its exam guide ("Come viene chiesto all'esame" / "How the exam asks it"): it is written from past exam questions, not from the sources, so do not report its examples or session counts as unsupported; check its methods and its mathematics like any other section.

Calibration: report each problem once, at the place where it is, not again in every section it touches. Do not report wording you would merely phrase differently, alternative presentations or matters of taste. A missing hypothesis is a blocker only when the statement is false without it; otherwise it is major. Cases the setting already excludes are not missing hypotheses: ${profile.excluded}. Report those as minor at most. Prefer fewer, solid issues to a long list of doubtful ones.`,
    prompt: `Chapter: ${p.chapterTitle}
Objectives per section:
${p.objectives}

Notation fixed for the whole book (symbols defined here need no definition in the chapter):
${p.notation || '(standard)'}

${p.program ? `COURSE PROGRAM ITEMS the chapter's sections teach (the exam covers these and nothing else): material clearly outside them is at most a minor issue, category "coverage", saying it is outside the program; do not invent scope and do not ask for topics the program does not list.\n${p.program}\n\n` : ''}${p.changes ? `${p.changes}\n\n` : ''}${p.handled ? `${p.handled}\n\n` : ''}CHAPTER TEXT (sections are marked with their ids):
${p.chapter}

EVIDENCE the writer had (verbatim source passages):
${p.evidence}

Return JSON issues (message and suggestion in ${lang}). Blocker: wrong mathematics or a false statement in the setting the text describes, so a student who follows it gets a wrong result. Major: missing hypothesis, unsupported claim, uncovered objective, misleading explanation. Minor: everything else worth fixing. Return an empty list if the chapter is correct.`,
  };
}

// ---------- second opinion on review findings ----------

export const secondOpinionSchema = z.object({
  findings: z.array(z.object({
    index: z.number().int().min(1).describe('the number of the finding in the list'),
    verdict: z.enum(['real', 'not-real']),
    severity: z.enum(['blocker', 'major', 'minor']).describe('the severity it deserves; never higher than the one given'),
    reason: z.string().describe('one short sentence'),
  })),
});

/** A second model checks each finding of the reviewer against the text and the sources before the author sees it. */
export function secondOpinionPrompt(p: { language: string; notation?: string; findings: string; text: string; evidence: string }) {
  const lang = languageName(p.language);
  return {
    system: `You check the findings another reviewer made on a university textbook written in ${lang}. Reviewers are useful but they also invent problems. For each finding, read the quoted passage in its context and decide whether the problem is real in the text as written.

A finding is not real when the text already says what the finding asks for (here or in an earlier passage it builds on), when it misreads the text, when its counterexample needs a case the setting excludes or that the course never meets (a negative angular frequency, an open system in a chapter about closed ones, dividing by a quantity that is nonzero in the setting), or when it is a preference about wording.

Severity: blocker only if a student who follows the text gets a wrong result in the setting the text describes; major for a missing hypothesis that matters, an unsupported claim or a misleading explanation; minor for everything else. You may keep or lower the severity, never raise it. Be strict about mathematics and physics: a real error stays real even when it is small.`,
    prompt: `Notation fixed for the whole book:
${p.notation || '(standard)'}

FINDINGS:
${p.findings}

TEXT (sections are marked with their ids):
${p.text}

EVIDENCE the writer had (verbatim source passages):
${p.evidence || '(none)'}

Return JSON {"findings": [{"index": <number>, "verdict": "real"|"not-real", "severity": "blocker"|"major"|"minor", "reason": "..."}]} with one entry per finding.`,
  };
}

// ---------- check of an applied fix ----------

export const fixCheckSchema = z.object({
  changes: z.array(z.object({
    block: z.number().int().min(0).describe('the number of the changed block, from the [B..] labels'),
    verdict: z.enum(['good', 'harmful']),
    reason: z.string().describe('one short sentence'),
  })),
  issues: z.array(z.object({
    index: z.number().int().min(1).describe('the number of the issue in the list'),
    fixed: z.boolean(),
    reason: z.string().describe('one short sentence, why it is not fixed; empty when it is'),
  })),
});

/** A cheap second look at an AI fix before it replaces the text. */
/** Marks where the builder cut a long block before showing it to a model. */
export const CUT = '[… cut here by the builder for length]';

export function fixCheckPrompt(p: { language: string; issues: string; changes: string; additive?: boolean }) {
  return {
    system: `You check edits made to a university textbook written in ${languageName(p.language)}. Each edit was meant to fix a listed problem. Judge every changed block and every issue; be strict about mathematics, lenient about style.`,
    prompt: `ISSUES THE EDITS SHOULD FIX:
${p.issues}

CHANGED BLOCKS (old text, new text and the neighbouring blocks for context):
${p.changes}

The marker "${CUT}" is where the builder shortened a block for this check; it is not in the book, so never judge a block unfinished because of it.

For each changed block give a verdict. "harmful" means the new text introduces a mathematical error or a false statement, removes content the issues did not ask to remove, changes the meaning beyond what the issues asked, or adds more than one new sentence of claims, caveats or explanations the issues did not ask for. Otherwise "good".${p.additive ? ' Issues marked [add material] ask for new material (more depth, a missing proof): adding it is what they ask, so it is good when it is correct, complete and consistent with the rest of the section.' : ''}
For each issue say whether the edits fixed it ("fixed": true) or not; if not, give the reason in one short sentence.

Return JSON {"changes": [{"block": <number>, "verdict": "good"|"harmful", "reason": "..."}], "issues": [{"index": <number>, "fixed": <boolean>, "reason": "..."}]}.`,
  };
}

// ---------- revision ----------

export function revisePrompt(p: { language: string; markdown: string; requests: string; evidence: string; knownFormulas: string; sectionIds: string }) {
  return {
    system: `You revise one section of a textbook in ${languageName(p.language)}. Apply the requested changes and nothing else; keep everything that is not affected word for word, including [[nX]] markers and formula keys.\n\n${formatRules(p.language)}`,
    prompt: `REQUESTED CHANGES:
${p.requests}

EVIDENCE NOTES:
${p.evidence || '(none)'}

Known formula keys: ${p.knownFormulas || '(none)'}
Section ids you may link to: ${p.sectionIds}

CURRENT SECTION:
${p.markdown}

Return JSON {"markdown": "..."} with the full revised section.`,
  };
}

// ---------- targeted revision ----------

const patchChanges = z.array(z.object({
  block: z.number().int().min(0).describe('number of the block to replace, from the [B..] labels'),
  text: z.string().describe('the new text of that block; may hold several paragraphs; empty string removes the block'),
}));

export interface PatchAnswer { changes: z.infer<typeof patchChanges>; figures?: z.infer<ReturnType<typeof figureSchemaFor>>[] }

/** The figure specs are in the schema only when the fix may add a figure (a figure problem or an instruction), so most fixes do not carry them. */
export function patchSchemaFor(figures: FigureSetup | null): z.ZodType<PatchAnswer> {
  return figures
    ? z.object({ changes: patchChanges, figures: z.array(figureSchemaFor(schemaKinds(figures))).describe('figures the new text adds with :::image blocks; usually empty') })
    : z.object({ changes: patchChanges });
}

/** Asks only for the blocks that must change, so a fix costs a few paragraphs of output instead of the whole section. */
export function patchPrompt(p: { language: string; blocks: string; requests: string; evidence: string; knownFormulas: string; sectionIds: string; minimal?: boolean; additive?: boolean; figures?: FigureSetup | null }) {
  // Fixes for review issues stay small: new explanatory sentences were what the next review found fault with.
  const minimal = p.minimal ? ' Make the smallest edit that fixes each problem: correct or narrow the sentence at fault. Do not add caveats, explanations or new claims the problem does not ask for; at most one new sentence per problem.' : '';
  // Program problems (thin coverage, a missing proof) ask for material the section lacks. They are the one case where a fix grows the text.
  const additive = p.additive ? ' Problems marked [add material] ask for content the section lacks: write it in full (definitions, statements with every hypothesis, worked steps, the complete proof), in the style of the section, from the evidence notes when there are any and otherwise the standard version. Put it in the text of the existing block it belongs after; there is no way to add a new block. The limit of one new sentence applies to the other problems only.' : '';
  return {
    system: `You fix specific problems in one section of a textbook in ${languageName(p.language)}. The section is split into numbered blocks. Change as few blocks as possible and return only those, each rewritten in full.${minimal}${additive} Keep [[nX]] citation markers and formula keys of text you keep. Keep existing :::image blocks unchanged unless a problem is about that figure.\n\n${formatRules(p.language)}${p.figures ? `\n\nAdd a figure only when a problem or the author's instruction asks for one: put it in "figures" and an :::image block in the block it belongs to. Otherwise return an empty "figures" array.\n${figureRules(p.figures)}` : ''}`,
    prompt: `PROBLEMS TO FIX:
${p.requests}

EVIDENCE NOTES:
${p.evidence || '(none)'}

Known formula keys: ${p.knownFormulas || '(none)'}
Section ids you may link to: ${p.sectionIds}

SECTION (blocks labelled [B0], [B1], …; the labels are not part of the text):
${p.blocks}

Return JSON {"changes": [{"block": <number>, "text": "<the full new text of that block>"}]${p.figures ? ', "figures": []' : ''}}. To add a paragraph, include it in the text of the block it follows. To delete a block, return an empty text.`,
  };
}

// ---------- figures pass ----------

export const figuresPassSchemaFor = (figures: FigureSetup) => z.object({
  figures: z.array(figureSchemaFor(schemaKinds(figures)).extend({
    afterBlock: z.number().int().min(1).describe('number of the block the figure illustrates, from the [n] labels; the figure goes right after it'),
  })),
  noFigureReason: z.string().nullable().optional().describe('leave null'),
});

/** Figures for a section that is already written: the model places and designs them, the text stays as it is. */
export function figuresPassPrompt(p: { language: string; bookTitle: string; chapterTitle: string; sectionTitle: string; blocks: string; existing: string; room: number; figures: FigureSetup; elsewhere?: string }) {
  const lang = languageName(p.language);
  return {
    system: `You add figures to one section of a university textbook in ${lang}: "${p.bookTitle}". The text is final and you do not change it. You choose where figures go and design them; the builder draws them and puts each one after the block you name.

${figureRules(p.figures)}

In this task you do not write :::image blocks or any text: return each figure with "afterBlock" and the builder inserts it. Captions and alt text are in ${lang}.`,
    prompt: `CHAPTER: ${p.chapterTitle}
SECTION: ${p.sectionTitle}
Figures the section already has: ${p.existing || '(none)'}
${p.elsewhere ? `Figures other sections already show (the book never repeats a picture: do not propose any of these again, nor the same species, photo or diagram with another caption):\n${p.elsewhere}\n` : ''}
TEXT, numbered by block:
${p.blocks}

INSTRUCTIONS
- Add at most ${p.room} figure${p.room === 1 ? '' : 's'}, each right after the block it illustrates. Do not repeat what an existing figure shows.
- Every number, species, label and direction in a figure must match the text exactly.
- Return JSON: figures, noFigureReason (leave null).`,
  };
}

export const figureCheckSchema = z.object({
  figures: z.array(z.object({
    index: z.number().int().min(1),
    keep: z.boolean(),
    reason: z.string().describe('one short sentence'),
  })),
});

/** A second model decides whether each proposed figure earns its place, before any photo is searched or file drawn. */
export function figureCheckPrompt(p: { language: string; items: string; kinds?: readonly FigureKind[] }) {
  const seeing = listOf((p.kinds ?? FIGURE_KINDS).map((k) => KIND_SEEING[k]));
  return {
    system: `You check figures proposed for a university textbook in ${languageName(p.language)}. Keep a figure when it lets the student see something the passage explains: ${seeing}. Seeing these helps even when the text also describes them. The passage is the paragraph the figure follows, with the paragraphs around it. Drop a figure that is decorative, that shows something the section does not discuss, an energy-level diagram used as a flow chart or conversion scheme, that does not match the passage (another species, other numbers or labels, a wrong direction), or that adds nothing a plain sentence does not already give (a straight line for a simple proportionality, a lone ion).`,
    prompt: `PROPOSED FIGURES, each with the passage it follows (the paragraph right before the figure comes last):

${p.items}

Return JSON {"figures": [{"index": <n>, "keep": true|false, "reason": "..."}]} with one entry per figure.`,
  };
}

// ---------- outside research ----------

export const researchSchema = z.object({
  additions: z.array(z.object({
    afterBlock: z.number().int().min(0).describe('number of the block the addition follows; 0 puts it first'),
    markdown: z.string().describe('one new block of book text'),
    why: z.string().describe('one sentence: what the section lacked'),
    sources: z.array(z.object({
      url: z.string(),
      title: z.string(),
      quote: z.string().describe('verbatim sentence of plain words, without formulas, copied from the page'),
    })),
  })),
});

export function researchPrompt(p: { language: string; bookTitle: string; chapterTitle: string; sectionTitle: string; objectives: string[]; notation: string; blocks: string }) {
  const lang = languageName(p.language);
  return {
    system: `You improve one section of a university textbook in ${lang}: "${p.bookTitle}". You search the web for standard material the section lacks and support every addition with reliable pages (university course pages, textbooks, encyclopedias, standards). You never contradict the section and never invent a source or a quote.

${formatRules(p.language)}`,
    prompt: `CHAPTER: ${p.chapterTitle}
SECTION: ${p.sectionTitle}
Objectives:
${p.objectives.map((o) => `- ${o}`).join('\n') || '- (none given)'}
Notation to follow:
${p.notation || '(standard notation of the field)'}

CURRENT TEXT, numbered by block:
${p.blocks}

INSTRUCTIONS
- Use web search and read the pages you cite. Find at most 3 additions a student preparing the exam would miss: a missing hypothesis or condition, a standard counterexample, an application, a common equivalent form. Skip anything the text already says. Return no additions if the section needs none.
- Each addition is one block (a paragraph, a list or a display formula with its sentence) in ${lang}, written to fit after the block it follows, in the same style and notation. Do not add [[n]] markers or links to the text.
- For each addition give 1 or 2 sources: the page URL, its title, and one sentence copied exactly from that page (any language) that supports the addition. Pick a sentence of plain words without formulas or symbols: pages store math as markup that differs from what you read. The builder opens every URL and drops additions whose quote it cannot find there.
- Return JSON: additions.`,
  };
}
