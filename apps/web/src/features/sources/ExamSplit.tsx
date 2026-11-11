import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Resource, SplitWarning } from '@smartbuilder/domain';
import { api, describeError } from '../../lib/api';
import { qk, useRun, useRuns } from '../../lib/queries';
import { TERMINAL_RUN, plural } from '../../lib/format';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';

const WHY: Record<SplitWarning, string> = {
  no_questions: 'A file with exam papers usually holds several sessions. No question was split out of this one, so nothing from it reaches the exercises or the exam practice.',
  no_heading: 'Questions were found, but no session heading, so the whole file counts as one session and the papers cannot be told apart.',
  thin_sessions: 'Every session has at most one question, which usually means the questions were not told apart. The exercises and the exam practice get fewer questions than the papers hold.',
};

/** What the last split of an exam file found, for the file's meta line. Shown when the split looks right. An excluded file has no warning to check, so it shows nothing. */
export function SplitFound({ r }: { r: Resource }) {
  if (!r.included || r.role !== 'exams' || r.splitSessions === null || r.splitQuestions === null || r.splitWarning) return null;
  return <span className="so-found so-found--ok"><Icon name="check" size={14} /> <b>{r.splitSessions}</b> {r.splitSessions === 1 ? 'session' : 'sessions'} · <b>{r.splitQuestions}</b> {r.splitQuestions === 1 ? 'question' : 'questions'} found</span>;
}

const TASK_DONE = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);

/**
 * The block under an exam file whose split looks wrong or whose AI split just ended badly: what happened, "Split with AI" and
 * "Mark as not an exam". It stays mounted for every source. The AI split being watched is not kept in the row: it is found
 * again from the newest Prepare run, whose `resource.split` task names the file, so the row is right after a visit to the run.
 */
export function ExamSplit({ r, pid }: { r: Resource; pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [refused, setRefused] = useState<{ message: string; action?: string } | null>(null);
  const [marked, setMarked] = useState(false);
  const runs = useRuns(pid).data;
  // An AI split is a Prepare run, and a newer Prepare run replaces the earlier one in the row.
  const latest = r.role === 'exams' ? runs?.find((x) => x.kind === 'prepare') : undefined;
  const run = useRun(latest?.id, !!latest && !TERMINAL_RUN.has(latest.status)).data;
  const task = run?.tasks.find((t) => t.kind === 'resource.split' && t.resourceId === r.id);
  const busy = !!task && !TASK_DONE.has(task.state) && !TERMINAL_RUN.has(run!.status);
  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.resources(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); };

  // The toast belongs to the person who watched the split run, so it needs the row to have seen it busy.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) { wasBusy.current = true; return; }
    if (!wasBusy.current || !task || !TASK_DONE.has(task.state)) return;
    wasBusy.current = false;
    refresh();
    void qc.invalidateQueries({ queryKey: qk.runs(pid) });
    if (task.applied) toast(`${r.filename} was split with AI`);
  // Runs when the task stops being busy: `wasBusy` guards it, so the helpers above are left out of the dependencies.
  }, [busy, task?.state]);

  // What the split task did is read from the task, not from how the whole run ended: it replaces the questions before the topic map runs.
  const warning = task ? run?.warnings.find((w) => w.taskId === task.id)?.message : undefined;
  const afterwards = run && (run.status === 'failed' || run.status === 'cancelled');
  let result: string | null = null;
  let kept = false;
  if (task && !busy) {
    if (task.state === 'failed') { kept = true; result = `The split with AI failed, so the file keeps the split it had.${task.error ? ` ${task.error.message}` : ''}`; }
    else if (task.state === 'cancelled') { kept = true; result = 'The split with AI was cancelled, so the file keeps the split it had.'; }
    else if (task.state === 'succeeded' && task.applied === false) { kept = true; result = `${warning ?? `The AI split of ${r.filename} was not applied.`} The file keeps the split it had.`; }
    else if (task.state === 'succeeded' && task.applied && afterwards) result = `The new split was saved, but the run ${run.status === 'failed' ? 'failed' : 'was cancelled'} afterwards, so the topics may not use it yet.`;
  }

  const split = useMutation({
    mutationFn: () => api('POST /api/resources/:rid/split', { params: { rid: r.id } }),
    onMutate: () => setRefused(null),
    // Stays pending until the new run is in the cache, so the row never offers the split again in between.
    onSuccess: (started) => Promise.all([
      qc.invalidateQueries({ queryKey: qk.runs(pid) }), qc.invalidateQueries({ queryKey: qk.project(pid) }),
      qc.prefetchQuery({ queryKey: qk.run(started.id), queryFn: () => api('GET /api/runs/:runId', { params: { runId: started.id } }), staleTime: 0 }),
    ]),
    onError: (e) => { const d = describeError(e); setRefused({ message: d.message, action: d.action }); },
  });
  const role = useMutation({
    // Theory is the one role whose questions do not count for exam frequency, practice or classification, and going back to Exams counts them again.
    mutationFn: (to: Resource['role']) => api('PATCH /api/resources/:rid', { params: { rid: r.id }, body: { role: to } }),
    onSuccess: (_d, to) => { setMarked(to === 'theory'); setRefused(null); refresh(); },
    onError: (e) => toast(describeError(e).message, { tone: 'danger' }),
  });

  if (busy) {
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
  if (marked && r.role === 'theory') {
    return (
      <div className="so-warn so-warn--note" role="status">
        <Icon name="info" />
        <div className="so-warn__body">
          <span className="so-warn__title">Marked as not an exam</span>
          <span className="ui-muted">The role is now Theory, so the questions of this file no longer count as exam questions and the file is used as source material for the topics. <button type="button" className="ui-btn ui-btn--link" onClick={() => role.mutate('exams')} disabled={role.isPending}>Undo</button></span>
        </div>
      </div>
    );
  }
  const found = r.splitWarning && r.splitSessions !== null && r.splitQuestions !== null;
  if (!found && !result) return null;

  return (
    <div className={`so-warn${found ? '' : ' so-warn--note'}`} role="alert">
      <Icon name={found ? 'alert' : 'info'} />
      <div className="so-warn__body">
        <span className="so-warn__title">{found ? `${plural(r.splitSessions!, 'session')} and ${plural(r.splitQuestions!, 'question')} found in ${r.filename}` : `Split of ${r.filename} with AI`}</span>
        {found && <span className="ui-muted">{WHY[r.splitWarning!]}</span>}
        {result && <span className="so-warn__result">{result} <Link to={`/books/${pid}/run`}>Open run</Link></span>}
        {refused && <span className="so-warn__result">{refused.message}{refused.action ? ` ${refused.action}` : ''} <Link to={`/books/${pid}/run`}>Open run</Link></span>}
        {(found || kept) && (
          <div className="so-warn__actions">
            <button type="button" className="ui-btn ui-btn--sm ui-btn--accent" onClick={() => split.mutate()} disabled={split.isPending || role.isPending}><Icon name="sparkle" size={14} />{kept || refused ? 'Try again' : 'Split with AI'}</button>
            {found && <button type="button" className="ui-btn ui-btn--sm" onClick={() => role.mutate('theory')} disabled={split.isPending || role.isPending}>Mark as not an exam</button>}
          </div>
        )}
      </div>
    </div>
  );
}
