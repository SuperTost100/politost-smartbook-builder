import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExportRow, ValidationReport } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { qk, useExports, useIssues, useProject } from '../../lib/queries';
import { bytes, dateTime, plural, shortHash } from '../../lib/format';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import './export.css';

function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return [...m.entries()];
}

export function ReportView({ report }: { report: ValidationReport }) {
  const errors = groupBy(report.errors, (e) => e.file);
  const warnings = groupBy(report.warnings, (e) => e.file);
  const lint = groupBy(report.lint, (e) => e.file);
  return (
    <div className="ex2-report">
      <p className={`ex2-verdict ${report.ok ? 'is-ok' : 'is-bad'}`}>
        <Icon name={report.ok ? 'check' : 'alert'} />
        {report.ok ? 'No errors. The package is valid.' : `${plural(report.errors.length, 'error')} to fix before the book is valid.`}
        <span className="ui-muted"> {plural(report.warnings.length, 'warning')}, {plural(report.lint.length, 'lint finding')}.</span>
      </p>
      {errors.length > 0 && (
        <section aria-label="Errors"><h3 className="ui-meta ex2-h ex2-h--danger">Errors</h3>
          {errors.map(([file, list]) => <FileGroup key={file} file={file} rows={list.map((r) => ({ text: r.message }))} tone="danger" />)}</section>
      )}
      {warnings.length > 0 && (
        <section aria-label="Warnings"><h3 className="ui-meta ex2-h ex2-h--warning">Warnings</h3>
          {warnings.map(([file, list]) => <FileGroup key={file} file={file} rows={list.map((r) => ({ text: r.message }))} tone="warning" />)}</section>
      )}
      {lint.length > 0 && (
        <section aria-label="Lint"><h3 className="ui-meta ex2-h">Lint</h3>
          {lint.map(([file, list]) => <FileGroup key={file} file={file} rows={list.map((r) => ({ text: r.message, rule: r.rule, line: r.line }))} tone="" />)}</section>
      )}
    </div>
  );
}

