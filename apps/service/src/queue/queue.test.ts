import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, newId, now } from '../db/db.ts';
import { Events } from '../events.ts';
import { Queue, TaskError, WaitForUser } from './queue.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sbq-'));
  const file = join(dir, 'db.sqlite');
  const db = new Db(file);
  const projectId = newId();
  db.insert('projects', { id: projectId, slug: 'p', title: 'P', subject: 'S', created_at: now(), updated_at: now() });
  const events = new Events(db);
  const queue = new Queue(db, events, () => 2);
  return { db, events, queue, projectId, file };
}

async function until(fn: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('runs dependencies in order and passes results', async () => {
  const { queue, projectId } = setup();
  const order: string[] = [];
  queue.register('a', async (t) => { order.push(t.task.key); return { value: t.task.key }; });
  queue.register('b', async (t) => { order.push(t.task.key); return { got: t.deps }; });
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'a', key: 'one', label: 'one' },
    { kind: 'a', key: 'two', label: 'two' },
    { kind: 'b', key: 'join', label: 'join', deps: ['one', 'two'] },
  ]);
  queue.start();
  await until(() => queue.runSummary(runId)!.status === 'completed');
  await queue.stop();
  assert.equal(order.at(-1), 'join');
  const join = queue.tasks(runId).find((t) => t.kind === 'b')!;
  assert.equal(join.state, 'succeeded');
});

test('retries temporary failures, then fails; quota waits keep attempts', async () => {
  const { queue, projectId, db } = setup();
  let calls = 0;
  queue.register('flaky', async () => { calls++; throw new TaskError('boom', 'temporary'); });
  queue.register('quota', async () => { throw new TaskError('limit', 'quota', undefined, 60_000); });
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'flaky', key: 'f', label: 'f', maxAttempts: 2 },
    { kind: 'quota', key: 'q', label: 'q' },
  ]);
  // Make backoff immediate for the test.
  const tick = setInterval(() => db.run(`UPDATE tasks SET retry_at = 0 WHERE key = 'f' AND state = 'retry_wait'`), 10);
  queue.start();
  await until(() => queue.tasks(runId).find((t) => t.kind === 'flaky')!.state === 'failed');
  await until(() => queue.tasks(runId).find((t) => t.kind === 'quota')!.state === 'retry_wait');
  clearInterval(tick);
  await queue.stop();
  assert.equal(calls, 2);
  const q = queue.tasks(runId).find((t) => t.kind === 'quota')!;
  assert.equal(q.attempts, 0);
  assert.equal(q.waitReason, 'limit');
});

test('gates wait for the author and dependents start after continue', async () => {
  const { queue, projectId } = setup();
  queue.register('gate', async () => { throw new WaitForUser('Review chapter 1', 'Press Continue'); });
  queue.register('work', async () => 'done');
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'gate', key: 'g', label: 'gate' },
    { kind: 'work', key: 'w', label: 'after gate', deps: ['g'] },
  ]);
  queue.start();
  await until(() => queue.runSummary(runId)!.status === 'waiting');
  assert.equal(queue.runSummary(runId)!.waiting?.reason, 'Review chapter 1');
  const gateId = queue.tasks(runId).find((t) => t.kind === 'gate')!.id;
  queue.resolve(gateId, 'continue');
  await until(() => queue.runSummary(runId)!.status === 'completed');
  await queue.stop();
});

test('a crash mid-task requeues the task on restart without repeating finished work', async () => {
  const { db, events, queue, projectId } = setup();
  let firstRuns = 0;
  queue.register('first', async () => { firstRuns++; return 1; });
  queue.register('slow', () => new Promise(() => {}));
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'first', key: 'a', label: 'a' },
    { kind: 'slow', key: 'b', label: 'b', deps: ['a'] },
  ]);
  queue.start();
  await until(() => queue.tasks(runId).find((t) => t.kind === 'slow')!.state === 'running');
  // Simulate a crash: drop the queue object without stopping it cleanly.
  await queue.stop();
  db.run(`UPDATE tasks SET state = 'running' WHERE key = 'b'`);
  const queue2 = new Queue(db, events, () => 2);
  let resumed = false;
  queue2.register('first', async () => { firstRuns++; return 1; });
  queue2.register('slow', async () => { resumed = true; return 2; });
  queue2.start();
  await until(() => queue2.runSummary(runId)!.status === 'completed');
  await queue2.stop();
  assert.equal(firstRuns, 1);
  assert.ok(resumed);
});

