// Copy of content-core 0.6.0 src/decimalComma.ts from the type DigitCommaKind on (lines 36 to 469 of that file). Content-core does not export
// digitCommas, and its package.json exports only the index, so the decimal-comma lint rule reads it from here.
// shortcut: a copy that must follow content-core, replace it with the import once content-core exports digitCommas. decimalComma.test.ts fails when the copy and the installed file differ.
/**
 * - `decimal`: rendered without the space.
 * - `list`: three or more items joined by commas with no space, as in `1,2,3`, `0,1,\dots` or `(1,2,\pi)`.
 * - `pair`: the two items are all that is inside a pair of brackets, as in `(3,4)` or `[0,2\pi)`.
 * - `script`: indices. The two items are all that is inside `_{...}` or `^{...}`, as in `x_{1,2}`,
 *   or the comma follows a one-character script, as in `x^2,5`.
 * - `marked`: the formula already writes its decimals as `{,}`, so its other commas stay as written.
 */
export type DigitCommaKind = 'decimal' | 'list' | 'pair' | 'script' | 'marked';

/** Every comma between two digits outside text-mode arguments, with how decimalCommas reads it. */
export function digitCommas(tex: string): { index: number; kind: DigitCommaKind }[] {
  if (!/\d,\d/.test(tex)) return [];
  const marked = tex.includes('{,}');
  const skip = protectedRanges(tex);
  const found: { index: number; kind: DigitCommaKind }[] = [];
  for (let i = 1; i < tex.length - 1; i++) {
    if (tex[i] !== ',' || skip[i] || !isDigit(tex[i - 1]) || !isDigit(tex[i + 1])) continue;
    found.push({ index: i, kind: marked ? 'marked' : commaKind(tex, i, skip) });
  }
  return found;
}

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';
const isLetter = (ch: string | undefined) => ch !== undefined && /[A-Za-z]/.test(ch);
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** Commands whose arguments are text or sizes, by how many leading `{...}` arguments to leave alone. */
const PROTECTED_ARGS: Record<string, number> = {
  text: 1, textrm: 1, textit: 1, textbf: 1, textsf: 1, texttt: 1, textnormal: 1, textup: 1, textmd: 1,
  emph: 1, mbox: 1, hbox: 1, operatorname: 1, tag: 1, label: 1, href: 1, url: 1,
  hspace: 1, vspace: 1, rule: 2, raisebox: 1, color: 1, textcolor: 1, colorbox: 2, fcolorbox: 3,
};

/** Commands that read a dimension straight after the name, without braces. */
const SIZE_WITHOUT_BRACES = new Set(['kern', 'mkern', 'hskip', 'mskip', 'mspace']);

/** Brackets around a pair. Either one can open or close, so `[0,1)`, `]0,1[` and `\rbrack 0,1\lbrack` count. */
const BRACKET_CHARS = new Set(['(', ')', '[', ']']);
const BRACKET_WORDS = new Set(['lbrack', 'rbrack', 'lbrace', 'rbrace', 'langle', 'rangle', 'lparen', 'rparen']);
/** Size prefixes between a pair and its closing bracket: `\right)`, `\bigr]`. */
const SIZE_WORDS = new Set([
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'Bigl', 'biggl', 'Biggl', 'bigr', 'Bigr', 'biggr', 'Biggr',
]);
/**
 * Inside brackets, these make the content more than two items, so the comma is a decimal:
 * units and text (`(2,0\,\mathrm{kg})`), spacing, and relations.
 */
const NOT_IN_ITEM = new Set([
  ...Object.keys(PROTECTED_ARGS), 'mathrm', 'rm', 'quad', 'qquad', 'enspace', 'thinspace', 'medspace',
  'thickspace', 'kern', 'mkern', 'approx', 'sim', 'simeq', 'cong', 'equiv', 'le', 'leq', 'ge', 'geq',
  'lt', 'gt', 'ne', 'neq', 'in', 'notin', 'ni', 'subset', 'subseteq', 'supset', 'supseteq', 'to',
  'mapsto', 'rightarrow', 'Rightarrow', 'leftarrow', 'Leftarrow', 'implies', 'iff',
]);
/** List items that are not numbers: `0,1,\dots`. */
const ITEM_WORDS = new Set(['dots', 'ldots', 'cdots', 'dotsc', 'dotsb', 'infty']);
/** Functions of one argument: `\log(2,5)` holds one number, a decimal. */
const UNARY_FUNCTIONS = new Set([
  'log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth',
]);

