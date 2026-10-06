import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IssueSeverity, IssueSource, IssueStatus, ReviewIssue } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk, useIssues, useManuscript, useProject, useQuestions } from '../../lib/queries';
import { plural, timeAgo } from '../../lib/format';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import './review.css';

const SEVERITIES: IssueSeverity[] = ['blocker', 'major', 'minor'];
const SOURCES: IssueSource[] = ['lint', 'review', 'verification'];
const STATUSES: IssueStatus[] = ['open', 'proposed', 'fixed', 'accepted', 'dismissed'];
const SEV_TONE: Record<IssueSeverity, string> = { blocker: 'danger', major: 'warning', minor: '' };
const SEV_ORDER: Record<IssueSeverity, number> = { blocker: 0, major: 1, minor: 2 };

export default function ReviewPage() {
  useDocumentTitle('Review');
  const pid = useBookId();
  const issuesQ = useIssues(pid);
  const manuscript = useManuscript(pid);
  const questions = useQuestions(pid);
  const project = useProject(pid);
  const qc = useQueryClient();
  const toast = useToast();

  const [sev, setSev] = useState<string>('');
  const [src, setSrc] = useState<string>('');
  const [status, setStatus] = useState<string>('open');
  const [picked, setPicked] = useState<Set<string>>(new Set());

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
  const openCount = all.filter((i) => i.status === 'open').length;
  const fixable = shown.filter((i) => picked.has(i.id) && (i.status === 'open'));

  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.issues(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); void qc.invalidateQueries({ queryKey: qk.manuscript(pid) }); void qc.invalidateQueries({ queryKey: ['section', pid] }); };
  const fixMany = useMutation({
    mutationFn: (ids: string[]) => api('POST /api/projects/:id/issues/fix', { params: { id: pid }, body: { issueIds: ids } }),
    onSuccess: (_r, ids) => { toast(`Fixing ${plural(ids.length, 'issue')}`, { action: { label: 'Open run', to: `/books/${pid}/run` } }); setPicked(new Set()); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const review = useMutation({
    mutationFn: () => api('POST /api/projects/:id/runs', { params: { id: pid }, body: { kind: 'review' } }),
    onSuccess: () => { toast('Review started', { action: { label: 'Open run', to: `/books/${pid}/run` } }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const setIssue = useMutation({
    mutationFn: (v: { id: string; status: IssueStatus; msg: string }) => api('PATCH /api/issues/:iid', { params: { iid: v.id }, body: { status: v.status } }),
    onSuccess: (_r, v) => { toast(v.msg); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = shown.length > 0 && shown.every((i) => picked.has(i.id));
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

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Review</h1>
          <p className="ui-lede">{openCount === 0 ? 'No open issues.' : `${plural(openCount, 'open issue')}. Open one to see it in the text, or let the writer propose fixes.`}</p>
        </div>
        <div className="ui-page__actions">
          <button type="button" className="ui-btn" onClick={() => review.mutate()} disabled={review.isPending || runActive}>{runActive ? <><span className="ui-spinner" />Reviewing…</> : 'Run review'}</button>
        </div>
      </div>

      <div className="rv-filters ui-row" role="group" aria-label="Filters">
        <label><span className="ui-sr">Severity</span><select className="ui-select ui-select--sm" value={sev} onChange={(e) => setSev(e.target.value)}><option value="">All severities</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label><span className="ui-sr">Source</span><select className="ui-select ui-select--sm" value={src} onChange={(e) => setSrc(e.target.value)}><option value="">All sources</option>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label><span className="ui-sr">Status</span><select className="ui-select ui-select--sm" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <span className="ui-grow" />
        <label className="ui-check"><input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((i) => i.id)) : new Set())} disabled={shown.length === 0} />Select all shown</label>
        <button type="button" className="ui-btn ui-btn--primary" disabled={fixable.length === 0 || fixMany.isPending} onClick={() => fixMany.mutate(fixable.map((i) => i.id))}><Icon name="sparkle" />Fix selected issues{fixable.length ? ` (${fixable.length})` : ''}</button>
      </div>

      {issuesQ.isLoading && <div className="ui-skeleton" style={{ height: 160 }} />}
      {issuesQ.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(issuesQ.error)}</div>}
      {!issuesQ.isLoading && all.length === 0 && <div className="ui-empty"><p className="ui-empty__text">Nothing to review yet. Run a review after drafting and the issues land here.</p><button type="button" className="ui-btn ui-btn--primary" onClick={() => review.mutate()} disabled={review.isPending}>Run review</button></div>}
      {all.length > 0 && shown.length === 0 && <p className="ui-muted">No issues match these filters.</p>}

      <ul className="rv-list">
        {shown.map((i) => (
          <li key={i.id} className={`rv-item rv-item--${i.severity}${picked.has(i.id) ? ' is-picked' : ''}`}>
            <label className="rv-pick"><input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} /><span className="ui-sr">Select issue: {i.message}</span></label>
            <div className="rv-main">
              <div className="ui-row">
                <span className={`ui-badge ui-badge--${SEV_TONE[i.severity] || 'neutral'}`}>{i.severity}</span>
                <span className="ui-badge ui-badge--mono">{i.source}</span>
                <span className="ui-muted rv-cat">{i.category}</span>
                <span className={`ui-badge${i.status === 'open' ? '' : i.status === 'fixed' || i.status === 'accepted' ? ' ui-badge--success' : i.status === 'proposed' ? ' ui-badge--info' : ''}`}>{i.status}</span>
                <span className="ui-muted rv-time">{timeAgo(i.createdAt)}</span>
              </div>
              <div className="rv-where"><span className="ui-meta">Where</span> {location(i)}</div>
              {i.quote && <blockquote className="rv-quote">{i.quote}</blockquote>}
              <p className="rv-msg">{i.message}</p>
              {i.suggestion && <p className="rv-sug"><strong>Suggestion:</strong> {i.suggestion}</p>}
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
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
