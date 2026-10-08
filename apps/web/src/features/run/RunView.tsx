import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RunSummary, TaskRow, TaskState } from '@smartbuilder/domain';
import { api, describeError } from '../../lib/api';
import { qk, useProject, useRun, useRuns } from '../../lib/queries';
import { RUN_KIND_LABEL, TASK_STATE_LABEL, TERMINAL_RUN, dateTime, runCounts, timeAgo, tokenCount } from '../../lib/format';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import './run.css';

const STATE_ORDER: TaskState[] = ['waiting_for_user', 'running', 'retry_wait', 'queued', 'failed', 'interrupted', 'succeeded', 'skipped', 'cancelled'];
const STATE_TONE: Record<TaskState, string> = {
  waiting_for_user: 'warning', running: 'primary', retry_wait: 'warning', queued: '', failed: 'danger', interrupted: 'danger',
  succeeded: 'success', skipped: '', cancelled: '',
};

const STATUS_LABEL: Record<RunSummary['status'], string> = {
  running: 'Running', pausing: 'Pausing', paused: 'Paused', cancelling: 'Cancelling', cancelled: 'Cancelled',
  completed: 'Completed', failed: 'Failed', waiting: 'Waiting for you',
};
const STATUS_TONE: Record<RunSummary['status'], string> = {
  running: 'primary', pausing: 'warning', paused: 'warning', cancelling: 'warning', cancelled: '', completed: 'success', failed: 'danger', waiting: 'warning',
};