function commaKind(tex: string, comma: number, skip: boolean[]): DigitCommaKind {
  // The cheap check first: a run of plain numbers is settled without walking the whole run.
  if (runLength(tex, comma, skip) >= 3) return 'list';
  if (isExpressionList(tex, comma, skip)) return 'list';
  // `x^2,5`: the script takes only the `2`, so this comma cannot sit inside a number.
  if (afterScriptChar(tex, comma)) return 'script';
  // Integers are not written with a leading zero, so `(1,00)` and `(0,05)` hold decimals.
  if (tex[comma + 1] === '0' && isDigit(tex[comma + 2])) return 'decimal';
  // Scientific notation: `(6,67\cdot10^{-11})`.
  if (/^\d+\s*\\(?:cdot|times)\s*\{?10\b/.test(tex.slice(comma + 1))) return 'decimal';
  const open = boundaryBefore(tex, comma);
  const close = boundaryAfter(tex, comma);
  if (!open || !close) return 'decimal';
  if (isBracket(open.token) && isBracket(close.token)) {
    return UNARY_FUNCTIONS.has(wordBefore(tex, open.pos)) ? 'decimal' : 'pair';
  }
  const script = open.token === '{' && close.token === '}' ? scriptBefore(tex, open.pos) : '';
  if (script) {
    // A signed exponent is a value, `10^{-9,52}`. Subscripts are indices even when signed, `a_{-1,2}`.
    let k = open.pos + 1;
    while (isSpace(tex[k])) k++;
    return script === '^' && (tex[k] === '-' || tex[k] === '+') ? 'decimal' : 'script';
  }
  return 'decimal';
}

/** `skip[i]` is true inside a protected argument, in `\verb`, and on the character of a control symbol such as `\,`. */
function protectedRanges(tex: string): boolean[] {
  const skip = new Array<boolean>(tex.length).fill(false);
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] !== '\\') continue;
    const name = /^[A-Za-z]+/.exec(tex.slice(i + 1))?.[0];
    if (!name) {
      if (i + 1 < tex.length) skip[i + 1] = true;
      i++;
      continue;
    }
    let j = i + 1 + name.length;
    const size = SIZE_WITHOUT_BRACES.has(name) ? /^\s*[-+]?[\d.,]+/.exec(tex.slice(j)) : null;
    if (size) {
      // \kern1,5em: the dimension is not math.
      skip.fill(true, j, j + size[0].length);
      i = j + size[0].length - 1;
      continue;
    }
    if (name === 'verb') {
      const end = j < tex.length ? tex.indexOf(tex[j], j + 1) : -1;
      const stop = end === -1 ? tex.length : end + 1;
      skip.fill(true, i, stop);
      i = stop - 1;
      continue;
    }
    let args = PROTECTED_ARGS[name] ?? 0;
    if (tex[j] === '*') j++;
    while (args > 0) {
      while (isSpace(tex[j])) j++;
      if (tex[j] === '[') {
        // optional argument, as in \colorbox[rgb]{...}
        const close = tex.indexOf(']', j);
        if (close === -1) break;
        j = close + 1;
        continue;
      }
      if (tex[j] !== '{') break;
      const end = braceAfter(tex, j);
      skip.fill(true, j, end);
      j = end;
      args--;
    }
    i = j - 1;
  }
  return skip;
}

/** Index just past the `}` that closes the `{` at `open`, or the end of the string. */
function braceAfter(tex: string, open: number): number {
  let depth = 0;
  for (let k = open; k < tex.length; k++) {
    if (tex[k] === '\\') k++;
    else if (tex[k] === '{') depth++;
    else if (tex[k] === '}' && --depth === 0) return k + 1;
  }
  return tex.length;
}

