import { proseLines } from './blocks.ts';
import { maskMath } from './scan.ts';

/**
 * Fixes the layout of display math ($$) without a model. Code fences and ::: blocks are not touched. Idempotent.
 *
 * - In every block that has both display and inline ($) math, display math moves to blocks of its own, or, inside lists,
 *   tables and quotes, becomes inline "$\displaystyle ...$" (the math-mixed lint).
 * - A $$ block has no blank line inside it (the math-blank-line lint), in a list too.
 * - Outside lists, tables and quotes a $$ block opens and closes on lines of its own, with a blank line before and after.
 *   One-line "$$ ... $$" on a line of its own stays as it is, and so does a formula in the middle of a sentence when the
 *   block has no inline math.
 * - A $$ that never closes is left alone: the text around it cannot be told apart from the formula.
 */
export function separateDisplayMath(markdown: string): string {
  const lines = markdown.split('\n');
  const prose = proseLines(lines);
  const out: string[] = [];
  let buf: string[] = [];
  let display = false;
  let changed = false;
  /** The last thing written ends a display block, so the next line needs a blank line before it. */
  let closed = false;
  const flush = () => {
    const fixed = buf.length ? fixBlock(buf) : null;
    if (fixed) {
      if (fixed.start && out.length && out[out.length - 1].trim()) { out.push(''); changed = true; }
      if (fixed.lines.length !== buf.length || fixed.lines.some((l, i) => l !== buf[i])) changed = true;
    }
    out.push(...(fixed?.lines ?? buf));
    closed = fixed?.end ?? false;
    buf = [];
    display = false;
  };
  lines.forEach((line, i) => {
    // Blank lines inside an open $$ belong to the display; headings and non-prose lines end a block.
    if (!prose[i] || (!display && (!line.trim() || /^#{1,6}\s/.test(line)))) {
      flush();
      if (closed && line.trim()) { out.push(''); changed = true; }
      closed = false;
      out.push(line);
      return;
    }
    buf.push(line);
    display = maskMath(line, display).inDisplay;
  });
  flush();
  return changed ? out.join('\n') : markdown;
}

const SPAN = /(`[^`\n]*`)|\$\$([\s\S]*?)\$\$/g;
const INLINE = /(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)/;
const LISTY = /^\s*([-*+]|\d+[.)])\s|^\s*[>|]/;

interface Span { start: number; end: number; tex: string; /** How many block quotes the line that opens the display sits in. */ depth: number }
interface Fixed { lines: string[]; /** The block starts with a display of its own. */ start: boolean; /** The block ends with one. */ end: boolean }

/**
 * The row without the quote marks of the `depth` quotes the display sits in. Only those marks are layout: a ">" beyond them
 * (a row "> >" in a quote, a row ">" outside any quote) belongs to the formula.
 */
const unquote = (row: string, depth: number) => row.replace(new RegExp(`^(?:[ \\t]*>[ \\t]?){0,${depth}}`), '');
/** A row with nothing in the formula on it. */
const blankRow = (row: string, depth: number) => !unquote(row, depth).trim();
/** The number of quote marks that start the line the display opens on. */
const quoteDepth = (text: string, at: number) => /^(?:[ \t]*>)*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))![0].split('>').length - 1;

/** `tex` is the formula without its blank rows, without the quote marks and without the space next to the delimiters. */
function displaySpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(SPAN)) {
    if (!m[2]?.trim()) continue;
    const depth = quoteDepth(text, m.index);
    // The first row follows the opening $$ on its line, so it has no quote marks of its own.
    const rows = m[2].split('\n').map((l, i) => (i ? unquote(l, depth) : l)).filter((l) => l.trim());
    // A formula of blank rows only ("> $$", ">", "> $$") has nothing to lay out: the lint reports it.
    if (!rows.length) continue;
    rows[0] = rows[0].trimStart();
    rows[rows.length - 1] = rows[rows.length - 1].trimEnd();
    spans.push({ start: m.index, end: m.index + m[0].length, tex: rows.join('\n'), depth });
  }
  return spans;
}

/** The block's new lines, or null when there is no display math in it or its $$ do not pair up. */
function fixBlock(lines: string[]): Fixed | null {
  const text = lines.join('\n');
  const spans = displaySpans(text);
  if (!spans.length) return null;
  let rest = text;
  for (const s of [...spans].reverse()) rest = `${rest.slice(0, s.start)} ${rest.slice(s.end)}`;
  const mixed = rest.split('\n').some((l) => INLINE.test(l));
  if (!mixed && (text.replace(/`[^`\n]*`/g, '').match(/\$\$/g) ?? []).length % 2) return null;

  const inline = (tex: string) => `$\\displaystyle ${tex.replace(/\s*\n\s*/g, ' ')}$`;
  // A line inside a formula that starts with "+ " or "- " is not a list item, so only the text outside the formulas decides.
  if (rest.split('\n').some((l) => LISTY.test(l))) {
    // A blank line inside the formula goes, whatever else the block holds. Mixed blocks get inline formulas instead.
    let out = text;
    for (const s of [...spans].reverse()) out = out.slice(0, s.start) + (mixed ? inline(s.tex) : tidy(text.slice(s.start, s.end), s.depth)) + out.slice(s.end);
    return { lines: out.split('\n'), start: false, end: false };
  }

  // Only a display on its own: a one-line formula stays, a longer one gets the delimiters on lines of their own.
  if (spans.length === 1 && text.trim() === text.slice(spans[0].start, spans[0].end) && !mixed) {
    const one = !text.includes('\n');
    return { lines: one ? lines : ['$$', ...spans[0].tex.split('\n'), '$$'], start: true, end: true };
  }

  // Text, display, text, ...: a display splits the block only when the text before it keeps its emphasis balanced.
  const pieces: { text: string; display: boolean }[] = [];
  let cur = '';
  let pos = 0;
  for (const s of spans) {
    cur += text.slice(pos, s.start);
    pos = s.end;
    // Without inline math in the block, only a formula that already has lines of its own is a display block; one inside a sentence is valid as written.
    if ((mixed || ownLines(text, s)) && balanced(cur)) {
      // Punctuation right after the formula moves inside it, as in a printed display, instead of starting the next paragraph.
      const punct = /^[ \t]*([.,;:])/.exec(text.slice(pos));
      if (punct) pos += punct[0].length;
      pieces.push({ text: cur, display: false }, { text: `$$\n${s.tex}${punct && !/[.,;:]$/.test(s.tex) ? punct[1] : ''}\n$$`, display: true });
      cur = '';
    } else cur += mixed ? inline(s.tex) : tidy(text.slice(s.start, s.end), s.depth);
  }
  pieces.push({ text: cur + text.slice(pos), display: false });
  const kept = pieces.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text);
  return { lines: kept.map((p) => p.text).join('\n\n').split('\n'), start: !!kept[0]?.display, end: !!kept.at(-1)?.display };
}

/** Nothing else on the first and the last line of the span. */
function ownLines(text: string, s: Span): boolean {
  return !text.slice(text.lastIndexOf('\n', s.start - 1) + 1, s.start).trim() && !text.slice(s.end, text.indexOf('\n', s.end) < 0 ? undefined : text.indexOf('\n', s.end)).trim();
}

/** The span's lines without the blank ones between its first and last line. */
function tidy(span: string, depth: number): string {
  const rows = span.split('\n');
  return rows.filter((l, i) => i === 0 || i === rows.length - 1 || !blankRow(l, depth)).join('\n');
}

/** True when ** and single * markers outside math and code pair up. */
function balanced(s: string): boolean {
  const t = s.replace(/\\\*/g, '').replace(/`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, '');
  return (t.split('**').length - 1) % 2 === 0 && (t.replace(/\*\*/g, '').split('*').length - 1) % 2 === 0;
}
