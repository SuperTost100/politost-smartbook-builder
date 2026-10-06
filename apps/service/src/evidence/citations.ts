// NotebookLM answers carry [n] markers. These helpers pull out the sentence each marker supports.

const MARKER = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g;
const MAX_CLAIM = 320;

function expand(group: string): number[] {
  const out: number[] = [];
  for (const part of group.split(',')) {
    const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part.trim());
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b >= a && b - a < 20) for (let i = a; i <= b; i++) out.push(i);
    } else if (/^\d+$/.test(part.trim())) out.push(Number(part.trim()));
  }
  return out;
}

function clean(text: string): string {
  return text
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, '')
    .replace(/\*\*|__|\*|`/g, '')
    .replace(/^[\s"'“”«»]+|[\s"'“”«»:;,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Start of the sentence that ends at the end of `text`. A boundary is . ! ? followed by whitespace. */
function sentenceStart(text: string): number {
  let start = 0;
  for (const m of text.matchAll(/[.!?]+["'”»)*_]*\s+(?=\S)/g)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end < text.length) start = end;
  }
  return start;
}

/**
 * For each citation number, the sentence(s) that carry its [n] marker, cleaned of Markdown.
 * Only numbers in `valid` count, so intervals such as [3, 5] are not mistaken for citations.
 */
export function claimsByCitation(answer: string, valid?: Set<number>): Map<number, string> {
  const claims = new Map<number, string[]>();
  const lines = answer.split('\n');
  let lastText = '';
  for (const line of lines) {
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    // Walk the markers of this line; the text since the previous marker/boundary is the claim.
    let cursor = 0;
    let carry = '';
    const matches = [...line.matchAll(MARKER)];
    for (const m of matches) {
      const all = expand(m[1]);
      const idx = m.index ?? 0;
      // [3, 5] inside a formula is an interval, not a citation: every number must be a known reference.
      if (!all.length || (valid && !all.every((n) => valid.has(n)))) continue;
      const nums = all;
      const before = carry + line.slice(cursor, idx).replace(MARKER, '');
      const sentence = clean(before.slice(sentenceStart(before))) || clean(before) || clean(lastText);
      cursor = idx + m[0].length;
      carry = '';
      if (!sentence) continue;
      for (const n of nums) {
        const list = claims.get(n) ?? [];
        if (!list.includes(sentence)) list.push(sentence);
        claims.set(n, list);
      }
      // A following sentence starts fresh after the marker.
    }
    lastText = line.replace(MARKER, '');
  }
  const out = new Map<number, string>();
  for (const [n, list] of claims) {
    let joined = list.join(' ');
    if (joined.length > MAX_CLAIM) joined = `${joined.slice(0, MAX_CLAIM - 1).trimEnd()}…`;
    out.set(n, joined);
  }
  return out;
}

/** Adds `offset` to every citation number in an answer and its references (used when several notebooks are queried). */
export function shiftCitations(answer: string, offset: number): string {
  if (!offset) return answer;
  return answer.replace(MARKER, (_all, group: string) => {
    const nums = expand(group);
    return nums.length ? `[${nums.map((n) => n + offset).join(', ')}]` : `[${group}]`;
  });
}
