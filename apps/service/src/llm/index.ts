// Model routing through cli-funnel. Callers name a role; settings map roles to provider/model with a fallback.
import { mkdirSync } from 'node:fs';
import type { ConnectionsResponse, ProbeResult, Role, Route } from '@smartbuilder/domain';
import { z } from 'zod';
import { TaskError } from '../queue/queue.ts';
import { paths } from '../config.ts';
import type { AppContext } from '../context.ts';
import { now } from '../db/db.ts';
import { classifyError, DEFAULT_QUOTA_WAIT_MS, loginAction, type Failure } from './errors.ts';
import { getFunnel, type FunnelLike } from './funnel.ts';
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
}

export interface RunRoleResult<T> { text: string; data: T; route: Route; usage: { inputTokens: number | null; outputTokens: number | null } }

/** Tunables that tests change. */
export const llmTuning = { callTimeoutMs: 10 * 60_000 };

/** Providers that hit a quota stay out of the first position until this time (epoch ms). */
const cooldown = new Map<string, number>();
export function resetLlmState() {
  cooldown.clear();
}

type Usage = { inputTokens: number | null; outputTokens: number | null };

/** Runs a prompt for a role. Throws TaskError with kind auth/quota/temporary/input so the queue can react. Falls back to the role's fallback route on quota/unavailable. */
export async function runRole<T = string>(ctx: AppContext, opts: RunRoleOptions<T>): Promise<RunRoleResult<T>> {
  const funnel = getFunnel();
  const needsImages = !!opts.images?.length;
  const canImages = (r: Route) => !!funnel.providers[r.provider]?.capabilities.images;

  const configured = ctx.settings().routes[opts.role];
  const primary = opts.route ?? configured.primary;
  const fallback = opts.route ? undefined : configured.fallback;

  let candidates: Route[];
  if (!needsImages) candidates = [primary, ...(fallback ? [fallback] : [])];
  else if (canImages(primary)) candidates = [primary, ...(fallback && canImages(fallback) ? [fallback] : [])];
  else if (fallback && canImages(fallback)) candidates = [fallback];
  else throw new TaskError(`The "${opts.role}" route (${primary.provider}/${primary.model}) cannot read images and there is no fallback that can.`, 'input', 'In Settings, pick a vision-capable model (Claude or Codex) for this role.');

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
        cooldown.set(route.provider, Date.now() + Math.min(f.retryAfterMs ?? DEFAULT_QUOTA_WAIT_MS, 10 * 60_000));
        firstQuota ??= f;
      }
      lastFailure = f;
      const canFallBack = i < candidates.length - 1 && (f.kind === 'quota' || f.kind === 'unavailable');
      if (canFallBack) continue;
      throw toTaskError(f, route, firstQuota, candidates.length > 1);
    }
  }
  throw new TaskError(lastFailure?.message ?? 'No route available', 'temporary');
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

  const first = await callOnce(ctx, funnel, opts, route, opts.prompt, jsonSchema);
  add(first.usage);
  if (!opts.schema) return { text: first.text, data: first.text as T, route, usage: total };

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
    const parsed = opts.schema!.safeParse(raw ? dropOptionalNulls(value, raw) : value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: describeIssues(parsed.error) };
  };

  const verdict = check(first);
  if (verdict.ok) return { text: first.text, data: verdict.data, route, usage: total };

  const repairPrompt = [
    opts.prompt,
    '',
    '---',
    'Your previous answer did not pass validation.',
    '',
    'Previous answer:',
    first.text.length > 12_000 ? `${first.text.slice(0, 12_000)}\n[truncated]` : first.text,
    '',
    'Problems:',
    verdict.problem,
    '',
    'Reply with the corrected JSON only: no commentary, no code fence. It must satisfy the schema exactly.',
  ].join('\n');
  const second = await callOnce(ctx, funnel, opts, route, repairPrompt, jsonSchema);
  add(second.usage);
  const again = check(second);
  if (again.ok) return { text: second.text, data: again.data, route, usage: total };
  throw new TaskError(`The ${opts.role} model returned an invalid answer twice: ${again.problem}`, 'input', 'Retry, or choose a different model for this role.');
}

interface CallOutput { text: string; structured: unknown; usage: Usage }

async function callOnce<T>(ctx: AppContext, funnel: FunnelLike, opts: RunRoleOptions<T>, route: Route, prompt: string, jsonSchema: Record<string, unknown> | undefined): Promise<CallOutput> {
  const scratch = paths.scratch(ctx.config);
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
        access: 'none',
      },
      system: opts.system,
      prompt,
      ...(opts.images?.length ? { attachments: opts.images.map((b) => ({ type: 'image' as const, mediaType: 'image/png' as const, data: b.toString('base64') })) } : {}),
      ...(jsonSchema ? { responseSchema: { name: 'response', schema: jsonSchema } } : {}),
      signal,
    });
    if (result.usage && result.usage.totalTokens > 0) usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    if (result.finishReason === 'cancelled') throw cancelled(opts.signal, timeout);
    if (result.finishReason !== 'stop') throw new RouteFailure({ kind: 'temporary', message: `The model stopped early (${result.finishReason}).` });
    ok = true;
    return { text: result.text, structured: result.structured, usage };
  } catch (err) {
    if (err instanceof RouteFailure || isAbort(err)) throw err;
    if (opts.signal?.aborted) throw opts.signal.reason ?? abortError();
    if (timeout.aborted) throw new RouteFailure({ kind: 'temporary', message: `Timed out after ${Math.round(llmTuning.callTimeoutMs / 1000)} s.` });
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

class AbortedByCaller extends Error {}
const abortError = () => Object.assign(new AbortedByCaller('Aborted'), { name: 'AbortError' });
const isAbort = (e: unknown) => e instanceof AbortedByCaller || (e instanceof Error && e.name === 'AbortError');

function cancelled(external: AbortSignal | undefined, timeout: AbortSignal): Error {
  if (external?.aborted) return (external.reason as Error) ?? abortError();
  if (timeout.aborted) return new RouteFailure({ kind: 'temporary', message: `Timed out after ${Math.round(llmTuning.callTimeoutMs / 1000)} s.` });
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
