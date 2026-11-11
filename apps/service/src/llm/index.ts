// Model routing through cli-funnel. Callers name a role; settings map roles to provider/model with a fallback.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookOptionsSchema, type BookOptions, type ConnectionsResponse, type ProbeResult, type Role, type Route } from '@smartbuilder/domain';
import { sanitizeModelCode, sanitizeModelValue } from '@smartbuilder/content';
import { z } from 'zod';
import { TaskError } from '../queue/queue.ts';
import { paths } from '../config.ts';
import type { AppContext } from '../context.ts';
import { json, now } from '../db/db.ts';
import { classifyError, DEFAULT_QUOTA_WAIT_MS, limitFailure, limitWaitMs, loginAction, type Failure } from './errors.ts';
import { accountUsage, getFunnel, type FunnelLike } from './funnel.ts';
import { claudeWebEnv, codexEnv } from './homes.ts';
import { ProviderSlots } from './slots.ts';
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
  /**
   * For an answer that is not JSON (Markdown, code, a text block with a small header). Gets the answer text with terminal
   * codes and control characters removed, and nothing else cleaned. When it rejects, one repair turn sends its `problem`
   * and asks for the full corrected answer, as for a schema. No provider JSON schema is sent. Not together with `schema`.
   */
  parse?: (text: string) => ParseResult<T>;
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

export type ParseResult<T> = { ok: true; data: T } | { ok: false; problem: string };

export interface RunRoleResult<T> { text: string; data: T; route: Route; usage: { inputTokens: number | null; outputTokens: number | null } }

/** Tunables that tests change. */
export const llmTuning = { callTimeoutMs: 10 * 60_000 };

/**
 * Roles whose calls are short: p99 of 29 to 110 s on Codex (checker, bulk, vision, editor), and the longest healthy call in
 * the usage table is 254 s. A hung one used to hold a Codex slot for 10 minutes, 23 times in 30 days.
 */
const SHORT_CALL_ROLES: readonly Role[] = ['checker', 'bulk', 'vision', 'evidence', 'editor'];
const SHORT_CALL_MS = 3 * 60_000;

/**
 * How long one call may run. Antigravity runs a whole agent per call (344 to 603 s at the median), so it keeps the long limit
 * in every role.
 */
export function callTimeoutMs(role: Role, route: Route): number {
  return SHORT_CALL_ROLES.includes(role) && route.provider !== 'antigravity' ? Math.min(llmTuning.callTimeoutMs, SHORT_CALL_MS) : llmTuning.callTimeoutMs;
}

/** One limiter per app context: the provider's concurrency setting counts every call, whichever role pool or fallback it comes from. */
const slotsByContext = new WeakMap<AppContext, ProviderSlots>();
function slotsFor(ctx: AppContext): ProviderSlots {
  let slots = slotsByContext.get(ctx);
  if (!slots) {
    slots = new ProviderSlots((provider) => ctx.settings().concurrency[provider] ?? 1);
    slotsByContext.set(ctx, slots);
  }
  return slots;
}

/** The book's options, which decide how its calls are routed. Defaults for a call without a book. */
function bookOptions(ctx: AppContext, projectId: string | null | undefined): BookOptions {
  const row = projectId ? ctx.db.get<{ options: string }>('SELECT options FROM projects WHERE id = ?', projectId) : undefined;
  return bookOptionsSchema.parse(json(row?.options, {}));
}

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

/** Milliseconds until a provider that reported its limit may be called again; zero or less when it may. */
const coolingFor = (provider: string) => (cooldown.get(provider) ?? 0) - Date.now();
const isReady = (r: Route) => coolingFor(r.provider) <= 0;

/** The error of a call that was not made because every route of the role is on a provider that reported its limit. The task waits for the shortest reset. */
function limitWait(routes: Route[]): TaskError {
  const where = routes.map((r) => `${r.provider}/${r.model}`).join(', ');
  return new TaskError(`${where}: usage limit reached (the provider reported it earlier, so no call was made).`, 'quota', 'Wait for the limit to reset, or pick another model in Settings.', Math.max(1000, Math.min(...routes.map((r) => coolingFor(r.provider)))));
}

