// Prompt templates. Instructions are in English; generated book text is always in the book language.
// Bump PROMPT_VERSION when a template changes meaning, so cached results can be told apart.
import { z } from 'zod';

export const PROMPT_VERSION = 7;

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
- LaTeX must compile with KaTeX: use \\lim_{x\\to 0}, \\frac{}{}, \\sqrt{}, \\mathbb{R}, \\operatorname{dom}, \\left( \\right). No \\begin{align}; use \\begin{aligned} inside $$ when you need several aligned lines.
- Important numbered formulas use a formula block, with a short unique kebab-case key and a label in ${lang}:
:::formula{key="limite-notevole-seno" label="Limite notevole del seno"}
$$\\lim_{x\\to 0}\\frac{\\sin x}{x} = 1$$
:::
- Refer to a numbered formula with {{formula:@its-key}}, with a space before and after. Only reference keys that exist in this text or in the list of known keys you are given.
- Link to another section with [testo](ref:section/<sectionId>) using the section ids you are given. No external links.
- Write statement labels (${language === 'it' ? 'Definizione, Teorema, Esempio, Errore tipico, ...' : 'Definition, Theorem, Example, Common mistake, ...'}) without numbers, e.g. ${label}. The builder numbers them per chapter, so never cite a statement by its number; name it instead.
- Bold with **word**, with a space or punctuation outside the asterisks. Never leave an unmatched **.
- Lists with "- " or "1. ". No tables (the reader cannot show them): turn tabular data into a list or prose. No code fences, no HTML, no images except the figure blocks described below.
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
      subsections: z.array(z.object({ title: z.string(), objectives: z.array(z.string()) })),
    })),
  })),
  exclusions: z.array(z.object({ topic: z.string(), reason: z.string() })),
});

export function outlinePrompt(p: { title: string; subject: string; language: string; audience: string; goals: string; topics: string; indexes: string; sessions: number }) {
  const lang = languageName(p.language);
  return {
    system: `You are the editor of a university textbook written in ${lang}. You design the book's common index from the course's sources and its exam history. The index must respect prerequisites, cover every topic the course needs, and give more depth to topics that the exams test often, without dropping topics the exams never test.`,
    prompt: `Book: ${p.title} (${p.subject})
Audience: ${p.audience || 'university students preparing the exam'}
Author's goals: ${p.goals || '(none given)'}

Topics (key | name | exam sessions where it appears, out of ${p.sessions} | prerequisites):
${p.topics}

Source indexes, for reference (the book may reorganize them):
${p.indexes}

Design the book:
- Chapters in teaching order; each chapter has 3-8 sections; each section covers one or a few closely related topic keys and has 1-4 concrete learning objectives (what the student can do afterwards).
- depth: "deep" for topics in many exam sessions or that are hard, "brief" for background, "standard" otherwise.
- Subsections only where a section clearly has distinct parts.
- Every topic key appears in some section, or in exclusions with a reason.
- notation: the conventions to use throughout (e.g. how to write the domain, intervals, derivatives, limits), in ${lang}.
- Titles in ${lang}, short, without numbering. slug: kebab-case from the chapter title.`,
  };
}

// ---------- section drafting ----------

