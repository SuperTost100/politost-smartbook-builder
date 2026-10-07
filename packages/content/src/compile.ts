import { latexToPlain } from './plaintext.ts';
import { isValidAssetPath, validateBundle, withChapterFrontmatter } from '@politost/content-core';
import type { Question } from '@smartbuilder/domain';
import type { BookInput, ChapterInput, CompiledBook, LintFinding } from './types.ts';
import { lintCompiled, lintQuestionText, lintSection, langOf } from './lint.ts';
import { parseAttrs, scan, type FormulaBlock } from './scan.ts';

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const SECTION_LABELS = {
  it: { smartbook: 'Capitoli', formulario: 'Formulario', esercizi: 'Esercizi', esami: "Prove d'esame", ide: 'Laboratorio', grafici: 'Grafici & Calcoli', risposte: 'Soluzioni' },
  en: { smartbook: 'Chapters', formulario: 'Formulas', esercizi: 'Exercises', esami: 'Exams', ide: 'Lab', grafici: 'Graphs & Calculators', risposte: 'Solutions' },
} as const;

function labelsFor(language: string) {
  return SECTION_LABELS[langOf(language) ?? 'en'];
}

function introTitle(language: string): string {
  return langOf(language) === 'it' ? 'Introduzione' : 'Introduction';
}

const GENERATED_EXAM_PREFIX = { it: "**Esercizio in stile d'esame (generato)**", en: '**Exam-style exercise (generated)**' } as const;

// ---------------------------------------------------------------------------------------------
// Findings helper
// ---------------------------------------------------------------------------------------------

function finding(rule: string, severity: LintFinding['severity'], file: string, message: string, line?: number, quote?: string): LintFinding {
  const f: LintFinding = { rule, severity, message, file };
  if (line !== undefined) f.line = line;
  if (quote !== undefined) f.quote = quote.trim().replace(/\s+/g, ' ').slice(0, 200);
  return f;
}

// ---------------------------------------------------------------------------------------------
// Formula blocks
// ---------------------------------------------------------------------------------------------

interface ParsedFormula {
  key: string | undefined;
  label: string;
  /** The $$ ... $$ text as written. */
  body: string;
}

/** A block the compiler can emit, or null (malformed: it is dropped and the lint reports it). */
function parseFormulaBlock(fb: FormulaBlock): ParsedFormula | null {
  if (fb.openProblem || !fb.closed) return null;
  const label = (fb.attrs.label ?? '').trim();
  if (!label) return null;
  const body = fb.body.join('\n');
  const m = /\$\$([\s\S]*?)\$\$/.exec(body);
  if (!m || !m[1].trim()) return null;
  return { key: fb.attrs.key, label: label.replace(/[}"]/g, ''), body: m[0].trim() };
}

// ---------------------------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------------------------

interface Unit {
  /** Section id (or chapter id for the introduction). */
  id: string;
  title: string;
  markdown: string;
  paragraph: number;
  /** Numbers assigned to the emitted formula blocks, in order. */
  formulaIds: string[];
  isIntro: boolean;
}

interface Numbering {
  units: Unit[];
}

function numberChapter(
  chapter: ChapterInput,
  number: number,
  language: string,
  formulaNumbers: Record<string, string>,
  sectionNumbers: Record<string, { chapter: number; paragraph: number }>,
  findings: LintFinding[],
): Numbering {
  const units: Unit[] = [];
  let paragraph = 0;
  let m = 0;
  const intro = chapter.intro ?? '';

  const make = (id: string, title: string, markdown: string, isIntro: boolean) => {
    paragraph++;
    const unit: Unit = { id, title: title.replace(/\s+/g, ' ').trim(), markdown, paragraph, formulaIds: [], isIntro };
    if (!unit.title) {
      findings.push(finding('book-structure', 'blocker', id, 'Section has no title.'));
      unit.title = isIntro ? introTitle(language) : `Sezione ${paragraph}`;
    }
    for (const fb of scan(markdown).formulas) {
      const parsed = parseFormulaBlock(fb);
      if (!parsed) continue;
      m++;
      const fid = `${number}.${m}`;
      unit.formulaIds.push(fid);
      if (parsed.key !== undefined) {
        if (parsed.key in formulaNumbers) {
          findings.push(finding('formula-malformed', 'blocker', id, `Duplicate formula key "${parsed.key}" (already ${formulaNumbers[parsed.key]}).`, fb.line, `:::formula{${fb.attrText}}`));
        } else formulaNumbers[parsed.key] = fid;
      }
    }
    if (id in sectionNumbers && !isIntro) {
      findings.push(finding('book-structure', 'blocker', id, `Section id "${id}" is used more than once.`));
    }
    sectionNumbers[id] = { chapter: number, paragraph };
    units.push(unit);
  };

  if (intro.trim()) make(chapter.id, introTitle(language), intro, true);
  for (const s of chapter.sections) make(s.id, s.title, s.markdown, false);
  return { units };
}

// ---------------------------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------------------------

interface RefEnv {
  formulaNumbers: Record<string, string>;
  sectionNumbers: Record<string, { chapter: number; paragraph: number }>;
  knownFormulaIds: Set<string>;
  chapterNumber: number | null;
  /** In chapters a hover reference must target the same chapter; elsewhere it can target any. */
  hoverSameChapterOnly: boolean;
  file: string;
  findings: LintFinding[];
  /** Sections of chapters left out of this export: links to them become plain text. */
  omitted?: Set<string>;
}

const REF_TOKEN =
  /\{\{formula:(@?)([^}\s]*)\}\}|\[([^\]]*)\]\(ref:(formula|section|chapter)\/([^)\s]*)\)/g;