type Usage = { inputTokens: number | null; outputTokens: number | null };

/** Runs a prompt for a role. Throws TaskError with kind auth/quota/temporary/input so the queue can react. Falls back to the role's fallback route on quota, unavailable, a timeout or a truncated answer. */
export async function runRole<T = string>(ctx: AppContext, opts: RunRoleOptions<T>): Promise<RunRoleResult<T>> {
  const talk = await openRole(ctx, opts);
  talk.close();
  return talk.result;
}

/** What a follow-up message got back. */
export interface FollowUp { text: string; usage: Usage }

/** A follow-up that failed. It has the kind, action and wait of the TaskError a first call would have thrown. The caller decides what to do, usually to keep what it has. */
export class FollowUpError extends TaskError {}

/** The answer to a first call, and the conversation it started. Follow-ups go to the model that answered, on the route that answered. */
export interface RoleConversation<T> {
  readonly result: RunRoleResult<T>;
  /**
   * Sends one more message. A live session gets only the message. Without one (a provider that keeps no process, or a
   * session that died) a new conversation carries the system prompt, the first prompt, the last answer and the message.
   * Images need a route that reads them. Throws FollowUpError when the route fails, and the abort reason when the
   * caller's signal aborts. Each call is a usage row and holds one provider slot while it runs.
   */
  send(prompt: string, options?: { images?: Buffer[] }): Promise<FollowUp>;
  /** Ends the model's process. Safe to call again. */
  close(): void;
}

/**
 * Like runRole, but keeps the conversation open for follow-up messages. The caller must call close(), and withRole does
 * it. The funnel closes a session that sits idle for a minute, so a leak ends there.
 */
export async function openRole<T = string>(ctx: AppContext, opts: RunRoleOptions<T>): Promise<RoleConversation<T>> {
  const { result, convo } = await startConversation(ctx, opts);
  return { result, send: (prompt, options) => convo.send(prompt, options?.images), close: () => convo.close() };
}

/** openRole with the close in a finally, so a throwing callback cannot leak the session. */
export async function withRole<T, R>(ctx: AppContext, opts: RunRoleOptions<T>, use: (talk: RoleConversation<T>) => Promise<R>): Promise<R> {
  const talk = await openRole(ctx, opts);
  try {
    return await use(talk);
  } finally {
    talk.close();
  }
}

