import type { ExportRow, ValidationReport } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { notFound } from './errors.ts';
import type { Rec } from './util.ts';
import { bool } from './util.ts';

export function mapExport(r: Rec): ExportRow {
  return {
    id: r.id, createdAt: r.created_at, approved: bool(r.approved), sha256: r.sha256, size: Number(r.size),
    report: json<ValidationReport>(r.report, { ok: false, errors: [], warnings: [], lint: [] }), filename: r.filename,
  };
}

export function listExports(ctx: AppContext, projectId: string): ExportRow[] {
  return ctx.db.all<Rec>('SELECT * FROM exports WHERE project_id = ? ORDER BY rowid DESC', projectId).map(mapExport);
}

export function getExport(ctx: AppContext, id: string): ExportRow & { projectId: string; path: string } {
  const r = ctx.db.get<Rec>('SELECT * FROM exports WHERE id = ?', id);
  if (!r) throw notFound('This export');
  return { ...mapExport(r), projectId: r.project_id, path: r.path };
}

export function insertExport(ctx: AppContext, e: { projectId: string; filename: string; path: string; sha256: string; size: number; approved: boolean; report: ValidationReport }): ExportRow {
  const id = newId();
  ctx.db.insert('exports', { id, project_id: e.projectId, filename: e.filename, path: e.path, sha256: e.sha256, size: e.size, approved: e.approved, report: e.report, created_at: now() });
  return getExport(ctx, id);
}
