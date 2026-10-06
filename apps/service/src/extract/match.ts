// Passage matching: tolerant to whitespace, accents, math symbols and a text layer that dropped or reordered formula pieces.
import { repairAccents } from './quality.ts';

/** Lowercase tokens: NFKC, accents stripped, punctuation and math symbols dropped, letter/digit boundaries split ("x2" -> "x","2"). */
export function tokenize(input: string, opts: { latex?: boolean } = {}): string[] {
  return tokenizeSpans(input, opts).map((t) => t.tok);
}

export interface TokenSpan { tok: string; start: number; end: number }

/** Like tokenize, but keeps the [start,end) offsets of each token in the original string. */
export function tokenizeSpans(input: string, opts: { latex?: boolean } = {}): TokenSpan[] {
  let s = repairAccents(input);
  if (opts.latex) s = s.replace(/\\[a-zA-Z]+/g, ' ');
  // Offsets must stay aligned with `s`, so only length-preserving steps run before scanning.
  const out: TokenSpan[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const norm = m[0].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    // Split at letter/digit boundaries.
    const parts = norm.match(/\p{L}+|\p{N}+/gu) ?? [];
    for (const p of parts) out.push({ tok: p, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function normalizeText(input: string, opts: { latex?: boolean } = {}): string {
  return tokenize(input, opts).join(' ');
}

const weight = (t: string) => Math.min(1, 0.4 + 0.2 * t.length);

export interface Window { start: number; end: number; score: number }

/**
 * Best window of `hay` tokens (start index limited to [0, startLimit)) for the needle tokens.
 * Score mixes weighted unigram coverage and bigram coverage so reordered noise does not match.
 */
export function bestWindow(needle: string[], hay: string[], startLimit = hay.length): Window | null {
  const n = needle.length;
  if (!n || !hay.length) return null;
  const need = new Map<string, number>();
  let totalW = 0;
  for (const t of needle) { need.set(t, (need.get(t) ?? 0) + 1); totalW += weight(t); }
  const needBi = new Map<string, number>();
  for (let i = 0; i + 1 < n; i++) { const k = needle[i] + ' ' + needle[i + 1]; needBi.set(k, (needBi.get(k) ?? 0) + 1); }
  const totalBi = Math.max(1, n - 1);

  let best: Window | null = null;
  // Windows slightly longer than the needle absorb inserted junk (stray symbols turned tokens).
  for (const len of [n, Math.ceil(n * 1.4)]) {
    const win = new Map<string, number>();
    let covW = 0;
    const add = (t: string) => {
      const have = win.get(t) ?? 0;
      win.set(t, have + 1);
      if (have < (need.get(t) ?? 0)) covW += weight(t);
    };
    const del = (t: string) => {
      const have = win.get(t)!;
      win.set(t, have - 1);
      if (have <= (need.get(t) ?? 0)) covW -= weight(t);
    };
    const last = Math.min(startLimit - 1, hay.length - 1);
    const size = Math.min(len, hay.length);
    for (let i = 0; i < size; i++) add(hay[i]);
    for (let s = 0; s <= last; s++) {
      const e = Math.min(hay.length, s + size);
      const uni = covW / totalW;
      if (uni > 0.35) {
        // Bigram coverage only for promising windows.
        let bi = 0;
        const seen = new Map<string, number>();
        for (let i = s; i + 1 < e; i++) {
          const k = hay[i] + ' ' + hay[i + 1];
          const want = needBi.get(k) ?? 0;
          if (!want) continue;
          const have = seen.get(k) ?? 0;
          if (have < want) { bi++; seen.set(k, have + 1); }
        }
        const score = n === 1 ? uni : 0.5 * uni + 0.5 * (bi / totalBi);
        if (!best || score > best.score) best = { start: s, end: e, score };
      }
      if (s + size < hay.length) { del(hay[s]); add(hay[s + size]); } else if (s + 1 < hay.length) { del(hay[s]); }
    }
  }
  return best;
}

export const MIN_SCORE = 0.6;
export const NEEDLE_TOKENS = 30;

/** Score of the best occurrence of `passage` inside `pageTokens`, optionally continuing into `nextTokens`. */
export function scoreInPage(passageTokens: string[], pageTokens: string[], nextTokens: string[] = []): number {
  if (!passageTokens.length || !pageTokens.length) return 0;
  const joinedPassage = ' ' + passageTokens.join(' ') + ' ';
  const hay = nextTokens.length ? pageTokens.concat(nextTokens.slice(0, passageTokens.length)) : pageTokens;
  // Exact normalized substring (a full-length passage; short ones need enough characters to be meaningful).
  if (joinedPassage.length >= 12) {
    const text = ' ' + hay.join(' ') + ' ';
    const at = text.indexOf(joinedPassage);
    // The occurrence has to start on this page, never only in the continuation.
    if (at >= 0 && (' ' + pageTokens.join(' ') + ' ').length > at + 1) return 1;
  }
  const needle = passageTokens.slice(0, NEEDLE_TOKENS);
  if (needle.length < 3) return 0;
  const w = bestWindow(needle, hay, pageTokens.length);
  return w ? Math.min(0.99, w.score) : 0;
}

/** Fuzzy locate inside one text with offsets (used for highlighting). Returns the original-text range of the match. */
export function locateSpan(text: string, passage: string): { start: number; end: number; score: number } | null {
  const spans = tokenizeSpans(text);
  const q = tokenize(passage);
  if (q.length < 1 || !spans.length) return null;
  const hay = spans.map((s) => s.tok);
  const needle = q.slice(0, NEEDLE_TOKENS);
  // Exact run of the whole passage.
  const hs = ' ' + hay.join(' ') + ' ';
  const qs = ' ' + q.join(' ') + ' ';
  const at = qs.length >= 8 ? hs.indexOf(qs) : -1;
  if (at >= 0) {
    const startTok = hs.slice(0, at + 1).trim() ? hs.slice(0, at + 1).trim().split(' ').length : 0;
    const endTok = startTok + q.length;
    return { start: spans[startTok].start, end: spans[endTok - 1].end, score: 1 };
  }
  const w = bestWindow(needle, hay);
  if (!w || w.score < MIN_SCORE) return null;
  // Tighten the window to the first and last matched tokens.
  const set = new Set(needle);
  let s = w.start;
  let e = Math.min(hay.length, w.end) - 1;
  while (s < e && !set.has(hay[s])) s++;
  while (e > s && !set.has(hay[e])) e--;
  // The window only saw the first tokens; a longer passage runs on for about its own length.
  if (q.length > needle.length) e = Math.min(hay.length - 1, Math.max(e, s + Math.round(q.length * 1.05) - 1));
  return { start: spans[s].start, end: spans[e].end, score: Math.min(0.99, w.score) };
}