const WORD = /[\p{L}\p{N}]/u;

function resolveRefs(line: string, lineNo: number, env: RefEnv): string {
  return line.replace(REF_TOKEN, (full, hoverAt: string | undefined, hoverKey: string | undefined, label: string | undefined, kind: string | undefined, target: string | undefined, offset: number) => {
    let out: string;
    if (hoverKey !== undefined) {
      out = resolveFormula(hoverAt === '@', hoverKey, null, full, lineNo, env);
    } else if (kind === 'formula') {
      out = resolveFormula(target!.startsWith('@'), target!.replace(/^@/, ''), label ?? '', full, lineNo, env);
    } else if (kind === 'section') {
      const sec = env.sectionNumbers[target!];
      if (!sec && env.omitted?.has(target!)) {
        env.findings.push(finding('section-ref-omitted', 'minor', env.file, `ref:section/${target} points to a chapter that is not in this export; the link became plain text.`, lineNo, full));
        out = label || '';
      } else if (!sec) {
        env.findings.push(finding('section-ref-unknown', 'blocker', env.file, `ref:section/${target} points to a section that is not in the book.`, lineNo, full));
        out = label || '';
      } else out = `[${label}](ref:chapter/${sec.chapter}#p${sec.paragraph})`;
    } else {
      out = full;
    }
    const before = line[offset - 1];
    const after = line[offset + full.length];
    // The reader wants spaces around hover references and links that touch a word.
    if (before !== undefined && WORD.test(before) && /^[{[]/.test(out)) out = ` ${out}`;
    if (after !== undefined && WORD.test(after) && /[})]$/.test(out)) out = `${out} `;
    return out;
  });
}

function resolveFormula(byKey: boolean, key: string, label: string | null, full: string, lineNo: number, env: RefEnv): string {
  let id: string | undefined;
  if (byKey) {
    id = env.formulaNumbers[key];
    if (!id) {
      env.findings.push(finding('formula-ref-unknown', 'blocker', env.file, `No formula with key "${key}" exists in the book.`, lineNo, full));
      return label !== null ? label || key : `formula @${key}`;
    }
  } else {
    env.findings.push(finding('formula-ref-unknown', 'blocker', env.file, `Formula references must use the symbolic key (@key), not the number "${key}".`, lineNo, full));
    if (!env.knownFormulaIds.has(key)) return label !== null ? label || key : `formula ${key}`;
    id = key;
  }
  if (label !== null) return `[${label || `(${id})`}](ref:formula/${id})`;
  const sameChapter = env.chapterNumber !== null && id.startsWith(`${env.chapterNumber}.`);
  if (env.hoverSameChapterOnly && !sameChapter) {
    // The reader's validator only accepts hover references inside the same chapter; link instead.
    return `[formula (${id})](ref:formula/${id})`;
  }
  return `{{formula:${id}}}`;
}

// ---------------------------------------------------------------------------------------------
// Chapter body
// ---------------------------------------------------------------------------------------------

interface CompileEnv extends Omit<RefEnv, 'file' | 'chapterNumber'> {
  assets: Set<string> | null;
  language: string;
  /** Figures emitted so far per chapter number. */
  figureCounts: Map<number, number>;
}

