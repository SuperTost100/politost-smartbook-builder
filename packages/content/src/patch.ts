// Guards for model patches: block changes are applied one at a time and a change that would damage the section is dropped. Pure.
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
      const image = opts.figures && onlyImage(old);
      if (!image && !opts.removals && (headings(old).length || hasDirective(old) || formulaKeys(old).length)) { drop('it would delete a heading, a formula or another special block'); continue; }
      const limit = opts.removals ? MAX_DELETED_BLOCKS * REMOVAL_FACTOR : MAX_DELETED_BLOCKS;
      if (deleted >= limit) { drop(`it would delete more than ${limit} blocks`); continue; }
    } else {
      const lostKey = formulaKeys(old).find((k) => !formulaKeys(text).includes(k));
      if (lostKey) { drop(`it drops the formula "${lostKey}"`); continue; }
      const newHeadings = headings(text);
      if (headings(old).some((h) => !newHeadings.includes(h))) { drop('it drops or rewrites a heading'); continue; }
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
 * The bodies get no cleaning here: the caller passes text whose terminal codes and control characters are already removed.
 * TODO(sanitize split): apply the operator-name rewriting (\cotan to \operatorname{cotan}) to the bodies once sanitize.ts
 * offers it apart from the backslash guessing. The guessing must not run on these bodies, which never were JSON strings.
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
    changes.push({ block, text: p.kind === 'delete' ? '' : body, issues });
  }
  return { ok: true, data: { changes, resolved, figures } };
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
