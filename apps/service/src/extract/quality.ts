// Page text quality. The question is not "is there text" but "can a model trust this text for math":
// text layers from LaTeX and scanned notes lose fraction bars, roots, exponents and handwriting.
import type { PageQuality } from '@smartbuilder/domain';

export interface PageSignals {
  chars: number;
  fffd: number;
  overlay: number;
  detachedAccents: number;
  oddAccents: number;
  isolatedLines: number;
  danglingOps: number;
  macMath: number;
  exotic: number;
  implausibleRatio: number;
  wordsPerLine: number;
  lines: number;
  score: number;
}

const OP_ALONE = /^[=+−\-<>≤≥→⇒⇔∈∪∩·×|∑∫]$/u;
const OP_TRAILING = /\s[=→⇒⇔≤≥<>+−]$/u;
const LABEL_LINE = /^(\(?[a-eA-E1-9]\)|\(?\d{1,2}[.)]|[a-z]\))$/u;
// Scripts that never appear in an Italian math text: OCR of handwriting produces them.
const EXOTIC = /[฀-๿　-鿿가-힯①-⓿㈀-㋿Ѐ-ӿ֐-׿؀-ۿ]/gu;

function plausibleWord(w: string): boolean {
  // Letters only, 4+ long: needs vowels in a believable ratio and no case flips inside.
  const v = (w.match(/[aeiouyàèéìòùáíóúAEIOUY]/g) ?? []).length;
  if (v === 0) return false;
  const ratio = v / w.length;
  if (ratio < 0.18 || ratio > 0.8) return false;
  if (/[a-zà-ÿ][A-ZÀ-Ý]/.test(w)) return false;
  if (/[^aeiouyàèéìòù]{5,}/i.test(w)) return false;
  return true;
}

export function pageSignals(text: string): PageSignals {
  const chars = text.replace(/\s+/gu, '').length;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const fffd = (text.match(/�/gu) ?? []).length;
  const overlay = (text.match(/̸|(^|\s)[̀-⃒ͯ-⃓]/gu) ?? []).length;
  // "`e", "´e": harmless in Italian prose (repaired when stored) but a hint of a lossy encoding.
  const detachedAccents = (text.match(/[`´][aeiouAEIOU]/gu) ?? []).length;
  const oddAccents = (text.match(/[`´¨˜ˆ˙ˇ](?![aeiouAEIOU])/gu) ?? []).length;
  const isolatedLines = lines.filter((l) => l.replace(/\s+/gu, '').length <= 2 && !LABEL_LINE.test(l) && !/^\d{1,3}$/u.test(l)).length;
  const danglingOps = lines.filter((l) => OP_ALONE.test(l) || OP_TRAILING.test(l)).length;
  const macMath = (text.match(/(^|\s)[æÆŒœ™”](?=\s|$)/gu) ?? []).length;
  const exotic = (text.match(EXOTIC) ?? []).length;
  const tokens = text.split(/\s+/u).filter(Boolean);
  const words = tokens.filter((w) => /^[\p{L}]{4,}$/u.test(w));
  const noisy = words.filter((w) => !plausibleWord(w)).length;
  const implausibleRatio = words.length >= 6 ? noisy / words.length : 0;
  const wordsPerLine = lines.length ? tokens.length / lines.length : 0;

  let score = 0;
  score += Math.min(1, fffd * 0.5);
  score += Math.min(1, overlay * 0.5);
  score += Math.min(1, macMath * 0.34);
  score += Math.min(1, exotic * 0.5);
  score += Math.min(1, implausibleRatio / 0.12);
  score += Math.min(0.75, danglingOps * 0.25);
  score += Math.min(0.5, isolatedLines / 50);
  score += Math.min(0.3, detachedAccents * 0.03) + Math.min(0.5, oddAccents * 0.1);
  // Scanned notes: text comes out one fragment per line.
  if (lines.length >= 12 && wordsPerLine < 2.2) score += 1;
  // Stacked fractions and limits leave many short lines in an otherwise textual page.
  else if (lines.length >= 20 && wordsPerLine < 3) score += 0.3;
  return { chars, fffd, overlay, detachedAccents, oddAccents, isolatedLines, danglingOps, macMath, exotic, implausibleRatio, wordsPerLine, lines: lines.length, score };
}

export const EMPTY_BELOW = 40;
export const GARBLED_AT = 1;

export function classifyPage(text: string): { quality: PageQuality; signals: PageSignals } {
  const signals = pageSignals(text);
  if (signals.chars < EMPTY_BELOW) return { quality: 'empty', signals };
  return { quality: signals.score >= GARBLED_AT ? 'garbled' : 'good', signals };
}

/** Repair accents the PDF stores as a spacing mark before the vowel: "pi`u" -> "più", "Poich´e" -> "Poiché". */
export function repairAccents(text: string): string {
  const grave: Record<string, string> = { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' };
  const acute: Record<string, string> = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' };
  return text
    .replace(/`([aeiouAEIOU])/gu, (_, c: string) => grave[c])
    .replace(/´([aeiouAEIOU])/gu, (_, c: string) => acute[c]);
}

/** Collapse the whitespace noise structured text carries (blank-only lines, trailing spaces, long runs of blank lines). */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