function emitUnit(unit: Unit, number: number, env: CompileEnv): string {
  const sc = scan(unit.markdown);
  const byIndex = new Map(sc.formulas.map((f) => [f.index, f]));
  const refEnv: RefEnv = { ...env, file: unit.id, chapterNumber: number };
  const out: string[] = [];
  let formulaCursor = 0;
  const lines = sc.lines;
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.kind === 'formula-open') {
      const fb = byIndex.get(i);
      const parsed = fb ? parseFormulaBlock(fb) : null;
      if (fb && parsed) {
        const id = unit.formulaIds[formulaCursor++];
        out.push('', `:::formula{id="${id}" label="${parsed.label}"}`, parsed.body, ':::', '');
        i = fb.closeIndex + 1;
        continue;
      }
      // Malformed: drop the opening (and the body if it was a closed block); the lint reports it.
      i = fb && fb.closed ? fb.closeIndex + 1 : i + 1;
      continue;
    }
    if (l.kind === 'heading') {
      const text = l.raw.replace(/^#{1,6}\s+/, '').trim();
      out.push(text ? `### ${resolveRefs(text, l.n, refEnv)}` : '');
      i++;
      continue;
    }
    if (l.kind === 'image-open') {
      const attrs = parseAttrs(l.raw);
      const src = attrs.src;
      if (src && env.assets && !env.assets.has(src)) {
        env.findings.push(finding('image', 'blocker', unit.id, `Image "${src}" is not among the book's assets.`, l.n, l.raw));
      }
      // Figures are numbered per chapter, and captions/alt lose their LaTeX: the reader prints them as plain text.
      const n = (env.figureCounts.get(number) ?? 0) + 1;
      env.figureCounts.set(number, n);
      const caption = latexToPlain(attrs.caption ?? '').replace(/^Fig\.\s*[\d.]+\s*[—-]\s*/, '');
            out.push('', `:::image{src="${src ?? ''}" alt="${latexToPlain(attrs.alt ?? '')}"${caption ? ` caption="Fig. ${number}.${n} — ${caption}"` : ''}}`);
      i++;
      continue;
    }
    if (l.kind === 'image-close') {
      out.push(l.raw.trim(), '');
      i++;
      continue;
    }
    if (l.kind === 'text' || l.kind === 'list' || l.kind === 'table') {
      out.push(resolveRefs(l.raw, l.n, refEnv));
    } else {
      out.push(l.raw);
    }
    i++;
  }
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function chapterFileName(chapter: ChapterInput, number: number): string {
  return `${String(number).padStart(2, '0')}-${chapter.slug}.md`;
}

function emitChapter(chapter: ChapterInput, number: number, numbering: Numbering, env: CompileEnv): string {
  const parts: string[] = [];
  for (const unit of numbering.units) {
    const body = emitUnit(unit, number, env);
    parts.push(`## p${unit.paragraph} | ${unit.title}\n\n${body}`.trimEnd());
  }
  const title = chapter.title.replace(/\s+/g, ' ').trim();
  return withChapterFrontmatter(parts.join('\n\n') + '\n', number, title);
}

/**
 * Numbers of every section (chapter introductions included, as the compiler numbers them) and every keyed formula of a
 * set of chapters. This is the compiler's own numbering pass, so previews and checks agree with the full book.
 */
export function numberChapters(
  chapters: ChapterInput[],
  language = 'it',
): { formulaNumbers: Record<string, string>; sectionNumbers: Record<string, { chapter: number; paragraph: number }> } {
  const formulaNumbers: Record<string, string> = {};
  const sectionNumbers: Record<string, { chapter: number; paragraph: number }> = {};
  for (const ch of [...chapters].sort((a, b) => a.number - b.number)) numberChapter(ch, ch.number, language, formulaNumbers, sectionNumbers, []);
  return { formulaNumbers, sectionNumbers };
}

/** Compile one chapter to reader Markdown, for preview. */
export function compileChapter(
  chapter: ChapterInput,
  knownSections?: Record<string, { chapter: number; paragraph: number }>,
  opts: { language?: string; knownFormulas?: Record<string, string>; assets?: Set<string> } = {},
): {
  markdown: string;
  formulaNumbers: Record<string, string>;
  sectionNumbers: Record<string, { chapter: number; paragraph: number }>;
  findings: LintFinding[];
} {
  const language = opts.language ?? 'it';
  const findings: LintFinding[] = [];
  const formulaNumbers: Record<string, string> = {};
  const sectionNumbers: Record<string, { chapter: number; paragraph: number }> = {};
  const number = chapter.number;
  const numbering = numberChapter(chapter, number, language, formulaNumbers, sectionNumbers, findings);
  const allFormulas = { ...(opts.knownFormulas ?? {}), ...formulaNumbers };
  const env: CompileEnv = {
    figureCounts: new Map(),
    formulaNumbers: allFormulas,
    sectionNumbers: { ...(knownSections ?? {}), ...sectionNumbers },
    knownFormulaIds: new Set(Object.values(allFormulas)),
    hoverSameChapterOnly: true,
    findings,
    assets: opts.assets ?? null,
    language,
  };
  const markdown = emitChapter(chapter, number, numbering, env);
  return { markdown, formulaNumbers, sectionNumbers, findings };
}