async function startConversation<T>(ctx: AppContext, opts: RunRoleOptions<T>): Promise<{ result: RunRoleResult<T>; convo: Conversation }> {
  if (opts.schema && opts.parse) throw new Error('A call takes a schema or a parse function, not both.');
  const funnel = getFunnel();
  const needsImages = !!opts.images?.length;
  const canImages = (r: Route) => routeReadsImages(funnel, r);
  // Claude only: its tools can be switched off by the settings file in the web folder (see webFolder). Codex runs
  // commands it considers safe, such as cat, without asking, so a page could get it to read local files.
  const canWeb = (r: Route) => r.provider === 'claude' && !!funnel.providers[r.provider]?.capabilities.access?.includes('supervised');

  const configured = ctx.settings().routes[opts.role];
  const primary = opts.route ?? configured.primary;
  // A book that must not continue on a replacement when Claude runs out: a role that starts on Claude waits for the reset instead.
  const stayOnClaude = primary.provider === 'claude' && bookOptions(ctx, opts.projectId).noClaudeFallback;
  const fallback = opts.route || stayOnClaude ? undefined : configured.fallback;

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
  if (opts.taskId && candidates.length > 1 && timedOutBefore(ctx, opts.taskId, opts.role, candidates[0])) candidates = [...candidates.slice(1), candidates[0]];

  // Codex reports its usage windows, so a full one sends the role to the next route without a failed call first.
  if (candidates.length > 1) {
    await Promise.all(candidates.map(async (c) => {
      const limit = (await accountUsage(c.provider, ctx.config))?.limit;
      if (limit) coolDown(c.provider, { retryAfterMs: limitWaitMs(limit), reported: true });
    }));
  }

  // A provider that reported its limit gets no call until its reset. The role goes on with its other routes, and with none left the task waits.
  const ready = candidates.filter(isReady);
  if (!ready.length) throw limitWait(candidates);
  candidates = ready;

  let firstQuota: Failure | undefined;
  let lastFailure: Failure | undefined;
  let lastRoute: Route | undefined;
  const calls = { n: 0 };
  for (let i = 0; i < candidates.length; i++) {
    const route = candidates[i];
    // The provider's slot is taken for the route actually used, and the call's timeout starts only after it.
    const release = await slotsFor(ctx).acquire(route.provider, opts.signal);
    try {
      // A call that waited for its slot may find that another call reported the provider's limit meanwhile, and a fallback may be on the provider that just did.
      if (!isReady(route)) {
        if (candidates.slice(i + 1).some(isReady)) continue;
        throw lastFailure ? toTaskError(lastFailure, lastRoute!, firstQuota, candidates.length > 1) : limitWait([route]);
      }
      return await attemptRoute(ctx, funnel, opts, route, { calls, fallback: route === fallback });
    } catch (err) {
      if (!(err instanceof RouteFailure)) throw err;
      const f = err.failure;
      if (f.kind === 'quota') {
        coolDown(route.provider, f);
        firstQuota ??= f;
      }
      lastFailure = f;
      lastRoute = route;
      // A call that hangs until the timeout, or an answer cut off at the output limit, usually repeats on the same model, so the fallback gets the next try.
      const canFallBack = candidates.slice(i + 1).some(isReady) && (f.kind === 'quota' || f.kind === 'unavailable' || !!f.timedOut || !!f.truncated);
      if (canFallBack) continue;
      throw toTaskError(f, route, firstQuota, candidates.length > 1);
    } finally {
      release();
    }
  }
  throw new TaskError(lastFailure?.message ?? 'No route available', 'temporary');
}

const routeReadsImages = (funnel: FunnelLike, r: Route) => !!funnel.providers[r.provider]?.capabilities.images;

/** The same task key, in an earlier run within the last two weeks, hit the call timeout on this route. */
function timedOutBefore(ctx: AppContext, taskId: string, role: Role, route: Route): boolean {
  return !!ctx.db.get(
    `SELECT 1 FROM usage u JOIN tasks t ON t.id = u.task_id
     WHERE t.key = (SELECT key FROM tasks WHERE id = ?) AND t.project_id = (SELECT project_id FROM tasks WHERE id = ?) AND t.id <> ?
       AND u.role = ? AND u.provider = ? AND u.model = ? AND u.ok = 0 AND u.ms >= ? AND u.created_at > ? LIMIT 1`,
    taskId, taskId, taskId, role, route.provider, route.model, callTimeoutMs(role, route), new Date(Date.now() - 14 * 86_400_000).toISOString());
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
    case 'unavailable': return new TaskError(`${where}: ${f.message}`, 'auth', 'Install the CLI or pick another model in Settings, then press Continue.');
    case 'input': return new TaskError(`${where}: ${f.message}`, 'input');
    case 'fatal': return new TaskError(`${where}: ${f.message}`, 'fatal', 'Check the model and effort for this role in Settings.');
    default: return new TaskError(`${where}: ${f.message}`, 'temporary');
  }
}

/** What a usage row records besides the call itself: its number within the runRole call, and whether the route is the fallback. */
interface CallMeta { calls: { n: number }; fallback: boolean }

