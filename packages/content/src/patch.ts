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
const fenceBalance = (s: string) => {
  let n = 0;
  for (const line of s.split('\n')) {
    if (/^\s*:::\s*[A-Za-z]/.test(line)) n++;
    else if (/^\s*:::\s*$/.test(line)) n--;
  }
  return n;
};
const serious = (f: LintFinding[]) => f.filter((x) => x.severity === 'blocker' || x.severity === 'major').length;
const join = (blocks: string[]) => blocks.filter((b) => b.trim()).join('\n\n');

/**
 * Applies `changes` to `blocks` one by one. A change is dropped (the old block stays) when it deletes a block with a heading,
 * a `:::` directive or a formula, deletes more than MAX_DELETED_BLOCKS blocks, drops a heading or formula key the old block
 * had, leaves `:::` fences unbalanced, or makes the whole section lint worse at blocker or major level (a KaTeX error).
 */
export function applyGuardedChanges(blocks: string[], changes: BlockChange[], lint: (markdown: string) => LintFinding[]): GuardedPatch {
  const out = [...blocks];
  const kept = new Set<number>();
  const reverted: RevertedChange[] = [];
  let deleted = 0;
  let base = -1;
  for (const c of changes) {
    if (!Number.isInteger(c.block) || c.block < 0 || c.block >= out.length) continue;
    const old = out[c.block];
    const text = c.text.trim();
    const drop = (reason: string) => { reverted.push({ block: c.block, reason }); };
    if (!text) {
      if (!old.trim()) continue;
      if (headings(old).length || hasDirective(old) || formulaKeys(old).length) { drop('it would delete a heading, a formula or another special block'); continue; }
      if (deleted >= MAX_DELETED_BLOCKS) { drop(`it would delete more than ${MAX_DELETED_BLOCKS} blocks`); continue; }
    } else {
      const lostKey = formulaKeys(old).find((k) => !formulaKeys(text).includes(k));
      if (lostKey) { drop(`it drops the formula "${lostKey}"`); continue; }
      const newHeadings = headings(text);
      if (headings(old).some((h) => !newHeadings.includes(h))) { drop('it drops or rewrites a heading'); continue; }
      if (fenceBalance(text) !== 0 && fenceBalance(text) !== fenceBalance(old)) { drop('it leaves a ::: fence open'); continue; }
    }
    if (base < 0) base = serious(lint(join(out)));
    const next = [...out];
    next[c.block] = text;
    const after = serious(lint(join(next)));
    if (after > base) { drop('it introduces a formula or formatting error'); continue; }
    base = after;
    out[c.block] = text;
    kept.add(c.block);
    if (!text) deleted++;
  }
  return { blocks: out, kept: [...kept].sort((a, b) => a - b), reverted };
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
