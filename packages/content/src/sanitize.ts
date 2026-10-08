// Cleans control characters that some model outputs carry into text. Pure.

// "\t" and "\n" are legitimate whitespace, so they are restored only before the rest of a LaTeX command name.
const TAB_COMMANDS = /^(?:heta|ext(?:bf|it|rm)?|au|imes|anh?|o(?![a-z])|op|riangle(?:left|right)?|ilde|frac|ag)/;
// Function names KaTeX does not define (Italian conventions among them), written as if they were commands.
const UNKNOWN_OPERATORS = /\\(cotan|arcsen|arccotg|arcsinh|arccosh|arctanh|settsinh|settcosh|setttgh|settth|sen|sgn|sign|Log|Arg|dom|rank|Ker|grad|rot|diag)(?![A-Za-z])/g;
const NEWLINE_COMMANDS = /^(?:abla|eq(?![a-z])|ot(?![a-z])|exists|i(?![a-z])|u(?![a-z])|leq|geq|mid|parallel|subseteq|supseteq)/;

/**
 * A control character in LaTeX text is almost always a backslash that was eaten by an escape: "\f" in "\frac", "\b" in
 * "\beta", or a stray byte in front of the command name. ANSI colour sequences come from the CLI that ran the model.
 * Function names KaTeX lacks, such as \cotan or \sen, become \operatorname{...}; \Q and \C become \mathbb{Q} and \mathbb{C}.
 */
export function sanitizeModelText(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\t(?=[a-z])/g, (c, at: number, all: string) => (TAB_COMMANDS.test(all.slice(at + 1)) && inMath(all, at) ? '\\t' : c))
    .replace(/\n(?=[a-z])/g, (c, at: number, all: string) => (NEWLINE_COMMANDS.test(all.slice(at + 1)) && inMath(all, at) ? '\\n' : c))
    .replace(/[\x00-\x08\x0b-\x1f]/g, (c, at: number, all: string) => {
      if (c === '\x0c') return '\\f';
      if (c === '\x08') return '\\b';
      if (c === '\r' && /[A-Za-z]/.test(all[at + 1] ?? '')) return '\\r';
      if (/[A-Za-z]/.test(all[at + 1] ?? '')) return '\\';
      return '';
    })
    .replace(UNKNOWN_OPERATORS, '\\operatorname{$1}')
    .replace(/\\([QC])(?![A-Za-z])/g, '\\mathbb{$1}');
}

/** The position is inside $...$ on its line, or inside a $$ display block: an odd number of unescaped dollars before it. */
function inMath(all: string, at: number): boolean {
  const before = all.slice(0, at).replace(/\\\$/g, '');
  const display = (before.match(/\$\$/g) ?? []).length;
  if (display % 2 === 1) return true;
  // A newline that is itself an eaten \n command does not start a line.
  let start = before.length;
  while (start > 0 && (start = before.lastIndexOf('\n', start - 1)) >= 0 && NEWLINE_COMMANDS.test(before.slice(start + 1)));
  const line = before.slice(start + 1).replace(/\$\$/g, '');
  return (line.match(/\$/g) ?? []).length % 2 === 1;
}

/** sanitizeModelText on every string of a parsed JSON value. */
export function sanitizeModelValue<T>(value: T): T {
  if (typeof value === 'string') return sanitizeModelText(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeModelValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeModelValue(v)])) as T;
  return value;
}