// ---------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------

const natural = new Intl.Collator('en', { numeric: true });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function cleanInline(s: string): string {
  return s.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

interface QuestionOut {
  q: Question;
  id: string;
  chapter: number | null;
}

function compileQuestions(
  kind: 'exercise' | 'exam',
  questions: Question[],
  chapterNumberById: Map<string, number>,
  language: string,
  env: CompileEnv,
  knownKeys: Set<string>,
  findings: LintFinding[],
): string {
  const items = questions.filter((q) => q.kind === kind);
  const chapterOf = (q: Question) => (q.chapterId ? chapterNumberById.get(q.chapterId) ?? null : null);
  const chap = (q: Question) => chapterOf(q) ?? Number.POSITIVE_INFINITY;
  if (kind === 'exercise') {
    items.sort((a, b) => chap(a) - chap(b) || natural.compare(a.id, b.id));
  } else {
    items.sort((a, b) => cmp(a.examDate ?? '9999', b.examDate ?? '9999') || chap(a) - chap(b) || natural.compare(a.number ?? '', b.number ?? '') || natural.compare(a.id, b.id));
  }

  const counters = new Map<string, number>();
  const nextN = (k: string) => {
    const n = (counters.get(k) ?? 0) + 1;
    counters.set(k, n);
    return n;
  };
  const used = new Set<string>();
  const outs: QuestionOut[] = items.map((q) => {
    const chapter = chapterOf(q);
    if (q.chapterId && chapter === null) {
      findings.push(finding('book-structure', 'minor', `question:${q.id}`, `Question refers to unknown chapter "${q.chapterId}".`));
    }
    let id: string;
    if (kind === 'exercise') id = `E${chapter ?? 0}.${nextN(`E${chapter ?? 0}`)}`;
    else {
      const year = /^(\d{4})/.exec(q.examDate ?? '')?.[1];
      id = year ? `X${year}-${nextN(`X${year}`)}` : `X${nextN('X')}`;
    }
    used.add(id);
    return { q, id, chapter };
  });

  const lang = langOf(language);
  const blocks = outs.map(({ q, id, chapter }) => {
    const file = `question:${q.id}`;
    const refEnv: RefEnv = { ...env, file, chapterNumber: chapter, hoverSameChapterOnly: false };
    const prep = (text: string, part: string): string => {
      const src = text.replace(/\r\n?/g, '\n').trim();
      for (const f of lintQuestionText(src, { file, language, knownFormulaKeys: knownKeys, skipRules: ['formula-ref-unknown'] })) {
        findings.push({ ...f, message: `[${part}] ${f.message}` });
      }
      return src
        .split('\n')
        .map((line, idx) => resolveRefs(line, idx + 1, refEnv))
        .join('\n')
        .trim();
    };

    let statement = prep(q.statement, 'statement');
    if (kind === 'exam') {
      if (q.origin === 'generated') statement = `${GENERATED_EXAM_PREFIX[lang === 'it' ? 'it' : 'en']}\n\n${statement}`;
      else if (q.examGroup && cleanInline(q.examGroup)) statement = `**${cleanInline(q.examGroup)}**\n\n${statement}`;
    }
    const hint = prep(q.hint ?? '', 'hint');
    const solution = prep(q.solution ?? '', 'solution');

    const attrs = [`id="${id}"`];
    if (kind === 'exam') attrs.push('type="esame"');
    if (chapter !== null) attrs.push(`chapter="${chapter}"`);
    attrs.push(`difficulty="${q.difficulty}"`);
    const parts = [`:::exercise{${attrs.join(' ')}}`, '## Domanda', statement];
    if (hint) parts.push('', ':::hint', hint, ':::');
    if (solution) parts.push('', ':::solution', solution, ':::');
    parts.push(':::');
    return parts.join('\n');
  });

  const fm = `---\ntype: ${kind === 'exercise' ? 'esercizi' : 'esami'}\nprintable: true\n---\n`;
  return blocks.length ? `${fm}\n${blocks.join('\n\n')}\n` : fm;
}

// ---------------------------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------------------------

/** Compile a whole book to reader files (smartbook.json, chapters/*.md, esercizi.md, esami.md, ide.json, grafici.json, assets/*). */
export function compileBook(input: BookInput): CompiledBook {
  const findings: LintFinding[] = [];
  const files: Record<string, string | Uint8Array> = {};
  const formulaNumbers: Record<string, string> = {};
  const sectionNumbers: Record<string, { chapter: number; paragraph: number }> = {};
  const { meta } = input;
  const language = meta.language;

  // Assets first: sources are checked against them.
  const assetNames = new Set<string>();
  for (const a of input.assets) {
    const path = `assets/${a.filename}`;
    if (!isValidAssetPath(path)) {
      findings.push(finding('image', 'blocker', path, `Asset name "${a.filename}" is not allowed (use letters, digits, ".", "_", "-" and a .png/.jpg/.jpeg/.webp/.svg extension).`));
      continue;
    }
    if (assetNames.has(path)) findings.push(finding('image', 'minor', path, `Asset "${a.filename}" appears twice; the last one wins.`));
    assetNames.add(path);
    files[path] = a.bytes;
  }

  // Chapters in number order.
  const chapters = [...input.chapters].sort((a, b) => a.number - b.number);
  const seenNumbers = new Set<number>();
  for (const ch of chapters) {
    if (seenNumbers.has(ch.number)) findings.push(finding('book-structure', 'blocker', ch.id, `Chapter number ${ch.number} is used twice.`));
    seenNumbers.add(ch.number);
  }

  // Pass 1: numbering.
  const numberings = chapters.map((ch) => numberChapter(ch, ch.number, language, formulaNumbers, sectionNumbers, findings));
  const knownKeys = new Set(Object.keys(formulaNumbers));
  const knownFormulaIds = new Set(Object.values(formulaNumbers));
  // Every emitted formula id, including key-less ones, for numeric reference checks.
  for (const n of numberings) for (const u of n.units) for (const id of u.formulaIds) knownFormulaIds.add(id);

  // Pass 2: emit.
  const env: CompileEnv = {
    figureCounts: new Map(),
    formulaNumbers,
    sectionNumbers,
    knownFormulaIds,
    hoverSameChapterOnly: true,
    findings,
    assets: assetNames,
    language,
    omitted: new Set(input.omittedSectionIds ?? []),
  };
  const chapterMeta: { id: string; number: number; title: string; file: string; printable: boolean }[] = [];
  chapters.forEach((ch, idx) => {
    const file = chapterFileName(ch, ch.number);
    files[`chapters/${file}`] = emitChapter(ch, ch.number, numberings[idx], env);
    chapterMeta.push({ id: ch.slug, number: ch.number, title: ch.title.replace(/\s+/g, ' ').trim(), file, printable: true });
    // Source-dialect lints (reference problems are reported by the resolver above).
    for (const u of numberings[idx].units) {
      findings.push(...lintSection(u.markdown, { sectionId: u.id, language, knownFormulaKeys: knownKeys, skipRules: ['formula-ref-unknown'] }));
    }
  });

  const chapterNumberById = new Map(chapters.map((c) => [c.id, c.number]));
  const formulaCount = numberings.reduce((n, g) => n + g.units.reduce((m, u) => m + u.formulaIds.length, 0), 0);

  const wanted = input.sections;
  if (wanted.esercizi) files['esercizi.md'] = compileQuestions('exercise', input.questions, chapterNumberById, language, env, knownKeys, findings);
  if (wanted.esami) files['esami.md'] = compileQuestions('exam', input.questions, chapterNumberById, language, env, knownKeys, findings);

  const orderOf = (nodeId: string) => {
    const s = sectionNumbers[nodeId];
    return s ? s.chapter * 10000 + s.paragraph : Number.POSITIVE_INFINITY;
  };
  const payloads = (kind: 'ide' | 'graph') =>
    input.enrichments
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === kind)
      .sort((a, b) => orderOf(a.e.nodeId) - orderOf(b.e.nodeId) || a.i - b.i)
      .map(({ e }) => e.payload);
  if (wanted.ide) files['ide.json'] = `${JSON.stringify(payloads('ide'), null, 2)}\n`;
  if (wanted.grafici) files['grafici.json'] = `${JSON.stringify(payloads('graph'), null, 2)}\n`;

  const labels = labelsFor(language);
  const config: Record<string, unknown> = {
    id: meta.slug,
    title: meta.title,
    subject: meta.subject,
    access: 'public',
  };
  if (meta.authors.length) config.authors = meta.authors;
  config.version = meta.version;
  config.specVersion = '1.1';
  config.sections = {
    smartbook: { enabled: true, label: labels.smartbook },
    formulario: { enabled: formulaCount > 0, label: labels.formulario },
    esercizi: { enabled: wanted.esercizi, label: labels.esercizi },
    esami: { enabled: wanted.esami, label: labels.esami },
    ide: { enabled: wanted.ide, label: labels.ide },
    grafici: { enabled: wanted.grafici, label: labels.grafici },
    risposte: { enabled: false, label: labels.risposte },
  };
  config.chapters = chapterMeta;
  files['smartbook.json'] = `${JSON.stringify(config, null, 2)}\n`;

  // Reader validators on the compiled output.
  findings.push(...runContentCore(config, files, assetNames, new Set(findings.map((f) => f.rule))));
  // Cross-chapter rules; per-text rules already ran on the sources.
  findings.push(...lintCompiled(files, { content: false, integrity: false, duplicates: true }));

  return { files, formulaNumbers, sectionNumbers, findings: dedupe(findings) };
}