/** The first turn on one route, with its repair turn. The conversation stays open for the caller, except when the call fails. */
async function attemptRoute<T>(ctx: AppContext, funnel: FunnelLike, opts: RunRoleOptions<T>, route: Route, meta: CallMeta): Promise<{ result: RunRoleResult<T>; convo: Conversation }> {
  const raw = opts.schema ? rawJsonSchema(opts.schema) : undefined;
  const jsonSchema = opts.parse ? undefined : (opts.jsonSchema ?? (raw ? strictify(raw) : undefined));
  const total: Usage = { inputTokens: null, outputTokens: null };
  const add = (u: Usage) => {
    for (const k of ['inputTokens', 'outputTokens'] as const) if (u[k] !== null) total[k] = (total[k] ?? 0) + u[k]!;
  };

  const checkSchema = (r: CallOutput): { ok: true; data: T } | { ok: false; problem: string } => {
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
    const parsed = opts.schema!.safeParse(sanitizeModelValue(raw ? dropOptionalNulls(value, raw) : value, raw));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: describeIssues(parsed.error) };
  };
  // A parse function gets the text with only the terminal codes and control characters removed: the caller cleans the rest.
  const check = (r: CallOutput): { ok: true; data: T; text: string } | { ok: false; problem: string } => {
    if (!opts.parse) {
      const v = checkSchema(r);
      return v.ok ? { ...v, text: r.text } : v;
    }
    const text = sanitizeModelCode(r.text);
    const v = opts.parse(text);
    return v.ok ? { ok: true, data: v.data, text } : v;
  };

  const convo = new Conversation(ctx, funnel, opts, route, meta);
  try {
    const first = await convo.first(jsonSchema);
    add(first.usage);
    if (!opts.schema && !opts.parse) return { result: { text: first.text, data: first.text as T, route, usage: total }, convo };
    const verdict = check(first);
    if (verdict.ok) return { result: { text: verdict.text, data: verdict.data, route, usage: total }, convo };

    const fix = opts.parse
      ? ['Your previous answer could not be used.', '', 'Problems:', verdict.problem, '', 'Reply with the full corrected answer in the same format as before, not only the parts that change.']
      : ['Your previous answer did not pass validation.', '', 'Problems:', verdict.problem, '', 'Reply with the corrected JSON only: no commentary, no code fence. It must satisfy the schema exactly.'];
    const second = await convo.next(fix.join('\n'), { jsonSchema });
    add(second.usage);
    const again = check(second);
    if (again.ok) return { result: { text: again.text, data: again.data, route, usage: total }, convo };
    throw new TaskError(`The ${opts.role} model returned an invalid answer twice: ${again.problem}`, 'input', 'Retry, or choose a different model for this role.');
  } catch (err) {
    convo.close();
    throw err;
  }
}

/** The text the model gets when its conversation cannot be continued: what it was asked, what it said last, and the new message. */
function replayPrompt(firstPrompt: string, lastAnswer: string, message: string): string {
  // The guard keeps a runaway answer from doubling the size of the prompt.
  const answer = lastAnswer.length > 12_000 ? `${lastAnswer.slice(0, 12_000)}\n[truncated]` : lastAnswer;
  return [firstPrompt, '', '---', 'Your previous answer to the request above:', '', answer, '', '---', message].join('\n');
}

/**
 * One conversation with the model of one route. The first turn and every later turn go through callOnce, so they share the
 * timeout, the abort signal, the private homes and the usage rows. A live session gets only the new message. Other providers
 * would replay the whole conversation (Antigravity took twice as long), so they get the prompt and the last answer again in a new one.
 */
class Conversation {
  private sessionId: string | undefined;
  /** Every session a turn reported, so close() ends a replayed one too. */
  private readonly sessionIds = new Set<string>();
  private lastText = '';
  private closed = false;

  constructor(private readonly ctx: AppContext, private readonly funnel: FunnelLike, private readonly opts: RunRoleOptions<unknown>, readonly route: Route, private readonly meta: CallMeta) {}

  first(jsonSchema: Record<string, unknown> | undefined): Promise<CallOutput> {
    return this.call({ prompt: this.opts.prompt, images: this.opts.images }, jsonSchema);
  }

