// Guards for model patches: block changes are applied one at a time and a change that would damage the section is dropped. Pure.
import { LATEX_COMMAND_N_T, UNICODE_MATH } from './lint.ts';
import { rewriteLatexNames } from './sanitize.ts';
import type { LintFinding } from './types.ts';

export interface BlockChange { block: number; text: string }
export interface RevertedChange { block: number; reason: string }
export interface GuardedPatch {
  /** All blocks, same indices as the input; a deleted block is ''. */
  blocks: string[];
  /** Indices of the blocks that changed. */
  kept: number[];
  reverted: RevertedChange[];
}

/** A fix may delete this many blocks at most; a model that wants more is rewriting, not fixing. */
export const MAX_DELETED_BLOCKS = 3;
/** A fix for off-program material may delete this many times as many blocks. */
export const REMOVAL_FACTOR = 5;
/** A fix that leaves less than this share of the section's text is not applied; it waits as a proposal. */
export const MIN_KEPT_SHARE = 0.8;

const headings = (s: string) => [...s.matchAll(/^#{1,6}[ \t]+\S.*$/gm)].map((m) => m[0].trim());
const formulaKeys = (s: string) => [...s.matchAll(/:::formula\{[^}]*\bkey="([^"]+)"/g)].map((m) => m[1]);
/** The first item of `before` that `after` has fewer times than `before`: two identical headings of which one goes count as a loss. */
function firstLost(before: string[], after: string[]): string | undefined {
  const left = new Map<string, number>();
  for (const x of after) left.set(x, (left.get(x) ?? 0) + 1);
  return before.find((x) => { const n = left.get(x) ?? 0; left.set(x, n - 1); return n <= 0; });
}
const hasDirective = (s: string) => /^[ \t]*:::/m.test(s);
/** A block that is one :::image directive and nothing else. */
const onlyImage = (s: string) => /^\s*:::image\{[^}]*\}\s*\n\s*:::\s*$/.test(s);
const fenceBalance = (s: string) => {
  let n = 0;
  for (const line of s.split('\n')) {
    if (/^\s*:::\s*[A-Za-z]/.test(line)) n++;
    else if (/^\s*:::\s*$/.test(line)) n--;
  }
  return n;
};
/** Blocker and major findings counted per rule and severity, so trading one kind of error for another still counts as worse. */
const serious = (f: LintFinding[]) => {
  const n = new Map<string, number>();
  for (const x of f) {
    if (x.severity !== 'blocker' && x.severity !== 'major') continue;
    const k = `${x.rule}:${x.severity}`;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return n;
};
const worse = (after: Map<string, number>, base: Map<string, number>) => [...after].some(([k, n]) => n > (base.get(k) ?? 0));
const join = (blocks: string[]) => blocks.filter((b) => b.trim()).join('\n\n');

/**
 * Applies `changes` to `blocks` one by one. A change is dropped (the old block stays) when it deletes a block with a heading,
 * a `:::` directive or a formula, deletes more than MAX_DELETED_BLOCKS blocks, drops a heading or formula key the old block
 * had, leaves `:::` fences unbalanced, or adds a blocker or major lint finding of any rule (a KaTeX error, a placeholder).
 * With `figures` (the fix answers a figure problem), a block that is only an image may be deleted: removing a useless
 * figure is the fix, and refusing it left the problem open for ever.
 */
/**
 * `removals`: the fix removes off-program material, so whole blocks may go, headings, formulas and ::: blocks included,
 * and up to five times the usual number of them. Changed (not deleted) blocks keep every guard.
 */
export function applyGuardedChanges(blocks: string[], changes: BlockChange[], lint: (markdown: string) => LintFinding[], opts: { figures?: boolean; removals?: boolean } = {}): GuardedPatch {
  const out = [...blocks];
  const kept = new Set<number>();
  const reverted: RevertedChange[] = [];
  let deleted = 0;
  let base: Map<string, number> | null = null;
  for (const c of changes) {
    if (!Number.isInteger(c.block) || c.block < 0 || c.block >= out.length) continue;
    const old = out[c.block];
    const text = c.text.trim();
    const drop = (reason: string) => { reverted.push({ block: c.block, reason }); };
    if (!text) {
      if (!old.trim()) continue;
      // Also with removals: the fix model is told a figure goes only when a problem is about that figure, a note around an image included.
      if (!opts.figures && /^[ \t]*:::image\{/m.test(old)) { drop('it would delete a figure block'); continue; }
      const image = opts.figures && onlyImage(old);
      if (!image && !opts.removals && (headings(old).length || hasDirective(old) || formulaKeys(old).length)) { drop('it would delete a heading, a formula or another special block'); continue; }
      const limit = opts.removals ? MAX_DELETED_BLOCKS * REMOVAL_FACTOR : MAX_DELETED_BLOCKS;
      if (deleted >= limit) { drop(`it would delete more than ${limit} blocks`); continue; }
    } else {
      const lostKey = firstLost(formulaKeys(old), formulaKeys(text));
      if (lostKey) { drop(`it drops the formula "${lostKey}"`); continue; }
      if (firstLost(headings(old), headings(text))) { drop('it drops or rewrites a heading'); continue; }
      // A block rewritten without its picture loses the figure as a deletion does, so the same rule holds.
      if (!opts.figures && firstLost(imageSources(old), imageSources(text))) { drop('it would remove a figure'); continue; }
      if (fenceBalance(text) !== 0 && fenceBalance(text) !== fenceBalance(old)) { drop('it leaves a ::: fence open'); continue; }
    }
    base ??= serious(lint(join(out)));
    const next = [...out];
    next[c.block] = text;
    const after = serious(lint(join(next)));
    if (worse(after, base)) { drop('it introduces a formula or formatting error'); continue; }
    base = after;
    out[c.block] = text;
    kept.add(c.block);
    if (!text) deleted++;
  }
  return { blocks: out, kept: [...kept].sort((a, b) => a - b), reverted };
}

/**
 * The guard rules as text for the fix model, built from the constants above so that the prompt and the guard cannot drift.
 * Without them the model deleted headings, formulas and blocks the guard then reverted, and one fix in five changed nothing.
 */
export function guardRules(opts: { figures?: boolean; removals?: boolean } = {}): string {
  const rules = opts.removals
    ? [`This fix removes off-program material, so you may delete whole blocks, headings, formulas and ::: blocks, up to ${MAX_DELETED_BLOCKS * REMOVAL_FACTOR} blocks. A block you rewrite instead of deleting keeps its heading and its formula keys.`]
    : [
      `Never delete a block that holds a heading, a formula or another ::: block, and never drop a heading or a formula key from a block you rewrite. Keep the heading line and the key="..." of every formula as they are.`,
      `Delete at most ${MAX_DELETED_BLOCKS} blocks. Correct the sentence at fault instead of deleting its paragraph.`,
    ];
  rules.push(opts.figures
    ? 'A figure block (:::image) may be deleted because a problem is about that figure.'
    : 'Never delete a figure block (:::image): it may go only when a problem is about that figure.');
  rules.push(
    'Every ::: block you write opens and closes.',
    'Write no formula or formatting error: a change that adds a KaTeX error, a placeholder or another blocker or major lint finding is dropped.',
    `A fix that leaves less than ${Math.round(MIN_KEPT_SHARE * 100)}% of the section's text is not applied; it waits for the author.`,
  );
  return `Rules the builder enforces on every change. A change that breaks one is dropped and its problem stays open:\n${rules.map((r) => `- ${r}`).join('\n')}`;
}

/**
 * What the fix model answers, in plain text. Each part starts with a line that begins with "@@@":
 *   @@@ block 3 | issues 1, 2     the new text of block 3 follows, up to the next "@@@" line, exactly as it goes in the book
 *   @@@ delete 5 | issues 2       removes block 5
 *   @@@ resolved | issues 3       the current text already fixes problem 3; one sentence says where
 *   @@@ figures                   a JSON array of figure specs follows (only when the fix may add figures)
 *   @@@ none                      nothing to change, alone
 * The new text is not a JSON string, so LaTeX backslashes need no escaping and none is eaten on the way.
 */
export const PATCH_MARK = '@@@';

export interface PatchChange extends BlockChange { issues: number[] }
export interface ParsedPatch {
  changes: PatchChange[];
  /** Problems (1-based, as numbered in the request) the model says the current text already fixes, each group with its reason. */
  resolved: { issues: number[]; reason: string }[];
  /** The JSON of the figures part, not yet checked against a figure schema. Null when there is none. */
  figures: unknown[] | null;
}

/**
 * Reads the answer described at PATCH_MARK. `blocks` is the number of numbered blocks, `issues` the number of numbered
 * problems (0 for an author's instruction, which names none). A problem returns a message the model can act on in a repair turn.
 * The caller passes text whose terminal codes and control characters are already removed. A new text gets the function
 * names KaTeX lacks rewritten (\cotan), like a drafted section, and nothing else: these bodies never were JSON strings,
 * so no backslash is guessed at.
 */
export function parsePatchAnswer(text: string, limits: { blocks: number; issues: number }): { ok: true; data: ParsedPatch } | { ok: false; problem: string } {
  const fail = (problem: string) => ({ ok: false as const, problem });
  type Part = { kind: string; arg: string; issues: string; body: string[] };
  const parts: Part[] = [];
  const before: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const head = new RegExp(`^${PATCH_MARK}[ \\t]*(block|delete|resolved|figures|none)\\b[ \\t]*(\\d*)[ \\t]*(?:\\|[ \\t]*issues?[ \\t]*([\\d,\\s]*))?[ \\t]*$`).exec(line);
    if (head) parts.push({ kind: head[1], arg: head[2], issues: head[3] ?? '', body: [] });
    else if (line.startsWith(PATCH_MARK)) return fail(`This line is not a valid part header: "${line.slice(0, 80)}". Headers look like "${PATCH_MARK} block 3 | issues 1, 2".`);
    else (parts.at(-1)?.body ?? before).push(line);
  }
  if (before.join('').trim()) return fail(`Text before the first "${PATCH_MARK}" line: every word of the answer belongs to a part.`);
  if (!parts.length) return fail(`The answer has no parts. Start each part with a "${PATCH_MARK}" line, or answer only "${PATCH_MARK} none" when nothing needs to change.`);
  const issueList = (raw: string): number[] | string => {
    const nums = raw.split(/[,\s]+/).filter(Boolean).map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 1 || (limits.issues > 0 && n > limits.issues))) return `Problem numbers must be between 1 and ${limits.issues}, as in the request.`;
    return limits.issues > 0 ? nums : [];
  };
  const changes: PatchChange[] = [];
  const resolved: ParsedPatch['resolved'] = [];
  let figures: unknown[] | null = null;
  const seen = new Set<number>();
  for (const p of parts) {
    const body = p.body.join('\n').trim();
    if (p.kind === 'none') {
      if (parts.length > 1 || body) return fail(`"${PATCH_MARK} none" stands alone, with no text.`);
      return { ok: true, data: { changes, resolved, figures } };
    }
    const issues = issueList(p.issues);
    if (typeof issues === 'string') return fail(issues);
    if (p.kind === 'figures') {
      try {
        const v: unknown = JSON.parse(body.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(v)) return fail(`The "${PATCH_MARK} figures" part must be a JSON array.`);
        figures = v;
      } catch (err) {
        return fail(`The "${PATCH_MARK} figures" part is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (p.kind === 'resolved') {
      if (!issues.length) return fail(`"${PATCH_MARK} resolved" needs the numbers of the problems: "${PATCH_MARK} resolved | issues 2".`);
      resolved.push({ issues, reason: body });
      continue;
    }
    const block = Number(p.arg);
    if (p.arg === '' || !Number.isInteger(block) || block < 0 || block >= limits.blocks) return fail(`"${PATCH_MARK} ${p.kind}" needs the number of an existing block, from 0 to ${limits.blocks - 1}.`);
    if (seen.has(block)) return fail(`Block ${block} appears twice. Give each block once, with its full new text.`);
    seen.add(block);
    if (p.kind === 'block' && !body) return fail(`Block ${block} has no text. To remove a block, write "${PATCH_MARK} delete ${block}".`);
    changes.push({ block, text: p.kind === 'delete' ? '' : rewriteLatexNames(body), issues });
  }
  return { ok: true, data: { changes, resolved, figures } };
}

/** Opening lines of ::: blocks, by block name. */
const directiveNames = (s: string) => [...s.matchAll(/^[ \t]*:::[ \t]*([A-Za-z][\w-]*)/gm)].map((m) => m[1]);
const imageSources = (s: string) => [...s.matchAll(/:::image\{[^}]*\bsrc="([^"]+)"/g)].map((m) => m[1]);

/**
 * Why a rewrite of a whole section must not replace the original, or null when it may. A rewrite loses structure when it
 * drops or rewrites a heading, drops a formula key, has fewer ::: blocks of some kind than the original, drops an image
 * or leaves a ::: fence open.
 */
export function lostStructure(before: string, after: string): string | null {
  const heading = firstLost(headings(before), headings(after));
  if (heading) return `it drops or rewrites the heading "${heading}"`;
  const key = firstLost(formulaKeys(before), formulaKeys(after));
  if (key) return `it drops the formula "${key}"`;
  const blocks = directiveNames(after);
  for (const name of new Set(directiveNames(before))) {
    if (blocks.filter((n) => n === name).length < directiveNames(before).filter((n) => n === name).length) return `it drops a :::${name} block`;
  }
  const image = firstLost(imageSources(before), imageSources(after));
  if (image) return `it drops the image "${image}"`;
  if (fenceBalance(after) !== 0 && fenceBalance(after) !== fenceBalance(before)) return 'it leaves a ::: fence open';
  return null;
}

/** Prose only: display and inline math and the opening line of a ::: block hold LaTeX commands and attributes, which are no vocabulary. */
const withoutMath = (s: string) => s.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ').replace(/^[ \t]*:::.*$/gm, ' ');
export const paragraphWords = (s: string | undefined) => withoutMath(s ?? '').toLowerCase().match(/\p{L}{3,}/gu) ?? [];
const paragraphsOf = (md: string) => md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/**
 * A rewrite of a whole section sometimes starts or ends with a note about the rewrite ("I fixed the step in ..."), which would
 * go into the book. True when the first or the last paragraph of `after` has few words in common with the same paragraph of
 * `before` (a short one must use only words the old section has). Only prose counts: a corrected number or formula,
 * inline or display, passes.
 */
export function addsCommentary(before: string, after: string): boolean {
  const old = paragraphsOf(before);
  const next = paragraphsOf(after);
  const known = new Set(paragraphWords(before));
  return [[old[0], next[0]], [old.at(-1), next.at(-1)]].some(([x, y]) => {
    const words = paragraphWords(y);
    if (!words.length) return false;
    const sameParagraph = new Set(paragraphWords(x));
    return words.length >= 4 ? words.filter((w) => sameParagraph.has(w)).length / words.length < 0.5 : words.some((w) => !known.has(w));
  });
}

/** Math spans: display and inline. */
const MATH_SPAN = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g;

/**
 * LaTeX commands for the symbols the unicode-math lint rule flags in prose. A repair that follows the rule writes "$\tau$" for
 * "τ", so the guard reads both as the same symbol. Several commands can stand for one character (\epsilon and \varepsilon are
 * both ε), because a Unicode text does not tell them apart.
 */
export const MATH_SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'π', rho: 'ρ', varrho: 'ρ',
  sigma: 'σ', varsigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ',
  Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '⋅', circ: '∘', ast: '∗',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', oint: '∮', sqrt: '√', forall: '∀', exists: '∃', emptyset: '∅', varnothing: '∅',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
  wedge: '∧', vee: '∨', oplus: '⊕', otimes: '⊗', perp: '⊥', parallel: '∥', angle: '∠', therefore: '∴', because: '∵', cdots: '⋯',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
};
/**
 * LaTeX commands that only decorate, size, space or group what they hold, so a repair may add or drop them. Any other command
 * (\\sin, \\lim, \\max, \\not, one this list does not know) names something, so it counts as a word: "$\\sin x$" and "$\\cos x$"
 * differ. shortcut: a decoration missing from this list makes a repair that adds it look like a change and be refused, which
 * keeps the old text; add the command here when that shows up.
 */
const PRESENTATION = new Set([
  'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathscr', 'mathfrak', 'boldsymbol', 'bm', 'rm', 'bf', 'it',
  'text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'textnormal', 'mbox', 'hbox', 'operatorname',
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'middle',
  'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits',
  'quad', 'qquad', 'hspace', 'vspace', 'hskip', 'enspace', 'thinspace', 'medspace', 'thickspace', 'negthinspace', 'phantom', 'vphantom', 'hphantom', 'strut',
  'frac', 'dfrac', 'tfrac', 'binom', 'dbinom', 'tbinom', 'begin', 'end', 'tag', 'label', 'nonumber', 'notag', 'cr', 'hline',
  'vec', 'hat', 'bar', 'overline', 'underline', 'dot', 'ddot', 'tilde', 'widehat', 'widetilde', 'overrightarrow', 'overbrace', 'underbrace', 'color',
  'ldots', 'dots', 'vdots', 'ddots', 'lbrace', 'rbrace', 'langle', 'rangle', 'lvert', 'rvert', 'lVert', 'rVert', 'vert', 'Vert', 'mid', 'lfloor', 'rfloor', 'lceil', 'rceil',
  'mathbin', 'mathrel', 'mathop', 'mathord',
]);
/** Characters that look alike and mean the same symbol: the micro sign and the ohm sign, and the variant Greek letters. */
const SAME_SYMBOL: Record<string, string> = { '\u00b5': '\u03bc', '\u2126': '\u03a9', 'ς': 'σ', 'ϕ': 'φ', 'ϵ': 'ε', 'ϑ': 'θ', 'ϖ': 'π', 'ϱ': 'ρ', '−': '-', '–': '-' };
const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' } as const;
const WHOLE_SYMBOL = new RegExp(`^(?:${UNICODE_MATH.source})$`, 'u');
const SYMBOL = `(?:${UNICODE_MATH.source})`;
const MATH_TOKEN = new RegExp(`${SYMBOL}|\\p{L}+|\\d+(?:\\.\\d+)*|[-+^]`, 'gu');
// Prose has no operators: a sign counts only in front of a digit and not inside a word, so a hyphen or a list marker is none.
const PROSE_TOKEN = new RegExp(`${SYMBOL}|\\p{L}+|\\d+(?:\\.\\d+)*|(?<!\\p{L})[-+](?=\\.?\\d)`, 'gu');

/**
 * The words, numbers and symbols of a text, in order and lower case. Markup, math delimiters, LaTeX commands without a symbol
 * and spacing are not words, and neither is a literal backslash-n or backslash-t outside math (a line break or tab a model
 * wrote as two characters). A number keeps its value however it is typeset: its decimal separator ("," or "{,}") reads as ".",
 * and a minus, a plus and a "^" in math, or in front of a digit in prose, are tokens, so a dropped sign or exponent shows.
 * A symbol is one token, written as a Unicode character or as its LaTeX command. Letters and digits count separately, so "x1"
 * and "x_1" give the same sequence.
 */
function wordSequence(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  const commands = (s: string) => s
    .replace(/\\mathbb\{([RNZQC])\}/g, (_, c: keyof typeof BLACKBOARD) => ` ${BLACKBOARD[c]} `)
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => (MATH_SYMBOLS[name] ? ` ${MATH_SYMBOLS[name]} ` : PRESENTATION.has(name) ? ' ' : ` ${name} `))
    .replace(/\\./g, ' ');
  // A backslash-n or -t that starts a LaTeX command (\nu, \to) is no line break, also in a fragment with an unbalanced $.
  const prose = (s: string) => commands(s.replace(/(?<!\\)\\[nt]/g, (m, at: number) => (LATEX_COMMAND_N_T.test(s.slice(at)) ? m : ' ')));
  const take = (s: string, re: RegExp) => {
    const same = s.replace(/[\u00b5\u2126ςϕϵϑϖϱ−–]/g, (c) => SAME_SYMBOL[c]).replace(/(\d)(?:\{,\}|[.,])(?=\d)/g, '$1.');
    for (const [tok] of same.matchAll(re)) out.push(/^\p{L}+$/u.test(tok) && !WHOLE_SYMBOL.test(tok) ? tok.toLowerCase() : tok);
  };
  for (const m of text.matchAll(MATH_SPAN)) {
    take(prose(text.slice(last, m.index)), PROSE_TOKEN);
    take(commands(m[0]), MATH_TOKEN);
    last = m.index + m[0].length;
  }
  take(prose(text.slice(last)), PROSE_TOKEN);
  return out;
}

/**
 * How a formatting repair changed the words and numbers of a text, or null when it changed none. A repair may change line
 * breaks, spacing, math delimiters and markup, and must neither add nor remove a word or a number.
 */
export function changedWords(before: string, after: string): string | null {
  // Text made only of symbols the comparison sets aside (a lone "$\bot$") has no words, so its loss is checked by itself.
  if (before.trim() && !after.trim()) return 'it removes all the text';
  const a = wordSequence(before);
  const b = wordSequence(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  if (!removed.length && !added.length) return null;
  const list = (w: string[]) => `"${w.slice(0, 6).join(' ')}${w.length > 6 ? ' …' : ''}"`;
  if (!removed.length) return `it adds ${list(added)}`;
  if (!added.length) return `it removes ${list(removed)}`;
  return `it replaces ${list(removed)} with ${list(added)}`;
}

const flat = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();

/** The first 60 whitespace-normalised characters of a quote: what issues are matched on. */
export const quoteKey = (quote: string) => flat(quote).slice(0, 60);

/** Two quotes point at the same text. Empty quotes match nothing. */
export function sameQuote(a: string, b: string): boolean {
  const x = quoteKey(a);
  const y = quoteKey(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

/** The quote lies in this block (or the block is part of the quote). */
export function quoteInBlock(quote: string, block: string): boolean {
  const k = quoteKey(quote);
  const b = flat(block);
  return !!k && !!b && (b.includes(k) || k.includes(b));
}

/**
 * Formula blocks whose key is already defined in another section lose their wrapper and keep their math, so the book
 * has one formula per key. References to the key keep pointing at the first definition.
 */
export function unwrapFormulaKeys(markdown: string, taken: Set<string>): string {
  if (!taken.size) return markdown;
  const out: string[] = [];
  let open = false;
  for (const line of markdown.split('\n')) {
    const key = /^\s*:::formula\{[^}]*key="([^"]+)"[^}]*\}\s*$/.exec(line)?.[1];
    if (key && taken.has(key)) { open = true; continue; }
    if (open && line.trim() === ':::') { open = false; continue; }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Section links whose id is in no outline node, which models write when they copy a long id from a list or use a
 * chapter's slug instead of its id. A link whose id shares its first 8 characters with exactly one node, or equals a
 * chapter slug, points there; any other becomes its plain label.
 */
export function repairSectionRefs(markdown: string, nodes: { id: string; slug?: string }[]): string {
  const known = new Set(nodes.map((n) => n.id));
  const bySlug = new Map(nodes.filter((n) => n.slug).map((n) => [n.slug!, n.id]));
  // The label has no "[" of its own, so a match can't start at the "[" of an earlier interval like ]a,b[.
  return markdown.replace(/\[([^[\]]*)\]\(ref:section\/([^)\s]+)\)/g, (full, label: string, id: string) => {
    if (known.has(id)) return full;
    const near = nodes.filter((n) => n.id.slice(0, 8) === id.slice(0, 8));
    const target = bySlug.get(id) ?? (near.length === 1 ? near[0].id : null);
    return target ? `[${label}](ref:section/${target})` : label;
  });
}

/**
 * Removes the references a removed section leaves behind: links to it keep their label as plain text, and references to
 * the formulas it defined become the formula's name (first letter lower case, as it sits inside a sentence).
 */
export function dropReferences(markdown: string, nodeId: string, formulas: { key: string; label: string }[]): string {
  const name = (key: string) => {
    const label = formulas.find((f) => f.key === key)?.label;
    return label ? label.charAt(0).toLowerCase() + label.slice(1) : null;
  };
  return markdown
    .replace(/\[([^[\]]*)\]\(ref:section\/([^)\s]+)\)/g, (full, label: string, id: string) => (id === nodeId ? label : full))
    .replace(/\[([^[\]]*)\]\(ref:formula\/@([^)\s]+)\)/g, (full, label: string, key: string) => (name(key) ? label : full))
    .replace(/\{\{formula:@([^}\s]+)\}\}/g, (full, key: string) => name(key) ?? full);
}
