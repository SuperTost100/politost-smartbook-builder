import katex from 'katex';
import { isValidAssetPath, parseChapterMarkdown } from '@politost/content-core';
import type { LintFinding } from './types.ts';
import { extractMath, isTableSeparator, parseAttrs, scan, type LineKind, type Scan, type ScannedLine } from './scan.ts';

// ---------------------------------------------------------------------------------------------
// Rule ids (stable, used by the UI)
// ---------------------------------------------------------------------------------------------

export const LINT_RULES = [
  'formula-malformed',
  'meta-leak',
  'bold-unpaired',
  'formula-ref-unknown',
  'colon-dangling',
  'unicode-math',
  'code-fence',
  'math-mixed',
  'katex',
  'heading-level',
  'image',
  'table',
  'language-drift',
  'empty-section',
  'duplicate-ide',
  'duplicate-graph',
  'section-ref-unknown',
  'exercise-fence',
] as const;
export type LintRule = (typeof LINT_RULES)[number];

export interface LintSectionOptions {
  sectionId: string;
  language: string;
  /** Book-wide set of formula keys. Without it, @key refs are not checked against the book. */
  knownFormulaKeys?: Set<string>;
  /** Rule ids to skip (used by the compiler, which reports reference problems itself). */
  skipRules?: string[];
}

/** Quality lints on source-dialect Markdown for one section. language: book language code. */
export function lintSection(markdown: string, opts: LintSectionOptions): LintFinding[] {
  return lintText(markdown, {
    file: opts.sectionId,
    mode: 'source',
    language: opts.language,
    knownKeys: opts.knownFormulaKeys,
    skip: new Set(opts.skipRules ?? []),
  });
}

/** Lints for one part (statement, hint or solution) of a question written in source dialect. */
export function lintQuestionText(markdown: string, opts: { file: string; language: string; knownFormulaKeys?: Set<string>; skipRules?: string[] }): LintFinding[] {
  return lintText(markdown, { file: opts.file, mode: 'question', language: opts.language, knownKeys: opts.knownFormulaKeys, skip: new Set(opts.skipRules ?? []) });
}

// ---------------------------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------------------------

type Mode = 'source' | 'chapter' | 'exercises' | 'question';

interface TextLintOptions {
  file: string;
  mode: Mode;
  language?: string;
  knownKeys?: Set<string>;
  skip?: Set<string>;
}

const SEVERITY: Record<string, LintFinding['severity']> = {
  'formula-malformed': 'blocker',
  katex: 'blocker',
  'formula-ref-unknown': 'blocker',
  'section-ref-unknown': 'blocker',
  'meta-leak': 'blocker',
  'code-fence': 'blocker',
  image: 'blocker',
  'exercise-fence': 'blocker',
  'colon-dangling': 'major',
  'unicode-math': 'major',
  'bold-unpaired': 'major',
  'language-drift': 'major',
  'duplicate-ide': 'major',
  'duplicate-graph': 'major',
  'heading-level': 'minor',
  'math-mixed': 'minor',
  table: 'minor',
  'empty-section': 'minor',
};

function quoteOf(s: string, max = 200): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function mk(rule: LintRule, file: string, message: string, line?: number, quote?: string, severity?: LintFinding['severity']): LintFinding {
  const f: LintFinding = { rule, severity: severity ?? SEVERITY[rule] ?? 'minor', message, file };
  if (line !== undefined) f.line = line;
  if (quote !== undefined) f.quote = quoteOf(quote);
  return f;
}

