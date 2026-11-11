import assert from 'node:assert/strict';
import { readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FunnelError } from 'cli-funnel';
import { DEFAULT_ROUTES, ROLES, type Role } from '@smartbuilder/domain';
import { z } from 'zod';
import { TaskError } from '../queue/queue.ts';
import { setNlmRunner } from '../evidence/nlm.ts';
import { callTimeoutMs, classifyError, FollowUpError, getConnections, llmTuning, openRole, parseRetryAfter, probeRole, resetConnectionsCache, resetLlmState, runRole, setFunnel, withRole } from './index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from './testkit.ts';

const schema = z.object({ kind: z.enum(['a', 'b']), note: z.string().optional() });
let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
const base = { system: 'sys', prompt: 'the prompt' };

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  kit = makeCtx();
  resetLlmState();
  resetConnectionsCache();
  llmTuning.callTimeoutMs = 10 * 60_000;
});
afterEach(() => {
  setFunnel(null);
  setNlmRunner(null);
  kit.cleanup();
});

const usageRows = () => kit.ctx.db.all<Record<string, unknown>>('SELECT * FROM usage ORDER BY id');

function useRoutes(role: 'bulk' | 'vision' | 'evidence', primary: { provider: string; model: string; effort?: string }, fallback?: { provider: string; model: string; effort?: string }) {
  kit.ctx.saveSettings({ routes: { ...DEFAULT_ROUTES, [role]: { primary, fallback } } });
}

describe('control characters in answers', () => {
  test('every string of a structured answer is cleaned before validation', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'gpt-6-luna' });
    fake.next(() => ({ structured: { kind: 'a', note: '$+\u001finfty$ e $x^{-\u001b[0m\\alpha}$' }, text: '{}', usage: usageOf(1, 1) }));
    const out = await runRole(kit.ctx, { ...base, role: 'bulk', schema });
    assert.equal(out.data.note, '$+\\infty$ e $x^{-\\alpha}$');
  });
});

describe('schema validation and repair', () => {
  test('valid structured answer: one call, schema sent in strict form, access none, scratch cwd', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'gpt-6-luna', effort: 'low' });
    fake.next(() => ({ structured: { kind: 'a', note: null }, text: '{}', usage: usageOf(100, 20) }));
    const out = await runRole(kit.ctx, { ...base, role: 'bulk', schema, projectId: 'p1', runId: 'r1', taskId: 't1' });
    assert.deepEqual(out.data, { kind: 'a' });
    assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 20 });
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.selection.access, 'none');
    assert.equal(call.selection.effort, 'low');
    assert.ok(call.selection.cwd?.endsWith('scratch'));
    const js = call.responseSchema!.schema as { additionalProperties: boolean; required: string[] };
    assert.equal(js.additionalProperties, false);
    assert.deepEqual([...js.required].sort(), ['kind', 'note']);
    const rows = usageRows();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].provider, rows[0].model, rows[0].role, rows[0].input_tokens, rows[0].output_tokens, rows[0].ok, rows[0].project_id, rows[0].task_id], ['codex', 'gpt-6-luna', 'bulk', 100, 20, 1, 'p1', 't1']);
  });

  test('invalid answer triggers exactly one repair call carrying errors and the previous answer', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(
      () => ({ structured: { kind: 'zzz' }, text: '{"kind":"zzz"}', usage: usageOf(10, 5) }),
      () => ({ structured: { kind: 'b' }, text: '{"kind":"b"}', usage: usageOf(12, 6) }),
    );
    const out = await runRole(kit.ctx, { ...base, role: 'bulk', schema });
    assert.equal(out.data.kind, 'b');
    assert.equal(fake.calls.length, 2);
    const repair = fake.calls[1].prompt;
    assert.match(repair, /the prompt/);
    assert.match(repair, /"kind":"zzz"/);
    assert.match(repair, /kind/);
    assert.match(repair, /corrected JSON only/);
    assert.deepEqual(out.usage, { inputTokens: 22, outputTokens: 11 });
    assert.equal(usageRows().length, 2);
  });

  test('a live session gets only the problems for its repair turn, without the images, and is closed afterwards', async () => {
    useRoutes('vision', { provider: 'claude', model: 'm' });
    fake.next(
      () => { fake.live.add('s1'); return { structured: { kind: 'zzz' }, text: '{"kind":"zzz"}', sessionId: 's1' }; },
      () => ({ structured: { kind: 'a' }, text: '{"kind":"a"}', sessionId: 's1' }),
    );
    const out = await runRole(kit.ctx, { ...base, role: 'vision', schema, images: [Buffer.from('png')] });
    assert.equal(out.data.kind, 'a');
    const [first, repair] = fake.calls;
    assert.equal(first.attachments?.length, 1);
    assert.equal(repair.sessionId, 's1');
    assert.equal(repair.attachments, undefined);
    assert.doesNotMatch(repair.prompt, /the prompt|"kind":"zzz"/);
    assert.match(repair.prompt, /kind/);
    assert.match(repair.prompt, /corrected JSON only/);
    assert.deepEqual(fake.closed, ['s1']);
    assert.equal(fake.live.size, 0);
  });

  test('a session that is not live gets the full repair prompt in a new conversation', async () => {
    useRoutes('bulk', { provider: 'antigravity', model: 'm' });
    fake.next(() => ({ text: '{"kind":"zzz"}', sessionId: 'old' }), () => ({ text: '{"kind":"b"}' }));
    const out = await runRole(kit.ctx, { ...base, role: 'bulk', schema });
    assert.equal(out.data.kind, 'b');
    assert.equal(fake.calls[1].sessionId, undefined);
    assert.match(fake.calls[1].prompt, /the prompt/);
  });

  test('the session is closed when the repair turn fails too', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(() => { fake.live.add('s2'); return { text: 'not json', sessionId: 's2' }; }, () => new Error('socket hang up'));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk', schema }), (e: unknown) => e instanceof TaskError && e.kind === 'temporary');
    assert.deepEqual(fake.closed, ['s2']);
  });

  test('still invalid after the repair: TaskError input, and no third call', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(() => ({ text: 'not json at all' }), () => ({ text: '{"kind":"nope"}' }));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk', schema }), (e: unknown) => e instanceof TaskError && e.kind === 'input');
    assert.equal(fake.calls.length, 2);
  });

  test('text answers in a ```json fence are accepted', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(() => ({ text: '```json\n{"kind":"a"}\n```' }));
    const out = await runRole(kit.ctx, { ...base, role: 'bulk', schema });
    assert.equal(out.data.kind, 'a');
    assert.equal(fake.calls.length, 1);
  });

  test('unknown token usage is stored as NULL, never 0', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(() => ({ text: 'hello' }), () => ({ text: 'x', usage: usageOf(0, 0) }));
    const out = await runRole(kit.ctx, { ...base, role: 'bulk' });
    assert.equal(out.text, 'hello');
    assert.deepEqual(out.usage, { inputTokens: null, outputTokens: null });
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    for (const r of usageRows()) {
      assert.equal(r.input_tokens, null);
      assert.equal(r.output_tokens, null);
    }
  });
});

