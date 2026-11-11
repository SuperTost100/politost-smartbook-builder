import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Asset, IssueSeverity, IssueSource, IssueStatus, ReviewIssue } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { qk, useAssets, useIssues, useManuscript, useProject, useQuestions, useRuns } from '../../lib/queries';
import { figureOfIssue } from '../../lib/figureIssue';
import { plural, timeAgo } from '../../lib/format';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { MathText } from '../../components/MathText';
import { ConfirmDialog } from '../../components/Dialog';
import { AlignmentPanel } from './AlignmentPanel';
import './review.css';

const SEVERITIES: IssueSeverity[] = ['blocker', 'major', 'minor'];
const SOURCES: IssueSource[] = ['lint', 'review', 'verification'];
const STATUSES: IssueStatus[] = ['open', 'proposed', 'fixed', 'accepted', 'dismissed'];
const SEV_TONE: Record<IssueSeverity, string> = { blocker: 'danger', major: 'warning', minor: '' };
const SEV_ORDER: Record<IssueSeverity, number> = { blocker: 0, major: 1, minor: 2 };
/** Minor notes listed before "Show the other n notes". */
const MINOR_SHOWN = 6;
const label = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function ReviewPage() {
  useDocumentTitle('Review');
  const pid = useBookId();
  const issuesQ = useIssues(pid);
  const manuscript = useManuscript(pid);
  const questions = useQuestions(pid);
  const project = useProject(pid);
  const assets = useAssets(pid);
  const runs = useRuns(pid);
  const qc = useQueryClient();
  const toast = useToast();

  const [sev, setSev] = useState<string>('');
  const [src, setSrc] = useState<string>('');
  const [status, setStatus] = useState<string>('open');
  // Every open issue is selected until the author clears it, so a new issue arrives selected. The set holds the ones cleared.
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [minorOpen, setMinorOpen] = useState(false);
  const [minorAll, setMinorAll] = useState(false);

  const sectionName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of manuscript.data ?? []) {
      m.set(c.chapterId, `Chapter ${c.number}`);
      c.sections.forEach((s, i) => m.set(s.sectionId, `${c.number}.${i + 1} ${s.title}`));
    }
    return m;
  }, [manuscript.data]);

  const all = issuesQ.data ?? [];
  const shown = useMemo(() => all
    .filter((i) => (!sev || i.severity === sev) && (!src || i.source === src) && (!status || i.status === status))
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.createdAt.localeCompare(a.createdAt)), [all, sev, src, status]);
  const open = all.filter((i) => i.status === 'open');
  const openCount = open.length;
  const proposedCount = all.filter((i) => i.status === 'proposed').length;
  const picked = (i: ReviewIssue) => i.status === 'open' && !cleared.has(i.id);
  const fixable = shown.filter(picked);
  const main = shown.filter((i) => i.severity !== 'minor');
  const minor = shown.filter((i) => i.severity === 'minor');
  const openShown = shown.filter((i) => i.status === 'open');
  const minorOpenShown = minor.filter((i) => i.status === 'open');
  const minorPicked = minorOpenShown.filter(picked).length;
  const serious = open.filter((i) => i.severity !== 'minor');
  // shortcut: "nothing serious" is derived here from the open issues and the last review run. Switch to the field of the review run's result that says so once it is in pipeline/review.ts.
  const lastReview = [...(runs.data ?? [])].filter((r) => r.kind === 'review').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const reviewedClear = lastReview?.status === 'completed' && serious.length === 0;

  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.issues(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); void qc.invalidateQueries({ queryKey: qk.manuscript(pid) }); void qc.invalidateQueries({ queryKey: ['section', pid] }); };
  const fixMany = useMutation({
    mutationFn: (ids: string[]) => api('POST /api/projects/:id/issues/fix', { params: { id: pid }, body: { issueIds: ids } }),
    onSuccess: (_r, ids) => { toast(`Fixing ${plural(ids.length, 'issue')}. Fixes are applied to the text; earlier versions stay in each section's history.`, { action: { label: 'Open run', to: `/books/${pid}/run` } }); setCleared(new Set()); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const [confirmFull, setConfirmFull] = useState(false);
  const review = useMutation({
    mutationFn: (mode?: 'full') => api('POST /api/projects/:id/runs', { params: { id: pid }, body: { kind: 'review', ...(mode ? { scope: { reviewMode: mode } } : {}) } }),
    onSuccess: (_r, mode) => { toast(mode ? 'Full review started' : 'Review started', { action: { label: 'Open run', to: `/books/${pid}/run` } }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const setIssue = useMutation({
    mutationFn: (v: { id: string; status: IssueStatus; msg: string }) => api('PATCH /api/issues/:iid', { params: { iid: v.id }, body: { status: v.status } }),
    onSuccess: (_r, v) => { toast(v.msg); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const toggle = (id: string) => setCleared((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  /** Selects or clears a whole group at once. */
  const setGroup = (list: ReviewIssue[], on: boolean) => setCleared((s) => { const n = new Set(s); for (const i of list) { if (on) n.delete(i.id); else n.add(i.id); } return n; });
  const allPicked = openShown.length > 0 && openShown.every(picked);
  const runActive = project.data?.activeRun?.kind === 'review' && !['completed', 'failed', 'cancelled'].includes(project.data.activeRun.status);

  const location = (i: ReviewIssue) => {
    if (i.nodeId) {
      const name = sectionName.get(i.nodeId) ?? 'Section';
      return <Link to={`/books/${pid}/manuscript/${i.nodeId}?issue=${i.id}`} className="rv-loc ui-wrap">{name}</Link>;
    }
    if (i.questionId) {
      const q = (questions.data ?? []).find((x) => x.id === i.questionId);
      return <Link to={`/books/${pid}/practice?tab=${q?.kind === 'exam' ? 'exam' : 'exercise'}&q=${i.questionId}`} className="rv-loc ui-wrap">{q ? `${q.kind === 'exam' ? 'Exam question' : 'Exercise'} ${q.number ?? ''}`.trim() : 'Question'}</Link>;
    }
    return <span className="ui-muted">Whole book</span>;
  };

  const counts = (['blocker', 'major', 'minor'] as const).map((sv) => [open.filter((i) => i.severity === sv).length, sv === 'blocker' ? 'blocker' : sv === 'major' ? 'major issue' : 'minor note'] as const).filter(([n]) => n > 0).map(([n, w]) => plural(n, w));
  const joined = counts.length > 1 ? `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]}` : counts[0];
  const waiting = proposedCount > 0 ? ` · ${plural(proposedCount, 'fix', 'fixes')} waiting for your approval in the Manuscript` : '';
  const summary = reviewedClear ? (
    <p className="rv-summary" role="status"><Icon name="check" size={18} /><span>No blockers or major issues in the changed text. The book is ready to export.{openCount > 0 ? ` ${plural(openCount, 'minor note')} ${openCount === 1 ? 'is' : 'are'} left, and ${openCount === 1 ? 'it does' : 'they do'} not hold back the export.` : ''} <Link to={`/books/${pid}/export`}>Go to Export</Link>{waiting}</span></p>
  ) : (
    <p className="ui-lede">{openCount === 0 ? 'No open issues.' : `${joined} in the changed text. Open one to see it in the text, or let the writer fix it.`}{waiting}</p>
  );

  const card = (i: ReviewIssue, compact = false) => {
    const figure = figureOfIssue(i, assets.data ?? []);
    const text = (
      <>
        {i.quote && <blockquote className="rv-quote"><MathText text={i.quote} /></blockquote>}
        <p className="rv-msg"><MathText text={i.message} /></p>
        {i.suggestion && <p className="rv-sug"><strong>Suggestion:</strong> <MathText text={i.suggestion} /></p>}
        {i.resolution && <p className="ui-muted rv-sug">Resolution: {i.resolution}</p>}
        <div className="ui-row">
          {i.status === 'open' || i.status === 'proposed' ? (
            <>
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => setIssue.mutate({ id: i.id, status: 'accepted', msg: 'Issue accepted as is' })}>Accept as is</button>
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => setIssue.mutate({ id: i.id, status: 'dismissed', msg: 'Issue dismissed' })}>Dismiss</button>
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => setIssue.mutate({ id: i.id, status: 'fixed', msg: 'Issue marked fixed' })}>Mark fixed</button>
            </>
          ) : (
            <button type="button" className="ui-btn ui-btn--sm" onClick={() => setIssue.mutate({ id: i.id, status: 'open', msg: 'Issue reopened' })}>Reopen</button>
          )}
        </div>
      </>
    );
    return (
      <li key={i.id} className={`rv-item rv-item--${i.severity}${picked(i) ? ' is-picked' : ''}${compact ? ' rv-item--compact' : ''}`}>
        {i.status === 'open' && <label className="rv-pick"><input type="checkbox" checked={picked(i)} onChange={() => toggle(i.id)} /><span className="ui-sr">Select issue: {i.message}</span></label>}
        <div className="rv-main">
          <div className="ui-row">
            <span className={`ui-badge ui-badge--${SEV_TONE[i.severity] || 'neutral'}`}>{i.severity}</span>
            <span className="ui-badge ui-badge--mono">{i.source}</span>
            <span className="ui-muted rv-cat">{i.category}</span>
            <span className={`ui-badge${i.status === 'open' ? '' : i.status === 'fixed' || i.status === 'accepted' ? ' ui-badge--success' : i.status === 'proposed' ? ' ui-badge--info' : ''}`}>{i.status}</span>
            <span className="ui-muted rv-time">{timeAgo(i.createdAt)}</span>
          </div>
          <div className="rv-where"><span className="ui-meta">Where</span> {location(i)}</div>
          {figure ? (
            <div className="rv-body">
              <div className="rv-body__text">{text}</div>
              <FigureThumb pid={pid} figure={figure} issue={i} />
            </div>
          ) : text}
        </div>
      </li>
    );
  };

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Review</h1>
          {summary}
        </div>
        <div className="ui-page__actions">
          <button type="button" className="ui-btn" onClick={() => setConfirmFull(true)} disabled={review.isPending || runActive}>Full review</button>
          <button type="button" className="ui-btn" onClick={() => review.mutate(undefined)} disabled={review.isPending || runActive}>{runActive ? <><span className="ui-spinner" />Reviewing…</> : 'Run review'}</button>
        </div>
      </div>

      <AlignmentPanel pid={pid} />

      <div className="rv-filters ui-row" role="group" aria-label="Filters">
        <label><span className="ui-sr">Severity</span><select className="ui-select ui-select--sm" value={sev} onChange={(e) => setSev(e.target.value)}><option value="">All severities</option>{SEVERITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
        <label><span className="ui-sr">Source</span><select className="ui-select ui-select--sm" value={src} onChange={(e) => setSrc(e.target.value)}><option value="">All sources</option>{SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
        <label><span className="ui-sr">Status</span><select className="ui-select ui-select--sm" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
        <span className="ui-grow" />
        <label className="ui-check"><input type="checkbox" checked={allPicked} onChange={(e) => setGroup(openShown, e.target.checked)} disabled={openShown.length === 0} />Select all shown</label>
        <button type="button" className="ui-btn ui-btn--accent" disabled={fixable.length === 0 || fixMany.isPending} onClick={() => fixMany.mutate(fixable.map((i) => i.id))}><Icon name="sparkle" />Fix selected issues{fixable.length ? ` (${fixable.length})` : ''}</button>
      </div>

      {issuesQ.isLoading && <div className="ui-skeleton" style={{ height: 160 }} />}
      {issuesQ.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(issuesQ.error)}</div>}
      {!issuesQ.isLoading && all.length === 0 && <div className="ui-empty"><p className="ui-empty__text">Nothing to review yet. Run a review after drafting and the issues land here.</p><button type="button" className="ui-btn ui-btn--accent" onClick={() => review.mutate(undefined)} disabled={review.isPending}>Run review</button></div>}
      {all.length > 0 && shown.length === 0 && <p className="ui-muted">No issues match these filters.</p>}

      {main.length > 0 && <ul className="rv-list" aria-label="Blockers and major issues">{main.map((i) => card(i))}</ul>}

      {minor.length > 0 && (
        <details className="rv-minor" open={minorOpen || sev === 'minor'} onToggle={(e) => setMinorOpen(e.currentTarget.open)}>
          <summary>
            <Icon name="chevron-right" size={16} className="rv-chev" />
            <span>{plural(minor.length, 'minor note')}</span>
            {minorOpenShown.length > 0 && <span className={`ui-badge${minorPicked > 0 ? ' ui-badge--accent' : ''}`}>{minorPicked === 0 ? 'not selected' : minorPicked === minorOpenShown.length ? 'all selected' : `${minorPicked} selected`}</span>}
            <span className="rv-minor__hint">Style and small wording. They do not hold back the export.</span>
          </summary>
          <div className="rv-minor__body">
            {minorOpenShown.length > 0 && (
              <div className="rv-minor__bar">
                <button type="button" className="ui-btn ui-btn--link" onClick={() => setGroup(minorOpenShown, minorPicked < minorOpenShown.length)}>{minorPicked < minorOpenShown.length ? `Select all ${minorOpenShown.length} minor notes` : `Clear all ${minorOpenShown.length} minor notes`}</button>
                <span className="ui-muted">{minorPicked} of {minorOpenShown.length} selected</span>
              </div>
            )}
            <ul className="rv-list">{(minorAll ? minor : minor.slice(0, MINOR_SHOWN)).map((i) => card(i, true))}</ul>
            {!minorAll && minor.length > MINOR_SHOWN && <button type="button" className="ui-btn ui-btn--sm rv-more" onClick={() => setMinorAll(true)}>Show the other {minor.length - MINOR_SHOWN} notes</button>}
          </div>
        </details>
      )}

      <ConfirmDialog
        open={confirmFull}
        title="Full review"
        message="Every section is reviewed on its own call instead of the whole chapter at once, and every finding gets a second opinion. It costs about as much as 3 to 5 normal reviews, so use it once, before the final export. Open review issues are replaced by what it finds."
        confirmLabel="Start full review"
        onClose={() => setConfirmFull(false)}
        onConfirm={() => { setConfirmFull(false); review.mutate('full'); }}
      />
    </div>
  );
}

/** The drawing an issue is about, on the book's figure plate. It opens the section at the issue. */
function FigureThumb({ pid, figure, issue }: { pid: string; figure: Asset; issue: ReviewIssue }) {
  const name = figure.caption.trim() || figure.alt.trim() || figure.filename;
  return (
    <Link className="rv-thumb" to={`/books/${pid}/manuscript/${issue.nodeId}?issue=${issue.id}`} aria-label={`Open the section with the figure: ${name}`}>
      <span className="sb-figure-frame rv-fig"><img src={apiUrl('GET /api/assets/:assetId/file', { params: { assetId: figure.id } })} alt={figure.alt || figure.filename} loading="lazy" /></span>
      <small className="ui-wrap">{name}</small>
    </Link>
  );
}