export function langOf(language: string | undefined): 'it' | 'en' | null {
  const l = (language ?? '').trim().toLowerCase();
  if (/^(it|ita)/.test(l)) return 'it';
  if (/^(en|eng)/.test(l)) return 'en';
  return null;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NUMERIC_ID_RE = /^\d+\.\d+$/;

// -- meta leak ---------------------------------------------------------------------------------

interface MetaPattern {
  test: (line: string) => boolean;
  why: string;
}
const re = (r: RegExp) => (line: string) => r.test(line);

const META_PATTERNS: MetaPattern[] = [
  { test: re(/(Riepilogo|Sintesi|Sommario|Riassunto)\s+del\s+lavoro\s+svolto/i), why: 'summary of the work done' },
  { test: re(/\b(Il testo sorgente è stato|Ho riscritto|Sono stati inseriti \d+ blocchi)/i), why: 'commentary on the rewrite' },
  { test: re(/\bNON includere\b/), why: 'prompt instruction leaked' },
  { test: re(/\btesto sorgente\b/i), why: 'mentions the "source text"' },
  { test: re(/\b(?:il|questo|quel)\s+(?:testo|paragrafo|contenuto|brano)\s+(?:sorgente|originale|originario|di partenza)\s+(?:è stato|è stata|sono stati)\b/i), why: 'commentary on the rewrite' },
  { test: re(/\bho\s+(?:riscritto|riformulato|rielaborato|riadattato|parafrasato|rispettato i vincoli|strutturato il)\b/i), why: 'first-person commentary on the rewrite' },
  { test: re(/^\s*(?:\*\*)?Ecco(?:\s+qui|\s+di seguito)?\s+(?:la|una|il|un|lo)?\s*(?:nuov[oa]\s+|rielaborat[oa]\s+|riscritt[oa]\s+|riformulat[oa]\s+|corrett[oa]\s+)?(?:versione|testo|paragrafo|riscrittura|rielaborazione|bozza)\b/i), why: 'chat-style lead-in' },
  { test: (l) => /\bcome richiesto\b/i.test(l) && /\b(ho|abbiamo|versione|testo|paragraf\w*|prompt|istruzion\w*)\b/i.test(l), why: '"come richiesto" about the writing task' },
  { test: re(/\bin questa versione\b[^.\n]*\b(?:ho|abbiamo|è stato|sono stati|sono state|rispetto|originale|sorgente)\b/i), why: 'commentary on the version' },
  { test: re(/\b(?:testo|paragrafo|contenuto|versione|spiegazione)\b[^.\n]{0,60}\b(?:riformulat|riscritt|rielaborat|riadattat|parafrasat)\w*/i), why: 'commentary on the rewrite' },
  { test: re(/^\s*(?:\*\*)?(?:Certo|Certamente|Va bene|Perfetto)[!,.]\s+(?:ecco|ho|di seguito)\b/i), why: 'chat-style lead-in' },
  { test: re(/^\s*(?:\*\*)?(?:Here(?:'s| is| are)|Below is|Sure[,!]|Certainly[,!]|Of course[,!])\s[^.\n]{0,80}\b(?:rewritten|revised|rewrite|rephrased|version|text|paragraph|draft)\b/i), why: 'chat-style lead-in' },
  { test: (l) => /\bas requested\b/i.test(l) && /\b(I|I've|here|below|version|text|paragraph|rewritten|revised|draft)\b/i.test(l), why: '"as requested" about the writing task' },
  { test: re(/\bI(?:'ve| have)\s+(?:rewritten|rephrased|revised|reformulated|kept|added|inserted|followed|preserved|removed|corrected)\b|\bI\s+(?:rewrote|rephrased|reformulated|revised)\b/), why: 'first-person commentary on the rewrite' },
  { test: re(/\bin this (?:version|rewrite|revision)\b/i), why: 'commentary on the version' },
  { test: re(/\bsource text\b|\boriginal text (?:has|was) been\b/i), why: 'mentions the "source text"' },
  { test: re(/^\s*(?:\*\*)?(?:Note|Nota)(?:\*\*)?\s*:\s*(?:I\b|I'|this (?:version|text|rewrite)|the (?:source|original) text|ho\b|il testo|questa versione|le formule numerate|i blocchi)/i), why: 'note addressed to the user' },
  { test: re(/\bvincoli strutturali dello Smartbook\b|\bil paragrafo inizia con l'intestazione\b/i), why: 'commentary on the format rules' },
];

const META_INLINE_CODE = /`[^`]*(?:## p\d+|:::formula|:::exercise|\{\{formula)[^`]*`/;

// -- unicode math ------------------------------------------------------------------------------

const UNICODE_MATH =
  /[Ͱ-Ͽἀ-῿←-⇿∀-⋿⟀-⟯⦀-⧿⨀-⫿⃐-⃿ℂℏℑℓℕℚℜℝℤℵ×÷±]/gu;
const UNIT_SYMBOLS = new Set(['Ω', 'μ', 'Ω', 'µ']);

function unicodeMathChars(masked: string): string[] {
  const found = new Set<string>();
  for (const m of masked.matchAll(UNICODE_MATH)) {
    const ch = m[0];
    const idx = m.index ?? 0;
    const before = masked.slice(0, idx).replace(/\s+$/, '');
    if (UNIT_SYMBOLS.has(ch) && /\d$/.test(before)) continue; // "10 Ω", "5 μm"
    // chemical/biological names such as "α-elica", "β-carotene"
    if (/[Ͱ-Ͽ]/.test(ch) && /^-\p{L}/u.test(masked.slice(idx + ch.length, idx + ch.length + 2))) continue;
    found.add(ch);
  }
  return [...found];
}

// -- language drift ----------------------------------------------------------------------------

const EN_STOP = new Set(
  'the of and to is that for with are this by be it from which or we if then where when has have not you will each an was were can but they their there these those into than such its also our your do does'.split(' '),
);
const IT_STOP = new Set(
  'il lo gli le di del della dello dei degli delle che per un una uno con è sono da non si come al alla ai nel nella nei nelle più ma anche quindi quando dove questo questa questi queste essere ha hanno può possono se'.split(' '),
);

function stopRatios(text: string): { words: number; en: number; it: number } {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let en = 0;
  let it = 0;
  for (const w of words) {
    if (EN_STOP.has(w)) en++;
    if (IT_STOP.has(w)) it++;
  }
  return { words: words.length, en: en / Math.max(1, words.length), it: it / Math.max(1, words.length) };
}

// -- katex -------------------------------------------------------------------------------------

const katexCache = new Map<string, string | null>();
/** Same call content-core's validateChapter makes, minus the console noise of strict "warn". */
export function katexError(tex: string, display: boolean): string | null {
  const key = `${display ? 'D' : 'I'}:${tex}`;
  const hit = katexCache.get(key);
  if (hit !== undefined) return hit;
  let err: string | null = null;
  const warn = console.warn;
  console.warn = () => {}; // KaTeX warns about glyphs without metrics even when it does not throw
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: display, strict: 'ignore' });
  } catch (e) {
    err = (e as Error).message;
  } finally {
    console.warn = warn;
  }
  if (katexCache.size > 5000) katexCache.clear();
  katexCache.set(key, err);
  return err;
}

// -- main text linter --------------------------------------------------------------------------

const REF_HOVER = /\{\{formula:(@?)([^}\s]*)\}\}/g;
const REF_LINK_FORMULA = /\]\(ref:formula\/(@?)([^)\s]*)\)/g;

function lintText(markdown: string, o: TextLintOptions): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (f: LintFinding) => {
    if (!o.skip?.has(f.rule)) out.push(f);
  };
  const sc: Scan = scan(markdown);
  const { lines } = sc;
  const file = o.file;
  const prose = (k: LineKind) => k === 'text' || k === 'list' || k === 'heading' || k === 'table';

  // formula blocks -------------------------------------------------------------------------
  const localKeys = new Set<string>();
  for (const fb of sc.formulas) {
    const quote = lines[fb.index].raw;
    if (o.mode === 'exercises' || o.mode === 'question') {
      add(mk('formula-malformed', file, 'Numbered formula blocks are not supported inside exercises; use inline math.', fb.line, quote));
      continue;
    }
    if (fb.openProblem) {
      add(mk('formula-malformed', file, `Malformed :::formula opening: ${fb.openProblem}. Expected ${o.mode === 'source' ? ':::formula{key="slug" label="..."}' : ':::formula{id="N.M" label="..."}'}.`, fb.line, quote));
      continue;
    }
    const { key, id, label } = fb.attrs;
    if (o.mode === 'source') {
      if (id !== undefined) add(mk('formula-malformed', file, 'Source dialect formulas use key="slug", never id="N.M": the compiler assigns the number.', fb.line, quote));
      if (key === undefined) {
        if (id === undefined) add(mk('formula-malformed', file, 'Formula has no key attribute.', fb.line, quote));
      } else if (!KEY_RE.test(key)) {
        add(mk('formula-malformed', file, `Formula key "${key}" must use letters, digits, "-" and "_".`, fb.line, quote));
      } else {
        if (localKeys.has(key)) add(mk('formula-malformed', file, `Duplicate formula key "${key}" in this section.`, fb.line, quote));
        localKeys.add(key);
      }
    } else if (id === undefined || !NUMERIC_ID_RE.test(id)) {
      add(mk('formula-malformed', file, 'Formula id must look like "N.M".', fb.line, quote));
    }
    if (label === undefined || !label.trim()) add(mk('formula-malformed', file, 'Formula has no label.', fb.line, quote));
    else if (label.includes('}')) add(mk('formula-malformed', file, 'Formula label cannot contain "}".', fb.line, quote));
    if (!fb.closed) {
      add(mk('formula-malformed', file, fb.gluedCloseLine
        ? `Formula block is not closed: line ${fb.gluedCloseLine} has text after the closing ":::". The ::: must be alone on its line.`
        : 'Formula block is not closed with a ::: line.', fb.line, fb.gluedCloseLine ? lines[fb.gluedCloseLine - 1].raw : quote));
      continue;
    }
    const body = fb.body.join('\n');
    const m = /\$\$([\s\S]*?)\$\$/.exec(body);
    if (!m) add(mk('formula-malformed', file, 'Formula block has no $$ ... $$ body.', fb.line, quote));
    else if (!m[1].trim()) add(mk('formula-malformed', file, 'Formula body is empty.', fb.line, quote));
    else {
      const rest = body.replace(m[0], '').trim();
      if (rest) add(mk('formula-malformed', file, 'Text next to the $$ body inside a formula block is dropped by the reader.', fb.line, rest));
    }
  }

  // line rules -----------------------------------------------------------------------------
  for (const l of lines) {
    const t = l.raw;
    if (l.kind === 'code-fence') {
      add(mk('code-fence', file, 'Code fences are not supported by the reader.', l.n, t));
      continue;
    }
    if (l.kind === 'math' || l.kind === 'formula-body') continue;
    if (/^\s*:{4,}\s*\w/.test(t)) add(mk('formula-malformed', file, 'Block fences use exactly three colons (:::).', l.n, t));

    // meta leak (HTML comments everywhere, patterns on prose)
    if (/<!--/.test(t)) add(mk('meta-leak', file, 'HTML comment in content.', l.n, t));
    if (prose(l.kind) || l.kind === 'fence-open') {
      let hit: string | null = null;
      for (const p of META_PATTERNS) {
        if (p.test(t)) {
          hit = p.why;
          break;
        }
      }
      if (!hit && META_INLINE_CODE.test(t)) hit = 'format directives quoted in code';
      if (hit) add(mk('meta-leak', file, `Model commentary leaked into the content (${hit}).`, l.n, t));
    }

    if (prose(l.kind)) {
      // bold
      const stars = (l.masked.match(/\*\*/g) ?? []).length;
      if (stars % 2 !== 0) add(mk('bold-unpaired', file, 'Unpaired ** bold marker; the reader would show it literally.', l.n, t));

      // unicode math
      const chars = unicodeMathChars(l.masked);
      if (chars.length) add(mk('unicode-math', file, `Math symbols outside $...$: ${chars.join(' ')}. Write them as LaTeX inside $...$.`, l.n, t));

      // markdown images
      if (/!\[[^\]]*\]\([^)]*\)/.test(l.masked)) add(mk('image', file, 'Markdown images are not allowed; use a :::image block with an asset.', l.n, t));
    }

    // headings
    if (l.kind === 'heading') {
      const hm = /^(#{1,6})\s/.exec(t)!;
      const level = hm[1].length;
      if (o.mode === 'source') {
        if (/^## p\d+ \|/.test(t)) add(mk('heading-level', file, 'Paragraph headings (## pN | ...) are added by the compiler; remove it.', l.n, t, 'blocker'));
        else if (level !== 3) add(mk('heading-level', file, `Only "###" headings are allowed inside a section (found level ${level}).`, l.n, t));
      } else if (o.mode === 'chapter') {
        if (!(level === 2 && /^## p\d+ \| \S/.test(t)) && level !== 3) add(mk('heading-level', file, `Unexpected heading level ${level}; only "## pN | Title" and "###" are used.`, l.n, t));
      } else if (o.mode === 'question') {
        add(mk('heading-level', file, 'Headings are not used inside exercise text.', l.n, t));
      } else if (level !== 2 || !/^## Domanda\s*$/.test(t)) {
        if (level !== 3) add(mk('heading-level', file, 'Unexpected heading inside an exercise.', l.n, t));
      }
    }

    // images
    if (l.kind === 'image-open') {
      const im = /^:::image\{(.*)\}\s*$/.exec(t.trim());
      if (!im) {
        add(mk('image', file, 'Malformed :::image line; expected :::image{src="assets/x.png" alt="..."}.', l.n, t));
      } else {
        const a = parseAttrs(im[1]);
        if (!a.src) add(mk('image', file, 'Image has no src.', l.n, t));
        else if (!a.src.startsWith('assets/')) add(mk('image', file, `Image src must start with assets/ (found "${a.src}"); external files and URLs are not allowed.`, l.n, t));
        else if (!isValidAssetPath(a.src)) add(mk('image', file, `Image src "${a.src}" must be assets/<name> with .png, .jpg, .jpeg, .webp or .svg.`, l.n, t));
        if (!a.alt || !a.alt.trim()) add(mk('image', file, 'Image has no alt text.', l.n, t));
      }
      const next = lines[l.n]; // line after (index = n)
      if (!next || next.kind !== 'image-close') add(mk('image', file, 'Image block must be followed by a ::: line.', l.n, t));
      if (o.mode === 'exercises' || o.mode === 'question') add(mk('exercise-fence', file, 'Image blocks cannot be nested inside exercises (the reader cannot parse them).', l.n, t));
    }
  }

  // exercise fences: formula/other fences inside exercises break the reader's fence matcher
  if (o.mode === 'exercises') {
    let depth = 0;
    for (const l of lines) {
      const t = l.raw.trim();
      if (l.kind === 'fence-open' && /^:::(exercise|hint|solution)\b/.test(t)) depth++;
      else if (l.kind === 'fence-open' && depth > 0) {
        add(mk('exercise-fence', file, `Unsupported block "${t.split('{')[0]}" inside an exercise.`, l.n, t));
      } else if (l.kind === 'fence-close') depth--;
    }
    if (depth !== 0) add(mk('exercise-fence', file, 'Unbalanced ::: fences in exercises.', lines.length || 1));
  }

  if (o.mode === 'question') {
    for (const l of lines) {
      if (l.kind === 'fence-open' || l.kind === 'fence-close') add(mk('exercise-fence', file, 'Block fences (:::) are added by the compiler; do not write them in exercise text.', l.n, l.raw));
    }
  }

  // tables ---------------------------------------------------------------------------------
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind !== 'table') continue;
    const prev = lines[i - 1];
    if (prev && prev.kind === 'table') continue;
    let j = i;
    while (j < lines.length && lines[j].kind === 'table') j++;
    const rows = lines.slice(i, j);
    if (rows.length >= 2 && rows.some((r) => isTableSeparator(r.raw))) {
      add(mk('table', file, 'Markdown tables are not supported by the reader; rewrite as a list or prose.', l.n, l.raw));
    }
  }

  // math: katex, unbalanced $, mixed -------------------------------------------------------
  const body = mathText(lines);
  for (const span of extractMath(body.text)) {
    if (!span.tex) {
      add(mk('katex', file, span.display ? 'Empty display math.' : 'Empty inline math.', body.map[span.line - 1], '$$ $$'));
      continue;
    }
    const err = katexError(span.tex, span.display);
    if (err) {
      add(mk('katex', file, `${span.display ? 'Display' : 'Inline'} math does not render: ${err.replace(/^KaTeX parse error:\s*/, '')}`, body.map[span.line - 1], span.tex));
    }
  }
  for (const l of lines) {
    if (!prose(l.kind)) continue;
    // A single "$" left after masking means an unclosed inline math (or a currency sign).
    const stray = /\$/.test(l.masked.replace(/\$\$/g, ''));
    if (stray) add(mk('katex', file, 'Unbalanced "$": inline math must open and close on the same line.', l.n, l.raw, 'major'));
  }

  // math-mixed: display $$ and inline $ in the same block
  for (const blk of blocksOf(lines, ['text', 'list', 'math'])) {
    const hasDisplay = blk.some((l) => l.kind === 'math' || /\$\$/.test(l.raw));
    if (!hasDisplay) continue;
    const hasInline = blk.some((l) => {
      if (l.kind === 'math') {
        // inline math after a closing $$ on the same line
        return false;
      }
      return /(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)/.test(l.raw.replace(/\$\$[\s\S]*?\$\$/g, ''));
    });
    // multi-line display followed by prose with inline math, without a blank line
    if (hasInline) {
      add(mk('math-mixed', file, 'Display math ($$) and inline math ($) in the same block; separate them with a blank line.', blk[0].n, blk.map((l) => l.raw).join(' ')));
    }
  }

  // refs -----------------------------------------------------------------------------------
  if (o.mode === 'source' || o.mode === 'question') {
    for (const l of lines) {
      if (!prose(l.kind)) continue;
      for (const m of l.raw.matchAll(REF_HOVER)) checkFormulaRef(m[1] === '@', m[2], m[0], l.n);
      for (const m of l.raw.matchAll(REF_LINK_FORMULA)) checkFormulaRef(m[1] === '@', m[2], m[0], l.n);
    }
  }
  function checkFormulaRef(at: boolean, key: string, text: string, line: number) {
    if (!at) {
      add(mk('formula-ref-unknown', file, `Formula references use the symbolic key ({{formula:@key}}, ref:formula/@key), not the number "${key}".`, line, text));
      return;
    }
    if (o.knownKeys && !o.knownKeys.has(key) && !localKeys.has(key)) {
      add(mk('formula-ref-unknown', file, `No formula with key "${key}" exists in the book.`, line, text));
    }
  }

  // colon-dangling -------------------------------------------------------------------------
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind !== 'text') continue;
    const next = lines[i + 1];
    if (next && next.kind === 'text') continue; // same paragraph continues
    if (/^\s*\*\*[^*]+(?::\*\*|\*\*:)\s*$/.test(l.masked)) continue; // a bold label such as "**Esempio:**"
    const trimmed = l.masked.replace(/\*+\s*$/, '').trimEnd();
    if (!trimmed.endsWith(':') || trimmed.endsWith('::')) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].kind === 'blank') j++;
    const nk = lines[j];
    const ok = nk && (nk.kind === 'formula-open' || nk.kind === 'heading' || nk.kind === 'math' || nk.kind === 'list' || nk.kind === 'image-open' || nk.kind === 'table' || nk.kind === 'code-fence' || /^\s*\$/.test(nk.raw));
    if (!ok) add(mk('colon-dangling', file, 'Paragraph ends with ":" but no formula, list or figure follows.', l.n, l.raw));
  }

  // language drift -------------------------------------------------------------------------
  const lang = langOf(o.language);
  if (lang && o.mode !== 'exercises' && o.mode !== 'chapter') {
    for (const blk of blocksOf(lines, ['text', 'list'])) {
      const text = blk.map((l) => l.masked).join(' ');
      const r = stopRatios(text);
      if (r.words <= 20) continue;
      if (lang === 'it' && r.en >= 0.25 && r.it <= 0.06) {
        add(mk('language-drift', file, 'Paragraph looks English in an Italian book.', blk[0].n, blk.map((l) => l.raw).join(' ')));
      } else if (lang === 'en' && r.it >= 0.25 && r.en <= 0.06) {
        add(mk('language-drift', file, 'Paragraph looks Italian in an English book.', blk[0].n, blk.map((l) => l.raw).join(' ')));
      }
    }
  }

  // empty section --------------------------------------------------------------------------
  if (o.mode === 'source') {
    const content = lines.some((l) => !['blank', 'heading'].includes(l.kind));
    if (!content) add(mk('empty-section', file, 'Section has no content.', 1));
  }

  out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return out;
}

/** Group consecutive lines of the given kinds (a block ends at any other kind). */
function blocksOf(lines: ScannedLine[], kinds: LineKind[]): ScannedLine[][] {
  const blocks: ScannedLine[][] = [];
  let cur: ScannedLine[] = [];
  for (const l of lines) {
    if (kinds.includes(l.kind)) cur.push(l);
    else if (cur.length) {
      blocks.push(cur);
      cur = [];
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

/** The lines that can carry math (everything but formula tags and fences), with a map back to source lines. */
function mathText(lines: ScannedLine[]): { text: string; map: number[] } {
  const kept = lines.filter((l) => l.kind !== 'formula-open' && l.kind !== 'formula-close' && l.kind !== 'code-fence');
  return { text: kept.map((l) => l.raw).join('\n'), map: kept.map((l) => l.n) };
}

// ---------------------------------------------------------------------------------------------
// Compiled books
// ---------------------------------------------------------------------------------------------

const dec = new TextDecoder();
function asText(v: string | Uint8Array | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : dec.decode(v);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface LintCompiledOptions {
  /** Run the per-file content rules (default true). */
  content?: boolean;
  /** Run reference and asset integrity checks (default true). */
  integrity?: boolean;
  /** Run duplicate IDE/graph detection (default true). */
  duplicates?: boolean;
}

/** Lints on a compiled book (cross-chapter rules such as duplicated IDE/graph payloads). */
export function lintCompiled(files: Record<string, string | Uint8Array>, opts: LintCompiledOptions = {}): LintFinding[] {
  const doContent = opts.content !== false;
  const doIntegrity = opts.integrity !== false;
  const doDup = opts.duplicates !== false;
  const out: LintFinding[] = [];

  const chapterPaths = Object.keys(files).filter((p) => /^chapters\/.+\.md$/.test(p)).sort();

  if (doContent) {
    for (const p of chapterPaths) out.push(...lintText(asText(files[p])!, { file: p, mode: 'chapter' }));
    for (const p of ['esercizi.md', 'esami.md']) {
      const t = asText(files[p]);
      if (t) out.push(...lintText(t.replace(/^---[\s\S]*?---\n*/, (fm) => fm.replace(/[^\n]/g, ' ')), { file: p, mode: 'exercises' }));
    }
  }

  if (doIntegrity) {
    // Book-wide index.
    const formulaIds = new Map<string, string>(); // id -> file
    const chapters: { path: string; number: number; paragraphs: Set<string>; formulas: Set<string> }[] = [];
    for (const p of chapterPaths) {
      const raw = asText(files[p])!;
      const fm = /^---\s*\nchapter:\s*(\d+)/.exec(raw);
      const number = fm ? Number(fm[1]) : Number(/^chapters\/(\d+)/.exec(p)?.[1] ?? 0);
      const parsed = parseChapterMarkdown(raw, number);
      const formulas = new Set(parsed.formulas.map((f) => f.id));
      chapters.push({ path: p, number, paragraphs: new Set(parsed.paragraphs.map((x) => x.id)), formulas });
      for (const f of parsed.formulas) {
        const prev = formulaIds.get(f.id);
        if (prev) out.push(mk('formula-malformed', p, `Duplicate formula id ${f.id} (also in ${prev}).`, undefined, f.id));
        else formulaIds.set(f.id, p);
      }
      for (const para of parsed.paragraphs) {
        if (!para.content.trim()) out.push(mk('empty-section', p, `Paragraph ${para.id} "${para.title}" is empty.`, undefined, para.title));
      }
    }
    const assets = new Set(Object.keys(files).filter((k) => k.startsWith('assets/')));
    const checkRefs = (file: string, text: string, ownFormulas: Set<string> | null) => {
      const ls = text.split('\n');
      ls.forEach((line, idx) => {
        for (const m of line.matchAll(/\{\{formula:([\d.]+)\}\}/g)) {
          const known = ownFormulas ? ownFormulas.has(m[1]) : formulaIds.has(m[1]);
          if (!known) out.push(mk('formula-ref-unknown', file, `Hover reference {{formula:${m[1]}}} has no formula${ownFormulas ? ' in this chapter' : ''}.`, idx + 1, line));
        }
        for (const m of line.matchAll(/\]\(ref:formula\/([\d.]+)\)/g)) {
          if (!formulaIds.has(m[1])) out.push(mk('formula-ref-unknown', file, `Link ref:formula/${m[1]} has no formula in the book.`, idx + 1, line));
        }
        for (const m of line.matchAll(/\]\(ref:chapter\/(\d+)#(p\d+)\)/g)) {
          const ch = chapters.find((c) => c.number === Number(m[1]));
          if (!ch || !ch.paragraphs.has(m[2])) out.push(mk('section-ref-unknown', file, `Link ref:chapter/${m[1]}#${m[2]} does not exist.`, idx + 1, line));
        }
        for (const m of line.matchAll(/:::image\{([^}]*)\}/g)) {
          const src = parseAttrs(m[1]).src;
          if (src && !assets.has(src)) out.push(mk('image', file, `Image asset "${src}" is not in the package.`, idx + 1, line));
        }
      });
    };
    for (const c of chapters) checkRefs(c.path, asText(files[c.path])!, c.formulas);
    for (const p of ['esercizi.md', 'esami.md']) {
      const t = asText(files[p]);
      if (t) checkRefs(p, t, null);
    }
  }

  if (doDup) {
    const ide = parseJsonArray(asText(files['ide.json']));
    if (ide) {
      groupDuplicates(ide, (s) => normCode(String((s as { code?: unknown }).code ?? '')), (items, key) => {
        if (key) out.push(mk('duplicate-ide', 'ide.json', `Identical code in ${items.length} snippets (${items.map((s) => (s as { id?: unknown }).id).join(', ')}).`, undefined, String((items[0] as { code?: unknown }).code ?? '').slice(0, 120)));
      });
      const ids = new Map<string, number>();
      for (const s of ide) ids.set(String((s as { id?: unknown }).id), (ids.get(String((s as { id?: unknown }).id)) ?? 0) + 1);
      for (const [id, n] of ids) if (n > 1) out.push(mk('duplicate-ide', 'ide.json', `Snippet id "${id}" used ${n} times.`, undefined, id));
    }
    const gr = parseJsonArray(asText(files['grafici.json']));
    if (gr) {
      groupDuplicates(gr, (g) => stableStringify((g as { config?: unknown }).config ?? null), (items) => {
        out.push(mk('duplicate-graph', 'grafici.json', `Identical graph config in ${items.length} graphs (${items.map((g) => (g as { id?: unknown }).id).join(', ')}).`, undefined, String((items[0] as { title?: unknown }).title ?? '')));
      });
      const ids = new Map<string, number>();
      for (const g of gr) ids.set(String((g as { id?: unknown }).id), (ids.get(String((g as { id?: unknown }).id)) ?? 0) + 1);
      for (const [id, n] of ids) if (n > 1) out.push(mk('duplicate-graph', 'grafici.json', `Graph id "${id}" used ${n} times.`, undefined, id));
    }
  }
  return out;
}

function parseJsonArray(text: string | undefined): unknown[] | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function normCode(code: string): string {
  return code.replace(/\s+/g, ' ').trim();
}

function groupDuplicates(items: unknown[], keyOf: (x: unknown) => string, report: (items: unknown[], key: string) => void): void {
  const groups = new Map<string, unknown[]>();
  for (const it of items) {
    const k = keyOf(it);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  for (const [k, g] of groups) if (g.length > 1) report(g, k);
}