  /** The next turn: the message alone in a live session, or the whole conversation in a new one. */
  next(message: string, extra: { images?: Buffer[]; jsonSchema?: Record<string, unknown> } = {}): Promise<CallOutput> {
    const live = !!this.sessionId && this.funnel.sessions().some((x) => x.sessionId === this.sessionId);
    return this.call(
      live ? { prompt: message, sessionId: this.sessionId, images: extra.images } : { prompt: replayPrompt(this.opts.prompt, this.lastText, message), images: [...(this.opts.images ?? []), ...(extra.images ?? [])] },
      extra.jsonSchema,
    );
  }

  private async call(turn: { prompt: string; sessionId?: string; images?: Buffer[] }, jsonSchema: Record<string, unknown> | undefined): Promise<CallOutput> {
    const out = await callOnce(this.ctx, this.funnel, this.opts, this.route, this.meta, turn, jsonSchema);
    if (out.sessionId) {
      this.sessionId = out.sessionId;
      this.sessionIds.add(out.sessionId);
      // A call that was running when the handle was closed must not leave its session behind.
      if (this.closed) this.funnel.closeSession(out.sessionId, this.route.provider as never);
    }
    this.lastText = out.text;
    return out;
  }

  /** A follow-up from the caller. It takes a provider slot for the call only, so a caller that works between turns blocks nobody. */
  async send(prompt: string, images?: Buffer[]): Promise<FollowUp> {
    if (this.closed) throw new FollowUpError('The conversation is closed.', 'input');
    if (images?.length && !routeReadsImages(this.funnel, this.route)) throw new FollowUpError(`${this.route.provider}/${this.route.model} cannot read images.`, 'input');
    const release = await slotsFor(this.ctx).acquire(this.route.provider, this.opts.signal);
    try {
      // The handle may have been closed while this call waited for its slot.
      if (this.closed) throw new FollowUpError('The conversation is closed.', 'input');
      const out = await this.next(prompt, { images });
      return { text: out.text, usage: out.usage };
    } catch (err) {
      if (!(err instanceof RouteFailure)) throw err;
      if (err.failure.kind === 'quota') coolDown(this.route.provider, err.failure);
      const t = toTaskError(err.failure, this.route, undefined, false);
      throw new FollowUpError(t.message, t.kind, t.action, t.retryAfterMs);
    } finally {
      release();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.sessionIds) this.funnel.closeSession(id, this.route.provider as never);
  }
}

interface CallOutput { text: string; structured: unknown; usage: Usage; sessionId?: string }

/** The environment of a call: Codex runs in the service's own home, and a web call runs Claude Code in one without the owner's setup. */
function callEnv(ctx: AppContext, route: Route, web: boolean | undefined): Record<string, string> | undefined {
  if (route.provider === 'codex') return codexEnv(ctx.config);
  if (route.provider === 'claude' && web) return claudeWebEnv(ctx.config);
  return undefined;
}

/** The short word stored with a failed call. */
const errorKind = (f: Failure) => (f.timedOut ? 'timeout' : f.truncated ? 'truncated' : f.kind);

