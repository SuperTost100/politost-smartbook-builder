/**
 * Line scanner shared by the compiler, the lints and the decompiler.
 * It classifies every line of a Markdown text (source dialect or reader format) and masks math,
 * so rules can look at prose without tripping over $...$ content.
 */

export type LineKind =
  | 'blank'
  | 'text'
  | 'list'
  | 'heading'
  | 'table'
  | 'math'
  | 'formula-open'
  | 'formula-body'
  | 'formula-close'
  | 'image-open'
  | 'image-close'
  | 'fence-open'
  | 'fence-close'
  | 'code-fence';

export interface ScannedLine {
  /** 1-based line number. */
  n: number;
  raw: string;
  kind: LineKind;
  /** raw with $...$ and $$...$$ regions replaced by spaces (same length) and inline code blanked. */
  masked: string;
}

export interface FormulaBlock {
  /** 1-based line of the :::formula{...} opening. */
  line: number;
  /** Line index (0-based) of the opening line in `lines`. */
  index: number;
  /** Attribute text between the braces, or null when the opening line has no {...}. */
  attrText: string | null;
  attrs: Record<string, string>;
  closed: boolean;
  /** Body lines between the opening and the closing :::, only when closed. */
  body: string[];
  /** Index of the closing ::: line, when closed. */
  closeIndex: number;
  /** Problems with the opening line itself (shorthand, trailing text, no braces). */
  openProblem: string | null;
  /** First line (1-based) that looked like a closing fence but has text after the colons. */
  gluedCloseLine?: number;
}

export interface Scan {
  lines: ScannedLine[];
  formulas: FormulaBlock[];
}

export function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of text.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

const PLACE = ' ';

/** Replace math regions of one line with spaces. `inDisplay` carries multi-line $$ state across lines. */
export function maskMath(line: string, inDisplay: boolean): { masked: string; inDisplay: boolean; startedInDisplay: boolean } {
  const startedInDisplay = inDisplay;
  let out = '';
  let i = 0;
  let display = inDisplay;
  while (i < line.length) {
    if (line.startsWith('$$', i)) {
      display = !display;
      out += PLACE + PLACE;
      i += 2;
      continue;
    }
    if (display) {
      out += PLACE;
      i++;
      continue;
    }
    if (line[i] === '`') {
      // inline code span: blank it
      const end = line.indexOf('`', i + 1);
      if (end > i) {
        out += PLACE.repeat(end - i + 1);
        i = end + 1;
        continue;
      }
    }
    if (line[i] === '$') {
      const end = line.indexOf('$', i + 1);
      // Inline math needs a closing $ on the same line and at least one char (reader: /\$([^$\n]+)\$/).
      if (end > i + 1 && line[end + 1] !== '$') {
        out += PLACE.repeat(end - i + 1);
        i = end + 1;
        continue;
      }
    }
    out += line[i];
    i++;
  }
  return { masked: out, inDisplay: display, startedInDisplay };
}

const FORMULA_OPEN_PREFIX = /^:::formula/;
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+\S/;
const HEADING_RE = /^#{1,6}\s/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const FENCE_RE = /^:::[A-Za-z]/;

