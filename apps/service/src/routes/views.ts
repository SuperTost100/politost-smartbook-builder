// Manuscript read models: outline + current text + proposals + evidence + issues + compiled Markdown.
import { numberChapters, type ChapterInput } from '@smartbuilder/content';
import type { ChapterView, Outline, SectionView } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { HttpError } from '../server.ts';
import {
  activeIssuesByNode, currentHeads, effectiveOutline, findNode, getProject, latestEvidenceByNode, pendingProposals, listAssets,
} from '../repo/index.ts';
import { deps } from './deps.ts';

type Known = Record<string, { chapter: number; paragraph: number }>;
type CompileOpts = { language?: string; knownFormulas?: Record<string, string>; assets?: Set<string> };

export function outlineOf(ctx: AppContext, projectId: string): Outline | null {
  return effectiveOutline(ctx, projectId)?.revision.outline ?? null;
}

export function requireOutline(ctx: AppContext, projectId: string): Outline {
  const o = outlineOf(ctx, projectId);
  if (!o) throw new HttpError(404, 'no_outline', 'There is no outline yet.', 'Build the outline first.');
  return o;
}

/** Chapter and paragraph number of every section and keyed formula, from the compiler's own numbering pass (introductions count as p1). */
export function bookNumbering(outline: Outline, heads: Map<string, { markdown: string }>, language: string) {
  return numberChapters(outline.chapters.map((_, i) => chapterInput(outline, i, heads)), language);
}

export function chapterInput(outline: Outline, index: number, heads: Map<string, { markdown: string }>): ChapterInput {
  const c = outline.chapters[index];
  return {
    id: c.id, slug: c.slug, number: index + 1, title: c.title, intro: heads.get(c.id)?.markdown ?? '',
    sections: c.sections.map((s) => ({ id: s.id, title: s.title, markdown: heads.get(s.id)?.markdown ?? '' })),
  };
}

function safeCompile(chapter: ChapterInput, known: Known, opts: CompileOpts): string | null {
  try {
    return deps.compileChapter(chapter, known, opts).markdown;
  } catch {
    return null;
  }
}

/**
 * Compiled Markdown per section with the numbers the section has in the book. Formula numbers depend on the sections
 * before, so the chapter is compiled cumulatively and each section is the part that its addition appended.
 * `intro` is the compiled chapter introduction. Sections whose compile failed map to ''.
 */
export function compileSections(chapter: ChapterInput, known: Known, opts: CompileOpts, upTo = chapter.sections.length - 1): { intro: string; sections: Record<string, string> } {
  const introOut = safeCompile({ ...chapter, sections: [] }, known, opts) ?? '';
  const sections: Record<string, string> = {};
  let prev = introOut;
  for (let i = 0; i <= upTo && i < chapter.sections.length; i++) {
    const out = safeCompile({ ...chapter, sections: chapter.sections.slice(0, i + 1) }, known, opts);
    if (out === null) { sections[chapter.sections[i].id] = ''; continue; }
    sections[chapter.sections[i].id] = (out.startsWith(prev) ? out.slice(prev.length) : out).trim();
    prev = out;
  }
  return { intro: introOut.trim(), sections };
}

/** Reference context of the whole book: section and formula numbers of every chapter, and the known assets. */
export function bookContext(ctx: AppContext, projectId: string, outline: Outline, heads: Map<string, { markdown: string }>): { known: Known; opts: CompileOpts } {
  const language = getProject(ctx, projectId).language;
  const numbering = bookNumbering(outline, heads, language);
  return { known: numbering.sectionNumbers, opts: { language, knownFormulas: numbering.formulaNumbers, assets: new Set(listAssets(ctx, projectId).map((a) => `assets/${a.filename}`)) } };
}

function viewsFor(ctx: AppContext, projectId: string, outline: Outline, only?: { chapterIndex: number; sectionIndex: number | null }) {
  const heads = currentHeads(ctx, projectId);
  const proposals = pendingProposals(ctx, projectId);
  const evidence = latestEvidenceByNode(ctx, projectId);
  const issues = activeIssuesByNode(ctx, projectId);
  const { known, opts } = bookContext(ctx, projectId, outline, heads);
  const view = (chapterId: string, nodeId: string, title: string, compiled: string): SectionView => ({
    chapterId, sectionId: nodeId, title, current: heads.get(nodeId) ?? null, proposal: proposals.get(nodeId) ?? null,
    evidence: evidence.get(nodeId) ?? null, issues: issues.get(nodeId) ?? [], compiled,
  });
  const out: { chapter: ChapterView; intro: SectionView }[] = [];
  outline.chapters.forEach((c, i) => {
    if (only && only.chapterIndex !== i) return;
    const compiled = compileSections(chapterInput(outline, i, heads), known, opts, only ? (only.sectionIndex ?? -1) : undefined);
    out.push({
      chapter: {
        chapterId: c.id, number: i + 1, title: c.title, intro: heads.get(c.id) ?? null,
        sections: c.sections.map((s) => view(c.id, s.id, s.title, compiled.sections[s.id] ?? '')),
      },
      intro: view(c.id, c.id, c.title, compiled.intro),
    });
  });
  return out;
}

export function buildManuscript(ctx: AppContext, projectId: string): ChapterView[] {
  const outline = outlineOf(ctx, projectId);
  if (!outline) return [];
  return viewsFor(ctx, projectId, outline).map((v) => v.chapter);
}

export function buildSectionView(ctx: AppContext, projectId: string, nodeId: string): SectionView {
  const outline = requireOutline(ctx, projectId);
  const node = findNode(outline, nodeId);
  if (!node) throw new HttpError(404, 'not_found', 'This section is not in the outline.', 'Reload the page.');
  const sectionIndex = node.kind === 'section' ? outline.chapters[node.chapterIndex].sections.findIndex((s) => s.id === nodeId) : null;
  const [v] = viewsFor(ctx, projectId, outline, { chapterIndex: node.chapterIndex, sectionIndex });
  return node.kind === 'chapter-intro' ? v.intro : v.chapter.sections[sectionIndex!];
}

export function previewChapter(ctx: AppContext, projectId: string, chapterId: string): { markdown: string; number: number; assets: Record<string, string> } {
  const outline = requireOutline(ctx, projectId);
  const index = outline.chapters.findIndex((c) => c.id === chapterId);
  if (index < 0) throw new HttpError(404, 'not_found', 'This chapter is not in the outline.', 'Reload the page.');
  const heads = currentHeads(ctx, projectId);
  const { known, opts } = bookContext(ctx, projectId, outline, heads);
  const markdown = safeCompile(chapterInput(outline, index, heads), known, opts) ?? '';
  const assets: Record<string, string> = {};
  for (const a of listAssets(ctx, projectId)) assets[a.filename] = `/api/assets/${a.id}/file`;
  return { markdown, number: index + 1, assets };
}

/** Keys of numbered formulas used anywhere in the project, so lints can tell a missing key from a known one. */
export function knownFormulaKeys(ctx: AppContext, projectId: string): Set<string> {
  const keys = new Set<string>();
  for (const rev of currentHeads(ctx, projectId).values()) {
    for (const m of rev.markdown.matchAll(/:::formula\{[^}]*\bkey="([^"]+)"/g)) keys.add(m[1]);
  }
  return keys;
}