describe('error mapping and fallback', () => {
  test('auth error becomes TaskError(auth) with the sign-in action', async () => {
    useRoutes('bulk', { provider: 'claude', model: 'claude-sonnet-5' }, { provider: 'codex', model: 'm' });
    fake.next(() => new FunnelError('Not logged in', 'not-logged-in'));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk' }), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.kind, 'auth');
      assert.equal(e.action, 'Sign in to Claude Code: run "claude auth login" in a terminal, then press Continue.');
      return true;
    });
    assert.equal(fake.calls.length, 1, 'auth does not fall back');
    assert.equal(usageRows()[0].ok, 0);
  });

  test('quota on the primary goes to the fallback route once', async () => {
    useRoutes('bulk', { provider: 'antigravity', model: 'gemini-3.8-flash' }, { provider: 'codex', model: 'gpt-6-luna', effort: 'low' });
    fake.next(() => Object.assign(new Error("You've hit your usage limit. Try again in 2 hours 5 minutes."), { code: 'cli-failed' }), () => ({ text: 'ok', usage: usageOf(5, 1) }));
    const out = await runRole(kit.ctx, { ...base, role: 'bulk' });
    assert.equal(out.text, 'ok');
    assert.deepEqual(out.route, { provider: 'codex', model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['antigravity', 'codex']);
    assert.deepEqual(usageRows().map((r) => r.ok), [0, 1]);
  });

  test('quota on both routes: TaskError(quota) with the shortest wait the CLIs reported', async () => {
    useRoutes('bulk', { provider: 'claude', model: 'm' }, { provider: 'codex', model: 'm' });
    fake.next(
      () => Object.assign(new Error('Rate limit exceeded. Retry after 3600 seconds'), { code: '429' }),
      () => new Error('Usage limit reached. Try again in 20 minutes.'),
    );
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk' }), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.kind, 'quota');
      assert.equal(e.retryAfterMs, 20 * 60_000);
      return true;
    });
  });

  test('quota without fallback and without a reported time waits 15 minutes', async () => {
    useRoutes('bulk', { provider: 'claude', model: 'm' });
    fake.next(() => new Error('quota exceeded'));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk' }), (e: unknown) => e instanceof TaskError && e.kind === 'quota' && e.retryAfterMs === 15 * 60_000);
  });

  test('a provider in quota cooldown is skipped on the next call when a fallback exists', async () => {
    useRoutes('bulk', { provider: 'claude', model: 'm' }, { provider: 'codex', model: 'm' });
    fake.next(() => new Error('usage limit reached'), () => ({ text: 'one' }), () => ({ text: 'two' }));
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['claude', 'codex', 'codex']);
  });

  test('a limit cli-funnel reports sets the wait from its reset time, beyond the 10-minute cap for parsed messages', async () => {
    useRoutes('bulk', { provider: 'claude', model: 'm' }, { provider: 'codex', model: 'm' });
    const resetAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    fake.next(
      () => Object.assign(new Error('Claude Code failed'), { code: 'cli-failed', limit: { kind: 'rate', resetAt, detail: 'Claude five-hour limit reached.' } }),
      () => ({ text: 'one' }),
      () => ({ text: 'two' }),
    );
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 3600_000;
    try {
      await runRole(kit.ctx, { ...base, role: 'bulk' });
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['claude', 'codex', 'codex'], 'still cooling down two hours later');
  });

  test('a reported limit without a fallback is a quota error with the provider\'s wait', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(() => Object.assign(new Error('failed'), { limit: { kind: 'quota', retryAfterMs: 2 * 86_400_000, detail: 'Weekly limit reached.' } }));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk' }), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.kind, 'quota');
      assert.equal(e.retryAfterMs, 2 * 86_400_000);
      assert.match(e.message, /Weekly limit reached/);
      return true;
    });
  });

  test('an answer that arrives with a limit report is kept, and the next call starts on the fallback', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' }, { provider: 'claude', model: 'm' });
    fake.next(() => ({ text: 'one', limit: { kind: 'rate', retryAfterMs: 3600_000, detail: 'Codex 5-hour window is full.' } }), () => ({ text: 'two' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'bulk' })).text, 'one');
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['codex', 'claude']);
  });

  test('a run that ends early with a limit report is a quota failure and falls back', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' }, { provider: 'claude', model: 'm' });
    fake.next(() => ({ text: '', finishReason: 'error', limit: { kind: 'rate', detail: 'Rate limited.' } }), () => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'bulk' })).text, 'ok');
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['codex', 'claude']);
  });

  test('a full Codex usage window sends the role to its fallback without calling Codex', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' }, { provider: 'claude', model: 'm' });
    fake.usage.codex = { provider: 'codex' as never, primary: { usedPercent: 100, windowMinutes: 300 }, limit: { kind: 'rate', retryAfterMs: 3600_000, detail: 'full' } };
    fake.next(() => ({ text: 'ok' }));
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['claude']);
  });

  test('not installed falls back; crashes and unknown failures are temporary', async () => {
    useRoutes('bulk', { provider: 'agent', model: 'm' }, { provider: 'codex', model: 'm' });
    fake.next(() => new FunnelError('Cursor Agent CLI is not installed.', 'not-installed'), () => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'bulk' })).route.provider, 'codex');
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(() => Object.assign(new Error('Codex app-server exited early.'), { code: 'cli-failed' }));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk' }), (e: unknown) => e instanceof TaskError && e.kind === 'temporary');
  });

  test('timeout aborts the CLI and maps to temporary', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    llmTuning.callTimeoutMs = 30;
    let sawAbort = false;
    fake.next((input) => new Promise((_res, rej) => input.signal!.addEventListener('abort', () => { sawAbort = true; rej(new FunnelError('aborted', 'aborted')); })));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk' }), (e: unknown) => e instanceof TaskError && e.kind === 'temporary' && /Timed out/.test(e.message));
    assert.ok(sawAbort);
  });

  test('a timeout falls back to the next route', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' }, { provider: 'antigravity', model: 'g' });
    llmTuning.callTimeoutMs = 30;
    fake.next((input) => new Promise((_res, rej) => input.signal!.addEventListener('abort', () => rej(new FunnelError('aborted', 'aborted')))), () => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'bulk' })).route.provider, 'antigravity');
  });

  test('a task that timed out on its first route in an earlier run starts on the fallback', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' }, { provider: 'antigravity', model: 'g' });
    kit.ctx.db.run('PRAGMA foreign_keys = OFF');
    const task = (id: string, run: string) => kit.ctx.db.insert('tasks', { id, run_id: run, project_id: 'p', kind: 'chapter.review', label: 'Review', key: 'review:c1', created_at: new Date().toISOString() });
    const usage = (taskId: string, ms: number) => kit.ctx.db.insert('usage', { project_id: 'p', task_id: taskId, provider: 'codex', model: 'm', role: 'bulk', ms, ok: 0, created_at: new Date().toISOString() });
    task('old', 'r1'); task('new', 'r2'); task('other', 'r3');
    kit.ctx.db.run(`UPDATE tasks SET key = 'review:c2' WHERE id = 'other'`);
    // A failure that was not a timeout, or a timeout of another task key, changes nothing.
    usage('old', 5_000); usage('other', llmTuning.callTimeoutMs);
    fake.next(() => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'bulk', taskId: 'new' })).route.provider, 'codex');
    usage('old', llmTuning.callTimeoutMs);
    fake.next(() => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'bulk', taskId: 'new' })).route.provider, 'antigravity');
    // The first route stays as the last resort.
    fake.next(() => Object.assign(new Error("You've hit your usage limit. Try again in 2 hours."), { code: 'cli-failed' }), () => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'bulk', taskId: 'new' })).route.provider, 'codex');
  });

  test('an answer cut off at the output limit falls back to the next route', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' }, { provider: 'antigravity', model: 'g' });
    fake.next(() => ({ text: 'half an ans', finishReason: 'length' }), () => ({ text: 'ok' }));
    const out = await runRole(kit.ctx, { ...base, role: 'bulk' });
    assert.equal(out.route.provider, 'antigravity');
    assert.equal(out.text, 'ok');
  });

  test('an answer cut off at the output limit without a fallback is a temporary error that says so', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    fake.next(() => ({ text: 'half', finishReason: 'length' }));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'bulk' }), (e: unknown) => e instanceof TaskError && e.kind === 'temporary' && /output limit/.test(e.message));
  });

  test('caller abort cancels the CLI and is not wrapped as a TaskError', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'm' });
    const ac = new AbortController();
    fake.next((input) => new Promise((res) => input.signal!.addEventListener('abort', () => res({ finishReason: 'cancelled' }))));
    const p = runRole(kit.ctx, { ...base, role: 'bulk', signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p, (e: unknown) => !(e instanceof TaskError));
  });
});

