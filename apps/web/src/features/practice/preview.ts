const MATH = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$([^$]*)\$/g;
/** A display formula that only reads on its own lines: an environment or a line break. */
const MULTILINE = /\\begin\{|\\\\/;

/**
 * The start of a statement as one line for the question list, about `max` characters long, with its formulas kept as inline
 * `$…$` for the renderer. A display formula becomes inline, unless it needs its own lines (an aligned system, a matrix): the
 * line stops there with "…". A formula is never cut in the middle. Markdown marks and directive braces are dropped from
 * the text around the formulas.
 */
export function statementPreview(statement: string, max = 150): string {
  let out = '';
  let used = 0;
  const addText = (raw: string) => {
    const text = raw.replace(/[#*:{}]/g, '').replace(/\s+/g, ' ');
    if (used + text.length <= max) { out += text; used += text.length; return true; }
    out += `${text.slice(0, Math.max(0, max - used)).trimEnd()}…`;
    return false;
  };
  let last = 0;
  for (const m of statement.matchAll(MATH)) {
    if (!addText(statement.slice(last, m.index))) return tidy(out);
    last = m.index + m[0].length;
    const display = m[1] !== undefined || m[2] !== undefined;
    const tex = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/\s+/g, ' ');
    if (!tex) continue;
    if ((display && MULTILINE.test(tex)) || (used > 0 && used + tex.length > max)) return tidy(`${out.trimEnd()} …`);
    out += `$${tex}$`;
    used += tex.length;
  }
  addText(statement.slice(last));
  return tidy(out);
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
