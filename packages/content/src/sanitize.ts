// Cleans control characters and tool-call markup that some model outputs carry into text. Pure.

// "\t" and "\n" are legitimate whitespace, so they are restored only before the rest of a LaTeX command name.
const TAB_COMMANDS = /^(?:heta|ext(?:bf|it|rm)?|au|imes|anh?|o(?![a-z])|op|riangle(?:left|right)?|ilde|frac|ag)/;
// Function names KaTeX does not define (Italian conventions among them), written as if they were commands.
const UNKNOWN_OPERATORS = /\\(cotan|arcsen|arccotg|arcsinh|arccosh|arctanh|settsinh|settcosh|setttgh|settth|sen|sgn|sign|Log|Arg|dom|rank|Ker|grad|rot|diag)(?![A-Za-z])/g;
const NEWLINE_COMMANDS = /^(?:abla|eq(?![a-z])|ot(?![a-z])|exists|i(?![a-z])|u(?![a-z])|leq|geq|mid|parallel|subseteq|supseteq)/;

/** Tool-call wrapper tags that models leave in text (</markdown>, </invoke>). Same pattern content-core 0.3.0 rejects. */
export const GENERATOR_MARKUP = /<\/?(?:markdown|invoke|parameter|function_calls|antml:[\w-]+|tool_use|tool_result)\b[^>]*>/i;
const TAG_LINE = `[ \\t]*(?:${GENERATOR_MARKUP.source}[ \\t]*)+`;
const MARKUP_LINE = new RegExp(`\\r?\\n${TAG_LINE}(?=\\r?\\n|$)|^${TAG_LINE}(?:\\r?\\n|$)`, 'gi');
const MARKUP_ANY = new RegExp(GENERATOR_MARKUP.source, 'gi');

/** Removes generator markup: a line holding only tags goes away with its newline, a tag inside a line is cut out. */
export function stripGeneratorMarkup(s: string): string {
  return s.replace(MARKUP_LINE, '').replace(MARKUP_ANY, '');
}

/**
 * A control character in LaTeX text is almost always a backslash that was eaten by an escape: "\f" in "\frac", "\b" in
 * "\beta", or a stray byte in front of the command name. ANSI colour and terminal mode sequences come from the CLI that
 * ran the model.
 * Function names KaTeX lacks, such as \cotan or \sen, become \operatorname{...}; \Q and \C become \mathbb{Q} and \mathbb{C}.
 * Tool-call markup the model wrapped its answer in is removed.
 */
export function sanitizeModelText(s: string): string {
  return stripLatexRepairs(cleanTerminal(s));
}

/** Code (lab programs, expressions, SMILES) keeps its backslashes and whitespace: only markup, terminal codes and control bytes go. */
export function sanitizeModelCode(s: string): string {
  return cleanTerminal(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function cleanTerminal(s: string): string {
  return stripGeneratorMarkup(s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // A terminal mode code ("[?25l" hides the cursor) whose escape byte the CLI already dropped; never valid text.
    .replace(/\[\?\d+[hl]/g, '');
}

function stripLatexRepairs(s: string): string {
  return s
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

/** JSON-schema keyword that marks a string field as code. `codeString()` in the service sets it. */
export const CODE_KEYWORD = 'x-code';

type Schema = Record<string, unknown> | undefined;
const asSchema = (v: unknown): Schema => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const branches = (s: Schema) => ['anyOf', 'oneOf', 'allOf'].flatMap((k) => (Array.isArray(s?.[k]) ? (s![k] as unknown[]).map(asSchema) : []));
const isCode = (s: Schema): boolean => !!s && (s[CODE_KEYWORD] === true || branches(s).some(isCode));
const child = (s: Schema, key: string): Schema[] => [s, ...branches(s)].map((b) => asSchema(asSchema(b?.properties)?.[key]) ?? undefined).filter(Boolean);
const items = (s: Schema): Schema[] => [s, ...branches(s)].map((b) => asSchema(b?.items)).filter(Boolean);

/**
 * sanitizeModelText on every string of a parsed JSON value. With the answer's raw JSON schema, strings the schema marks as
 * code (`CODE_KEYWORD`) get sanitizeModelCode instead, so the LaTeX repairs never touch them.
 */
export function sanitizeModelValue<T>(value: T, schema?: Record<string, unknown>): T {
  return walk(value, schema ? [schema] : []) as T;
}

function walk(value: unknown, schemas: Schema[]): unknown {
  if (typeof value === 'string') return schemas.some(isCode) ? sanitizeModelCode(value) : sanitizeModelText(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, schemas.flatMap(items)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, schemas.flatMap((s) => child(s, k)))]));
  return value;
}