test('cancel stops running work and keeps committed results', async () => {
  const { queue, projectId } = setup();
  queue.register('quick', async () => 'ok');
  queue.register('hang', (t) => new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'quick', key: 'q', label: 'q' },
    { kind: 'hang', key: 'h', label: 'h', deps: ['q'] },
    { kind: 'quick', key: 'later', label: 'later', deps: ['h'] },
  ]);
  queue.start();
  await until(() => queue.tasks(runId).find((t) => t.kind === 'hang')!.state === 'running');
  queue.cancel(runId);
  await until(() => queue.runSummary(runId)!.status === 'cancelled');
  await queue.stop();
  const states = Object.fromEntries(queue.tasks(runId).map((t) => [t.label, t.state]));
  assert.deepEqual(states, { q: 'succeeded', h: 'cancelled', later: 'cancelled' });
});

test('pause lets running tasks finish and dispatches nothing new', async () => {
  const { queue, projectId } = setup();
  let release!: () => void;
  queue.register('hold', () => new Promise((r) => { release = () => r('ok'); }));
  queue.register('next', async () => 'ok');
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'hold', key: 'h', label: 'h' },
    { kind: 'next', key: 'n', label: 'n', deps: ['h'] },
  ]);
  queue.start();
  await until(() => queue.tasks(runId).find((t) => t.kind === 'hold')!.state === 'running');
  queue.pause(runId);
  assert.equal(queue.runSummary(runId)!.status, 'pausing');
  release();
  await until(() => queue.runSummary(runId)!.status === 'paused');
  assert.equal(queue.tasks(runId).find((t) => t.kind === 'next')!.state, 'queued');
  queue.resume(runId);
  await until(() => queue.runSummary(runId)!.status === 'completed');
  await queue.stop();
});

test('a failure blocks everything downstream, however deep: A -> B -> C fails the run', async () => {
  const { queue, projectId } = setup();
  queue.register('boom', async () => { throw new TaskError('no', 'fatal'); });
  queue.register('work', async () => 'ok');
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'boom', key: 'a', label: 'a' },
    { kind: 'work', key: 'b', label: 'b', deps: ['a'] },
    { kind: 'work', key: 'c', label: 'c', deps: ['b'] },
  ]);
  queue.start();
  await until(() => queue.runSummary(runId)!.status === 'failed');
  await queue.stop();
  assert.deepEqual(queue.tasks(runId).map((t) => t.state), ['failed', 'queued', 'queued']);
});

test('independent work keeps a run going while a deep chain is blocked by a failure', async () => {
  const { queue, projectId } = setup();
  let release!: () => void;
  queue.register('boom', async () => { throw new TaskError('no', 'fatal'); });
  queue.register('work', async () => 'ok');
  queue.register('hold', () => new Promise((r) => { release = () => r('ok'); }));
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'boom', key: 'a', label: 'a' },
    { kind: 'work', key: 'b', label: 'b', deps: ['a'] },
    { kind: 'work', key: 'c', label: 'c', deps: ['b'] },
    { kind: 'hold', key: 'h', label: 'h' },
  ]);
  queue.start();
  await until(() => queue.tasks(runId).find((t) => t.kind === 'hold')!.state === 'running');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(queue.runSummary(runId)!.status, 'running');
  release();
  await until(() => queue.runSummary(runId)!.status === 'failed');
  await queue.stop();
});

test('a gate waiting two levels up makes the run wait for the author, not run forever', async () => {
  const { queue, projectId } = setup();
  queue.register('gate', async () => { throw new WaitForUser('Review', 'Press Continue'); });
  queue.register('work', async () => 'ok');
  const runId = queue.createRun(projectId, 'generate', [
    { kind: 'gate', key: 'g', label: 'g' },
    { kind: 'work', key: 'b', label: 'b', deps: ['g'] },
    { kind: 'work', key: 'c', label: 'c', deps: ['b'] },
  ]);
  queue.start();
  await until(() => queue.runSummary(runId)!.status === 'waiting');
  const gateId = queue.tasks(runId).find((t) => t.kind === 'gate')!.id;
  queue.resolve(gateId, 'skip');
  await until(() => queue.runSummary(runId)!.status === 'completed');
  await queue.stop();
});