export function scan(markdown: string): Scan {
  const src = markdown.replace(/\r\n?/g, '\n').split('\n');
  const lines: ScannedLine[] = [];
  const formulas: FormulaBlock[] = [];
  let display = false;

  const push = (i: number, kind: LineKind, masked?: string) => {
    lines.push({ n: i + 1, raw: src[i], kind, masked: masked ?? src[i] });
  };

  let i = 0;
  while (i < src.length) {
    const raw = src[i];
    const t = raw.trim();

    if (!display) {
      if (!t) {
        push(i, 'blank', '');
        i++;
        continue;
      }
      if (/^(```|~~~)/.test(t)) {
        push(i, 'code-fence');
        i++;
        continue;
      }
      if (FORMULA_OPEN_PREFIX.test(t)) {
        const block: FormulaBlock = {
          line: i + 1,
          index: i,
          attrText: null,
          attrs: {},
          closed: false,
          body: [],
          closeIndex: -1,
          openProblem: null,
        };
        const m = /^:::formula\{(.*)\}\s*$/.exec(t);
        if (!m) {
          block.openProblem = /^:::formula\{/.test(t)
            ? 'the opening line has text after the closing brace or lacks one'
            : 'the opening line has no {key="..." label="..."} attributes';
        } else {
          block.attrText = m[1];
          block.attrs = parseAttrs(m[1]);
          if (!/\b(key|id)="/.test(m[1]) || !/\blabel="/.test(m[1])) {
            // Includes the shorthand :::formula{R = F1 + F2}
            block.openProblem = 'attributes are not key="..." label="..." (shorthand or missing)';
          }
        }
        formulas.push(block);
        push(i, 'formula-open');
        if (block.openProblem === null) {
          // Look ahead for the closing ::: without crossing another block opener or a heading.
          let j = i + 1;
          let close = -1;
          for (; j < src.length; j++) {
            const tj = src[j].trim();
            if (tj === ':::') {
              close = j;
              break;
            }
            if (tj.startsWith(':::')) {
              // ":::$$ x" or ":::text": a closing fence glued to the next content
              if (!FENCE_RE.test(tj)) block.gluedCloseLine = j + 1;
              break;
            }
            if (/^## p\d+ \|/.test(tj)) break;
          }
          if (close >= 0) {
            block.closed = true;
            block.closeIndex = close;
            block.body = src.slice(i + 1, close);
            for (let k = i + 1; k < close; k++) push(k, 'formula-body');
            push(close, 'formula-close');
            i = close + 1;
            continue;
          }
        }
        i++;
        continue;
      }
      if (/^:::image\b/.test(t)) {
        push(i, 'image-open');
        if (i + 1 < src.length && src[i + 1].trim() === ':::') {
          push(i + 1, 'image-close');
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (FENCE_RE.test(t)) {
        push(i, 'fence-open');
        i++;
        continue;
      }
      if (t === ':::') {
        push(i, 'fence-close');
        i++;
        continue;
      }
    }

    // Prose or math.
    const startsDisplay = !display && t.startsWith('$$');
    const r = maskMath(raw, display);
    display = r.inDisplay;
    if (r.startedInDisplay || (startsDisplay && r.inDisplay)) {
      push(i, 'math', r.masked);
    } else if (HEADING_RE.test(raw)) {
      push(i, 'heading', r.masked);
    } else if (TABLE_ROW_RE.test(raw)) {
      push(i, 'table', r.masked);
    } else if (LIST_RE.test(raw)) {
      push(i, 'list', r.masked);
    } else {
      push(i, 'text', r.masked);
    }
    i++;
  }
  return { lines, formulas };
}

/** True when a separator row like |---|:---:| */
export function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

export interface MathSpan {
  tex: string;
  display: boolean;
  /** 1-based line where the span starts. */
  line: number;
}

/** All $$..$$ and $..$ spans of a text, like content-core's validateLatex plus line numbers. */
export function extractMath(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  const lineAt = (idx: number) => text.slice(0, idx).split('\n').length;
  let rest = text;
  const displayRe = /\$\$([\s\S]*?)\$\$/g;
  let m: RegExpExecArray | null;
  while ((m = displayRe.exec(text)) !== null) {
    spans.push({ tex: m[1].trim(), display: true, line: lineAt(m.index) });
    // blank the span but keep newlines so line numbers of later spans stay right
    rest = rest.slice(0, m.index) + m[0].replace(/[^\n]/g, ' ') + rest.slice(m.index + m[0].length);
  }
  const inlineRe = /(?<!\$)\$([^$\n]+)\$/g;
  while ((m = inlineRe.exec(rest)) !== null) {
    spans.push({ tex: m[1].trim(), display: false, line: lineAt(m.index) });
  }
  spans.sort((a, b) => a.line - b.line);
  return spans;
}
