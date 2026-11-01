import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AlignmentFinding, AlignmentReport } from '@smartbuilder/domain';
import { errorText, api } from '../../lib/api';
import { qk, useAlignment, useOutline, useProgram, useProject, useRun } from '../../lib/queries';
import { plural, runCounts, timeAgo } from '../../lib/format';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/Dialog';
import { MathText } from '../../components/MathText';
import { useToast } from '../../components/Toast';

type Kind = AlignmentFinding['kind'];

const GROUPS: { kind: Kind; title: string; hint: string }[] = [
  { kind: 'missing', title: 'Missing from the book', hint: 'No section teaches these items. Align book adds a section where the check suggests and writes it.' },
  { kind: 'thin', title: 'Too thin for the exam', hint: 'Taught more briefly than the exam needs. Each becomes a review issue and the writer expands the section.' },
  { kind: 'proof', title: 'Proofs the exam asks', hint: 'The section does not give a proof the exam asks for. Each becomes a review issue and the writer adds the proof.' },
  { kind: 'off-program', title: 'Outside the program', hint: 'Material the exam does not ask for.' },
  { kind: 'order', title: 'Order', hint: 'A section comes before one it depends on. This is only reported: Align book does not reorder, so move the section in the outline.' },
  { kind: 'exam-guide', title: 'Exam guides', hint: 'Chapters without their closing section on how the exam asks the topics. Align book adds it and writes it from the exam questions.' },
];

const inactive = (s: string) => ['completed', 'failed', 'cancelled'].includes(s);
const APPLICABLE = (f: AlignmentFinding) => f.kind !== 'order';

