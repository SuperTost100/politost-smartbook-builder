import { examFormatSchema, programItemSchema, type AlignmentFinding, type AlignmentReport, type CourseProgram, type ExamFormat, type ProgramItem } from '@smartbuilder/domain';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { notFound } from './errors.ts';
import type { Rec } from './util.ts';

const itemsSchema = z.array(programItemSchema);

export function mapProgram(r: Rec): CourseProgram {
  // Rows are written by this module, but a hand-edited database must not take the Setup screen down.
  const items = itemsSchema.safeParse(json(r.items, []));
  return {
    projectId: r.project_id, text: r.text, url: r.url ?? null, sourceText: r.source_text,
    items: items.success ? items.data : [], examFormat: examFormatSchema.parse(json(r.exam_format, {})),
    status: r.status, error: r.error ?? null, parsedAt: r.parsed_at ?? null, updatedAt: r.updated_at,
  };
}

/** The saved program, or null when the author never saved one. */
export function getProgram(ctx: AppContext, projectId: string): CourseProgram | null {
  const r = ctx.db.get<Rec>('SELECT * FROM course_programs WHERE project_id = ?', projectId);
  return r ? mapProgram(r) : null;
}

/** The program when it has items to plan, write and align with. Items from an earlier reading stay usable while a new one runs or fails. */
export function readyProgram(ctx: AppContext, projectId: string): CourseProgram | null {
  const p = getProgram(ctx, projectId);
  return p && p.items.length ? p : null;
}

/** Saves what the author pasted and marks the program as being read. Parsed items stay until the new ones arrive. */
export function saveProgramInput(ctx: AppContext, projectId: string, input: { text: string; url: string | null }): CourseProgram {
  ctx.db.run(
    `INSERT INTO course_programs (project_id, text, url, status, error, updated_at) VALUES (?, ?, ?, 'parsing', NULL, ?)
     ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, url = excluded.url, status = 'parsing', error = NULL, updated_at = excluded.updated_at`,
    projectId, input.text, input.url, now());
  return getProgram(ctx, projectId)!;
}

export function setProgramStatus(ctx: AppContext, projectId: string, status: CourseProgram['status'], error: string | null = null) {
  ctx.db.run('UPDATE course_programs SET status = ?, error = ?, updated_at = ? WHERE project_id = ?', status, error, now(), projectId);
}

/** Stores the items and exam format the author edited or the parser read. */
export function saveProgramItems(ctx: AppContext, projectId: string, v: { items: ProgramItem[]; examFormat: ExamFormat; sourceText?: string; parsed?: boolean }): CourseProgram {
  const t = now();
  ctx.db.run(
    `INSERT INTO course_programs (project_id, source_text, items, exam_format, status, error, parsed_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET items = excluded.items, exam_format = excluded.exam_format, status = excluded.status, error = NULL,
       source_text = CASE WHEN ? THEN excluded.source_text ELSE source_text END, parsed_at = CASE WHEN ? THEN excluded.parsed_at ELSE parsed_at END, updated_at = excluded.updated_at`,
    projectId, v.sourceText ?? '', JSON.stringify(v.items), JSON.stringify(v.examFormat), v.items.length ? 'ready' : 'idle', v.parsed ? t : null, t,
    v.sourceText !== undefined ? 1 : 0, v.parsed ? 1 : 0);
  return getProgram(ctx, projectId)!;
}

export function deleteProgram(ctx: AppContext, projectId: string) {
  ctx.db.run('DELETE FROM course_programs WHERE project_id = ?', projectId);
}

// ---------- alignment reports ----------

export function mapReport(r: Rec): AlignmentReport {
  return {
    id: r.id, projectId: r.project_id, outlineRevId: r.outline_rev_id, coverage: json(r.coverage, []), findings: json(r.findings, []),
    model: r.model, createdAt: r.created_at, appliedAt: r.applied_at ?? null, applied: json(r.applied, []), removed: json(r.removed, []),
  };
}

export function latestReport(ctx: AppContext, projectId: string): AlignmentReport | null {
  const r = ctx.db.get<Rec>('SELECT * FROM alignment_reports WHERE project_id = ? ORDER BY rowid DESC LIMIT 1', projectId);
  return r ? mapReport(r) : null;
}

export function getReport(ctx: AppContext, projectId: string, id: string): AlignmentReport {
  const r = ctx.db.get<Rec>('SELECT * FROM alignment_reports WHERE id = ? AND project_id = ?', id, projectId);
  if (!r) throw notFound('This alignment report');
  return mapReport(r);
}

/** What a report was made from, beyond the outline revision: the program's fingerprint and the text revision of every section a finding names. */
export interface ReportInputs { program?: string; heads?: Record<string, string | null> }

export function insertReport(ctx: AppContext, v: { projectId: string; outlineRevId: string; coverage: AlignmentReport['coverage']; findings: AlignmentFinding[]; model: string; inputs?: ReportInputs }): AlignmentReport {
  const id = newId();
  ctx.db.insert('alignment_reports', { id, project_id: v.projectId, outline_rev_id: v.outlineRevId, coverage: v.coverage, findings: v.findings, model: v.model, created_at: now(), applied: [], inputs: v.inputs ?? {} });
  return getReport(ctx, v.projectId, id);
}

export function reportInputs(ctx: AppContext, reportId: string): ReportInputs {
  return json<ReportInputs>(ctx.db.get<{ inputs: string }>('SELECT inputs FROM alignment_reports WHERE id = ?', reportId)?.inputs, {});
}