describe('image routing', () => {
  const png = Buffer.from('fakepng');

  test('primary that cannot read images is skipped for a fallback that can', async () => {
    useRoutes('vision', { provider: 'antigravity', model: 'g' }, { provider: 'codex', model: 'gpt-6-luna' });
    fake.next(() => ({ text: 'page' }));
    const out = await runRole(kit.ctx, { ...base, role: 'vision', images: [png] });
    assert.equal(out.route.provider, 'codex');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].attachments, [{ type: 'image', mediaType: 'image/png', data: png.toString('base64') }]);
  });

  test('no route can read images: TaskError(input) before any call', async () => {
    useRoutes('vision', { provider: 'antigravity', model: 'g' }, { provider: 'agent', model: 'x' });
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'vision', images: [png] }), (e: unknown) => e instanceof TaskError && e.kind === 'input');
    assert.equal(fake.calls.length, 0);
  });

  test('image-capable primary keeps its place; a non-image fallback is not used', async () => {
    useRoutes('vision', { provider: 'claude', model: 'm' }, { provider: 'antigravity', model: 'g' });
    fake.next(() => new Error('rate limit hit'));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'vision', images: [png] }), (e: unknown) => e instanceof TaskError && e.kind === 'quota');
    assert.equal(fake.calls.length, 1);
  });

  test('explicit route override has no fallback', async () => {
    fake.next(() => ({ text: 'x' }));
    const out = await runRole(kit.ctx, { ...base, role: 'writer', route: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } });
    assert.equal(out.route.model, 'claude-opus-5-5');
    assert.equal(fake.calls[0].selection.effort, 'high');
  });
});

describe('classifyError and retry hints', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  test('classification', () => {
    assert.equal(classifyError(new FunnelError('x', 'not-logged-in')).kind, 'auth');
    assert.equal(classifyError(new FunnelError('x', 'unsupported')).kind, 'input');
    assert.equal(classifyError(new FunnelError('x', 'invalid-selection')).kind, 'fatal');
    assert.equal(classifyError(new FunnelError('x', 'aborted')).kind, 'aborted');
    assert.equal(classifyError(Object.assign(new Error('API Error'), { code: '429' })).kind, 'quota');
    assert.equal(classifyError(Object.assign(new Error('API Error'), { code: '401' })).kind, 'auth');
    assert.equal(classifyError(new Error('Not logged in · Please run /login')).kind, 'auth');
    assert.equal(classifyError(new Error("You've hit your limit")).kind, 'quota');
    assert.equal(classifyError(new Error('socket hang up')).kind, 'temporary');
    const limited = classifyError(Object.assign(new Error('Claude Code failed'), { limit: { kind: 'rate', resetAt: '2026-10-06T15:00:00Z', detail: 'Five-hour limit reached.' } }), now);
    assert.deepEqual(limited, { kind: 'quota', message: 'Claude Code failed Five-hour limit reached.', retryAfterMs: 3 * 3600_000, reported: true });
    const noTime = classifyError(Object.assign(new Error('x'), { limit: { kind: 'quota', detail: 'Out of credits. Try again in 2 hours.' } }), now);
    assert.equal(noTime.kind, 'quota');
    assert.equal(noTime.retryAfterMs, 2 * 3600_000, 'falls back to reading the message');
    assert.equal(noTime.reported, undefined);
  });
  test('parseRetryAfter', () => {
    assert.equal(parseRetryAfter('Try again in 2 hours 5 minutes.', now), (2 * 60 + 5) * 60_000);
    assert.equal(parseRetryAfter('try again in 3 days', now), 3 * 86_400_000);
    assert.equal(parseRetryAfter('Retry after 120', now), 120_000);
    assert.equal(parseRetryAfter('Claude AI usage limit reached|' + (now / 1000 + 3600), now), (now / 1000 + 3600) * 1000 - now);
    assert.equal(parseRetryAfter('resets 2026-10-06T14:00:00Z', now), 2 * 3600_000);
    const t = parseRetryAfter("You've hit your limit · resets 3pm", now)!;
    assert.ok(t >= 30_000 && t <= 24 * 3600_000);
    assert.equal(parseRetryAfter('nothing useful', now), undefined);
    assert.equal(parseRetryAfter('retry after 1', now), 30_000, 'clamped to the minimum');
  });
});

