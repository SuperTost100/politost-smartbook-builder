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
      const limit = opts.removals ? MAX_DELETED_BLOCKS * 5 : MAX_DELETED_BLOCKS;
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

/** Opening lines of ::: blocks, by block name. */
const directiveNames = (s: string) => [...s.matchAll(/^[ \t]*:::\s*([A-Za-z][\w-]*)/gm)].map((m) => m[1]);
const imageSources = (s: string) => [...s.matchAll(/:::image\{[^}]*\bsrc="([^"]+)"/g)].map((m) => m[1]);

/**
 * Why a rewrite of a whole section must not replace the original, or null when it may. A rewrite loses structure when it
 * drops or rewrites a heading, drops a formula key, has fewer ::: blocks of some kind than the original, drops an image
 * or leaves a ::: fence open.
 */
export function lostStructure(before: string, after: string): string | null {
  const kept = headings(after);
  const heading = headings(before).find((h) => !kept.includes(h));
  if (heading) return `it drops or rewrites the heading "${heading}"`;
  const keys = formulaKeys(after);
  const key = formulaKeys(before).find((k) => !keys.includes(k));
  if (key) return `it drops the formula "${key}"`;
  const blocks = directiveNames(after);
  for (const name of new Set(directiveNames(before))) {
    if (blocks.filter((n) => n === name).length < directiveNames(before).filter((n) => n === name).length) return `it drops a :::${name} block`;
  }
  const sources = imageSources(after);
  const image = imageSources(before).find((src) => !sources.includes(src));
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