function FileGroup({ file, rows, tone }: { file: string; rows: { text: string; rule?: string; line?: number }[]; tone: string }) {
  return (
    <div className="ex2-file">
      <div className="ui-mono ex2-file__name ui-wrap">{file}</div>
      <ul className="ex2-rows">
        {rows.map((r, i) => (
          <li key={i} className={`ex2-row ${tone ? `ex2-row--${tone}` : ''}`}>
            {r.rule && <span className="ui-badge ui-badge--mono">{r.rule}</span>}
            <span className="ui-wrap">{r.text}{r.line ? <span className="ui-muted ui-mono"> · line {r.line}</span> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ExportPage() {
  useDocumentTitle('Export');
  const pid = useBookId();
  const qc = useQueryClient();
  const toast = useToast();
  const project = useProject(pid);
  const exportsQ = useExports(pid);
  const issuesQ = useIssues(pid);
  const [report, setReport] = useState<ValidationReport | null>(null);

  const validate = useMutation({
    mutationFn: () => api('POST /api/projects/:id/validate', { params: { id: pid } }),
    onSuccess: (r) => { setReport(r); toast(r.ok ? 'Validation passed' : 'Validation found errors', { tone: r.ok ? 'default' : 'danger' }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const exportBook = useMutation({
    mutationFn: (approved: boolean) => api('POST /api/projects/:id/exports', { params: { id: pid }, body: { approved } }),
    onSuccess: (row, approved) => {
      void qc.invalidateQueries({ queryKey: qk.exports(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) });
      setReport(row.report);
      toast(approved ? 'Book approved and exported' : 'Draft exported', { action: { label: 'Download .ptsb', onClick: () => { window.location.href = apiUrl('GET /api/exports/:exportId/download', { params: { exportId: row.id } }); } } });
    },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const blockerIssues = (issuesQ.data ?? []).filter((i) => i.status === 'open' && i.severity === 'blocker').length;
  const drafted = project.data?.counts.drafted ?? 0;
  const draftReason = drafted === 0 ? 'Nothing is drafted yet.' : null;
  const approveReason = useMemo(() => {
    if (draftReason) return draftReason;
    if (!report) return 'Run Validate first.';
    if (!report.ok) return `${plural(report.errors.length, 'validation error')} to fix.`;
    if (blockerIssues > 0) return `${plural(blockerIssues, 'blocker issue')} still open in Review.`;
    return null;
  }, [report, blockerIssues, draftReason]);

  const rows = [...(exportsQ.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Export</h1>
          <p className="ui-lede">Check the package, then export a draft to try in the reader or approve the finished book.</p>
        </div>
      </div>

      <section className="ui-card ui-card--pad ex2-actions" aria-label="Export actions">
        <div className="ui-row">
          <button type="button" className="ui-btn" onClick={() => validate.mutate()} disabled={validate.isPending}>{validate.isPending ? <><span className="ui-spinner" />Validating…</> : 'Validate'}</button>
          <button type="button" className="ui-btn" onClick={() => exportBook.mutate(false)} disabled={!!draftReason || exportBook.isPending}>Export draft</button>
          <button type="button" className="ui-btn ui-btn--primary" onClick={() => exportBook.mutate(true)} disabled={!!approveReason || exportBook.isPending} aria-describedby={approveReason ? 'ex2-why' : undefined}>Approve and export</button>
        </div>
        {approveReason && <p id="ex2-why" className="ex2-why ui-muted">Approve and export is off: {approveReason}{blockerIssues > 0 && <> <Link to={`/books/${pid}/review`}>Open review</Link></>}</p>}
        {draftReason && <p className="ex2-why ui-muted">Export draft is off: {draftReason}</p>}
      </section>

      {report && (
        <section className="ui-card ui-card--pad" aria-label="Validation report">
          <h2 className="ui-panel-title">Validation report</h2>
          <ReportView report={report} />
        </section>
      )}

      <section aria-label="Exports" className="ui-stack">
        <h2 className="ui-panel-title">Exports</h2>
        {exportsQ.isLoading && <div className="ui-skeleton" style={{ height: 80 }} />}
        {exportsQ.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(exportsQ.error)}</div>}
        {!exportsQ.isLoading && rows.length === 0 && <div className="ui-empty"><p className="ui-empty__text">No exports yet. Export a draft to open it in the reader.</p></div>}
        <ul className="ex2-list">{rows.map((r) => <ExportItem key={r.id} row={r} />)}</ul>
      </section>
    </div>
  );
}

function ExportItem({ row }: { row: ExportRow }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="ex2-item ui-card">
      <div className="ex2-item__main">
        <div className="ui-row">
          <span className={`ui-badge ${row.approved ? 'ui-badge--success' : 'ui-badge--warning'}`}>{row.approved ? 'Approved' : 'Draft'}</span>
          <span className="ui-mono ui-wrap">{row.filename}</span>
        </div>
        <div className="ui-muted ex2-item__meta">
          <span>{dateTime(row.createdAt)}</span><span>{bytes(row.size)}</span>
          <button type="button" className="ui-btn ui-btn--link ui-mono ex2-hash" title={row.sha256} onClick={() => { void navigator.clipboard?.writeText(row.sha256); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>sha256 {shortHash(row.sha256)}{copied ? ' copied' : ''}</button>
          <span>{plural(row.report.errors.length, 'error')}, {plural(row.report.warnings.length, 'warning')}</span>
        </div>
        <details className="ex2-details"><summary>Report</summary><ReportView report={row.report} /></details>
      </div>
      <a className="ui-btn ui-btn--primary" href={apiUrl('GET /api/exports/:exportId/download', { params: { exportId: row.id } })} download><Icon name="download" />Download .ptsb</a>
    </li>
  );
}