describe('probe and connections', () => {
  test('probeRole reports ok with timing and route', async () => {
    useRoutes('bulk', { provider: 'codex', model: 'gpt-6-luna' });
    fake.next(() => ({ structured: { kind: 'question' }, text: '{"kind":"question"}' }));
    const r = await probeRole(kit.ctx, 'bulk');
    assert.equal(r.ok, true);
    assert.match(r.detail, /codex\/gpt-6-luna/);
    assert.ok(r.ms >= 0);
  });

  test('probeRole reports failure with the action', async () => {
    useRoutes('bulk', { provider: 'claude', model: 'm' });
    fake.next(() => new FunnelError('Not logged in', 'not-logged-in'));
    const r = await probeRole(kit.ctx, 'bulk');
    assert.equal(r.ok, false);
    assert.match(r.detail, /claude auth login/);
  });

  test('getConnections combines funnel detection, notebooklm, libreoffice and node; provider detection is cached', async () => {
    let usageCalls = 0;
    setNlmRunner(async (args) => {
      if (args[0] === 'login') return { code: 0, stdout: '✓ Authentication valid!\n  Account: me@example.com\n', stderr: '' };
      usageCalls++;
      return { code: 0, stdout: JSON.stringify({ windows: [{ window: 'rolling', percent_used: 1, percent_remaining: 99, resets_at: '2026-10-07T04:04:42+00:00' }], tier: 'NOTEBOOKLM_TIER_PRO_CONSUMER_USER' }), stderr: '' };
    });
    const c = await getConnections(kit.ctx);
    assert.deepEqual(c.providers.map((p) => p.provider), ['claude', 'codex', 'agent', 'antigravity']);
    const claude = c.providers[0];
    assert.equal(claude.installed, true);
    assert.equal(claude.signedIn, true);
    assert.equal(claude.version, '1.2.3');
    assert.deepEqual(claude.models[0], { id: 'claude-model', label: 'claude model', efforts: ['low', 'high'] });
    assert.deepEqual(claude.capabilities, { images: true, schema: 'native', system: true });
    const agent = c.providers[2];
    assert.equal(agent.installed, false);
    assert.equal(agent.signedIn, false);
    assert.match(agent.error ?? '', /not installed/);
    assert.equal(c.providers[3].signedIn, false);
    assert.equal(c.providers[3].error, 'Not signed in');
    assert.equal(c.notebooklm.signedIn, true);
    assert.equal(c.notebooklm.account, 'me@example.com');
    assert.equal(c.notebooklm.usage[0].window, 'rolling');
    assert.match(c.notebooklm.loginCommand, /nlm login --storage file/);
    assert.equal(c.node, process.version);
    assert.equal(c.dataDir, kit.ctx.config.dataDir);
    assert.equal(typeof c.libreoffice.installed, 'boolean');
    assert.deepEqual(claude.usage, [], 'Claude Code reports no usage windows');
    assert.equal(claude.limit, null);
    fake.installed.agent = true;
    const again = await getConnections(kit.ctx);
    assert.equal(again.providers[2].installed, false, 'cached for 60 s');
    assert.ok(usageCalls >= 1);
  });

  test('getConnections shows the Codex usage windows and a reached limit', async () => {
    setNlmRunner(async () => ({ code: 1, stdout: '', stderr: 'not installed' }));
    fake.usage.codex = {
      provider: 'codex' as never,
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-10-16T16:33:51.000Z' },
      secondary: { usedPercent: 10, windowMinutes: 10080 },
      limit: { kind: 'rate', detail: '5-hour window is full.' },
    };
    const codex = (await getConnections(kit.ctx)).providers.find((p) => p.provider === 'codex')!;
    assert.deepEqual(codex.usage, [
      { window: '5 hours', usedPercent: 100, resetsAt: '2026-10-16T16:33:51.000Z' },
      { window: '7 days', usedPercent: 10, resetsAt: null },
    ]);
    assert.equal(codex.limit, '5-hour window is full.');
  });
});

const route = (provider: string, model = 'm') => ({ provider, model });
function setRoutes(routes: Partial<Record<Role, { primary: ReturnType<typeof route>; fallback?: ReturnType<typeof route> }>>, concurrency?: Record<string, number>) {
  kit.ctx.saveSettings({ routes: { ...DEFAULT_ROUTES, ...routes }, ...(concurrency ? { concurrency: { claude: 2, codex: 2, antigravity: 2, agent: 1, notebooklm: 2, ...concurrency } } : {}) });
}

describe('lean homes for the CLIs', () => {
  test('Codex calls and the usage read run in the service\'s own Codex home; Claude calls without the web run as they are', async () => {
    setRoutes({ bulk: { primary: route('codex') }, writer: { primary: route('claude') } });
    kit.ctx.saveSettings({ routes: { ...kit.ctx.settings().routes, vision: { primary: route('codex'), fallback: route('claude') } } });
    fake.usage.codex = { provider: 'codex', primary: { usedPercent: 1, windowMinutes: 300 } } as never;
    fake.next(() => ({ text: 'a' }), () => ({ text: 'b' }), () => ({ text: 'c' }));
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    await runRole(kit.ctx, { ...base, role: 'writer' });
    await runRole(kit.ctx, { ...base, role: 'vision' });
    const home = join(kit.ctx.config.dataDir, 'codex-home');
    assert.deepEqual(fake.calls.map((c) => c.env), [{ CODEX_HOME: home }, undefined, { CODEX_HOME: home }]);
    assert.equal(readlinkSync(join(home, 'auth.json')), join(process.env.CODEX_HOME!, 'auth.json'));
    // accountUsage runs when a role has a fallback: it reads the usage windows through the same home.
    assert.deepEqual(fake.rateLimitOptions[0], { env: { CODEX_HOME: home } });
  });

  test('a login that Codex rewrote during a call is back in the real place as soon as the call ends', async () => {
    setRoutes({ bulk: { primary: route('codex') } });
    const link = join(kit.ctx.config.dataDir, 'codex-home', 'auth.json');
    const real = join(process.env.CODEX_HOME!, 'auth.json');
    const before = readFileSync(real, 'utf8');
    try {
      fake.next(() => {
        rmSync(link);
        writeFileSync(link, '{"refreshed":true}');
        utimesSync(link, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
        return { text: 'a' };
      });
      await runRole(kit.ctx, { ...base, role: 'bulk' });
      assert.equal(readFileSync(real, 'utf8'), '{"refreshed":true}');
      assert.equal(readlinkSync(link), real);
    } finally {
      writeFileSync(real, before);
    }
  });

  test('a web call runs Claude Code in a home with only the login, and offers it only the two web tools', async () => {
    setRoutes({ research: { primary: route('claude') } });
    fake.next((input) => ({ text: JSON.stringify({ kind: 'a' }), usage: usageOf(3, 1), structured: input && { kind: 'a' } }));
    await runRole(kit.ctx, { ...base, role: 'research', web: true, schema });
    const call = fake.calls[0];
    assert.deepEqual(call.env, { CLAUDE_CONFIG_DIR: join(kit.ctx.config.dataDir, 'claude-home') });
    const denied = call.providerOptions?.claude?.disallowedTools ?? [];
    for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'Skill']) assert.ok(denied.includes(tool), tool);
    for (const tool of ['WebSearch', 'WebFetch']) assert.ok(!denied.includes(tool), tool);
    assert.equal(call.selection.access, 'supervised');
  });
});

