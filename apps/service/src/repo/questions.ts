import type { Question } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { conflict, notFound } from './errors.ts';
import type { Rec } from './util.ts';

export function mapQuestion(r: Rec): Question {
  return {
    id: r.id, projectId: r.project_id, kind: r.kind, origin: r.origin, resourceId: r.resource_id ?? null, pageFrom: r.page_from ?? null,
    pageTo: r.page_to ?? null, examGroup: r.exam_group ?? null, examDate: r.exam_date ?? null, number: r.number ?? null,
    statement: r.statement, hint: r.hint, solution: r.solution, difficulty: r.difficulty, topicIds: json(r.topic_ids, []),
    chapterId: r.chapter_id ?? null, status: r.status, checks: json(r.checks, []), rev: Number(r.rev), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Tells clients that question rows changed (import, checks, edits, classification, generation). */
export function questionsChanged(ctx: AppContext, projectId: string, questionIds: string[]): void {
  if (questionIds.length) ctx.events.emit('question.updated', { questionIds }, { projectId });
}

export function listQuestions(ctx: AppContext, projectId: string, filter: { kind?: Question['kind'] } = {}): Question[] {
  const rows = filter.kind
    ? ctx.db.all<Rec>('SELECT * FROM questions WHERE project_id = ? AND kind = ? ORDER BY rowid', projectId, filter.kind)
    : ctx.db.all<Rec>('SELECT * FROM questions WHERE project_id = ? ORDER BY rowid', projectId);
  return rows.map(mapQuestion);
}

export function getQuestion(ctx: AppContext, id: string): Question {
  const r = ctx.db.get<Rec>('SELECT * FROM questions WHERE id = ?', id);
  if (!r) throw notFound('This question');
  return mapQuestion(r);
}

export type QuestionFields = Partial<Omit<Question, 'id' | 'projectId' | 'rev' | 'createdAt' | 'updatedAt'>>;

const COLUMNS: Record<keyof QuestionFields, string> = {
  kind: 'kind', origin: 'origin', resourceId: 'resource_id', pageFrom: 'page_from', pageTo: 'page_to', examGroup: 'exam_group', examDate: 'exam_date',
  number: 'number', statement: 'statement', hint: 'hint', solution: 'solution', difficulty: 'difficulty', topicIds: 'topic_ids',
  chapterId: 'chapter_id', status: 'status', checks: 'checks',
};

function toColumns(fields: QuestionFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields) as [keyof QuestionFields, unknown][]) if (v !== undefined && COLUMNS[k]) out[COLUMNS[k]] = v;
  return out;
}

export function createQuestion(ctx: AppContext, projectId: string, fields: QuestionFields): Question {
  const id = newId();
  const t = now();
  ctx.db.insert('questions', {
    kind: 'exercise', origin: 'adapted', ...toColumns(fields), id, project_id: projectId, rev: 1, created_at: t, updated_at: t,
  });
  questionsChanged(ctx, projectId, [id]);
  return getQuestion(ctx, id);
}

/**
 * Rev-checked update: 409 when `rev` is not the stored one. Bumps rev. Editing the text of a question that was
 * verified puts it back to 'draft' (its checks no longer apply) unless the patch sets the status itself. Any change of
 * statement, hint or solution marks the question as author-edited (`edited_at`): it is verified as written and never
 * re-imported from its source pages. The import marker (`imported_at`) is not touched.
 */
export function updateQuestion(ctx: AppContext, id: string, rev: number, patch: QuestionFields): Question {
  return ctx.db.tx(() => {
    const cur = getQuestion(ctx, id);
    if (cur.rev !== rev) throw conflict('This question was changed somewhere else since you opened it.', 'Reload to see the latest version, then reapply your edit.', id);
    const values = toColumns(patch);
    const textChanged = ['statement', 'hint', 'solution'].some((k) => k in values && values[k] !== cur[k as 'statement']);
    if (textChanged && !('status' in values) && cur.status !== 'draft') {
      values.status = 'draft';
      values.checks = [];
    }
    const t = now();
    if (textChanged) values.edited_at = t;
    ctx.db.run(
      `UPDATE questions SET ${[...Object.keys(values), 'rev', 'updated_at'].map((k) => (k === 'rev' ? 'rev = rev + 1' : `${k} = ?`)).join(', ')} WHERE id = ? AND rev = ?`,
      ...Object.values(values).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : (v as string | number | null))), t, id, rev);
    questionsChanged(ctx, cur.projectId, [id]);
    return getQuestion(ctx, id);
  });
}

/**
 * Applies a layout-only repair to a question's text. Unlike an edit it keeps the status and the checks, because the
 * mathematics does not change. Returns whether the text changed.
 */
export function repairQuestionText(ctx: AppContext, id: string, fix: (text: string) => string): boolean {
  return ctx.db.tx(() => {
    const cur = getQuestion(ctx, id);
    const next = { statement: fix(cur.statement), hint: fix(cur.hint), solution: fix(cur.solution) };
    if (next.statement === cur.statement && next.hint === cur.hint && next.solution === cur.solution) return false;
    ctx.db.run('UPDATE questions SET statement = ?, hint = ?, solution = ?, rev = rev + 1, updated_at = ? WHERE id = ?', next.statement, next.hint, next.solution, now(), id);
    questionsChanged(ctx, cur.projectId, [id]);
    return true;
  });
}

export function deleteQuestion(ctx: AppContext, id: string): void {
  const q = getQuestion(ctx, id);
  ctx.db.run('DELETE FROM questions WHERE id = ?', id);
  questionsChanged(ctx, q.projectId, [id]);
}
