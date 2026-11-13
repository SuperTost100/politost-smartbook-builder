import { proseLines } from './blocks.ts';
import type { LintRule } from './lint.ts';
import { separateDisplayMath } from './displayMath.ts';
import { rewriteLatexNames, stripGeneratorMarkup } from './sanitize.ts';
import { maskMath } from './scan.ts';
import { unwrapFormulaKeys } from './patch.ts';

/** Section text (source dialect, headings are ###) or the text of a question (statement, hint, solution: no headings). */
export type TextKind = 'section' | 'question';

export interface FormatOptions {
  kind?: TextKind;
  /** Formula keys another section already defines: a formula block with such a key loses its wrapper and keeps its math. */
  takenFormulaKeys?: Set<string>;
}

/**
 * The mechanical fixes for text a model wrote, in one place and in this order: tool-call markup goes, function names KaTeX
 * lacks are rewritten (`\cotan`), formula blocks that reuse another section's key are unwrapped, every heading of a section
 * becomes `###`, and display math gets its layout (see `separateDisplayMath`).
 *
 * It never changes a word, a number or the content of a formula, leaves code fences and ::: blocks alone, and gives the same
 * text again when it runs on its own output. It is for text a model wrote: the author's own edits are only reported by the
 * lint. The compiler's `## pN | ...` headings are not source text, so they stay and the lint reports them. A question has
 * no headings, so it gets none changed.
 */
export function formatModelText(markdown: string, opts: FormatOptions = {}): string {
  let text = rewriteLatexNames(stripGeneratorMarkup(markdown));
  if (opts.takenFormulaKeys) text = unwrapFormulaKeys(text, opts.takenFormulaKeys);
  if (opts.kind !== 'question') text = headingsToThree(text);
  return separateDisplayMath(text);
}

/**
 * The formatter's fix for the given lint rules only. A fix the author asks for on chosen notes changes what those notes are
 * about: the rest of the text is the author's and stays as typed.
 */
export function formatForRules(markdown: string, rules: Iterable<string>, kind: TextKind = 'section'): string {
  const names = new Set([...rules].map((r) => r.replace(/^compile:/, '')));
  let text = markdown;
  if (kind !== 'question' && names.has('heading-level')) text = headingsToThree(text);
  if (names.has('math-mixed') || names.has('math-blank-line')) text = separateDisplayMath(text);
  return text;
}

/** Every heading of a section is `###`. `## pN | Title` is the compiler's own heading, and headings in code, ::: blocks and display math are not headings. */
function headingsToThree(markdown: string): string {
  const lines = markdown.split('\n');
  const prose = proseLines(lines);
  let display = false;
  let changed = false;
  const out = lines.map((line, i) => {
    if (!prose[i]) return line;
    const startedInDisplay = display;
    display = maskMath(line, display).inDisplay;
    const m = !startedInDisplay && /^(#{1,6})(\s.*)$/.exec(line);
    if (!m || m[1] === '###' || /^## p\d+ \|/.test(line)) return line;
    changed = true;
    return `###${m[2]}`;
  });
  return changed ? out.join('\n') : markdown;
}

/**
 * Lint rules the formatter settles, by the kind of text. A finding of one of these rules is never sent to a model: the
 * formatter runs, the text is linted again, and what is gone is closed. `heading-level` of a section is handled except the
 * blocker "## pN | ..." (a compiler heading in the source), which needs the author's or a model's decision.
 */
export function formatterHandles(rule: string, severity: string, kind: TextKind): boolean {
  const name = rule.replace(/^compile:/, '') as LintRule;
  if (name === 'math-mixed' || name === 'math-blank-line') return true;
  return kind === 'section' && name === 'heading-level' && severity !== 'blocker';
}
