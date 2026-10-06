import type { BookInput, ChapterInput } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { HttpError } from '../server.ts';
import { readAssetBytes } from './assets.ts';
import { currentHeads } from './content.ts';
import { listEnrichments } from './enrichments.ts';
import { effectiveOutline } from './outline.ts';
import { getProject } from './projects.ts';
import { listQuestions } from './questions.ts';

/**
 * Builds the compiler input from the project's outline, the current text of every node, questions, enrichments and assets.
 * With approvedOnly the outline must have been approved; otherwise the latest outline is used. Every question is included:
 * the export gate decides what blocks, not this function.
 */
export function loadBookInput(ctx: AppContext, projectId: string, opts: { approvedOnly?: boolean } = {}): BookInput {
  const project = getProject(ctx, projectId);
  const found = effectiveOutline(ctx, projectId);
  if (!found) throw new HttpError(409, 'no_outline', 'There is no outline yet.', 'Build and approve the outline first.');
  if (opts.approvedOnly && !found.approved) throw new HttpError(409, 'outline_not_approved', 'The outline has not been approved.', 'Approve the outline, or export a draft instead.');

  const heads = currentHeads(ctx, projectId);
  const chapters: ChapterInput[] = found.revision.outline.chapters.map((c, i) => ({
    id: c.id, slug: c.slug, number: i + 1, title: c.title,
    intro: heads.get(c.id)?.markdown ?? '',
    sections: c.sections.map((s) => ({ id: s.id, title: s.title, markdown: heads.get(s.id)?.markdown ?? '' })),
  }));
  // Only questions placed in a chapter belong to the book; unassigned authentic exam questions stay in the project.
  const chapterIds = new Set(chapters.map((c) => c.id));
  const questions = listQuestions(ctx, projectId).filter((q) => q.chapterId && chapterIds.has(q.chapterId) && q.statement.trim());
  const enrichments = listEnrichments(ctx, projectId);
  return {
    meta: { slug: project.slug, title: project.title, subject: project.subject, authors: project.authors, language: project.language, version: '1.0.0' },
    chapters,
    questions,
    enrichments,
    assets: readAssetBytes(ctx, projectId),
    sections: {
      esercizi: questions.some((q) => q.kind === 'exercise'),
      esami: questions.some((q) => q.kind === 'exam'),
      ide: project.options.ide && enrichments.some((e) => e.kind === 'ide'),
      grafici: project.options.graphs && enrichments.some((e) => e.kind === 'graph'),
    },
  };
}
