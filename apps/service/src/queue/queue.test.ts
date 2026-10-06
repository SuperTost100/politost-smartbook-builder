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
