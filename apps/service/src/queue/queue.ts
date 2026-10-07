// Durable dependency-based task queue on SQLite.
//
// Guarantees:
//  - A task's result is committed in the same transaction that marks it succeeded.
//  - Dependents only start after every dependency succeeded (or was skipped).
//  - After a crash, tasks that were running are marked interrupted and requeued.
//  - Handlers must be idempotent with respect to their own committed side effects:
//    they check what already exists (by key or hash) before calling a provider again.
import { hostname } from 'node:os';
import type { RunStatus, RunSummary, TaskRow, TaskState } from '@smartbuilder/domain';
import { type Db, json, newId, now } from '../db/db.ts';
import type { Events } from '../events.ts';

/**
 * 'later' is not a problem: the task is only waiting for other work (a barrier). It retries in a few seconds,
 * does not consume attempts and shows no wait reason.
 */
export type ErrorKind = 'temporary' | 'quota' | 'auth' | 'input' | 'fatal' | 'later';

const LATER_MS = 10_000;

/** Throw from a handler to control retry behaviour. */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind = 'temporary',
    /** What the author can do about it, in plain words. */
    readonly action?: string,
    /** For quota errors: when to try again. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Throw to park the task until the author resolves it. */
export class WaitForUser extends Error {
  constructor(readonly reason: string, readonly action: string) {
    super(reason);
  }
}

export interface TaskSpec {
  kind: string;
  key: string;
  label: string;
  input?: Record<string, unknown>;
  /** Task ids or keys (same run) this task waits for. */
  deps?: string[];
  /** Concurrency pool, usually the provider name. */
  pool?: string;
  maxAttempts?: number;
}

export interface TaskContext {
  task: { id: string; runId: string; projectId: string; kind: string; key: string; label: string; input: Record<string, unknown>; attempts: number };
  signal: AbortSignal;
  /** Results of dependencies keyed by task key. */
  deps: Record<string, unknown>;
  enqueue(specs: TaskSpec[]): string[];
  progress(message: string, data?: Record<string, unknown>): void;
  setProvider(provider: string): void;
}

export type Handler = (ctx: TaskContext) => Promise<unknown>;

interface TaskRecord {
  id: string; run_id: string; project_id: string; kind: string; key: string; label: string; input: string; state: TaskState;
  pool: string; attempts: number; max_attempts: number; lease_until: number | null; retry_at: number | null;
}

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const TICK_MS = 400;

