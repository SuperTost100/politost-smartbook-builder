import type { Enrichment, Question } from '@smartbuilder/domain';

export interface BookMetaInput {
  slug: string;
  title: string;
  subject: string;
  authors: string[];
  /** Book language code, e.g. "it". Drives section labels. */
  language: string;
  version: string;
}

export interface SectionInput {
  id: string;
  title: string;
  /** Source dialect Markdown (see @smartbuilder/domain ContentRevision docs). */
  markdown: string;
}

export interface ChapterInput {
  id: string;
  slug: string;
  number: number;
  title: string;
  /** Source dialect Markdown for the chapter introduction, or empty. */
  intro: string;
  sections: SectionInput[];
}

export interface AssetInput {
  /** Name inside assets/, e.g. "fig-limite.svg". */
  filename: string;
  bytes: Uint8Array;
}

export interface BookInput {
  meta: BookMetaInput;
  chapters: ChapterInput[];
  questions: Question[];
  enrichments: Enrichment[];
  assets: AssetInput[];
  sections: { esercizi: boolean; esami: boolean; ide: boolean; grafici: boolean };
}

export interface LintFinding {
  rule: string;
  severity: 'blocker' | 'major' | 'minor';
  message: string;
  /** File in the compiled book, or section id for source-dialect lints. */
  file: string;
  line?: number;
  quote?: string;
}

export interface CompiledBook {
  /** Path inside the package -> contents. */
  files: Record<string, string | Uint8Array>;
  /** Symbolic formula key -> "N.M". */
  formulaNumbers: Record<string, string>;
  /** Section id -> { chapter number, paragraph number }. */
  sectionNumbers: Record<string, { chapter: number; paragraph: number }>;
  findings: LintFinding[];
}
