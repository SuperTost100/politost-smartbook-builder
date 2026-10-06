import type { LintFinding } from './types.ts';
/** Quality lints on source-dialect Markdown for one section. language: book language code. */
export function lintSection(_markdown: string, _opts: { sectionId: string; language: string; knownFormulaKeys?: Set<string> }): LintFinding[] { throw new Error('not implemented'); }
/** Lints on a compiled book (cross-chapter rules such as duplicated IDE/graph payloads). */
export function lintCompiled(_files: Record<string, string | Uint8Array>): LintFinding[] { throw new Error('not implemented'); }