describe('call timeouts per role', () => {
  test('3 minutes for the short roles, 10 for the rest, and Antigravity keeps 10 in every role', () => {
    for (const role of ['checker', 'bulk', 'vision', 'evidence', 'editor'] as const) assert.equal(callTimeoutMs(role, route('codex')), 3 * 60_000, role);
    for (const role of ['writer', 'planner', 'reviewer', 'exercises', 'research', 'verifier'] as const) assert.equal(callTimeoutMs(role, route('codex')), 10 * 60_000, role);
    assert.equal(callTimeoutMs('bulk', route('antigravity')), 10 * 60_000);
    llmTuning.callTimeoutMs = 50;
    assert.equal(callTimeoutMs('bulk', route('codex')), 50, 'a tuned limit below 3 minutes applies to every role');
  });

  test('a call that took 4 minutes and failed counts as a timeout for a checker task but not for a writer task', async () => {
    seedProject(kit.ctx);
    kit.ctx.db.run('PRAGMA foreign_keys = OFF');
    const t = new Date().toISOString();
    for (const [id, run] of [['old', 'r1'], ['new', 'r2']]) kit.ctx.db.insert('tasks', { id, run_id: run, project_id: 'p1', kind: 'x', label: 'x', key: 'k', created_at: t });
    const call = (role: string) => kit.ctx.db.insert('usage', { project_id: 'p1', task_id: 'old', provider: 'codex', model: 'm', role, ms: 240_000, ok: 0, created_at: t });
    call('checker');
    setRoutes({ checker: { primary: route('codex'), fallback: route('claude') }, writer: { primary: route('codex'), fallback: route('claude') } });
    fake.next(() => ({ text: 'ok' }), () => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'checker', taskId: 'new' })).route.provider, 'claude');
    assert.equal((await runRole(kit.ctx, { ...base, role: 'writer', taskId: 'new' })).route.provider, 'codex');
  });
});

describe('one limit per provider', () => {
  /** Calls of different roles that all take a while, and how many were running at the busiest moment. */
  function busy() {
    const state = { now: 0, peak: 0, perProvider: {} as Record<string, number>, peakPerProvider: {} as Record<string, number> };
    const step = async (input: { selection: { provider: string } }) => {
      const p = input.selection.provider;
      state.now++;
      state.perProvider[p] = (state.perProvider[p] ?? 0) + 1;
      state.peak = Math.max(state.peak, state.now);
      state.peakPerProvider[p] = Math.max(state.peakPerProvider[p] ?? 0, state.perProvider[p]);
      await new Promise((r) => setTimeout(r, 20));
      state.now--;
      state.perProvider[p]--;
      return { text: 'ok' };
    };
    return { state, step };
  }

  test('seven role pools on one provider never run more calls than its limit', async () => {
    setRoutes({}, { codex: 2 });
    const { state, step } = busy();
    const codexRoles = ROLES.filter((r) => kit.ctx.settings().routes[r].primary.provider === 'codex');
    assert.ok(codexRoles.length >= 6, 'the default routes put many roles on Codex');
    fake.steps.push(...Array.from({ length: 24 }, () => step));
    await Promise.all(Array.from({ length: 24 }, (_, i) => runRole(kit.ctx, { ...base, role: codexRoles[i % codexRoles.length] })));
    assert.equal(state.peakPerProvider.codex, 2);
  });

  test('a call on a fallback route counts toward the fallback provider\'s limit', async () => {
    setRoutes({ writer: { primary: route('claude'), fallback: route('codex') }, bulk: { primary: route('codex') }, checker: { primary: route('codex') } }, { codex: 1, claude: 2 });
    const { state, step } = busy();
    // Two writer calls fail on Claude and move to Codex while a bulk and a checker call run there: one at a time in all.
    const answer = (input: { selection: { provider: string } }) => (input.selection.provider === 'claude' ? new Error('usage limit reached') : step(input));
    fake.steps.push(...Array.from({ length: 6 }, () => answer));
    await Promise.all([
      runRole(kit.ctx, { ...base, role: 'writer' }),
      runRole(kit.ctx, { ...base, role: 'writer' }),
      runRole(kit.ctx, { ...base, role: 'bulk' }),
      runRole(kit.ctx, { ...base, role: 'checker' }),
    ]);
    assert.equal(state.peakPerProvider.codex, 1);
  });

  test('the call timeout starts when the call starts, not while it waits for a slot', async () => {
    setRoutes({ writer: { primary: route('codex') } }, { codex: 1 });
    llmTuning.callTimeoutMs = 120;
    const slow = () => new Promise<{ text: string }>((r) => setTimeout(() => r({ text: 'ok' }), 80));
    fake.steps.push(slow, slow);
    const [a, b] = await Promise.all([runRole(kit.ctx, { ...base, role: 'writer' }), runRole(kit.ctx, { ...base, role: 'writer' })]);
    assert.deepEqual([a.text, b.text], ['ok', 'ok'], 'the second call waited 80 ms and ran 80 ms: more than its 120 ms limit in all');
  });

  test('a call that waits for a slot still honours its abort signal, and frees nothing it never held', async () => {
    setRoutes({ writer: { primary: route('codex') } }, { codex: 1 });
    let release!: () => void;
    fake.steps.push(() => new Promise<{ text: string }>((r) => { release = () => r({ text: 'first' }); }), () => ({ text: 'third' }));
    const first = runRole(kit.ctx, { ...base, role: 'writer' });
    await new Promise((r) => setTimeout(r, 10));
    const abort = new AbortController();
    const second = runRole(kit.ctx, { ...base, role: 'writer', signal: abort.signal });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort(new Error('cancelled'));
    await assert.rejects(second, /cancelled/);
    assert.equal(fake.calls.length, 1, 'the aborted call never reached the CLI');
    release();
    assert.equal((await first).text, 'first');
    assert.equal((await runRole(kit.ctx, { ...base, role: 'writer' })).text, 'third');
    assert.equal(usageRows().length, 2, 'no usage row for the call that never started');
  });
});

