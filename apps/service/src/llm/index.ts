// Model routing through cli-funnel. Callers name a role; settings map roles to provider/model with a fallback.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionsResponse, ProbeResult, Role, Route } from '@smartbuilder/domain';
import { sanitizeModelValue } from '@smartbuilder/content';
import { z } from 'zod';
import { TaskError } from '../queue/queue.ts';
import { paths } from '../config.ts';
import type { AppContext } from '../context.ts';
import { now } from '../db/db.ts';
import { classifyError, DEFAULT_QUOTA_WAIT_MS, limitFailure, limitWaitMs, loginAction, type Failure } from './errors.ts';
import { accountUsage, getFunnel, type FunnelLike } from './funnel.ts';
import { describeIssues, dropOptionalNulls, parseJsonAnswer, rawJsonSchema, strictify } from './schema.ts';

export { getConnections, resetConnectionsCache } from './connections.ts';
export { setFunnel, type FunnelLike } from './funnel.ts';
export { toProviderSchema, parseJsonAnswer } from './schema.ts';
export { classifyError, parseRetryAfter } from './errors.ts';

export interface RunRoleOptions<T> {
  role: Role;
  system: string;
  prompt: string;
  /** PNG images; only sent to routes whose provider supports images. */
  images?: Buffer[];
  /** When set, the answer must parse and validate; one repair request is made on failure. */
  schema?: z.ZodType<T>;
  /** JSON schema sent to the provider (derived from schema when omitted). */
  jsonSchema?: Record<string, unknown>;
  projectId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  signal?: AbortSignal;
  /** Override the configured route (e.g. escalation). */
  route?: Route;
  /** Let the model search and read the web. Every other tool stays refused. Only providers that pass approvals through can do this. */
  web?: boolean;
}

export interface RunRoleResult<T> { text: string; data: T; route: Route; usage: { inputTokens: number | null; outputTokens: number | null } }

/** Tunables that tests change. */
export const llmTuning = { callTimeoutMs: 10 * 60_000 };

/** Providers that hit a quota stay out of the first position until this time (epoch ms). */
const cooldown = new Map<string, number>();
export function resetLlmState() {
  cooldown.clear();
}

/** A wait the provider reported is its real reset time. One read from an error message is capped, so the provider gets tried again soon. */
function coolDown(provider: string, f: Pick<Failure, 'retryAfterMs' | 'reported'>) {
  const wait = f.retryAfterMs ?? DEFAULT_QUOTA_WAIT_MS;
  cooldown.set(provider, Date.now() + (f.reported ? wait : Math.min(wait, 10 * 60_000)));
}

type Usage = { inputTokens: number | null; outputTokens: number | null };