export function AlignmentPanel({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const programQ = useProgram(pid);
  const project = useProject(pid);
  const outlineQ = useOutline(pid);
  const activeRun = project.data?.activeRun;
  const alignRun = activeRun && activeRun.kind === 'align' && !inactive(activeRun.status) ? activeRun : null;
  const reportQ = useAlignment(pid, !!alignRun);
  const runDetail = useRun(alignRun?.id);

  const program = programQ.data ?? null;
  const report = reportQ.data ?? null;
  const offProgram = project.data?.options.offProgram ?? 'delete';
  const current = outlineQ.data?.current ?? null;

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);

  // A new report starts with everything selected that Align book can apply.
  useEffect(() => {
    setPicked(new Set((report?.findings ?? []).flatMap((f, i) => (APPLICABLE(f) ? [i] : []))));
  }, [report?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => {
    const sections = new Map<string, string>();
    const chapters = new Map<string, string>();
    (current?.outline.chapters ?? []).forEach((c, ci) => {
      chapters.set(c.id, `Chapter ${ci + 1}, ${c.title}`);
      c.sections.forEach((s, si) => sections.set(s.id, `${ci + 1}.${si + 1} ${s.title}`));
    });
    return { sections, chapters };
  }, [current]);
  const itemTitle = useMemo(() => new Map((program?.items ?? []).map((i) => [i.key, i.title])), [program]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.alignment(pid) });
    void qc.invalidateQueries({ queryKey: qk.project(pid) });
    void qc.invalidateQueries({ queryKey: qk.runs(pid) });
  };
  const check = useMutation({
    mutationFn: () => api('POST /api/projects/:id/alignment/check', { params: { id: pid } }),
    onSuccess: () => { toast('Checking the book against the program', { action: { label: 'Open run', to: `/books/${pid}/run` } }); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const apply = useMutation({
    mutationFn: (v: { reportId: string; findings: number[] }) => api('POST /api/projects/:id/alignment/apply', { params: { id: pid }, body: v }),
    onSuccess: () => {
      setConfirm(false);
      toast('Aligning the book. New sections are written when the run reaches them.', { action: { label: 'Open run', to: `/books/${pid}/run` } });
      refresh();
      void qc.invalidateQueries({ queryKey: qk.outline(pid) });
    },
    onError: (e) => { setConfirm(false); toast(errorText(e), { tone: 'danger' }); },
  });

  if (programQ.isLoading) return <div className="ui-skeleton" style={{ height: 96 }} />;

  if (!program || program.items.length === 0 || program.status !== 'ready') {
    return (
      <section className="ui-card ui-card--pad al-panel" aria-labelledby="al-title">
        <div className="al-head">
          <div>
            <h2 id="al-title" className="ui-panel-title">Course alignment</h2>
            <p className="ui-muted al-lede">
              {program?.status === 'parsing'
                ? 'The course program is being read. The check is available once its items are ready.'
                : 'Add the course program to check whether the book teaches what the exam asks.'}
            </p>
          </div>
          <Link className="ui-btn" to={`/books/${pid}/settings`}>Open Book setup</Link>
        </div>
      </section>
    );
  }

  const findings = report?.findings ?? [];
  const applied = !!report?.appliedAt;
  // Reports are made on the approved outline, which can be older than the newest (unapproved) revision.
  const stale = !!report && !!project.data && report.outlineRevId !== project.data.outlineRevId;
  const covered = report ? report.coverage.filter((c) => c.nodeIds.length > 0).length : 0;
  const busy = !!alignRun || check.isPending || apply.isPending;
  const counts = alignRun ? runCounts(alignRun) : null;
  const taskNow = (runDetail.data?.tasks ?? []).find((t) => t.state === 'running')?.label;

  const chosen = findings.flatMap((f, i) => (picked.has(i) && APPLICABLE(f) ? [{ f, i }] : []));
  const canApply = !!report && !applied && !stale && chosen.length > 0 && !busy;
  const toggle = (i: number) => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const setMany = (idx: number[], on: boolean) => setPicked((s) => { const n = new Set(s); idx.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; });

  const sectionLink = (nodeId: string) => {
    const name = names.sections.get(nodeId);
    return name ? <Link to={`/books/${pid}/manuscript/${nodeId}`} className="rv-loc ui-wrap">{name}</Link> : <span className="ui-muted">a section that is no longer in the outline</span>;
  };

  const row = (f: AlignmentFinding, i: number): ReactNode => {
    const applicable = APPLICABLE(f);
    let title: ReactNode;
    let extra: ReactNode = null;
    switch (f.kind) {
      case 'missing': {
        const s = f.suggested;
        const after = s.afterSectionId ? names.sections.get(s.afterSectionId) : null;
        title = <span className="al-title-text ui-wrap">{itemTitle.get(f.item) ?? f.item}</span>;
        extra = (
          <p className="al-suggest">
            <span className="ui-meta">New section</span> “{s.title}” in {names.chapters.get(s.chapterId) ?? 'a chapter'}{after ? `, after ${after}` : ', as the first section'}. Depth: {s.depth}.
            {s.objectives.length > 0 && <span className="ui-muted"> Objectives: {s.objectives.join('; ')}</span>}
          </p>
        );
        break;
      }
      case 'thin':
      case 'proof':
        title = <><span className="al-title-text ui-wrap">{itemTitle.get(f.item) ?? f.item}</span><span className="ui-muted"> in </span>{sectionLink(f.nodeId)}</>;
        break;
      case 'off-program':
        title = <>{sectionLink(f.nodeId)}<span className={`ui-badge ${f.whole ? 'ui-badge--warning' : ''}`}>{f.whole ? 'Whole section' : 'Part of a section'}</span></>;
        if (f.quote) extra = <blockquote className="rv-quote"><MathText text={f.quote} /></blockquote>;
        break;
      case 'order':
        title = <>{sectionLink(f.nodeId)}<span className="ui-badge">Report only</span></>;
        break;
      case 'exam-guide':
        title = <span className="al-title-text ui-wrap">{names.chapters.get(f.chapterId) ?? 'A chapter'}</span>;
        break;
    }
    return (
      <li key={i} className={`al-finding${picked.has(i) && applicable && !applied ? ' is-picked' : ''}`}>
        {!applied && (
          <label className="rv-pick">
            <input type="checkbox" checked={picked.has(i) && applicable} disabled={!applicable || busy} onChange={() => toggle(i)} />
            <span className="ui-sr">{applicable ? 'Apply: ' : 'Cannot be applied: '}{f.message}</span>
          </label>
        )}
        <div className="rv-main">
          <div className="al-finding__title">{title}</div>
          {extra}
          <p className="rv-msg"><MathText text={f.message} /></p>
        </div>
      </li>
    );
  };

  // What the confirm dialog promises, counted from the selection.
  const n = (k: Kind, test: (f: AlignmentFinding) => boolean = () => true) => chosen.filter(({ f }) => f.kind === k && test(f)).length;
  const wholeOff = n('off-program', (f) => f.kind === 'off-program' && f.whole);
  const partOff = n('off-program', (f) => f.kind === 'off-program' && !f.whole);

  return (
    <section className="ui-card ui-card--pad al-panel" aria-labelledby="al-title">
      <div className="al-head">
        <div>
          <h2 id="al-title" className="ui-panel-title">Course alignment</h2>
          <p className="ui-muted al-lede">
            {report
              ? `Checked ${timeAgo(report.createdAt)}. ${covered} of ${plural(program.items.length, 'program item')} ${covered === 1 ? 'has' : 'have'} a section. ${findings.length === 0 ? 'Nothing to fix.' : plural(findings.length, 'finding')}.`
              : `Compares the outline and the structure of each written section with the ${plural(program.items.length, 'program item')} and the exam. It does not read whole sections.`}
          </p>
        </div>
        <div className="ui-page__actions">
          <button type="button" className={`ui-btn${report ? '' : ' ui-btn--accent'}`} onClick={() => check.mutate()} disabled={busy}>
            {busy ? <><span className="ui-spinner" />Working…</> : report ? 'Check again' : 'Check alignment'}
          </button>
          {report && !applied && findings.some(APPLICABLE) && (
            <button type="button" className="ui-btn ui-btn--accent" onClick={() => setConfirm(true)} disabled={!canApply}><Icon name="sparkle" />Align book{chosen.length ? ` (${chosen.length})` : ''}</button>
          )}
        </div>
      </div>

      {alignRun && (
        <div className="ui-banner ui-banner--info" role="status">
          <span className="ui-spinner al-spin" aria-hidden="true" />
          <div className="ui-banner__body">
            <span className="ui-banner__title">Working on the alignment</span>
            <span>{taskNow ? `${taskNow}. ` : ''}{counts && counts.total ? `${counts.done} of ${plural(counts.total, 'step')} done. ` : ''}<Link className="ui-btn ui-btn--link" to={`/books/${pid}/run`}>Open run</Link></span>
          </div>
        </div>
      )}
      {reportQ.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(reportQ.error)}</div>}

      {report && stale && !applied && (
        <div className="ui-banner ui-banner--warning" role="status">
          <Icon name="alert" size={16} />
          <div className="ui-banner__body">
            <span className="ui-banner__title">The outline changed after this check</span>
            <span>Check again before you align the book, so the changes match the current outline.</span>
          </div>
        </div>
      )}

      {report && applied && <AppliedList report={report} pid={pid} />}

      {report && !applied && findings.length === 0 && (
        <p className="al-clear"><Icon name="check" size={16} />The book matches the program. Every item has a section and every chapter has its exam guide.</p>
      )}

      {report && !applied && GROUPS.map((g) => {
        const list = findings.flatMap((f, i) => (f.kind === g.kind ? [{ f, i }] : []));
        if (list.length === 0) return null;
        const idx = list.map((x) => x.i);
        const all = g.kind !== 'order' && idx.every((i) => picked.has(i));
        const hint = g.kind === 'off-program'
          ? (offProgram === 'delete'
            ? 'Material the exam does not ask for. Whole sections are removed from the outline and passages are cut. Book setup can switch this to keeping them with a note.'
            : 'Material the exam does not ask for. Sections and passages stay and start with a note that the exam does not ask for them. Book setup can switch this to removing them.')
          : g.hint;
        return (
          <details key={g.kind} className="al-group" open>
            <summary>
              <span className="al-group__title">{g.title}</span>
              <span className="ui-badge">{list.length}</span>
            </summary>
            <p className="ui-muted al-hint">{hint}</p>
            {g.kind !== 'order' && (
              <div className="ui-row al-bulk">
                <button type="button" className="ui-btn ui-btn--link" onClick={() => setMany(idx, !all)} disabled={busy}>{all ? 'Select none' : 'Select all'}</button>
              </div>
            )}
            <ul className="al-list">{list.map(({ f, i }) => row(f, i))}</ul>
          </details>
        );
      })}

      <ConfirmDialog
        open={confirm}
        title="Align the book"
        message={
          <div className="al-confirm">
            <p>This uses {plural(chosen.length, 'finding')} from the check:</p>
            <ul>
              {n('missing') > 0 && <li>Adds {plural(n('missing'), 'section')} for missing program items and writes {n('missing') === 1 ? 'it' : 'them'}.</li>}
              {n('exam-guide') > 0 && <li>Adds {plural(n('exam-guide'), 'exam guide')} at the end of {n('exam-guide') === 1 ? 'a chapter' : 'chapters'} and writes {n('exam-guide') === 1 ? 'it' : 'them'}.</li>}
              {n('thin') + n('proof') > 0 && <li>Opens {plural(n('thin') + n('proof'), 'review issue')} for thin sections and missing proofs, and the writer fixes {n('thin') + n('proof') === 1 ? 'it' : 'them'}. Earlier versions stay in each section’s history.</li>}
              {wholeOff > 0 && <li>{offProgram === 'delete' ? <><strong>Removes {plural(wholeOff, 'section')}</strong> from the outline.</> : <>Keeps {plural(wholeOff, 'off-program section')} and puts a note at the top of {wholeOff === 1 ? 'it' : 'each'}.</>}</li>}
              {partOff > 0 && <li>{offProgram === 'delete' ? `Cuts ${plural(partOff, 'off-program passage')} from the text.` : `Adds a note before ${plural(partOff, 'off-program passage')}.`}</li>}
            </ul>
            <p>The new outline is saved and approved as a new revision. {offProgram === 'delete' && wholeOff > 0 ? 'Removed sections keep their text, and Put back returns each one to where it was. A section that other sections link to or take formulas from is kept with a note instead, and the result says so.' : 'The earlier outline stays in the history.'}</p>
          </div>
        }
        confirmLabel="Align book"
        danger={offProgram === 'delete' && wholeOff > 0}
        busy={apply.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => report && apply.mutate({ reportId: report.id, findings: chosen.map((c) => c.i).sort((a, b) => a - b) })}
      />
    </section>
  );
}

function AppliedList({ report, pid }: { report: AlignmentReport; pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const restore = useMutation({
    mutationFn: (nodeId: string) => api('POST /api/projects/:id/alignment/restore', { params: { id: pid }, body: { reportId: report.id, nodeId } }),
    onSuccess: (_, nodeId) => {
      toast(`Put back "${report.removed.find((r) => r.nodeId === nodeId)?.title ?? 'the section'}"`);
      void qc.invalidateQueries({ queryKey: qk.alignment(pid) });
      void qc.invalidateQueries({ queryKey: qk.outline(pid) });
    },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const removed = report.removed ?? [];
  return (
    <div className="ui-banner ui-banner--success" role="status">
      <Icon name="check" size={16} />
      <div className="ui-banner__body">
        <span className="ui-banner__title">Aligned {report.appliedAt ? timeAgo(report.appliedAt) : ''}</span>
        {report.applied.length === 0 ? <span>The service made no changes.</span> : (
          <ul className="al-applied">{report.applied.map((l, i) => <li key={i} className="ui-wrap">{l}</li>)}</ul>
        )}
        {removed.length > 0 && (
          <ul className="al-removed" aria-label="Removed sections">
            {removed.map((r) => (
              <li key={r.nodeId}>
                <span className="ui-wrap">{r.title}</span>
                {r.restoredAt
                  ? <span className="ui-muted">Put back {timeAgo(r.restoredAt)}</span>
                  : <button type="button" className="ui-btn ui-btn--sm" onClick={() => restore.mutate(r.nodeId)} disabled={restore.isPending}>Put back</button>}
              </li>
            ))}
          </ul>
        )}
        <span className="ui-muted">Run the check again to see what is left.</span>
      </div>
    </div>
  );
}
