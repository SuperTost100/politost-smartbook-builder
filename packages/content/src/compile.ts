import type { BookInput, CompiledBook, ChapterInput } from './types.ts';
/** Compile a whole book to reader files (smartbook.json, chapters/*.md, esercizi.md, esami.md, ide.json, grafici.json, assets/*). */
export function compileBook(_input: BookInput): CompiledBook { throw new Error('not implemented'); }
/** Compile one chapter to reader Markdown, for preview. formulaOffset lets numbering continue across calls. */
export function compileChapter(_chapter: ChapterInput, _knownSections?: Record<string, { chapter: number; paragraph: number }>): { markdown: string; formulaNumbers: Record<string, string> } { throw new Error('not implemented'); }
