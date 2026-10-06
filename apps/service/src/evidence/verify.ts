// Quote verification for the local evidence reader. Same idea as extract.findPassage: ignore whitespace and typography.

const MIN_QUOTE_CHARS = 8;

/** Lowercase, NFKC, unify quotes and dashes, rejoin hyphenated line breaks, drop all whitespace. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„«»″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * True when every segment of the quote appears in the text, in order. Segments are separated by "..." or an ellipsis
 * so the reader can skip the middle of a long passage without inventing words.
 */
export function quoteInText(text: string, quote: string): boolean {
  const haystack = normalizeForMatch(text);
  const segments = quote
    .split(/\.{3,}|…|\[…\]|\[\.\.\.\]/)
    .map(normalizeForMatch)
    .filter((x) => x.length > 0);
  if (!segments.length || segments.join('').length < MIN_QUOTE_CHARS) return false;
  let from = 0;
  for (const seg of segments) {
    const at = haystack.indexOf(seg, from);
    if (at < 0) return false;
    from = at + seg.length;
  }
  return true;
}

/** Cut a quote to at most `max` characters on a word boundary. A prefix of a verbatim quote is still verbatim. */
export function clipQuote(quote: string, max = 400): string {
  const q = quote.trim();
  if (q.length <= max) return q;
  const cut = q.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}