/** Runs a prompt for a role. Throws TaskError with kind auth/quota/temporary/input so the queue can react. Falls back to the role's fallback route on quota, unavailable, a timeout or a truncated answer. */
export async function runRole<T = string>(ctx: AppContext, opts: RunRoleOptions<T>): Promise<RunRoleResult<T>> {
  const funnel = getFunnel();
  const needsImages = !!opts.images?.length;
  const canImages = (r: Route) => !!funnel.providers[r.provider]?.capabilities.images;
  // Claude only: its tools can be switched off by the settings file in the web folder (see webFolder). Codex runs
  // commands it considers safe, such as cat, without asking, so a page could get it to read local files.
  const canWeb = (r: Route) => r.provider === 'claude' && !!funnel.providers[r.provider]?.capabilities.access?.includes('supervised');

  const configured = ctx.settings().routes[opts.role];
  const primary = opts.route ?? configured.primary;
  const fallback = opts.route ? undefined : configured.fallback;

  let candidates: Route[];
  if (!needsImages) candidates = [primary, ...(fallback ? [fallback] : [])];
  else if (canImages(primary)) candidates = [primary, ...(fallback && canImages(fallback) ? [fallback] : [])];
  else if (fallback && canImages(fallback)) candidates = [fallback];
  else throw new TaskError(`The "${opts.role}" route (${primary.provider}/${primary.model}) cannot read images and there is no fallback that can.`, 'input', 'In Settings, pick a vision-capable model (Claude or Codex) for this role.');

  if (opts.web) {
    candidates = candidates.filter(canWeb);
    if (!candidates.length) throw new TaskError(`The "${opts.role}" route cannot search the web.`, 'input', 'In Settings, pick a Claude model for this role.');
  }

  // A task that timed out on its first route in an earlier run (a review of the same chapter, say) tends to time out
  // there again, so it starts on the next route instead of waiting for the timeout once more.
  if (opts.taskId && candidates.length > 1 && timedOutBefore(ctx, opts.taskId, candidates[0])) candidates = [...candidates.slice(1), candidates[0]];

  // Codex reports its usage windows, so a full one sends the role to the next route without a failed call first.
  if (candidates.length > 1) {
    await Promise.all(candidates.map(async (c) => {
      const limit = (await accountUsage(c.provider))?.limit;
      if (limit) coolDown(c.provider, { retryAfterMs: limitWaitMs(limit), reported: true });
    }));
  }

  // Skip a provider that recently hit its quota when another candidate is available.
  const ready = candidates.filter((c) => (cooldown.get(c.provider) ?? 0) <= Date.now());
  if (ready.length && ready.length < candidates.length) candidates = ready;

  let firstQuota: Failure | undefined;
  let lastFailure: Failure | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const route = candidates[i];
    try {
      return await attemptRoute(ctx, funnel, opts, route);
    } catch (err) {
      if (!(err instanceof RouteFailure)) throw err;
      const f = err.failure;
      if (f.kind === 'quota') {
        coolDown(route.provider, f);
        firstQuota ??= f;
      }
      lastFailure = f;
      // A call that hangs until the timeout, or an answer cut off at the output limit, usually repeats on the same model, so the fallback gets the next try.
      const canFallBack = i < candidates.length - 1 && (f.kind === 'quota' || f.kind === 'unavailable' || !!f.timedOut || !!f.truncated);
      if (canFallBack) continue;
      throw toTaskError(f, route, firstQuota, candidates.length > 1);
    }
  }
  throw new TaskError(lastFailure?.message ?? 'No route available', 'temporary');
}

/** The same task key, in an earlier run within the last two weeks, hit the call timeout on this route. */
function timedOutBefore(ctx: AppContext, taskId: string, route: Route): boolean {
  return !!ctx.db.get(
    `SELECT 1 FROM usage u JOIN tasks t ON t.id = u.task_id
     WHERE t.key = (SELECT key FROM tasks WHERE id = ?) AND t.project_id = (SELECT project_id FROM tasks WHERE id = ?) AND t.id <> ?
       AND u.provider = ? AND u.model = ? AND u.ok = 0 AND u.ms >= ? AND u.created_at > ? LIMIT 1`,
    taskId, taskId, taskId, route.provider, route.model, llmTuning.callTimeoutMs, new Date(Date.now() - 14 * 86_400_000).toISOString());
}

class RouteFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

function toTaskError(f: Failure, route: Route, firstQuota: Failure | undefined, hadFallback: boolean): TaskError {
  const where = `${route.provider}/${route.model}`;
  switch (f.kind) {
    case 'auth': return new TaskError(`${where}: ${f.message}`, 'auth', loginAction(route.provider));
    case 'quota': {
      const waits = [f.retryAfterMs, firstQuota?.retryAfterMs].filter((x): x is number => typeof x === 'number');
      const wait = waits.length ? Math.min(...waits) : DEFAULT_QUOTA_WAIT_MS;
      return new TaskError(`${where}: usage limit reached${hadFallback ? ' (fallback also unavailable)' : ''}. ${f.message}`.trim(), 'quota', 'Wait for the limit to reset, or pick another model in Settings.', wait);
    }
    case 'unavailable': return new TaskError(`${where}: ${f.message}`, 'auth', 'Install the CLI or pick another model in Settings, then press Retry.');
    case 'input': return new TaskError(`${where}: ${f.message}`, 'input');
    case 'fatal': return new TaskError(`${where}: ${f.message}`, 'fatal', 'Check the model and effort for this role in Settings.');
    default: return new TaskError(`${where}: ${f.message}`, 'temporary');
  }
}