export const draftSchema = z.object({
  markdown: z.string().describe('the section body in PoliTost source Markdown, with [[nX]] citation markers'),
  figures: z.array(z.object({
    key: z.string().describe('kebab-case, used as file name'),
    caption: z.string(),
    alt: z.string(),
    plot: z.object({
      xRange: z.tuple([z.number(), z.number()]),
      yRange: z.tuple([z.number(), z.number()]),
      xLabel: z.string().nullable(),
      yLabel: z.string().nullable(),
      functions: z.array(z.object({ expr: z.string(), label: z.string().nullable(), domain: z.tuple([z.number(), z.number()]).nullable(), style: z.enum(['solid', 'dashed']).nullable() })),
      points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().nullable(), open: z.boolean().nullable() })).nullable(),
      asymptotes: z.array(z.object({ kind: z.enum(['vertical', 'horizontal']), value: z.number(), label: z.string().nullable() })).nullable(),
    }),
  })),
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
  figures: boolean;
  outside: boolean;
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
- Where the sources disagree, follow the course notes and mention the other convention in one sentence.
- ${p.figures ? 'If a function graph would help (a limit, an asymptote, a discontinuity, a derivative as slope), request up to 2 figures in "figures" and place each one in the text with :::image{src="assets/<key>.svg" alt="<alt>" caption="<caption>"} followed by a line with ::: on its own. Captions and alt text are plain text without $ or LaTeX (write "sin(x)/x", "x → 0"); do not number figures, the builder does. Plot expressions use x, + - * / ^, and functions sin cos tan asin acos atan exp log sqrt abs sign floor; the plot must match the text exactly.' : 'Do not add figures; return an empty "figures" array.'}
- Return JSON: markdown (the section body, without the section title), figures, summary.`,
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

Write ${p.count} problems in total, distributing them as requested across topics and difficulties (facile, medio, difficile). Statement, hint (${p.kind === 'exam' ? 'always empty: exams have no hints' : 'one or two sentences that point the way without solving'}) and solution (every step, with the final result clearly stated) are separate fields in source Markdown without headings. Check every computation; prefer problems whose answer can be checked (a number, a limit, an interval, a function). Return JSON.`,
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

export const verifySchema = z.object({
  independentAnswer: z.string(),
  resultsAgree: z.boolean().describe('the final results of the given solution match yours'),
  agrees: z.boolean().describe('results match and the reasoning has no major gap'),
  problems: z.array(z.object({ severity: z.enum(['blocker', 'major', 'minor']), message: z.string(), suggestion: z.string() })),
});

export function verifyPrompt(p: { language: string; statement: string; solution: string }) {
  return {
    system: 'You are an independent examiner checking a textbook problem. First solve it yourself from the statement alone, then compare with the given solution. Be strict about wrong results, missing hypotheses (domains, continuity, convergence), unjustified steps and statements that lack information. Do not complain about style.',
    prompt: `STATEMENT:
${p.statement}

GIVEN SOLUTION:
${p.solution}

Return JSON: independentAnswer (your final results, concise), resultsAgree (true when every final result of the given solution equals yours, regardless of how it is argued), agrees (true only if additionally the reasoning has no major gap), problems (each with severity, message and a concrete suggested correction, written in ${languageName(p.language)}). Empty problems when everything is right.`,
  };
}

// ---------- enrichment ----------

export const enrichPickSchema = z.object({
  graphs: z.array(z.object({ sectionId: z.string(), purpose: z.string() })),
  ide: z.array(z.object({ sectionId: z.string(), purpose: z.string() })),
});

export function enrichPickPrompt(p: { sections: string; graphs: boolean; ide: boolean }) {
  return {
    system: 'You decide where interactive material helps students learn. Interactive graphs fit concepts students understand by exploring a function. Python examples fit numerical methods, sequences and series, approximations and computations worth running. Choose few, high-value places; it is fine to choose none.',
    prompt: `Sections (id | title | summary):
${p.sections}

Pick ${p.graphs ? 'at most 2 sections for interactive function graphs' : 'no graphs'} and ${p.ide ? 'at most 1 section for a Python example' : 'no Python examples'}. Return JSON with sectionId and purpose for each.`,
  };
}

export const graphSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  functions: z.array(z.object({ fn: z.string(), label: z.string() })),
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
  code: z.string(),
  expectedOutput: z.string().describe('what the program prints, exactly or approximately'),
});