/** "Waiting for <provider> quota — resumes at <local time>" */
function quotaTitle(waiting: NonNullable<RunSummary['waiting']>, tasks: TaskRow[] | undefined): string {
  const provider = tasks?.find((t) => t.id === waiting.taskId)?.provider ?? 'provider';
  const at = waiting.retryAt ? new Date(waiting.retryAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
  return when ? `Waiting for ${provider} quota — resumes at ${when}` : `Waiting for ${provider} quota — resumes when the limit resets`;
}

export function RunView({ projectId }: { projectId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const runs = useRuns(projectId);
  const project = useProject(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const list = useMemo(() => [...(runs.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [runs.data]);
  const activeId = list.find((r) => !TERMINAL_RUN.has(r.status))?.id;
  const selectedId = picked ?? activeId ?? list[0]?.id;
  const summary = list.find((r) => r.id === selectedId);
  const live = !!summary && !TERMINAL_RUN.has(summary.status);
  const detail = useRun(selectedId, live);
  const run = detail.data ?? summary;

  useEffect(() => { if (picked && !list.some((r) => r.id === picked)) setPicked(null); }, [list, picked]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.runs(projectId) });
    if (selectedId) void qc.invalidateQueries({ queryKey: qk.run(selectedId) });
    void qc.invalidateQueries({ queryKey: qk.project(projectId) });
  };
  const fail = (e: unknown) => { const d = describeError(e); toast(`${d.message}${d.action ? ` ${d.action}` : ''}`, { tone: 'danger' }); };

  const control = useMutation({
    mutationFn: async (a: 'pause' | 'resume' | 'cancel' | 'retry') => {
      if (!selectedId) return;
      const params = { runId: selectedId };
      if (a === 'pause') await api('POST /api/runs/:runId/pause', { params });
      if (a === 'resume') await api('POST /api/runs/:runId/resume', { params });
      if (a === 'cancel') await api('POST /api/runs/:runId/cancel', { params });
      if (a === 'retry') await api('POST /api/runs/:runId/retry', { params, body: {} });
    },
    onSuccess: (_d, a) => {
      toast({ pause: 'Pausing the run', resume: 'Run resumed', cancel: 'Cancelling the run', retry: 'Retrying failed tasks' }[a]);
      refresh();
    },
    onError: fail,
  });
  const retryTask = useMutation({
    mutationFn: (taskId: string) => api('POST /api/runs/:runId/retry', { params: { runId: selectedId! }, body: { taskIds: [taskId] } }),
    onSuccess: () => { toast('Retrying task'); refresh(); },
    onError: fail,
  });
  const resolve = useMutation({
    mutationFn: (v: { taskId: string; decision: 'continue' | 'skip' }) => api('POST /api/tasks/:taskId/resolve', { params: { taskId: v.taskId }, body: { decision: v.decision } }),
    onSuccess: (_d, v) => { toast(v.decision === 'continue' ? 'Continuing' : 'Skipped'); refresh(); },
    onError: fail,
  });
  const start = useMutation({
    mutationFn: (kind: RunSummary['kind']) => api('POST /api/projects/:id/runs', { params: { id: projectId }, body: { kind } }),
    onSuccess: (r) => { toast(`${RUN_KIND_LABEL[r.kind]} started`); setPicked(r.id); refresh(); },
    onError: fail,
  });

  const tasks = detail.data?.tasks ?? [];
  const grouped = useMemo(() => {
    const m = new Map<TaskState, TaskRow[]>();
    for (const t of tasks) m.set(t.state, [...(m.get(t.state) ?? []), t]);
    return STATE_ORDER.filter((s) => m.has(s)).map((s) => ({ state: s, tasks: m.get(s)! }));
  }, [tasks]);

  if (runs.isLoading) return <div className="rn-root"><div className="ui-skeleton" style={{ height: 120 }} /></div>;

  const canGenerate = !!project.data?.outlineRevId && !live;

  if (!run) {
    return (
      <div className="rn-root">
        <div className="ui-empty">
          <p className="ui-empty__text">No runs yet. A run reads your sources, plans the outline or drafts the book, and keeps going while this window is closed.</p>
          <div className="ui-row">
            <button type="button" className="ui-btn ui-btn--accent" disabled={start.isPending} onClick={() => start.mutate('prepare')}>Prepare sources</button>
            {canGenerate && <button type="button" className="ui-btn" onClick={() => start.mutate('generate')}>Generate book</button>}
          </div>
        </div>
      </div>
    );
  }

  const c = runCounts(run);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const runningNow = run.counts.running ?? 0;
  const failedTasks = (run.counts.failed ?? 0) + (run.counts.interrupted ?? 0);
  const waiting = run.waiting;

  return (
    <div className="rn-root">
      <section className="rn-head" aria-label="Current run">
        <div className="rn-head__top">
          <div>
            <div className="ui-meta">{run.id.slice(0, 8)} · started {timeAgo(run.createdAt)}</div>
            <h2 className="ui-panel-title">{RUN_KIND_LABEL[run.kind]}</h2>
          </div>
          <span className={`ui-badge ui-badge--${STATUS_TONE[run.status] || 'neutral'}`}>{run.status === 'waiting' && run.waiting?.kind === 'quota' ? 'Waiting for quota' : STATUS_LABEL[run.status]}</span>
        </div>
        <div className="rn-bar" role="progressbar" aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={c.done} aria-label="Tasks finished">
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="ui-muted">{c.done} of {c.total} tasks finished{runningNow ? `, ${runningNow} running` : ''}{failedTasks ? `, ${failedTasks} failed` : ''}.</p>

        <div className="ui-row">
          {run.status === 'running' && <button type="button" className="ui-btn" onClick={() => control.mutate('pause')} disabled={control.isPending}><Icon name="pause" />Pause</button>}
          {run.status === 'pausing' && <button type="button" className="ui-btn" disabled><span className="ui-spinner" />Pausing…</button>}
          {run.status === 'paused' && <button type="button" className="ui-btn ui-btn--accent" onClick={() => control.mutate('resume')} disabled={control.isPending}><Icon name="play" />Resume</button>}
          {run.status === 'cancelling' && <button type="button" className="ui-btn" disabled><span className="ui-spinner" />Cancelling…</button>}
          {live && run.status !== 'cancelling' && <button type="button" className="ui-btn ui-btn--danger" onClick={() => setConfirmCancel(true)}>Cancel</button>}
          {failedTasks > 0 && <button type="button" className="ui-btn" onClick={() => control.mutate('retry')} disabled={control.isPending}><Icon name="refresh" />Retry failed</button>}
          {!live && canGenerate && <button type="button" className="ui-btn ui-btn--accent" onClick={() => start.mutate('generate')}>Generate book</button>}
        </div>
        {run.status === 'pausing' && <p className="rn-note" aria-live="polite">Pausing: {runningNow} running {runningNow === 1 ? 'task is' : 'tasks are'} finishing. Nothing new starts, and the run shows Paused when they are done.</p>}
        {run.status === 'paused' && <p className="rn-note">Paused. Resume continues with the queued tasks; finished work is kept.</p>}
        {run.status === 'running' && <p className="rn-note">Pause lets running tasks finish and starts nothing new. Cancel drops queued tasks and keeps finished work.</p>}
      </section>

      {waiting && waiting.kind === 'author' && (
        <section className="rn-waiting" aria-label="Waiting for you">
          <div className="ui-meta">Waiting for you</div>
          <h3 className="ui-panel-title">{waiting.action}</h3>
          <p>{waiting.reason}</p>
          <div className="ui-row">
            <button type="button" className="ui-btn ui-btn--accent" disabled={resolve.isPending} onClick={() => resolve.mutate({ taskId: waiting.taskId, decision: 'continue' })}>Continue</button>
            <button type="button" className="ui-btn" disabled={resolve.isPending} onClick={() => resolve.mutate({ taskId: waiting.taskId, decision: 'skip' })}>Skip</button>
          </div>
          <p className="rn-note">Continue lets the run go on. Skip leaves this step out and goes on without it.</p>
        </section>
      )}
      {waiting && waiting.kind === 'quota' && (
        <section className="rn-waiting" aria-label="Waiting for provider quota">
          <div className="ui-meta">Waiting for quota</div>
          <h3 className="ui-panel-title">{quotaTitle(waiting, detail.data?.tasks)}</h3>
          <p>{waiting.reason}</p>
          <p className="rn-note">Nothing to do: the run goes on by itself when the limit resets. It does not use up retries.</p>
        </section>
      )}

      <section aria-label="Tasks" className="rn-section">
        <h3 className="ui-panel-title">Tasks</h3>
        {detail.isLoading && <div className="ui-skeleton" style={{ height: 80 }} />}
        {!detail.isLoading && grouped.length === 0 && <p className="ui-muted">No tasks yet.</p>}
        {grouped.map((g) => (
          <details key={g.state} className="rn-group" open={g.state !== 'succeeded' && g.state !== 'skipped' && g.state !== 'cancelled'}>
            <summary>
              <span className={`ui-badge ui-badge--${STATE_TONE[g.state] || 'neutral'}`}>{TASK_STATE_LABEL[g.state]}</span>
              <span className="ui-muted">{g.tasks.length}</span>
            </summary>
            <ul className="rn-tasks">
              {g.tasks.slice(0, 200).map((t) => (
                <li key={t.id} className="rn-task">
                  <div className="rn-task__main">
                    <span className="ui-wrap">{t.label}</span>
                    <span className="ui-muted rn-task__meta">
                      {t.provider && <span className="ui-mono">{t.provider}</span>}
                      {t.attempts > 0 && <span>attempt {t.attempts}</span>}
                      {t.waitReason && <span>{t.waitReason}</span>}
                    </span>
                    {t.error && (
                      <span className="rn-task__error">{t.error.message}{t.error.action ? ` ${t.error.action}` : ''}</span>
                    )}
                  </div>
                  {(t.state === 'failed' || t.state === 'interrupted') && (
                    <button type="button" className="ui-btn ui-btn--sm" onClick={() => retryTask.mutate(t.id)} disabled={retryTask.isPending}>Retry</button>
                  )}
                </li>
              ))}
            </ul>
            {g.tasks.length > 200 && <p className="ui-muted">Showing 200 of {g.tasks.length}.</p>}
          </details>
        ))}
      </section>

      <section aria-label="Usage" className="rn-section">
        <h3 className="ui-panel-title">Usage</h3>
        {(detail.data?.usage ?? []).length === 0 ? <p className="ui-muted">No model calls yet.</p> : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead><tr><th>Provider</th><th>Model</th><th>Role</th><th className="ui-num">Calls</th><th className="ui-num">Input tokens</th><th className="ui-num">Output tokens</th></tr></thead>
              <tbody>
                {detail.data!.usage.map((u, i) => (
                  <tr key={i}>
                    <td className="ui-mono">{u.provider}</td><td className="ui-mono">{u.model}</td><td>{u.role}</td>
                    <td className="ui-num">{u.calls}</td>
                    <td className={`ui-num${u.inputTokens === null ? ' ui-muted' : ''}`}>{tokenCount(u.inputTokens)}</td>
                    <td className={`ui-num${u.outputTokens === null ? ' ui-muted' : ''}`}>{tokenCount(u.outputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Past runs" className="rn-section">
        <h3 className="ui-panel-title">Runs</h3>
        <ul className="rn-runs">
          {list.map((r) => (
            <li key={r.id}>
              <button type="button" className="rn-run" aria-current={r.id === selectedId} onClick={() => setPicked(r.id)}>
                <span>{RUN_KIND_LABEL[r.kind]}</span>
                <span className={`ui-badge ui-badge--${STATUS_TONE[r.status] || 'neutral'}`}>{STATUS_LABEL[r.status]}</span>
                <span className="ui-muted rn-run__time">{dateTime(r.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this run"
        message="Queued tasks are dropped and running tasks are asked to stop. Text already written is kept. You can start a new run afterwards."
        confirmLabel="Cancel run"
        danger
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => { setConfirmCancel(false); control.mutate('cancel'); }}
      />
    </div>
  );
}