async function attemptRoute<T>(ctx: AppContext, funnel: FunnelLike, opts: RunRoleOptions<T>, route: Route): Promise<RunRoleResult<T>> {
  const raw = opts.schema ? rawJsonSchema(opts.schema) : undefined;
  const jsonSchema = opts.jsonSchema ?? (raw ? strictify(raw) : undefined);
  const total: Usage = { inputTokens: null, outputTokens: null };
  const add = (u: Usage) => {
    for (const k of ['inputTokens', 'outputTokens'] as const) if (u[k] !== null) total[k] = (total[k] ?? 0) + u[k]!;
  };

  const check = (r: CallOutput): { ok: true; data: T } | { ok: false; problem: string } => {
    let value: unknown;
    try {
      value = r.structured !== undefined ? r.structured : parseJsonAnswer(r.text);
    } catch (err) {
      if (r.structured === undefined) {
        try {
          value = parseJsonAnswer(r.text);
        } catch {
          return { ok: false, problem: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    // Control characters (eaten backslashes, ANSI colours) are removed from every string before validation.
    const parsed = opts.schema!.safeParse(sanitizeModelValue(raw ? dropOptionalNulls(value, raw) : value));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: describeIssues(parsed.error) };
  };

  const first = await callOnce(ctx, funnel, opts, route, { prompt: opts.prompt }, jsonSchema);
  add(first.usage);
  try {
    if (!opts.schema) return { text: first.text, data: first.text as T, route, usage: total };
    const verdict = check(first);
    if (verdict.ok) return { text: first.text, data: verdict.data, route, usage: total };

    const fix = ['Your previous answer did not pass validation.', '', 'Problems:', verdict.problem, '', 'Reply with the corrected JSON only: no commentary, no code fence. It must satisfy the schema exactly.'];
    // A live session already holds the prompt and the answer, so it only needs the problems. Other providers would replay the
    // whole conversation (Antigravity took twice as long), so they get the prompt and the answer again in a new one.
    const live = !!first.sessionId && funnel.sessions().some((x) => x.sessionId === first.sessionId);
    const repair = live
      ? { prompt: fix.join('\n'), sessionId: first.sessionId }
      : { prompt: [opts.prompt, '', '---', fix[0], '', 'Previous answer:', first.text.length > 12_000 ? `${first.text.slice(0, 12_000)}\n[truncated]` : first.text, '', ...fix.slice(2)].join('\n') };
    const second = await callOnce(ctx, funnel, opts, route, repair, jsonSchema);
    add(second.usage);
    const again = check(second);
    if (again.ok) return { text: second.text, data: again.data, route, usage: total };
    throw new TaskError(`The ${opts.role} model returned an invalid answer twice: ${again.problem}`, 'input', 'Retry, or choose a different model for this role.');
  } finally {
    // Only the repair turn uses the live process, so it closes as soon as the route is done.
    if (first.sessionId) funnel.closeSession(first.sessionId, route.provider as never);
  }
}

interface CallOutput { text: string; structured: unknown; usage: Usage; sessionId?: string }

/** One turn. With `sessionId` it continues that conversation, which already has the images. */
async function callOnce<T>(ctx: AppContext, funnel: FunnelLike, opts: RunRoleOptions<T>, route: Route, turn: { prompt: string; sessionId?: string }, jsonSchema: Record<string, unknown> | undefined): Promise<CallOutput> {
  const scratch = opts.web ? webFolder(ctx) : paths.scratch(ctx.config);
  mkdirSync(scratch, { recursive: true });
  const timeout = AbortSignal.timeout(llmTuning.callTimeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const started = Date.now();
  let ok = false;
  let usage: Usage = { inputTokens: null, outputTokens: null };
  try {
    const result = await funnel.run({
      selection: {
        provider: route.provider as never,
        model: route.model,
        ...(route.effort ? { effort: route.effort } : {}),
        cwd: scratch,
        access: opts.web ? 'supervised' : 'none',
      },
      ...(opts.web ? { onApproval: webOnly } : {}),
      system: opts.system,
      prompt: turn.prompt,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(opts.images?.length && !turn.sessionId ? { attachments: opts.images.map((b) => ({ type: 'image' as const, mediaType: 'image/png' as const, data: b.toString('base64') })) } : {}),
      ...(jsonSchema ? { responseSchema: { name: 'response', schema: jsonSchema } } : {}),
      signal,
    });
    if (result.usage && result.usage.totalTokens > 0) usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    if (result.finishReason === 'cancelled') throw cancelled(opts.signal, timeout);
    if (result.limit) {
      const f = limitFailure(result.limit, `The model stopped early (${result.finishReason}).`);
      if (result.finishReason !== 'stop') throw new RouteFailure(f);
      // The answer made it, but the provider said its limit is reached: the next calls start on another route.
      coolDown(route.provider, f);
    }
    // Retrying the same model would cut the answer off at the same place, so a truncated answer goes to the fallback.
    if (result.finishReason === 'length') throw new RouteFailure({ kind: 'temporary', message: 'The answer hit the model\'s output limit and was cut off.', truncated: true });
    if (result.finishReason !== 'stop') throw new RouteFailure({ kind: 'temporary', message: `The model stopped early (${result.finishReason}).` });
    ok = true;
    return { text: result.text, structured: result.structured, usage, sessionId: result.sessionId };
  } catch (err) {
    if (err instanceof RouteFailure || isAbort(err)) throw err;
    if (opts.signal?.aborted) throw opts.signal.reason ?? abortError();
    if (timeout.aborted) throw new RouteFailure({ kind: 'temporary', message: `Timed out after ${Math.round(llmTuning.callTimeoutMs / 1000)} s.`, timedOut: true });
    const f = classifyError(err);
    if (f.kind === 'aborted') throw opts.signal?.reason ?? abortError();
    throw new RouteFailure(f);
  } finally {
    ctx.db.insert('usage', {
      project_id: opts.projectId ?? null,
      run_id: opts.runId ?? null,
      task_id: opts.taskId ?? null,
      provider: route.provider,
      model: route.model,
      role: opts.role,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      ms: Date.now() - started,
      ok,
      created_at: now(),
    });
  }
}

/**
 * Working folder for web runs. Its Claude settings remove every tool that reads or changes this machine, so they are not
 * even offered to the model; the approval callback below is the second line and allows only the web tools.
 */
function webFolder(ctx: AppContext) {
  const dir = join(paths.scratch(ctx.config), 'web');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['WebSearch', 'WebFetch'], deny: ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'Task', 'Agent', 'mcp__*'] },
  }, null, 2));
  return dir;
}

