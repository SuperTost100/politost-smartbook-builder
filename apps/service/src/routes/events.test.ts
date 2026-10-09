import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './testkit.ts';

let t: TestApp;
let base: string;
before(async () => {
  t = await startApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
});
after(async () => { await t.close(); });

/** Reads an SSE stream until `until(text)` is true or the timeout hits, then aborts. */
async function readSse(url: string, headers: Record<string, string>, until: (text: string) => boolean, onOpen?: () => void) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  const res = await fetch(url, { headers, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  onOpen?.();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!until(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return text;
}

const ids = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

describe('GET /api/events', () => {
  it('replays events after Last-Event-ID, then continues live, without duplicates', async () => {
    const e1 = t.ctx.events.emit('log', { n: 1 }, { projectId: 'p1' });
    const e2 = t.ctx.events.emit('log', { n: 2 }, { projectId: 'p1' });
    const e3 = t.ctx.events.emit('log', { n: 3 }, { projectId: 'p1' });
    let live = 0;
    const text = await readSse(`${base}/api/events`, { 'last-event-id': String(e1.seq) }, (s) => ids(s).length >= 3, () => {
      setTimeout(() => { live = t.ctx.events.emit('log', { n: 4 }, { projectId: 'p1' }).seq; }, 50);
    });
    assert.deepEqual(ids(text), [e2.seq, e3.seq, live]);
    const first = JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
    assert.equal(first.type, 'log');
    assert.deepEqual(first.data, { n: 2 });
  });

  it('accepts ?since= and filters by projectId (global events pass)', async () => {
    const a = t.ctx.events.emit('log', { who: 'a' }, { projectId: 'pa' });
    t.ctx.events.emit('log', { who: 'b' }, { projectId: 'pb' });
    const g = t.ctx.events.emit('log', { who: 'global' });
    const text = await readSse(`${base}/api/events?projectId=pa&since=${a.seq - 1}`, {}, (s) => ids(s).length >= 2);
    assert.deepEqual(ids(text), [a.seq, g.seq]);
    assert.ok(!text.includes('"who":"b"'));
  });

  it('starts live only without a resume point', async () => {
    t.ctx.events.emit('log', { old: true });
    let live = 0;
    const text = await readSse(`${base}/api/events`, {}, (s) => ids(s).length >= 1, () => {
      setTimeout(() => { live = t.ctx.events.emit('log', { fresh: true }).seq; }, 50);
    });
    assert.deepEqual(ids(text), [live]);
  });
});

describe('shutdown', () => {
  it('closes while a browser keeps the event stream open', async () => {
    const own = await startApp();
    await own.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(own.app.server.address() as { port: number }).port}/api/events`;
    const res = await fetch(url);
    const reader = res.body!.getReader();
    await reader.read();
    const closed = await Promise.race([own.close().then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.equal(closed, true, 'app.close() waited for the open stream');
    assert.equal((await reader.read()).done, true);
  });
});
