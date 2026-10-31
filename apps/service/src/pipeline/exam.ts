// Exam statistics of a chapter, computed from the classified exam questions (never by a model).
import { outlineSectionSchema, type Outline, type OutlineChapter, type OutlineSection } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId } from '../db/db.ts';
import { examGuideText } from './prompts.ts';
import { COUNTED_QUESTION_SQL } from './util.ts';

export interface ExamQuestionRef { id: string; examGroup: string; examDate: string | null; number: string | null; topicIds: string[]; statement: string; difficulty: string }

/** Topics of the chapter's content sections; the exam guide itself has none. */
export const chapterTopicIds = (chapter: OutlineChapter) => new Set(chapter.sections.filter((s) => s.role !== 'exam-guide').flatMap((s) => s.topicIds));

/** Authentic exam questions that still count for the book, newest session first. */
function examQuestions(ctx: AppContext, projectId: string): ExamQuestionRef[] {
  return ctx.db.all<{ id: string; exam_group: string; exam_date: string | null; number: string | null; topic_ids: string; statement: string; difficulty: string }>(
    `SELECT id, exam_group, exam_date, number, topic_ids, statement, difficulty FROM questions
     WHERE project_id = ? AND kind = 'exam' AND exam_group IS NOT NULL AND ${COUNTED_QUESTION_SQL}
     ORDER BY COALESCE(exam_date, '') DESC, exam_group DESC, rowid`, projectId)
    .map((r) => ({ id: r.id, examGroup: r.exam_group, examDate: r.exam_date, number: r.number, topicIds: json<string[]>(r.topic_ids, []), statement: r.statement, difficulty: r.difficulty }));
}

/** Distinct exam sessions in the archive. */
export const examSessionTotal = (ctx: AppContext, projectId: string) => new Set(examQuestions(ctx, projectId).map((q) => q.examGroup)).size;

/** Sessions in the archive, and how many of them asked about the chapter's topics, with those questions. */
export function chapterExamStats(ctx: AppContext, projectId: string, chapter: OutlineChapter) {
  const all = examQuestions(ctx, projectId);
  const topics = chapterTopicIds(chapter);
  const questions = all.filter((q) => q.topicIds.some((id) => topics.has(id)));
  return { total: new Set(all.map((q) => q.examGroup)).size, asked: new Set(questions.map((q) => q.examGroup)).size, questions };
}

/** The closing section of a chapter: written from the chapter's exam questions, linked to its sections. */
export function examGuideSection(language: string): OutlineSection {
  const { title, objectives } = examGuideText(language);
  return outlineSectionSchema.parse({ id: newId(), title, objectives, topicIds: [], depth: 'standard', subsections: [], programItems: [], role: 'exam-guide' });
}

/** Chapters with exam questions and no closing exam guide yet. */
export function chaptersMissingGuide(ctx: AppContext, projectId: string, outline: Outline) {
  return outline.chapters.filter((c) => c.sections.length && !c.sections.some((s) => s.role === 'exam-guide'))
    .map((c) => ({ chapter: c, stats: chapterExamStats(ctx, projectId, c) })).filter((x) => x.stats.asked > 0);
}

/** Planner step: every chapter whose topics the exams ask about gets its exam guide as the last section. */
export function appendExamGuides(ctx: AppContext, projectId: string, outline: Outline, language: string): number {
  const missing = chaptersMissingGuide(ctx, projectId, outline);
  for (const { chapter } of missing) chapter.sections.push(examGuideSection(language));
  return missing.length;
}