describe('usage rows', () => {
  test('a good call records cached tokens, its call number and that it is on the first route', async () => {
    setRoutes({ bulk: { primary: route('codex') } });
    fake.next(() => ({ text: 'ok', usage: { ...usageOf(1000, 20), cachedInputTokens: 600, cacheCreationInputTokens: 50 } }));
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    const r = usageRows()[0];
    assert.deepEqual([r.input_tokens, r.cached_input_tokens, r.cache_creation_tokens, r.error_kind, r.attempt, r.fallback, r.ok], [1000, 600, 50, null, 1, 0, 1]);
  });

  test('a failed call on the primary and the good call on the fallback say what happened', async () => {
    setRoutes({ bulk: { primary: route('claude'), fallback: route('codex') } });
    fake.next(() => new Error('usage limit reached'), () => ({ text: 'ok', usage: usageOf(10, 2) }));
    await runRole(kit.ctx, { ...base, role: 'bulk' });
    const [failed, good] = usageRows();
    assert.deepEqual([failed.error_kind, failed.attempt, failed.fallback, failed.ok, failed.input_tokens], ['quota', 1, 0, 0, null]);
    assert.deepEqual([good.error_kind, good.attempt, good.fallback, good.ok], [null, 2, 1, 1]);
  });

  test('a repair turn is call number 2 on the same route; timeout and truncation have their own kinds', async () => {
    setRoutes({ bulk: { primary: route('codex'), fallback: route('claude') } });
    fake.next(() => ({ text: '{"kind":"zzz"}' }), () => ({ text: '{"kind":"a"}' }));
    await runRole(kit.ctx, { ...base, role: 'bulk', schema });
    assert.deepEqual(usageRows().map((r) => [r.attempt, r.fallback]), [[1, 0], [2, 0]]);
    kit.ctx.db.run('DELETE FROM usage');
    llmTuning.callTimeoutMs = 20;
    fake.next((input) => new Promise((_res, rej) => input.signal!.addEventListener('abort', () => rej(new FunnelError('aborted', 'aborted')))), () => ({ text: 'half', finishReason: 'length' }), () => ({ text: 'ok' }));
    setRoutes({ bulk: { primary: route('codex'), fallback: route('claude') }, checker: { primary: route('claude'), fallback: route('codex') } });
    await runRole(kit.ctx, { ...base, role: 'bulk' }).catch(() => undefined);
    await runRole(kit.ctx, { ...base, role: 'checker' });
    assert.deepEqual(usageRows().map((r) => r.error_kind), ['timeout', 'truncated', null]);
  });

  test('a caller abort is recorded as aborted', async () => {
    setRoutes({ bulk: { primary: route('codex') } });
    const abort = new AbortController();
    fake.next((input) => new Promise((_res, rej) => input.signal!.addEventListener('abort', () => rej(new FunnelError('aborted', 'aborted')))));
    const run = runRole(kit.ctx, { ...base, role: 'bulk', signal: abort.signal });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await run.catch(() => undefined);
    assert.equal(usageRows()[0].error_kind, 'aborted');
  });
});

describe('a book that must not continue on a replacement for Claude', () => {
  const claudeThenCodex = { primary: route('claude'), fallback: route('codex') };

  test('a Claude quota error waits for the reset, with no call to the fallback', async () => {
    seedProject(kit.ctx);
    kit.ctx.db.run(`UPDATE projects SET options = ? WHERE id = 'p1'`, JSON.stringify({ noClaudeFallback: true }));
    setRoutes({ writer: claudeThenCodex });
    fake.next(() => Object.assign(new Error("You've hit your usage limit. Try again in 2 hours."), { code: 'cli-failed' }), () => ({ text: 'should not run' }));
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'writer', projectId: 'p1' }), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.kind, 'quota');
      assert.equal(e.retryAfterMs, 2 * 3_600_000);
      assert.doesNotMatch(e.message, /fallback also unavailable/);
      return true;
    });
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['claude']);
  });

  test('the same role falls back as before when the option is off or the call has no book', async () => {
    seedProject(kit.ctx);
    setRoutes({ writer: claudeThenCodex });
    fake.next(() => new Error('usage limit reached'), () => ({ text: 'ok' }), () => new Error('usage limit reached'), () => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'writer', projectId: 'p1' })).route.provider, 'codex');
    resetLlmState();
    assert.equal((await runRole(kit.ctx, { ...base, role: 'writer' })).route.provider, 'codex');
  });

  test('a role that starts on another provider keeps its fallback, even on Claude', async () => {
    seedProject(kit.ctx);
    kit.ctx.db.run(`UPDATE projects SET options = ? WHERE id = 'p1'`, JSON.stringify({ noClaudeFallback: true }));
    setRoutes({ editor: { primary: route('codex'), fallback: route('claude') } });
    fake.next(() => new Error('usage limit reached'), () => ({ text: 'ok' }));
    assert.equal((await runRole(kit.ctx, { ...base, role: 'editor', projectId: 'p1' })).route.provider, 'claude');
  });
});

/** The step of a provider that keeps its process: the session is live after the turn. */
const live = (id: string, text: string, extra: Record<string, unknown> = {}) => () => { fake.live.add(id); return { text, sessionId: id, ...extra }; };