function dedupe(findings: LintFinding[]): LintFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.rule}|${f.file}|${f.line ?? ''}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// content-core validation
// ---------------------------------------------------------------------------------------------

/** Core messages the builder's own rules already report with a blocker severity. */
const COVERED_BY_LINT: { re: RegExp; rule: string }[] = [
  { re: /LaTeX (display|inline) invalido/, rule: 'katex' },
  { re: /Formula shorthand non valida|non canoniche|apertur[ae]\/?e? :::formula|Blocco formula malformato/, rule: 'formula-malformed' },
  { re: /testo meta LLM/, rule: 'meta-leak' },
  { re: /asset mancante|percorso immagine non valido|senza attributo (src|alt)|immagini markdown/, rule: 'image' },
  { re: /riferimento hover|link ref:/, rule: 'formula-ref-unknown' },
];

function runContentCore(config: Record<string, unknown>, files: Record<string, string | Uint8Array>, assetNames: Set<string>, haveRules: Set<string>): LintFinding[] {
  const text = (p: string) => (typeof files[p] === 'string' ? (files[p] as string) : undefined);
  const chapterFiles: Record<string, string> = {};
  for (const [p, v] of Object.entries(files)) {
    if (p.startsWith('chapters/') && typeof v === 'string') chapterFiles[p.slice('chapters/'.length)] = v;
  }
  const assets: Record<string, Uint8Array> = {};
  for (const p of assetNames) assets[p] = files[p] as Uint8Array;

  let result;
  const warn = console.warn;
  console.warn = () => {}; // KaTeX's strict-mode notices; real problems come back as errors
  try {
    result = validateBundle(
      config as unknown as Parameters<typeof validateBundle>[0],
      chapterFiles,
      assets,
      { eserciziRaw: text('esercizi.md'), esamiRaw: text('esami.md'), ideRaw: text('ide.json'), graficiRaw: text('grafici.json') },
    );
  } catch (e) {
    return [finding('content-core', 'blocker', 'smartbook.json', `Validator crashed: ${(e as Error).message}`)];
  } finally {
    console.warn = warn;
  }

  const out: LintFinding[] = [];
  const map = (msg: string, severity: LintFinding['severity']) => {
    const m = /^([\w.-]+\.(?:md|json))(\[\d+\])?:\s*([\s\S]*)$/.exec(msg);
    let file = 'smartbook.json';
    let rest = msg;
    if (m) {
      file = /^(esercizi|esami)\.md$/.test(m[1]) || m[1].endsWith('.json') ? m[1] : `chapters/${m[1]}`;
      rest = m[2] ? `${m[2]} ${m[3]}` : m[3];
    }
    const cover = COVERED_BY_LINT.find((c) => c.re.test(rest));
    if (cover && severity === 'blocker' && haveRules.has(cover.rule)) return; // reported (with positions) by the builder's own rule
    const line = /^Riga (\d+):/.exec(rest)?.[1];
    out.push(finding('content-core', severity, file, rest, line ? Number(line) : undefined));
  };
  for (const e of result.errors) map(e, 'blocker');
  for (const w of result.warnings) map(w, 'minor');
  return out;
}