/** Index of the `{` that opens the `}` at `close`, or -1. */
function braceBefore(tex: string, close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    if (escaped(tex, k)) continue;
    if (tex[k] === '}') depth++;
    else if (tex[k] === '{' && --depth === 0) return k;
  }
  return -1;
}

/** True when the character at `k` is the second half of a control symbol such as `\{`. */
const escaped = (tex: string, k: number) => tex[k - 1] === '\\' && tex[k - 2] !== '\\';

/** Start of a number (`3`, `-12`), a single letter or an ITEM_WORDS command that ends at `end`, or -1. */
function itemStartBefore(tex: string, end: number): number {
  let k = end;
  while (isDigit(tex[k - 1])) k--;
  if (k === end) {
    const word = /\\([A-Za-z]+)$/.exec(tex.slice(0, end));
    if (word && ITEM_WORDS.has(word[1])) k = end - word[0].length;
    else if (isLetter(tex[end - 1]) && !isLetter(tex[end - 2]) && tex[end - 2] !== '\\') k = end - 1;
    else return -1;
  }
  if (tex[k - 1] === '-' || tex[k - 1] === '+') k--;
  return k;
}

/** End of the item that starts at `start`, or -1. Same items as itemStartBefore. */
function itemEndAfter(tex: string, start: number): number {
  let k = start;
  if (tex[k] === '-' || tex[k] === '+') k++;
  const from = k;
  while (isDigit(tex[k])) k++;
  if (k === from) {
    const word = /^\\([A-Za-z]+)/.exec(tex.slice(k));
    if (word && ITEM_WORDS.has(word[1])) k += word[0].length;
    else if (isLetter(tex[k]) && !isLetter(tex[k + 1])) k++;
    else return -1;
  }
  return k;
}

/** A comma with no space on either side, outside protected text. */
const tightComma = (tex: string, i: number, skip: boolean[]) =>
  tex[i] === ',' && !skip[i] && !isSpace(tex[i - 1]) && !isSpace(tex[i + 1]);

/** How many items the run of tight commas through `comma` joins, counted up to three: callers only ask whether it is a list. */
function runLength(tex: string, comma: number, skip: boolean[]): number {
  let first = itemStartBefore(tex, comma);
  let last = itemEndAfter(tex, comma + 1);
  if (first === -1 || last === -1) return 0;
  let count = 2;
  while (count < 3 && tightComma(tex, first - 1, skip)) {
    const prev = itemStartBefore(tex, first - 1);
    if (prev === -1) break;
    first = prev;
    count++;
  }
  while (count < 3 && tightComma(tex, last, skip)) {
    const next = itemEndAfter(tex, last + 1);
    if (next === -1) break;
    last = next;
    count++;
  }
  return count;
}

type Boundary = { token: string; pos: number };

/**
 * Walks left from the comma over one item (digits, letters, `+ - / ^ _ '`, groups and most commands)
 * to the bracket or `{` that starts it. Null when the item ends any other way: another comma,
 * a space inside the item, a unit or a relation.
 */
function boundaryBefore(tex: string, comma: number): Boundary | null {
  let k = comma - 1;
  while (k >= 0) {
    const ch = tex[k];
    if (isSpace(ch)) {
      while (isSpace(tex[k])) k--;
      const b = k >= 0 ? boundaryEndingAt(tex, k) : null;
      return b;
    }
    if (escaped(tex, k) && !isLetter(ch)) {
      return ch === '{' || ch === '}' ? { token: `\\${ch}`, pos: k - 1 } : null;
    }
    if (ch === '}') {
      k = braceBefore(tex, k) - 1;
      if (k < -1) return null;
      continue;
    }
    if (ch === '{') return { token: '{', pos: k };
    if (BRACKET_CHARS.has(ch)) return { token: ch, pos: k };
    if (isLetter(ch)) {
      let s = k;
      while (isLetter(tex[s - 1])) s--;
      if (tex[s - 1] === '\\') {
        const name = tex.slice(s, k + 1);
        if (BRACKET_WORDS.has(name)) return { token: `\\${name}`, pos: s - 1 };
        if (NOT_IN_ITEM.has(name)) return null;
        k = s - 2;
      } else {
        k = s - 1;
      }
      continue;
    }
    if (isDigit(ch) || "+-/^_'*!.".includes(ch)) {
      k--;
      continue;
    }
    return null;
  }
  return null;
}

