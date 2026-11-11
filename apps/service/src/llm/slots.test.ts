import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderSlots } from './slots.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('never more calls than the provider limit, oldest waiter first, other providers independent', async () => {
  const slots = new ProviderSlots((p) => (p === 'codex' ? 2 : 1));
  const order: string[] = [];
  const r1 = await slots.acquire('codex');
  const r2 = await slots.acquire('codex');
  const claude = await slots.acquire('claude');
  const third = slots.acquire('codex').then((r) => { order.push('third'); return r; });
  const fourth = slots.acquire('codex').then((r) => { order.push('fourth'); return r; });
  await tick();
  assert.deepEqual(order, []);
  r1();
  const r3 = await third;
  await tick();
  assert.deepEqual(order, ['third']);
  r1(); // a second release of the same slot changes nothing
  await tick();
  assert.deepEqual(order, ['third']);
  r2();
  await fourth;
  assert.deepEqual(order, ['third', 'fourth']);
  r3();
  claude();
});

test('a waiting call that aborts leaves the queue without taking a slot', async () => {
  const slots = new ProviderSlots(() => 1);
  const held = await slots.acquire('codex');
  const abort = new AbortController();
  const waiting = slots.acquire('codex', abort.signal);
  const reason = new Error('cancelled');
  abort.abort(reason);
  await assert.rejects(waiting, (e) => e === reason);
  await assert.rejects(slots.acquire('codex', abort.signal), (e) => e === reason);
  const next = slots.acquire('codex');
  held();
  (await next)();
});

test('a limit raised while a call waits lets it start on the next acquire', async () => {
  let limit = 1;
  const slots = new ProviderSlots(() => limit);
  const first = await slots.acquire('codex');
  let started = false;
  const second = slots.acquire('codex').then((r) => { started = true; return r; });
  await tick();
  assert.equal(started, false);
  limit = 2;
  const third = slots.acquire('codex');
  await tick();
  assert.equal(started, true, 'the waiter started first');
  first();
  (await third)();
  (await second)();
});
