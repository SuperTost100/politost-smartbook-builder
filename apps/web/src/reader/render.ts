// Adapted from politost-smartbook (AGPL-3.0)
import {
  buildFormulaIndex,
  parseChapterMarkdown,
  parseExercises,
  preprocessContent,
  type Chapter,
  type Exercise,
  type FormulaRef,
} from '@politost/content-core';

export interface PreparedSnippet {
  /** Content ready for ContentFlow (formula and image markers, hover refs). */
  content: string;
  formulas: FormulaRef[];
}

/**
 * Runs a Markdown fragment through the reader's own parser by giving it a throwaway paragraph header,
 * so formulas, images and refs resolve exactly as in the reader.
 */
export function prepareSnippet(markdown: string, chapterNumber = 0): PreparedSnippet {
  const ch = parseChapterMarkdown(`## p0 | x\n${markdown}`, chapterNumber);
  const para = ch.paragraphs[0];
  return { content: preprocessContent(para?.content ?? ''), formulas: ch.formulas };
}

export function formulaMap(formulas: Iterable<FormulaRef>, base?: Map<string, FormulaRef>): Map<string, FormulaRef> {
  const m = new Map(base ?? []);
  for (const f of formulas) m.set(f.id, f);
  return m;
}

/** Whole compiled chapter -> paragraphs and chapter-wide formula index. */
export function parseCompiledChapter(markdown: string, number: number): { chapter: Chapter; index: Map<string, FormulaRef> } {
  const chapter = parseChapterMarkdown(markdown, number);
  return { chapter, index: buildFormulaIndex([chapter]) };
}

export function formulaIndexFromCompiled(compiledSections: string[], chapterNumber: number): Map<string, FormulaRef> {
  const index = new Map<string, FormulaRef>();
  for (const md of compiledSections) {
    for (const f of parseChapterMarkdown(md, chapterNumber).formulas) index.set(f.id, f);
  }
  return index;
}

export function exercisesIn(markdown: string): Exercise[] {
  if (!/^:::exercise/m.test(markdown)) return [];
  return parseExercises(markdown);
}

/**
 * The editor shows the source dialect, where formulas carry a symbolic key. For the live preview only,
 * give each key a provisional number so the reader parser accepts it.
 */
export function previewSource(markdown: string): string {
  const keys = new Map<string, string>();
  const idFor = (key: string) => {
    let id = keys.get(key);
    if (!id) { id = `0.${keys.size + 1}`; keys.set(key, id); }
    return id;
  };
  return markdown
    .replace(/:::formula\{([^}\n]*)\}/g, (full, attrs: string) => {
      const key = /\bkey="([^"]+)"/.exec(attrs)?.[1];
      const label = /\blabel="([^"]*)"/.exec(attrs)?.[1] ?? '';
      return key ? `:::formula{id="${idFor(key)}" label="${label}"}` : full;
    })
    .replace(/\{\{formula:@([^}]+)\}\}/g, (_, key: string) => `{{formula:${idFor(key.trim())}}}`);
}
