import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Resource, SplitWarning } from '@smartbuilder/domain';
import { api, describeError } from '../../lib/api';
import { qk, useRun } from '../../lib/queries';
import { TERMINAL_RUN, plural } from '../../lib/format';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';

const WHY: Record<SplitWarning, string> = {
  no_questions: 'A file with exam papers usually holds several sessions. No question was split out of this one, so nothing from it reaches the exercises or the exam practice.',
  no_heading: 'Questions were found, but no session heading, so the whole file counts as one session and the papers cannot be told apart.',
  thin_sessions: 'Every session has at most one question, which usually means the questions were not told apart. The exercises and the exam practice get fewer questions than the papers hold.',
};

/** What the last split of an exam file found, for the file's meta line. Shown when the split looks right. */
export function SplitFound({ r }: { r: Resource }) {
  if (r.role !== 'exams' || r.splitSessions === null || r.splitQuestions === null || r.splitWarning) return null;
  return <span className="so-found so-found--ok"><Icon name="check" size={14} /> <b>{r.splitSessions}</b> {r.splitSessions === 1 ? 'session' : 'sessions'} · <b>{r.splitQuestions}</b> {r.splitQuestions === 1 ? 'question' : 'questions'} found</span>;
}

/**
 * The block under an exam file whose split looks wrong: what happened, "Split with AI" and "Mark as not an exam".
 * It stays mounted for every source because the "marked as not an exam" note and the run being watched are local to the row.
 */
export function ExamSplit({ r, pid }: { r: Resource; pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [runId, setRunId] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ message: string; action?: string } | null>(null);
  const [marked, setMarked] = useState(false);
  const run = useRun(runId ?? undefined, true).data;
  const live = !!runId && (!run || !TERMINAL_RUN.has(run.status));
  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.resources(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); };

  // The service says an answer it did not accept in the run's warnings, and keeps the old split.
  const notApplied = run?.status === 'completed' ? run.warnings.find((w) => w.message.startsWith('The AI split of') && w.message.includes(r.filename))?.message : undefined;
  const ended = useRef<string | null>(null);
  useEffect(() => {
    if (!runId || !run || !TERMINAL_RUN.has(run.status) || ended.current === runId) return;
    ended.current = runId;
    refresh();
    if (run.status === 'completed' && !notApplied) toast(`${r.filename} was split with AI`);
  // Runs once per finished run: `ended` guards it, so the helpers above are left out of the dependencies.
  }, [runId, run?.status]);

  const split = useMutation({
    mutationFn: () => api('POST /api/resources/:rid/split', { params: { rid: r.id } }),
    onMutate: () => setRefused(null),
    onSuccess: (started) => { setRunId(started.id); void qc.invalidateQueries({ queryKey: qk.project(pid) }); },
    onError: (e) => { const d = describeError(e); setRefused({ message: d.message, action: d.action }); },
  });
  const role = useMutation({
    mutationFn: (to: Resource['role']) => api('PATCH /api/resources/:rid', { params: { rid: r.id }, body: { role: to } }),
    onSuccess: (_d, to) => { setMarked(to !== 'exams'); setRefused(null); refresh(); },
    onError: (e) => toast(describeError(e).message, { tone: 'danger' }),
  });

  if (live) {
    return (
      <div className="so-warn so-warn--busy" role="status">
        <span className="ui-spinner" aria-hidden="true" />
        <div className="so-warn__body">
          <span className="so-warn__title">Splitting {r.filename} with AI</span>
          <span className="ui-muted">The model reads the first lines of each page and marks where each session and each question starts. <Link to={`/books/${pid}/run`}>Open run</Link></span>
        </div>
      </div>
    );
  }
  if (marked && r.role !== 'exams') {
    return (
      <div className="so-warn so-warn--note" role="status">
        <Icon name="info" />
        <div className="so-warn__body">
          <span className="so-warn__title">Marked as not an exam</span>
          <span className="ui-muted">The role is now {r.role === 'mixed' ? 'Mixed' : r.role}, so the file is used as source material for the topics. <button type="button" className="ui-btn ui-btn--link" onClick={() => role.mutate('exams')} disabled={role.isPending}>Undo</button></span>
        </div>
      </div>
    );
  }
  if (!r.splitWarning || r.splitSessions === null || r.splitQuestions === null) return null;

  const failed = run && (run.status === 'failed' || run.status === 'cancelled');
  return (
    <div className="so-warn" role="alert">
      <Icon name="alert" />
      <div className="so-warn__body">
        <span className="so-warn__title">{plural(r.splitSessions, 'session')} and {plural(r.splitQuestions, 'question')} found in {r.filename}</span>
        <span className="ui-muted">{WHY[r.splitWarning]}</span>
        {notApplied && <span className="so-warn__result">{notApplied} The file keeps the split it had.</span>}
        {failed && <span className="so-warn__result">The split run {run.status === 'failed' ? 'failed' : 'was cancelled'}, so the file keeps the split it had. <Link to={`/books/${pid}/run`}>Open run</Link></span>}
        {refused && <span className="so-warn__result">{refused.message}{refused.action ? ` ${refused.action}` : ''} <Link to={`/books/${pid}/run`}>Open run</Link></span>}
        <div className="so-warn__actions">
          <button type="button" className="ui-btn ui-btn--sm ui-btn--accent" onClick={() => split.mutate()} disabled={split.isPending || role.isPending}><Icon name="sparkle" size={14} />{notApplied || failed || refused ? 'Try again' : 'Split with AI'}</button>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => role.mutate('mixed')} disabled={split.isPending || role.isPending}>Mark as not an exam</button>
        </div>
      </div>
    </div>
  );
}
