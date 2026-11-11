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

/** A symbol with a subscript: a Latin letter or a LaTeX command, then "_c" or "_{in}", not part of a longer word. */
const SYMBOL = /(?<![\p{L}\\\d])(\\[A-Za-z]+|[A-Za-z])_(?:\{([A-Za-z0-9]{1,6})\}|([A-Za-z0-9])(?![A-Za-z0-9]))/gu;
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

/**
 * The subscripted symbols the statements use ("f_c", "v_{out}", "V_0"), written the way a writer puts them in LaTeX, most
 * frequent first. A symbol counts once per statement, and "$f_{c}$", "f_c" and a text layer's "R₁" are the same kind of find.
 * shortcut: a symbol without a subscript ("R", "C") is the standard one of the field and is left out, and so is one whose base is a Greek letter written as a character, upgrade when a paper needs them.
 */
export function symbolsIn(texts: string[], max = 12): string[] {
  const count = new Map<string, number>();
  for (const text of texts) {
    const plain = text.replace(/([A-Za-z])([₀-₉]+)/g, (_m, base: string, digits: string) => `${base}_${[...digits].map((c) => SUBSCRIPT_DIGITS.indexOf(c)).join('')}`);
    const here = new Set([...plain.matchAll(SYMBOL)].map((m) => `${m[1]}_${m[2] === undefined ? m[3] : m[2].length > 1 ? `{${m[2]}}` : m[2]}`));
    for (const k of here) count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, max);
}

/** The symbols the exam papers use for these topics, from the statements of the authentic exam questions that count. */
export function examSymbols(ctx: AppContext, projectId: string, topicIds: string[]): string[] {
  const topics = new Set(topicIds);
  return symbolsIn(examQuestions(ctx, projectId).filter((q) => q.topicIds.some((id) => topics.has(id))).map((q) => q.statement));
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