/** The bracket or `{` whose last character is at `k`, or null. */
function boundaryEndingAt(tex: string, k: number): Boundary | null {
  const ch = tex[k];
  if (escaped(tex, k)) return ch === '{' || ch === '}' ? { token: `\\${ch}`, pos: k - 1 } : null;
  if (ch === '{' || BRACKET_CHARS.has(ch)) return { token: ch, pos: k };
  const word = /\\([A-Za-z]+)$/.exec(tex.slice(0, k + 1));
  if (word && BRACKET_WORDS.has(word[1])) return { token: word[0], pos: k + 1 - word[0].length };
  return null;
}

/** Mirror of boundaryBefore: walks right to the bracket or `}` that ends the item. */
function boundaryAfter(tex: string, comma: number): Boundary | null {
  let k = comma + 1;
  let spaced = false;
  while (k < tex.length) {
    const ch = tex[k];
    if (isSpace(ch)) {
      while (isSpace(tex[k])) k++;
      spaced = true;
      continue;
    }
    if (ch === '\\') {
      const name = /^[A-Za-z]+/.exec(tex.slice(k + 1))?.[0];
      if (!name) {
        const sym = tex[k + 1];
        return sym === '{' || sym === '}' ? { token: `\\${sym}`, pos: k } : null;
      }
      if (BRACKET_WORDS.has(name)) return { token: `\\${name}`, pos: k };
      if (SIZE_WORDS.has(name)) {
        k += 1 + name.length;
        continue;
      }
      if (spaced || NOT_IN_ITEM.has(name)) return null;
      k += 1 + name.length;
      continue;
    }
    if (ch === '}') return { token: '}', pos: k };
    if (BRACKET_CHARS.has(ch)) return { token: ch, pos: k };
    // After a space only the closing bracket may follow; anything else means more than one item.
    if (spaced) return null;
    if (ch === '{') {
      k = braceAfter(tex, k);
      continue;
    }
    if (isDigit(ch) || isLetter(ch) || "+-/^_'*!.".includes(ch)) {
      k++;
      continue;
    }
    return null;
  }
  return null;
}

function isBracket(token: string): boolean {
  if (BRACKET_CHARS.has(token) || token === '\\{' || token === '\\}') return true;
  return token.startsWith('\\') && BRACKET_WORDS.has(token.slice(1));
}

/** The command name just before `pos`, skipping spaces and size prefixes: `\log\left(` gives `log`. */
function wordBefore(tex: string, pos: number): string {
  let k = pos;
  for (;;) {
    while (isSpace(tex[k - 1])) k--;
    const word = /\\([A-Za-z]+)$/.exec(tex.slice(0, k));
    if (!word) return '';
    if (!SIZE_WORDS.has(word[1])) return word[1];
    k -= word[0].length;
  }
}

/** `_` or `^` at `pos` as a script operator. `\_` is a literal underscore, so an escaped one does not count. */
function scriptAt(tex: string, pos: number): string {
  if (tex[pos] !== '_' && tex[pos] !== '^') return '';
  let backslashes = 0;
  while (tex[pos - 1 - backslashes] === '\\') backslashes++;
  return backslashes % 2 === 1 ? '' : tex[pos];
}

/** `_` or `^` when the plain `{` at `pos` opens a script group, else an empty string. */
function scriptBefore(tex: string, pos: number): string {
  let k = pos;
  while (isSpace(tex[k - 1])) k--;
  return scriptAt(tex, k - 1);
}

/** True when the digit before the comma is the whole argument of an unbraced `^` or `_`. */
const afterScriptChar = (tex: string, comma: number) => scriptAt(tex, comma - 2) !== '';

