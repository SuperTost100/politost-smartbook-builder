import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FunnelError } from 'cli-funnel';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { z } from 'zod';
import { TaskError } from '../queue/queue.ts';
import { setNlmRunner } from '../evidence/nlm.ts';
import { classifyError, getConnections, llmTuning, parseRetryAfter, probeRole, resetConnectionsCache, resetLlmState, runRole, setFunnel } from './index.ts';
import { FakeFunnel, makeCtx, usageOf } from './testkit.ts';

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
      assert.equal(e.action, 'Sign in to Claude Code: run "claude auth login" in a terminal, then press Retry.');
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
