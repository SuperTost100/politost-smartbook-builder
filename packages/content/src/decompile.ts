/**
 * Reader Markdown -> source dialect. Used to import existing books and to prove the compiler
 * round-trips: compile(decompile(x)) is semantically x.
 *
 * Formula "N.M" becomes the key "f-N-M"; "ref:chapter/C#pK" becomes "ref:section/s-C-K".
 */

export interface DecompiledChapter {
  /** Text before the first "## pN |" heading (the reader's parser does not keep it), or "". */
  intro: string;
  sections: { id: string; title: string; markdown: string }[];
}

export const formulaKeyFor = (id: string): string => `f-${id.replace('.', '-')}`;
export const sectionIdFor = (chapter: number | string, paragraph: number | string): string => `s-${chapter}-${paragraph}`;

function toSource(body: string): string {
  return body
    .replace(/^(:::formula\{)(.*)(\}\s*)$/gm, (full, open: string, attrs: string, close: string) => {
      const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
      if (!id || !/^\d+\.\d+$/.test(id)) return full;
      return `${open}${attrs.replace(/\bid="[^"]+"/, `key="${formulaKeyFor(id)}"`)}${close}`;
    })
    .replace(/\{\{formula:(\d+\.\d+)\}\}/g, (_f, id: string) => `{{formula:@${formulaKeyFor(id)}}}`)
    .replace(/\]\(ref:formula\/(\d+\.\d+)\)/g, (_f, id: string) => `](ref:formula/@${formulaKeyFor(id)})`)
    .replace(/\]\(ref:chapter\/(\d+)#p(\d+)\)/g, (_f, c: string, p: string) => `](ref:section/${sectionIdFor(c, p)})`);
}

export function decompileChapter(readerMarkdown: string, chapterNumber: number): DecompiledChapter {
  const body = readerMarkdown.replace(/\r\n?/g, '\n').replace(/^---[\s\S]*?---\n*/, '');
  const re = /^## p(\d+) \| (.+)$/gm;
  const heads = [...body.matchAll(re)];
  const intro = (heads.length ? body.slice(0, heads[0].index) : body).trim();
  const sections = heads.map((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? body.length) : body.length;
    return {
      id: sectionIdFor(chapterNumber, h[1]),
      title: h[2].trim(),
      markdown: toSource(body.slice(start, end).trim()),
    };
  });
  return { intro: toSource(intro), sections };
}