describe('a conversation that continues after the first answer', () => {
  const png = Buffer.from('fakepng');
  const b64 = png.toString('base64');

  test('a follow-up in a live session sends only the message, and the session stays open until the handle is closed', async () => {
    setRoutes({ writer: { primary: route('claude'), fallback: route('codex') } });
    fake.next(live('s1', 'draft'), live('s1', 'OK'));
    const talk = await openRole(kit.ctx, { ...base, role: 'writer' });
    assert.equal(talk.result.text, 'draft');
    assert.deepEqual(fake.closed, [], 'open after the first answer');
    const back = await talk.send('check it');
    assert.equal(back.text, 'OK');
    const [first, second] = fake.calls;
    assert.equal(second.sessionId, 's1');
    assert.equal(second.prompt, 'check it');
    assert.equal(second.attachments, undefined);
    assert.equal(second.selection.provider, 'claude');
    assert.equal(first.sessionId, undefined);
    assert.deepEqual(fake.closed, []);
    talk.close();
    talk.close();
    assert.deepEqual(fake.closed, ['s1'], 'closed once');
  });

  test('without a live session the follow-up replays the first prompt, the last answer and the message in a new conversation', async () => {
    setRoutes({ writer: { primary: route('antigravity') } });
    fake.next(() => ({ text: 'x'.repeat(13_000), sessionId: 'old' }), () => ({ text: 'second', sessionId: 'new' }), () => ({ text: 'third' }));
    const talk = await openRole(kit.ctx, { ...base, role: 'writer' });
    await talk.send('check it');
    const replay = fake.calls[1];
    assert.equal(replay.sessionId, undefined);
    assert.match(replay.prompt, /the prompt/);
    assert.match(replay.prompt, /x{12000}\n\[truncated\]/);
    assert.doesNotMatch(replay.prompt, /x{12001}/);
    assert.match(replay.prompt, /check it$/);
    assert.equal(replay.system, 'sys');
    // The last answer is now the second one.
    await talk.send('again');
    assert.match(fake.calls[2].prompt, /second/);
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['antigravity', 'antigravity', 'antigravity']);
    talk.close();
    assert.deepEqual(fake.closed.sort(), ['new', 'old'], 'a session started by a replay is closed too');
  });

  test('a session that died is replayed on the same route', async () => {
    setRoutes({ writer: { primary: route('codex') } });
    fake.next(live('s1', 'first'), () => ({ text: 'second', sessionId: 's2' }));
    const talk = await openRole(kit.ctx, { ...base, role: 'writer' });
    fake.live.delete('s1');
    assert.equal((await talk.send('go on')).text, 'second');
    assert.equal(fake.calls[1].sessionId, undefined);
    assert.match(fake.calls[1].prompt, /first/);
    talk.close();
  });

  test('images on a follow-up go with it in a live session, and with the first images in a replay', async () => {
    setRoutes({ writer: { primary: route('claude') } });
    fake.next(live('s1', 'draft'), live('s1', 'red'), () => ({ text: 'again', sessionId: 's3' }));
    const talk = await openRole(kit.ctx, { ...base, role: 'writer', images: [Buffer.from('first')] });
    await talk.send('what colour?', { images: [png] });
    assert.deepEqual(fake.calls[1].attachments, [{ type: 'image', mediaType: 'image/png', data: b64 }]);
    assert.equal(fake.calls[1].sessionId, 's1');
    fake.live.delete('s1');
    await talk.send('and now?', { images: [png] });
    assert.equal(fake.calls[2].sessionId, undefined);
    assert.deepEqual(fake.calls[2].attachments?.map((a) => a.data), [Buffer.from('first').toString('base64'), b64]);
    talk.close();
  });

  test('a route that cannot read images refuses a follow-up with images before any call', async () => {
    setRoutes({ writer: { primary: route('antigravity') } });
    fake.next(() => ({ text: 'draft' }));
    const talk = await openRole(kit.ctx, { ...base, role: 'writer' });
    await assert.rejects(talk.send('look', { images: [png] }), (e: unknown) => e instanceof FollowUpError && e.kind === 'input');
    assert.equal(fake.calls.length, 1);
    assert.equal(talk.result.text, 'draft');
    talk.close();
  });

  test('a failed follow-up throws a FollowUpError, does not leave the route, and leaves the first result usable', async () => {
    setRoutes({ writer: { primary: route('claude'), fallback: route('codex') } });
    fake.next(live('s1', 'draft'), () => new Error("You've hit your usage limit. Try again in 2 hours."), live('s1', 'fine'));
    const talk = await openRole(kit.ctx, { ...base, role: 'writer' });
    await assert.rejects(talk.send('check it'), (e: unknown) => {
      assert.ok(e instanceof FollowUpError && e instanceof TaskError);
      assert.equal(e.kind, 'quota');
      assert.equal(e.retryAfterMs, 2 * 3_600_000);
      return true;
    });
    assert.deepEqual(fake.calls.map((c) => c.selection.provider), ['claude', 'claude'], 'no fallback for a follow-up');
    assert.equal(talk.result.text, 'draft');
    assert.equal((await talk.send('once more')).text, 'fine');
    talk.close();
  });

  test('a follow-up that times out is a temporary FollowUpError, and a caller abort passes through unchanged', async () => {
    setRoutes({ writer: { primary: route('codex') } });
    const hang = (input: { signal?: AbortSignal }) => new Promise<never>((_res, rej) => input.signal!.addEventListener('abort', () => rej(new FunnelError('aborted', 'aborted'))));
    fake.next(() => ({ text: 'draft' }), hang, hang);
    const abort = new AbortController();
    const talk = await openRole(kit.ctx, { ...base, role: 'writer', signal: abort.signal });
    llmTuning.callTimeoutMs = 30;
    await assert.rejects(talk.send('slow'), (e: unknown) => e instanceof FollowUpError && e.kind === 'temporary' && /Timed out/.test(e.message));
    llmTuning.callTimeoutMs = 10 * 60_000;
    const pending = talk.send('stop me');
    setTimeout(() => abort.abort(new Error('stopped by the author')), 10);
    await assert.rejects(pending, (e: unknown) => !(e instanceof TaskError) && /stopped by the author/.test(String(e)));
    assert.deepEqual(usageRows().map((r) => r.error_kind), [null, 'timeout', 'aborted']);
  });

  test('withRole closes the session when the callback succeeds and when it throws', async () => {
    setRoutes({ writer: { primary: route('claude') } });
    fake.next(live('s1', 'draft'), live('s1', 'OK'), live('s2', 'draft'));
    const out = await withRole(kit.ctx, { ...base, role: 'writer' }, async (talk) => (await talk.send('check')).text);
    assert.equal(out, 'OK');
    assert.deepEqual(fake.closed, ['s1']);
    await assert.rejects(withRole(kit.ctx, { ...base, role: 'writer' }, async () => { throw new Error('the caller broke'); }), /the caller broke/);
    assert.deepEqual(fake.closed, ['s1', 's2']);
  });

  test('a first call that fails or does not validate leaves no open session, and a closed handle refuses messages', async () => {
    setRoutes({ writer: { primary: route('claude') } });
    fake.next(live('s1', 'not json'), live('s1', 'still not'));
    await assert.rejects(openRole(kit.ctx, { ...base, role: 'writer', schema }), (e: unknown) => e instanceof TaskError && e.kind === 'input');
    assert.deepEqual(fake.closed, ['s1']);
    fake.next(live('s3', 'draft'));
    const talk = await openRole(kit.ctx, { ...base, role: 'writer' });
    talk.close();
    await assert.rejects(talk.send('late'), (e: unknown) => e instanceof FollowUpError && /closed/.test(e.message));
    assert.equal(fake.calls.length, 3);
  });

  test('every turn is a usage row with the next attempt number on the route that answered', async () => {
    setRoutes({ writer: { primary: route('claude'), fallback: route('codex') } });
    fake.next(
      () => new Error('usage limit reached'),
      live('s1', '{"kind":"zzz"}', { usage: usageOf(10, 2) }),
      live('s1', '{"kind":"a"}', { usage: usageOf(11, 3) }),
      live('s1', 'OK', { usage: usageOf(5, 1) }),
      () => new Error('socket hang up'),
    );
    const talk = await openRole(kit.ctx, { ...base, role: 'writer', schema, taskId: 't1' });
    await talk.send('check');
    await talk.send('and again').catch(() => undefined);
    talk.close();
    assert.deepEqual(usageRows().map((r) => [r.provider, r.attempt, r.fallback, r.ok, r.error_kind, r.role, r.task_id]), [
      ['claude', 1, 0, 0, 'quota', 'writer', 't1'],
      ['codex', 2, 1, 1, null, 'writer', 't1'],
      ['codex', 3, 1, 1, null, 'writer', 't1'],
      ['codex', 4, 1, 1, null, 'writer', 't1'],
      ['codex', 5, 1, 0, 'temporary', 'writer', 't1'],
    ]);
    assert.equal(usageRows()[3].input_tokens, 5);
  });

  test('the provider slot is held for one call at a time, not while the caller works between turns', async () => {
    setRoutes({ writer: { primary: route('codex') } }, { codex: 1 });
    let release!: () => void;
    fake.next(
      live('s1', 'draft'),
      () => ({ text: 'other' }),
      () => new Promise<{ text: string }>((r) => { release = () => r({ text: 'checked' }); }),
      () => ({ text: 'last' }),
    );
    const talk = await openRole(kit.ctx, { ...base, role: 'writer' });
    // The conversation is open and idle: another call on the same provider runs at once.
    assert.equal((await runRole(kit.ctx, { ...base, role: 'writer' })).text, 'other');
    // While a follow-up runs, another call waits for its slot.
    const follow = talk.send('check');
    await new Promise((r) => setTimeout(r, 10));
    const other = runRole(kit.ctx, { ...base, role: 'writer' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.calls.length, 3, 'the other call has not started');
    release();
    assert.equal((await follow).text, 'checked');
    assert.equal((await other).text, 'last');
    talk.close();
  });
});