export function idePrompt(p: { language: string; purpose: string; section: string }) {
  return {
    system: `You write a short Python 3 example for a textbook in ${languageName(p.language)}. It runs in Pyodide in the browser: standard library only (math, fractions, decimal, itertools, statistics), no numpy, no matplotlib, no input(), no files, no network, under 40 lines, prints its results. Comments and printed labels in ${languageName(p.language)}.`,
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

export function reviewPrompt(p: { language: string; chapterTitle: string; chapter: string; evidence: string; objectives: string; notation?: string; handled?: string; changes?: string }) {
  const lang = languageName(p.language);
  return {
    system: `You are an independent reviewer of a university textbook chapter written in ${lang}. You did not write it. Find real problems: wrong statements or computations, theorems missing hypotheses, claims the evidence does not support, objectives not covered, inconsistent notation, unclear explanations, repetition, figures that do not match the text, text not in ${lang}. Quote the exact text each issue refers to.

Statement labels (Teorema, Definizione, ...) are numbered automatically per chapter when the book is compiled; ignore their numbers in this source text.

Calibration: report each problem once, at the place where it is, not again in every section it touches. Do not report wording you would merely phrase differently, alternative presentations or matters of taste. A missing hypothesis is a blocker only when the statement is false without it; otherwise it is major. Prefer fewer, solid issues to a long list of doubtful ones.`,
    prompt: `Chapter: ${p.chapterTitle}
Objectives per section:
${p.objectives}

Notation fixed for the whole book (symbols defined here need no definition in the chapter):
${p.notation || '(standard)'}

${p.changes ? `${p.changes}\n\n` : ''}${p.handled ? `${p.handled}\n\n` : ''}CHAPTER TEXT (sections are marked with their ids):
${p.chapter}

EVIDENCE the writer had (verbatim source passages):
${p.evidence}

Return JSON issues (message and suggestion in ${lang}). Blocker: wrong mathematics or a false statement. Major: missing hypothesis, unsupported claim, uncovered objective, misleading explanation. Minor: everything else worth fixing. Return an empty list if the chapter is correct.`,
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
export function fixCheckPrompt(p: { language: string; issues: string; changes: string }) {
  return {
    system: `You check edits made to a university textbook written in ${languageName(p.language)}. Each edit was meant to fix a listed problem. Judge every changed block and every issue; be strict about mathematics, lenient about style.`,
    prompt: `ISSUES THE EDITS SHOULD FIX:
${p.issues}

CHANGED BLOCKS (old text, new text and the neighbouring blocks for context):
${p.changes}

For each changed block give a verdict. "harmful" means the new text introduces a mathematical error or a false statement, removes content the issues did not ask to remove, or changes the meaning beyond what the issues asked. Otherwise "good".
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

export const patchSchema = z.object({
  changes: z.array(z.object({
    block: z.number().int().min(0).describe('number of the block to replace, from the [B..] labels'),
    text: z.string().describe('the new text of that block; may hold several paragraphs; empty string removes the block'),
  })),
});

/** Asks only for the blocks that must change, so a fix costs a few paragraphs of output instead of the whole section. */
export function patchPrompt(p: { language: string; blocks: string; requests: string; evidence: string; knownFormulas: string; sectionIds: string }) {
  return {
    system: `You fix specific problems in one section of a textbook in ${languageName(p.language)}. The section is split into numbered blocks. Change as few blocks as possible and return only those, each rewritten in full. Keep [[nX]] citation markers and formula keys of text you keep.\n\n${formatRules(p.language)}`,
    prompt: `PROBLEMS TO FIX:
${p.requests}

EVIDENCE NOTES:
${p.evidence || '(none)'}

Known formula keys: ${p.knownFormulas || '(none)'}
Section ids you may link to: ${p.sectionIds}

SECTION (blocks labelled [B0], [B1], …; the labels are not part of the text):
${p.blocks}

Return JSON {"changes": [{"block": <number>, "text": "<the full new text of that block>"}]}. To add a paragraph, include it in the text of the block it follows. To delete a block, return an empty text.`,
  };
}
