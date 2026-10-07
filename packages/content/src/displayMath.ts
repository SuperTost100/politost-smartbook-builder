import { proseLines } from './blocks.ts';
import { maskMath } from './scan.ts';

/**
 * Fixes the math-mixed lint without a model. In every block that has both display ($$) and inline ($) math, display math
 * moves to blocks of its own, or, inside lists, tables and quotes, becomes inline "$\displaystyle ...$". Code fences and
 * ::: blocks are not touched. Idempotent.
 */
export function separateDisplayMath(markdown: string): string {
  const lines = markdown.split('\n');
  const prose = proseLines(lines);
  const out: string[] = [];
  let buf: string[] = [];
  let display = false;
  let changed = false;
  const flush = () => {
    const fixed = buf.length ? fixBlock(buf) : null;
    if (fixed) changed = true;
    out.push(...(fixed ?? buf));
    buf = [];
    display = false;
  };
  lines.forEach((line, i) => {
    // Blank lines inside an open $$ belong to the display; headings and non-prose lines end a block.
    if (!prose[i] || (!display && (!line.trim() || /^#{1,6}\s/.test(line)))) {
      flush();
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

interface Span { start: number; end: number; tex: string }

function displaySpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(SPAN)) if (m[2]?.trim()) spans.push({ start: m.index, end: m.index + m[0].length, tex: m[2].trim() });
  return spans;
}

/** The block's new lines, or null when the lint would not flag it. */
function fixBlock(lines: string[]): string[] | null {
  const text = lines.join('\n');
  const spans = displaySpans(text);
  if (!spans.length) return null;
  let rest = text;
  for (const s of [...spans].reverse()) rest = `${rest.slice(0, s.start)} ${rest.slice(s.end)}`;
  if (!rest.split('\n').some((l) => INLINE.test(l))) return null;

  const quote = lines.every((l) => /^\s*>/.test(l));
  const inline = (tex: string) => `$\\displaystyle ${tex.replace(quote ? /\s*\n[ \t]*(?:>[ \t]*)*/g : /\s*\n\s*/g, ' ')}$`;
  if (lines.some((l) => /^\s*([-*+]|\d+[.)])\s|^\s*[>|]/.test(l))) {
    let out = text;
    for (const s of [...spans].reverse()) out = out.slice(0, s.start) + inline(s.tex) + out.slice(s.end);
    return out.split('\n');
  }

  // Text, display, text, ...: a display splits the block only when the text before it keeps its emphasis balanced.
  const pieces: string[] = [];
  let cur = '';
  let pos = 0;
  for (const s of spans) {
    cur += text.slice(pos, s.start);
    pos = s.end;
    if (balanced(cur)) {
      // Punctuation right after the formula moves inside it, as in a printed display, instead of starting the next paragraph.
      const punct = /^[ \t]*([.,;:])/.exec(text.slice(pos));
      if (punct) pos += punct[0].length;
      pieces.push(cur, `$$\n${s.tex}${punct && !/[.,;:]$/.test(s.tex) ? punct[1] : ''}\n$$`);
      cur = '';
    } else cur += inline(s.tex);
  }
  pieces.push(cur + text.slice(pos));
  return pieces.map((p) => p.trim()).filter(Boolean).join('\n\n').split('\n');
}

/** True when ** and single * markers outside math and code pair up. */
function balanced(s: string): boolean {
  const t = s.replace(/\\\*/g, '').replace(/`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, '');
  return (t.split('**').length - 1) % 2 === 0 && (t.replace(/\*\*/g, '').split('*').length - 1) % 2 === 0;
}