/** One turn. With `sessionId` it continues that conversation, and `images` are the ones that turn adds. */
async function callOnce<T>(ctx: AppContext, funnel: FunnelLike, opts: RunRoleOptions<T>, route: Route, meta: CallMeta, turn: { prompt: string; sessionId?: string; images?: Buffer[] }, jsonSchema: Record<string, unknown> | undefined): Promise<CallOutput> {
  const scratch = opts.web ? webFolder(ctx) : paths.scratch(ctx.config);
  mkdirSync(scratch, { recursive: true });
  const timeoutMs = callTimeoutMs(opts.role, route);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const env = callEnv(ctx, route, opts.web);
  const attempt = ++meta.calls.n;
  const started = Date.now();
  let ok = false;
  let failure: string | null = null;
  let usage: Usage = { inputTokens: null, outputTokens: null };
  let cached: { read: number | null; created: number | null } = { read: null, created: null };
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
      ...(opts.web && route.provider === 'claude' ? { providerOptions: { claude: { disallowedTools: NON_WEB_TOOLS } } } : {}),
      ...(env ? { env } : {}),
      system: opts.system,
      prompt: turn.prompt,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(turn.images?.length ? { attachments: turn.images.map((b) => ({ type: 'image' as const, mediaType: 'image/png' as const, data: b.toString('base64') })) } : {}),
      ...(jsonSchema ? { responseSchema: { name: 'response', schema: jsonSchema } } : {}),
      signal,
    });
    if (result.usage && result.usage.totalTokens > 0) {
      usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
      cached = { read: result.usage.cachedInputTokens ?? null, created: result.usage.cacheCreationInputTokens ?? null };
    }
    if (result.finishReason === 'cancelled') throw cancelled(opts.signal, timeout, timeoutMs);
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
    if (err instanceof RouteFailure) {
      failure = errorKind(err.failure);
      throw err;
    }
    if (isAbort(err)) {
      failure = 'aborted';
      throw err;
    }
    if (opts.signal?.aborted) {
      failure = 'aborted';
      throw opts.signal.reason ?? abortError();
    }
    if (timeout.aborted) {
      failure = 'timeout';
      throw new RouteFailure({ kind: 'temporary', message: `Timed out after ${Math.round(timeoutMs / 1000)} s.`, timedOut: true });
    }
    const f = classifyError(err);
    failure = errorKind(f);
    if (f.kind === 'aborted') throw opts.signal?.reason ?? abortError();
    throw new RouteFailure(f);
  } finally {
    // A CLI that refreshed its token may have replaced the login link with a file. Putting that login back now, and not
    // only before the next call, keeps the time in which the owner's own CLI holds a stale token to this one call.
    if (env) callEnv(ctx, route, opts.web);
    ctx.db.insert('usage', {
      project_id: opts.projectId ?? null,
      run_id: opts.runId ?? null,
      task_id: opts.taskId ?? null,
      provider: route.provider,
      model: route.model,
      role: opts.role,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_input_tokens: cached.read,
      cache_creation_tokens: cached.created,
      error_kind: failure,
      attempt,
      fallback: meta.fallback ? 1 : 0,
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

/**
 * Claude Code's other built-in tools. A denied tool is not offered to the model at all, so its definition costs no input
 * tokens. A tool added in a later Claude Code version is not on this list: the project settings and the approval callback
 * still refuse it, it just costs its definition.
 */
const NON_WEB_TOOLS = [
  'Agent', 'Task', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'AskUserQuestion', 'Bash', 'BashOutput', 'KillShell',
  'Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'Skill', 'SlashCommand', 'ToolSearch', 'Monitor', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'RemoteTrigger',
  'SendMessage', 'ListAgents', 'Workflow', 'Artifact', 'ArtifactComments', 'ArtifactData', 'ArtifactCheck', 'DesignSync', 'ReportFindings',
  'SendToProject', 'SendToProjectContext', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
];

/** Approval policy for web runs: searching and reading pages, nothing that touches this machine. */
const WEB_TOOLS = /^(WebSearch|WebFetch|web_search|web_fetch)$/;
export const webOnly = (req: { tool: string }) => (WEB_TOOLS.test(req.tool) ? 'allow' as const : 'deny' as const);

class AbortedByCaller extends Error {}
const abortError = () => Object.assign(new AbortedByCaller('Aborted'), { name: 'AbortError' });
const isAbort = (e: unknown) => e instanceof AbortedByCaller || (e instanceof Error && e.name === 'AbortError');

function cancelled(external: AbortSignal | undefined, timeout: AbortSignal, timeoutMs: number): Error {
  if (external?.aborted) return (external.reason as Error) ?? abortError();
  if (timeout.aborted) return new RouteFailure({ kind: 'temporary', message: `Timed out after ${Math.round(timeoutMs / 1000)} s.`, timedOut: true });
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