export class Queue {
  readonly workerId = `${hostname()}:${process.pid}:${Date.now()}`;
  private handlers = new Map<string, Handler>();
  private running = new Map<string, { abort: AbortController; pool: string; runId: string }>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private db: Db,
    private events: Events,
    private poolLimit: (pool: string) => number,
  ) {}

  register(kind: string, handler: Handler) {
    this.handlers.set(kind, handler);
  }

  start() {
    this.recover();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.heartbeat = setInterval(() => this.renewLeases(), HEARTBEAT_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const r of this.running.values()) r.abort.abort(new Error('service stopping'));
  }

  // ---------- runs ----------

  createRun(projectId: string, kind: RunSummary['kind'], specs: TaskSpec[], snapshot: Record<string, unknown> = {}): string {
    const runId = newId();
    this.db.tx(() => {
      this.db.insert('runs', { id: runId, project_id: projectId, kind, status: 'running', snapshot, created_at: now() });
      this.addTasks(runId, projectId, specs);
    });
    this.events.emit('run.state', { status: 'running', kind }, { projectId, runId });
    this.wake();
    return runId;
  }

  /** Adds tasks to a run. Keys already present are ignored, which makes enqueue idempotent. */
  addTasks(runId: string, projectId: string, specs: TaskSpec[]): string[] {
    return this.db.tx(() => {
      const ids: string[] = [];
      for (const s of specs) {
        const existing = this.db.get<{ id: string }>('SELECT id FROM tasks WHERE run_id = ? AND key = ?', runId, s.key);
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        const id = newId();
        this.db.insert('tasks', {
          id, run_id: runId, project_id: projectId, kind: s.kind, key: s.key, label: s.label, input: s.input ?? {},
          state: 'queued', pool: s.pool ?? 'local', max_attempts: s.maxAttempts ?? 3, created_at: now(),
        });
        for (const dep of s.deps ?? []) {
          const depRow = this.db.get<{ id: string }>('SELECT id FROM tasks WHERE run_id = ? AND (id = ? OR key = ?)', runId, dep, dep);
          if (!depRow) throw new Error(`Unknown dependency ${dep} for task ${s.key}`);
          this.db.run('INSERT OR IGNORE INTO task_deps (task_id, dep_id) VALUES (?, ?)', id, depRow.id);
        }
        ids.push(id);
      }
      // A run that had finished becomes active again when new work arrives.
      this.db.run(`UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ? AND status IN ('completed', 'failed')`, runId);
      return ids;
    });
  }

  pause(runId: string) {
    this.setRunStatus(runId, this.countRunning(runId) ? 'pausing' : 'paused');
  }

  resume(runId: string) {
    this.db.run(`UPDATE tasks SET state = 'queued', retry_at = NULL WHERE run_id = ? AND state IN ('interrupted')`, runId);
    this.setRunStatus(runId, 'running');
    this.wake();
  }

  cancel(runId: string) {
    this.db.run(`UPDATE tasks SET state = 'cancelled', finished_at = ? WHERE run_id = ? AND state IN ('queued', 'retry_wait', 'waiting_for_user', 'interrupted')`, now(), runId);
    for (const [taskId, r] of this.running) if (r.runId === runId) r.abort.abort(new Error('cancelled'));
    this.setRunStatus(runId, this.countRunning(runId) ? 'cancelling' : 'cancelled');
  }

  /** Requeue failed (or the given) tasks; succeeded work is kept. */
  retry(runId: string, taskIds?: string[]) {
    this.db.tx(() => {
      const rows = taskIds?.length
        ? taskIds.map((id) => ({ id }))
        : this.db.all<{ id: string }>(`SELECT id FROM tasks WHERE run_id = ? AND state IN ('failed', 'cancelled', 'interrupted')`, runId);
      for (const r of rows) this.db.run(`UPDATE tasks SET state = 'queued', attempts = 0, error = NULL, retry_at = NULL, wait_reason = NULL WHERE id = ? AND state != 'running'`, r.id);
      this.db.run(`UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?`, runId);
    });
    this.events.emit('run.state', { status: 'running' }, { runId, projectId: this.runProject(runId) });
    this.wake();
  }

  /** Resolve a task waiting for the author. continue: gate passes or the task is retried. skip: mark skipped. */
  resolve(taskId: string, decision: 'continue' | 'skip') {
    const t = this.db.get<TaskRecord>('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!t || t.state !== 'waiting_for_user') return;
    if (decision === 'skip') {
      this.finish(t, 'skipped', null, null);
    } else if (t.kind === 'gate') {
      this.finish(t, 'succeeded', { approved: true, at: now() }, null);
    } else {
      this.db.run(`UPDATE tasks SET state = 'queued', wait_reason = NULL, attempts = 0 WHERE id = ?`, taskId);
      this.emitTask(t, 'queued');
    }
    this.db.run(`UPDATE runs SET status = 'running' WHERE id = ? AND status = 'waiting'`, t.run_id);
    this.wake();
  }

  wake() {
    setImmediate(() => void this.tick());
  }

  // ---------- read models ----------

  runSummary(runId: string): RunSummary | null {
    const r = this.db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!r) return null;
    const counts: Partial<Record<TaskState, number>> = {};
    for (const c of this.db.all<{ state: TaskState; n: number }>('SELECT state, COUNT(*) AS n FROM tasks WHERE run_id = ? GROUP BY state', runId)) counts[c.state] = c.n;
    // An author wait (gate, login) comes first; otherwise a provider limit that lifts by itself at retry_at.
    const w = this.db.get<{ id: string; state: TaskState; wait_reason: string; error: string | null; retry_at: number | null }>(
      `SELECT id, state, wait_reason, error, retry_at FROM tasks WHERE run_id = ? AND state IN ('waiting_for_user', 'retry_wait') AND wait_reason IS NOT NULL ORDER BY state DESC LIMIT 1`, runId);
    return {
      id: runId, projectId: r.project_id as string, kind: r.kind as RunSummary['kind'], status: r.status as RunStatus,
      createdAt: r.created_at as string, finishedAt: (r.finished_at as string) ?? null, counts,
      waiting: w ? {
        taskId: w.id, reason: w.wait_reason, action: json<{ action?: string }>(w.error, {}).action ?? '',
        kind: w.state === 'waiting_for_user' ? 'author' : 'quota', retryAt: w.state === 'retry_wait' && w.retry_at ? new Date(w.retry_at).toISOString() : null,
      } : null,
    };
  }

  tasks(runId: string): TaskRow[] {
    return this.db.all('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, rowid', runId).map((t) => ({
      id: t.id as string, runId, kind: t.kind as string, label: t.label as string, state: t.state as TaskState,
      attempts: Number(t.attempts), provider: (t.provider as string) ?? null, error: json(t.error, null),
      waitReason: (t.wait_reason as string) ?? null, startedAt: (t.started_at as string) ?? null, finishedAt: (t.finished_at as string) ?? null,
    }));
  }

  // ---------- engine ----------

  private recover() {
    this.db.tx(() => {
      const lost = this.db.all<TaskRecord>(`SELECT * FROM tasks WHERE state = 'running'`);
      for (const t of lost) {
        this.db.run(`UPDATE tasks SET state = 'interrupted', lease_owner = NULL, lease_until = NULL WHERE id = ?`, t.id);
        this.events.emit('task.state', { state: 'interrupted', label: t.label }, { projectId: t.project_id, runId: t.run_id, taskId: t.id });
      }
      // Interrupted tasks of active runs run again; their handlers skip work that was already committed.
      this.db.run(`UPDATE tasks SET state = 'queued' WHERE state = 'interrupted' AND run_id IN (SELECT id FROM runs WHERE status IN ('running', 'waiting'))`);
      this.db.run(`UPDATE runs SET status = 'paused' WHERE status = 'pausing'`);
      this.db.run(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status = 'cancelling'`, now());
    });
  }

  private renewLeases() {
    const until = Date.now() + LEASE_MS;
    for (const id of this.running.keys()) this.db.run('UPDATE tasks SET lease_until = ? WHERE id = ? AND lease_owner = ?', until, id, this.workerId);
  }

  private countRunning(runId: string) {
    return [...this.running.values()].filter((r) => r.runId === runId).length;
  }

  private runProject(runId: string) {
    return (this.db.get<{ project_id: string }>('SELECT project_id FROM runs WHERE id = ?', runId)?.project_id) ?? null;
  }

  private setRunStatus(runId: string, status: RunStatus) {
    const finished = ['completed', 'failed', 'cancelled'].includes(status) ? now() : null;
    this.db.run('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?', status, finished, runId);
    this.events.emit('run.state', { status }, { runId, projectId: this.runProject(runId) });
  }

  private poolBusy(pool: string) {
    let n = 0;
    for (const r of this.running.values()) if (r.pool === pool) n++;
    return n;
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const t = Date.now();
      this.db.run(`UPDATE tasks SET state = 'queued' WHERE state = 'retry_wait' AND retry_at <= ?`, t);
      const candidates = this.db.all<TaskRecord>(`
        SELECT t.* FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE t.state = 'queued' AND r.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.dep_id
            WHERE d.task_id = t.id AND dt.state NOT IN ('succeeded', 'skipped'))
        ORDER BY r.created_at, t.created_at, t.rowid LIMIT 200`);
      for (const c of candidates) {
        if (this.running.has(c.id)) continue;
        if (this.poolBusy(c.pool) >= this.poolLimit(c.pool)) continue;
        if (this.poolBusy('*') >= 12) break;
        this.claim(c);
      }
      this.settleRuns();
    } finally {
      this.ticking = false;
    }
  }

  private claim(c: TaskRecord) {
    const claimed = this.db.run(
      `UPDATE tasks SET state = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1, started_at = ?, wait_reason = NULL WHERE id = ? AND state = 'queued'`,
      this.workerId, Date.now() + LEASE_MS, now(), c.id,
    );
    if (claimed.changes !== 1) return;
    const abort = new AbortController();
    this.running.set(c.id, { abort, pool: c.pool, runId: c.run_id });
    this.emitTask(c, 'running');
    void this.execute({ ...c, attempts: c.attempts + 1 }, abort);
  }

  private async execute(t: TaskRecord, abort: AbortController) {
    const handler = this.handlers.get(t.kind);
    const deps: Record<string, unknown> = {};
    for (const d of this.db.all<{ key: string; result: string | null }>(
      'SELECT dt.key, dt.result FROM task_deps d JOIN tasks dt ON dt.id = d.dep_id WHERE d.task_id = ?', t.id)) deps[d.key] = json(d.result, null);
    const ctx: TaskContext = {
      task: { id: t.id, runId: t.run_id, projectId: t.project_id, kind: t.kind, key: t.key, label: t.label, input: json(t.input, {}), attempts: t.attempts },
      signal: abort.signal,
      deps,
      enqueue: (specs) => this.addTasks(t.run_id, t.project_id, specs),
      progress: (message, data = {}) => this.events.emit('task.progress', { message, label: t.label, ...data }, { projectId: t.project_id, runId: t.run_id, taskId: t.id }),
      setProvider: (provider) => this.db.run('UPDATE tasks SET provider = ? WHERE id = ?', provider, t.id),
    };
    try {
      if (!handler) throw new TaskError(`No handler for task kind "${t.kind}"`, 'fatal');
      const result = await handler(ctx);
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error('cancelled');
      this.finish(t, 'succeeded', result ?? null, null);
    } catch (err) {
      this.fail(t, err, abort.signal.aborted);
    } finally {
      this.running.delete(t.id);
      this.wake();
    }
  }

  private fail(t: TaskRecord, err: unknown, aborted: boolean) {
    const run = this.db.get<{ status: RunStatus }>('SELECT status FROM runs WHERE id = ?', t.run_id);
    if (aborted && (run?.status === 'cancelling' || run?.status === 'cancelled')) {
      this.finish(t, 'cancelled', null, { message: 'Cancelled' });
      return;
    }
    if (aborted) {
      // Service shutdown: leave it for recovery.
      this.db.run(`UPDATE tasks SET state = 'interrupted', lease_owner = NULL WHERE id = ?`, t.id);
      return;
    }
    if (err instanceof WaitForUser) {
      this.db.run(`UPDATE tasks SET state = 'waiting_for_user', wait_reason = ?, error = ?, lease_owner = NULL WHERE id = ?`,
        err.reason, JSON.stringify({ message: err.reason, action: err.action }), t.id);
      this.emitTask(t, 'waiting_for_user', { reason: err.reason, action: err.action });
      return;
    }
    const te = err instanceof TaskError ? err : new TaskError(err instanceof Error ? err.message : String(err), 'temporary');
    if (te.kind === 'later') {
      const at = Date.now() + (te.retryAfterMs ?? LATER_MS);
      this.db.run(`UPDATE tasks SET state = 'retry_wait', retry_at = ?, attempts = attempts - 1, wait_reason = NULL, error = NULL, lease_owner = NULL WHERE id = ?`, at, t.id);
      this.emitTask(t, 'retry_wait', { retryAt: new Date(at).toISOString() });
      return;
    }
    const body = JSON.stringify({ message: te.message, action: te.action, kind: te.kind });
    if (te.kind === 'auth') {
      this.db.run(`UPDATE tasks SET state = 'waiting_for_user', wait_reason = ?, error = ?, lease_owner = NULL WHERE id = ?`, te.message, body, t.id);
      this.emitTask(t, 'waiting_for_user', { reason: te.message, action: te.action });
      return;
    }
    if (te.kind === 'quota') {
      // Quota waits don't consume attempts.
      const at = Date.now() + (te.retryAfterMs ?? 15 * 60_000);
      this.db.run(`UPDATE tasks SET state = 'retry_wait', retry_at = ?, attempts = attempts - 1, wait_reason = ?, error = ?, lease_owner = NULL WHERE id = ?`,
        at, te.message, body, t.id);
      this.emitTask(t, 'retry_wait', { reason: te.message, retryAt: new Date(at).toISOString() });
      return;
    }
    if (te.kind === 'temporary' && t.attempts < t.max_attempts) {
      const delay = Math.min(5 * 60_000, 2_000 * 2 ** t.attempts) * (0.75 + Math.random() * 0.5);
      this.db.run(`UPDATE tasks SET state = 'retry_wait', retry_at = ?, error = ?, lease_owner = NULL WHERE id = ?`, Date.now() + delay, body, t.id);
      this.emitTask(t, 'retry_wait', { error: te.message });
      return;
    }
    this.finish(t, 'failed', null, { message: te.message, action: te.action });
  }

  private finish(t: TaskRecord, state: TaskState, result: unknown, error: { message: string; action?: string } | null) {
    this.db.run(`UPDATE tasks SET state = ?, result = ?, error = ?, finished_at = ?, lease_owner = NULL, lease_until = NULL WHERE id = ?`,
      state, result === null ? null : JSON.stringify(result), error ? JSON.stringify(error) : null, now(), t.id);
    this.emitTask(t, state, error ? { error: error.message } : {});
  }

  private emitTask(t: Pick<TaskRecord, 'id' | 'run_id' | 'project_id' | 'label' | 'kind'>, state: TaskState, extra: Record<string, unknown> = {}) {
    this.events.emit('task.state', { state, label: t.label, kind: t.kind, ...extra }, { projectId: t.project_id, runId: t.run_id, taskId: t.id });
  }

  /** Derive run status from task states. */
  private settleRuns() {
    const runs = this.db.all<{ id: string; status: RunStatus }>(`SELECT id, status FROM runs WHERE status IN ('running', 'pausing', 'cancelling', 'waiting')`);
    for (const r of runs) {
      const busy = this.countRunning(r.id);
      if (r.status === 'pausing' && !busy) { this.setRunStatus(r.id, 'paused'); continue; }
      if (r.status === 'cancelling' && !busy) { this.setRunStatus(r.id, 'cancelled'); continue; }
      if (r.status !== 'running' && r.status !== 'waiting') continue;
      const c = Object.fromEntries(this.db.all<{ state: TaskState; n: number }>('SELECT state, COUNT(*) AS n FROM tasks WHERE run_id = ? GROUP BY state', r.id).map((x) => [x.state, x.n])) as Partial<Record<TaskState, number>>;
      const active = (c.queued ?? 0) + (c.running ?? 0) + (c.retry_wait ?? 0) + busy;
      const waiting = c.waiting_for_user ?? 0;
      // Work that can still happen without the author: not blocked, however far up the chain, by a failed or cancelled task
      // or by one that waits for the author.
      const runnable = this.countRunnable(r.id, ['waiting_for_user', 'failed', 'cancelled']);
      if (busy || runnable) {
        if (r.status === 'waiting') this.setRunStatus(r.id, 'running');
        continue;
      }
      if (waiting) {
        if (r.status === 'running') this.setRunStatus(r.id, 'waiting');
        continue;
      }
      // Nothing can run and nobody is asked: finished, or stuck behind failures for good.
      this.setRunStatus(r.id, active === 0 && !c.failed ? 'completed' : 'failed');
    }
  }

  /**
   * Queued and retrying tasks that no blocking task stands in the way of, directly or through other tasks.
   * A task is blocked when any task it depends on, at any depth, is in one of the blocking states.
   */
  private countRunnable(runId: string, blocking: TaskState[]): number {
    const marks = blocking.map(() => '?').join(',');
    return this.db.get<{ n: number }>(`
      WITH RECURSIVE blocked(id) AS (
        SELECT d.task_id FROM task_deps d JOIN tasks dt ON dt.id = d.dep_id WHERE dt.run_id = ? AND dt.state IN (${marks})
        UNION
        SELECT d.task_id FROM task_deps d JOIN blocked b ON d.dep_id = b.id
      )
      SELECT COUNT(*) AS n FROM tasks t WHERE t.run_id = ? AND t.state IN ('queued', 'retry_wait') AND t.id NOT IN (SELECT id FROM blocked)`,
    runId, ...blocking, runId)?.n ?? 0;
  }
}