/** Approval policy for web runs: searching and reading pages, nothing that touches this machine. */
const WEB_TOOLS = /^(WebSearch|WebFetch|web_search|web_fetch)$/;
export const webOnly = (req: { tool: string }) => (WEB_TOOLS.test(req.tool) ? 'allow' as const : 'deny' as const);

class AbortedByCaller extends Error {}
const abortError = () => Object.assign(new AbortedByCaller('Aborted'), { name: 'AbortError' });
const isAbort = (e: unknown) => e instanceof AbortedByCaller || (e instanceof Error && e.name === 'AbortError');

function cancelled(external: AbortSignal | undefined, timeout: AbortSignal): Error {
  if (external?.aborted) return (external.reason as Error) ?? abortError();
  if (timeout.aborted) return new RouteFailure({ kind: 'temporary', message: `Timed out after ${Math.round(llmTuning.callTimeoutMs / 1000)} s.`, timedOut: true });
  return new RouteFailure({ kind: 'temporary', message: 'The model run was cancelled.' });
}

// ---------- Probe ----------

const probeSchema = z.object({ kind: z.enum(['question', 'statement', 'command']) });
const PROBE_SENTENCES: [string, 'question' | 'statement' | 'command'][] = [
  ['Qual è la derivata di x al quadrato?', 'question'],
  ['Il teorema di Weierstrass garantisce l\'esistenza di massimo e minimo.', 'statement'],
  ['Calcola il limite per x che tende a zero di sin(x)/x.', 'command'],
];

/** One tiny structured call through the role's configured route, to check the whole path works. */
export async function probeRole(ctx: AppContext, role: Role): Promise<ProbeResult> {
  const started = Date.now();
  const [sentence, expected] = PROBE_SENTENCES[Math.floor(Math.random() * PROBE_SENTENCES.length)];
  try {
    const out = await runRole(ctx, {
      role,
      system: 'You classify Italian sentences. Reply with JSON only.',
      prompt: `Classify this sentence as "question", "statement" or "command":\n\n${sentence}`,
      schema: probeSchema,
    });
    const ms = Date.now() - started;
    const via = `${out.route.provider}/${out.route.model}`;
    return { ok: true, ms, detail: `${via} answered "${out.data.kind}"${out.data.kind === expected ? '' : ` (expected "${expected}")`}.` };
  } catch (err) {
    const ms = Date.now() - started;
    const action = err instanceof TaskError && err.action ? ` ${err.action}` : '';
    return { ok: false, ms, detail: `${err instanceof Error ? err.message : String(err)}${action}` };
  }
}

export type { ConnectionsResponse };