test("'later' retries without consuming attempts and shows no wait reason", async () => {
  const { queue, projectId, db } = setup();
  let calls = 0;
  queue.register('barrier', async () => { calls++; if (calls < 3) throw new TaskError('not yet', 'later'); return 'done'; });
  const runId = queue.createRun(projectId, 'generate', [{ kind: 'barrier', key: 'b', label: 'b', maxAttempts: 1 }]);
  const tick = setInterval(() => db.run(`UPDATE tasks SET retry_at = 0 WHERE state = 'retry_wait'`), 10);
  queue.start();
  await until(() => calls === 1 && queue.tasks(runId)[0].state === 'retry_wait');
  assert.equal(queue.tasks(runId)[0].attempts, 0);
  assert.equal(queue.tasks(runId)[0].waitReason, null);
  assert.equal(queue.runSummary(runId)!.waiting, null);
  await until(() => queue.runSummary(runId)!.status === 'completed');
  clearInterval(tick);
  await queue.stop();
  assert.equal(calls, 3);
});

test('runSummary tells an author wait from a quota wait and gives the retry time', async () => {
  const { queue, projectId, db } = setup();
  const runId = queue.createRun(projectId, 'generate', [{ kind: 'x', key: 'quota', label: 'q' }, { kind: 'x', key: 'gate', label: 'g' }]);
  const at = Date.parse('2030-01-01T10:00:00.000Z');
  // Park the tasks so the queue (not started) and the summary see a stable state.
  db.run(`UPDATE tasks SET state = 'retry_wait', retry_at = ?, wait_reason = 'Usage limit reached' WHERE key = 'quota'`, at);
  assert.deepEqual(queue.runSummary(runId)!.waiting, { taskId: queue.tasks(runId).find((t) => t.state === 'retry_wait')!.id, reason: 'Usage limit reached', action: '', kind: 'quota', retryAt: '2030-01-01T10:00:00.000Z' });

  db.run(`UPDATE tasks SET state = 'waiting_for_user', wait_reason = 'Your review', error = ? WHERE key = 'gate'`, JSON.stringify({ message: 'Your review', action: 'Press Continue' }));
  const w = queue.runSummary(runId)!.waiting!;
  assert.equal(w.kind, 'author', 'an author wait is shown first');
  assert.equal(w.retryAt, null);
  assert.equal(w.action, 'Press Continue');

  // A retry_wait without a reason (plain backoff) is not reported.
  db.run(`UPDATE tasks SET state = 'succeeded' WHERE key = 'gate'`);
  db.run(`UPDATE tasks SET wait_reason = NULL WHERE key = 'quota'`);
  assert.equal(queue.runSummary(runId)!.waiting, null);
});

test('no more than 12 tasks run at once across pools', async () => {
  const { db, projectId } = setup();
  const queue = new Queue(db, new Events(db), () => 10);
  let running = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  queue.register('work', async () => { running++; peak = Math.max(peak, running); await gate; running--; return {}; });
  const tasks = ['a', 'b', 'c'].flatMap((pool) => Array.from({ length: 8 }, (_, i) => ({ kind: 'work', key: `${pool}${i}`, label: `${pool}${i}`, pool })));
  const runId = queue.createRun(projectId, 'generate', tasks);
  queue.start();
  await until(() => running === 12);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(peak, 12);
  release();
  await until(() => queue.runSummary(runId)!.status === 'completed');
  await queue.stop();
});

test("retry ignores task ids from another run", async () => {
  const { queue, projectId } = setup();
  queue.register('ok', async () => ({}));
  const a = queue.createRun(projectId, 'generate', [{ kind: 'ok', key: 'x', label: 'x' }]);
  const b = queue.createRun(projectId, 'generate', [{ kind: 'ok', key: 'y', label: 'y' }]);
  queue.start();
  await until(() => queue.runSummary(a)!.status === 'completed' && queue.runSummary(b)!.status === 'completed');
  const foreign = queue.tasks(b)[0].id;
  queue.retry(a, [foreign]);
  await until(() => queue.runSummary(a)!.status === 'completed');
  await queue.stop();
  assert.equal(queue.tasks(b)[0].state, 'succeeded');
});