describe('a parse function instead of a schema', () => {
  type Parsed = { title: string; body: string };
  const parse = (text: string) => {
    const m = /^TITLE: (.+)\n\n([\s\S]+)$/.exec(text);
    return m ? { ok: true as const, data: { title: m[1], body: m[2] } } : { ok: false as const, problem: 'The answer must start with a TITLE: line, then an empty line, then the text.' };
  };

  test('an accepted answer: the parser gets the text without terminal codes and control characters, no JSON schema is sent, and nothing else is cleaned', async () => {
    setRoutes({ writer: { primary: route('codex') } });
    // A real newline right before "u" inside math is what the schema cleaner would turn into "\nu". The parser must see it unchanged.
    fake.next(() => ({ text: 'TITLE: A\u001b[31m\u0001\n\nx\t$a\nu$ </markdown>\r\n' }));
    let seen = '';
    const out = await runRole<Parsed>(kit.ctx, { ...base, role: 'writer', parse: (t) => { seen = t; return parse(t); } });
    assert.equal(seen, 'TITLE: A\n\nx\t$a\nu$ \r\n', 'terminal codes, control bytes and tool markup removed; tab, newline and the rest kept');
    assert.deepEqual(out.data, { title: 'A', body: 'x\t$a\nu$ \r\n' });
    assert.equal(out.text, seen);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].responseSchema, undefined);
  });

  test('a rejected answer gets one repair turn with the problem and a request for the full answer, not for JSON', async () => {
    setRoutes({ writer: { primary: route('claude') } });
    fake.next(live('s1', 'no header here'), live('s1', 'TITLE: B\n\ntext'));
    const out = await runRole<Parsed>(kit.ctx, { ...base, role: 'writer', parse });
    assert.deepEqual(out.data, { title: 'B', body: 'text' });
    const repair = fake.calls[1];
    assert.equal(repair.sessionId, 's1');
    assert.match(repair.prompt, /must start with a TITLE: line/);
    assert.match(repair.prompt, /full corrected answer in the same format/);
    assert.doesNotMatch(repair.prompt, /JSON/);
    assert.equal(repair.responseSchema, undefined);
    assert.deepEqual(usageRows().map((r) => r.attempt), [1, 2]);
    assert.deepEqual(fake.closed, ['s1']);
  });

  test('without a live session the repair replays the prompt and the rejected answer', async () => {
    setRoutes({ writer: { primary: route('antigravity') } });
    fake.next(() => ({ text: 'no header here' }), () => ({ text: 'TITLE: B\n\ntext' }));
    await runRole<Parsed>(kit.ctx, { ...base, role: 'writer', parse });
    assert.match(fake.calls[1].prompt, /the prompt[\s\S]*no header here[\s\S]*must start with a TITLE/);
  });

  test('rejected twice: TaskError input with the problem, two calls, nothing left open', async () => {
    setRoutes({ writer: { primary: route('claude') } });
    fake.next(live('s1', 'bad'), live('s1', 'worse'));
    await assert.rejects(runRole<Parsed>(kit.ctx, { ...base, role: 'writer', parse }), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.kind, 'input');
      assert.match(e.message, /invalid answer twice: The answer must start with a TITLE/);
      return true;
    });
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.closed, ['s1']);
  });

  test('the conversation of an accepted parsed answer can continue', async () => {
    setRoutes({ writer: { primary: route('claude') } });
    fake.next(live('s1', 'TITLE: A\n\nbody'), live('s1', 'OK'));
    const text = await withRole<Parsed, string>(kit.ctx, { ...base, role: 'writer', parse }, async (talk) => (await talk.send('check your computations')).text);
    assert.equal(text, 'OK');
  });

  test('a schema and a parse function together are a programming error', async () => {
    await assert.rejects(runRole(kit.ctx, { ...base, role: 'writer', schema, parse: () => ({ ok: false, problem: 'x' }) }), /schema or a parse function/);
    assert.equal(fake.calls.length, 0);
  });
});

test('no default route names the older Claude Sonnet', () => {
  const models = Object.values(DEFAULT_ROUTES).flatMap((r) => [r.primary, r.fallback]).filter((x) => x?.provider === 'claude').map((x) => x!.model);
  assert.ok(models.length >= 6);
  for (const m of models) assert.ok(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'].includes(m), m);
});