/** A comma that could be a decimal: no space around it, a digit on each side, not right after `x^2`. */
const canBeDecimal = (tex: string, comma: number, skip: boolean[]) =>
  tightComma(tex, comma, skip) && isDigit(tex[comma - 1]) && isDigit(tex[comma + 1]) && !afterScriptChar(tex, comma);

/**
 * The run around the comma: everything up to a space, a relation, a unit or spacing command,
 * or the bracket or brace that encloses it, with nested groups such as `f(3)` or `\sqrt{3}` inside one item.
 * Its items are split at the commas with no space around them.
 *
 * It is a list when it has three or more items and at least one of those commas cannot be a decimal:
 * `(1,2,\pi)`, `(1,2^2,3)`. When every comma could be a decimal, as in `(2,0-1,0)`, the run is
 * decimal arithmetic or a list of numbers, and the other rules decide.
 */
function isExpressionList(tex: string, comma: number, skip: boolean[]): boolean {
  const commas = [comma];
  if (!collectRunCommas(tex, comma, -1, skip, commas) || !collectRunCommas(tex, comma, 1, skip, commas)) return false;
  return commas.length >= 2 && commas.some((c) => !canBeDecimal(tex, c, skip));
}

const RUN_STOP_CHARS = new Set(['=', '<', '>', '&', ';', '|']);

/**
 * Walks from the comma in one direction to the end of the run, adding each comma with no space around it.
 * Returns false when the walk meets something it does not understand, so the caller falls back to the other rules.
 */
function collectRunCommas(tex: string, comma: number, dir: 1 | -1, skip: boolean[], commas: number[]): boolean {
  let k = comma + dir;
  while (k >= 0 && k < tex.length) {
    const ch = tex[k];
    if (isSpace(ch) || RUN_STOP_CHARS.has(ch)) return true;
    if (dir === -1 ? escaped(tex, k) : ch === '\\' && !isLetter(tex[k + 1])) return true; // `\,` `\{` `\}`: spacing or a set bracket
    if (ch === ',') {
      if (!tightComma(tex, k, skip)) return true;
      commas.push(k);
      k += dir;
      continue;
    }
    if (dir === -1 && isLetter(ch)) {
      let s = k;
      while (isLetter(tex[s - 1])) s--;
      if (tex[s - 1] === '\\') {
        const name = tex.slice(s, k + 1);
        if (BRACKET_WORDS.has(name) || SIZE_WORDS.has(name) || NOT_IN_ITEM.has(name)) return true;
        k = s - 2;
      } else k = s - 1;
      continue;
    }
    if (dir === 1 && ch === '\\') {
      const name = /^[A-Za-z]+/.exec(tex.slice(k + 1))![0];
      if (BRACKET_WORDS.has(name) || NOT_IN_ITEM.has(name) || (SIZE_WORDS.has(name) && name !== 'left')) return true;
      k += 1 + name.length;
      continue;
    }
    // A nested group stays inside one item.
    const opens = dir === 1 ? '([{' : ')]}';
    const closes = dir === 1 ? ')]}' : '([{';
    if (opens.includes(ch)) {
      const end = groupEnd(tex, k, dir);
      if (end === -1) return false;
      k = end + dir;
      continue;
    }
    if (closes.includes(ch)) return true;
    k += dir;
  }
  return true;
}

/** Index of the bracket or brace that matches the one at `k`, walking in `dir`, or -1. Any bracket kind closes any other. */
function groupEnd(tex: string, k: number, dir: 1 | -1): number {
  const opens = dir === 1 ? '([{' : ')]}';
  const closes = dir === 1 ? ')]}' : '([{';
  let depth = 0;
  for (let i = k; i >= 0 && i < tex.length; i += dir) {
    if (dir === 1 ? tex[i] === '\\' : escaped(tex, i)) {
      if (dir === 1) i++;
      continue;
    }
    if (opens.includes(tex[i])) depth++;
    else if (closes.includes(tex[i]) && --depth === 0) return i;
  }
  return -1;
}
