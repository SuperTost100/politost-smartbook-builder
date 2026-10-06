// The `nlm` CLI (notebooklm-mcp-cli). Every call goes through an injectable runner that uses execFile with an args array.
import { execFile } from 'node:child_process';
import { TaskError } from '../queue/queue.ts';
import { parseJsonAnswer } from '../llm/schema.ts';

export const NLM_LOGIN_COMMAND = 'NLM_BROWSER_PATH=<browser> uvx --from notebooklm-mcp-cli nlm login --storage file';
export const NLM_LOGIN_ACTION = `Sign in to NotebookLM: run "${NLM_LOGIN_COMMAND}" in a terminal, then press Retry.`;

export interface NlmResult { stdout: string; stderr: string; code: number }
export interface NlmRunOptions { signal?: AbortSignal; timeoutMs?: number }
/** Runs `nlm <args>`. Resolves with the exit code for ordinary failures; rejects for a missing binary, a timeout or an abort. */
export type NlmRunner = (args: string[], opts?: NlmRunOptions) => Promise<NlmResult>;

export class NlmMissingError extends Error {
  constructor() {
    super('The nlm command was not found on PATH.');
  }
}

const defaultRunner: NlmRunner = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile('nlm', args, { timeout: opts.timeoutMs ?? 120_000, signal: opts.signal, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr, code: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string };
      if (e.code === 'ENOENT') return reject(new NlmMissingError());
      if (e.name === 'AbortError' || opts.signal?.aborted) return reject(opts.signal?.reason ?? e);
      if (e.killed || e.signal === 'SIGTERM') return reject(new TaskError(`nlm ${args.slice(0, 2).join(' ')} timed out.`, 'temporary'));
      resolve({ stdout, stderr, code: typeof e.code === 'number' ? e.code : 1 });
    });
  });

let runner: NlmRunner = defaultRunner;
/** Replace the command runner (tests). Pass null to restore the real one. */
export function setNlmRunner(fn: NlmRunner | null) {
  runner = fn ?? defaultRunner;
  resetNlmCache();
}
export const runNlm: NlmRunner = (args, opts) => runner(args, opts);

// ---------- Failure mapping ----------

const SOURCE_LIMIT = /(source.{0,40}(limit|maximum|exceed|too many|full))|((limit|maximum|at most|too many).{0,40}sources)|notebook.{0,20}\bfull\b/i;
const RATE_LIMIT = /rate.?limit|quota|usage (limit|window)|too many requests|\b429\b/i;
const NLM_AUTH = /cookies? (have |has )?expired|authentication (may have )?(expired|failed|required)|not (logged|signed) in|log ?in required|please (run )?.{0,20}login|unauthori[sz]ed|\b401\b|re-?authenticat/i;

export function isSourceLimit(text: string): boolean {
  return SOURCE_LIMIT.test(text) && !RATE_LIMIT.test(text);
}

/** Turns nlm's error text into a TaskError the queue understands. */
export function nlmFailure(text: string, retryAfterMs?: number): TaskError {
  const msg = text.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400) || 'nlm failed.';
  if (NLM_AUTH.test(text)) return new TaskError(`NotebookLM: ${msg}`, 'auth', NLM_LOGIN_ACTION);
  if (RATE_LIMIT.test(text)) return new TaskError(`NotebookLM: ${msg}`, 'quota', 'NotebookLM has its own usage limit; it resets on its own.', retryAfterMs);
  return new TaskError(`NotebookLM: ${msg}`, 'temporary');
}

/** Runs nlm and returns parsed JSON; throws TaskError on any failure. */
export async function nlmJson(args: string[], opts?: NlmRunOptions): Promise<unknown> {
  let res: NlmResult;
  try {
    res = await runNlm(args, opts);
  } catch (err) {
    if (err instanceof NlmMissingError) throw new TaskError(err.message, 'fatal', 'Install notebooklm-mcp-cli (uv tool install notebooklm-mcp-cli).');
    throw err;
  }
  const text = `${res.stdout}\n${res.stderr}`;
  let value: unknown;
  try {
    value = parseNlmJson(res.stdout);
  } catch {
    value = undefined;
  }
  const errText = isErrorBody(value) ? String((value as { error: unknown }).error) + (((value as { hint?: unknown }).hint) ? ` ${String((value as { hint: unknown }).hint)}` : '') : null;
  if (res.code !== 0 || errText) throw new NlmCallError(errText ?? text);
  if (value === undefined) throw new TaskError(`NotebookLM returned something that is not JSON: ${res.stdout.slice(0, 200)}`, 'temporary');
  return value;
}

/** Raw failure text, mapped to a TaskError by callers once they know whether it is a source-limit problem. */
export class NlmCallError extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

const isErrorBody = (v: unknown) => typeof v === 'object' && v !== null && (v as { status?: unknown }).status === 'error' && 'error' in v;

export function parseNlmJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through: warnings may precede the JSON */
  }
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[{[]/.test(lines[i])) {
      try {
        return JSON.parse(lines.slice(i).join('\n'));
      } catch {
        /* keep looking */
      }
    }
  }
  return parseJsonAnswer(trimmed);
}

/** Runs nlmJson and maps NlmCallError to TaskError. */
export async function nlmCall(args: string[], opts?: NlmRunOptions, retryAfter?: () => Promise<number | undefined>): Promise<unknown> {
  try {
    return await nlmJson(args, opts);
  } catch (err) {
    if (err instanceof NlmCallError) {
      resetNlmCache();
      throw nlmFailure(err.text, RATE_LIMIT.test(err.text) ? await retryAfter?.() : undefined);
    }
    throw err;
  }
}

// ---------- Typed operations ----------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

export async function createNotebook(title: string, signal?: AbortSignal): Promise<string> {
  const out = rec(await nlmCall(['notebook', 'create', title, '--json'], { signal, timeoutMs: 60_000 }));
  const id = str(out.notebook_id) ?? str(out.id) ?? str(rec(out.notebook).id);
  if (!id) throw new TaskError('NotebookLM did not return a notebook id.', 'temporary');
  return id;
}

export interface RemoteSource { id: string; title: string }

export async function listSources(notebookId: string, signal?: AbortSignal): Promise<RemoteSource[]> {
  const out = await nlmCall(['source', 'list', notebookId, '--json'], { signal, timeoutMs: 60_000 });
  const arr = Array.isArray(out) ? out : Array.isArray(rec(out).sources) ? (rec(out).sources as unknown[]) : [];
  return arr.flatMap((s) => {
    const r = rec(s);
    const id = str(r.id) ?? str(r.source_id);
    return id ? [{ id, title: str(r.title) ?? '' }] : [];
  });
}

/** Uploads a local file as a source with the given title; waits until NotebookLM has processed it. Raises NlmCallError (raw) on failure so callers can detect a full notebook. */
export async function addFileSource(notebookId: string, file: string, title: string, signal?: AbortSignal): Promise<string> {
  const out = rec(await nlmJson(['source', 'add', notebookId, '--file', file, '--title', title, '--wait', '--json'], { signal, timeoutMs: 12 * 60_000 }));
  const id = str(out.source_id) ?? str(out.id);
  if (!id) throw new TaskError('NotebookLM did not return a source id.', 'temporary');
  return id;
}

export interface QueryReference { source_id: string; citation_number: number; cited_text: string }
export interface QueryResponse { answer: string; references: QueryReference[]; sources_used: string[]; conversation_id?: string }

export async function queryNotebook(notebookId: string, question: string, sourceIds: string[], signal?: AbortSignal): Promise<QueryResponse> {
  const args = ['notebook', 'query', notebookId, question, '--json', '--new-conversation', '--timeout', '180'];
  if (sourceIds.length) args.push('--source-ids', sourceIds.join(','));
  const out = rec(await nlmCall(args, { signal, timeoutMs: 240_000 }, usageRetryAfter));
  const answer = str(out.answer);
  if (answer === undefined) throw new TaskError('NotebookLM returned no answer.', 'temporary');
  const references = (Array.isArray(out.references) ? out.references : []).flatMap((r): QueryReference[] => {
    const x = rec(r);
    const n = Number(x.citation_number);
    const source = str(x.source_id);
    const text = str(x.cited_text);
    return source && text && Number.isFinite(n) ? [{ source_id: source, citation_number: n, cited_text: text }] : [];
  });
  return { answer, references, sources_used: Array.isArray(out.sources_used) ? out.sources_used.filter((s): s is string => typeof s === 'string') : [], conversation_id: str(out.conversation_id) };
}

export async function deleteNotebook(notebookId: string, signal?: AbortSignal): Promise<void> {
  await nlmCall(['notebook', 'delete', notebookId, '--confirm', '--json'], { signal, timeoutMs: 60_000 });
}

export async function deleteSource(sourceId: string, signal?: AbortSignal): Promise<void> {
  await nlmCall(['source', 'delete', sourceId, '--confirm', '--json'], { signal, timeoutMs: 60_000 });
}

// ---------- Status and usage ----------

export interface NotebookStatus { installed: boolean; signedIn: boolean; account: string | null; usage: { window: string; remaining: string }[]; error: string | null }

interface UsageReport { windows: { window: string; percent_used: number; percent_remaining: number; resets_at: string }[]; tier?: string }

let statusCache: { at: number; value: NotebookStatus; tier: string | null } | null = null;
const STATUS_TTL_MS = 60_000;

export function resetNlmCache() {
  statusCache = null;
}

async function fetchUsage(): Promise<UsageReport | null> {
  try {
    const res = await runNlm(['usage', '--json'], { timeoutMs: 30_000 });
    if (res.code !== 0) return null;
    const v = rec(parseNlmJson(res.stdout));
    const windows = (Array.isArray(v.windows) ? v.windows : []).map((w) => rec(w)).filter((w) => typeof w.window === 'string') as unknown as UsageReport['windows'];
    return { windows, tier: str(v.tier) };
  } catch {
    return null;
  }
}

/** When the soonest exhausted NotebookLM window resets, as a wait in ms. */
export async function usageRetryAfter(): Promise<number | undefined> {
  const u = await fetchUsage();
  if (!u) return undefined;
  const exhausted = u.windows.filter((w) => Number(w.percent_remaining) <= 0.5 && typeof w.resets_at === 'string');
  const times = exhausted.map((w) => Date.parse(w.resets_at) - Date.now()).filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? Math.min(...times) : undefined;
}

/** NotebookLM availability for the Connections screen. Cached for 60 s unless fresh is set. */
export async function notebookStatus(opts: { fresh?: boolean } = {}): Promise<NotebookStatus> {
  if (!opts.fresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const fail = (installed: boolean, error: string): NotebookStatus => ({ installed, signedIn: false, account: null, usage: [], error });
  let value: NotebookStatus;
  let tier: string | null = null;
  try {
    const res = await runNlm(['login', '--check'], { timeoutMs: 45_000 });
    const text = `${res.stdout}\n${res.stderr}`;
    if (res.code === 0 && !/not authenticated|expired|invalid|failed|error/i.test(text.replace(/authentication valid/i, ''))) {
      const account = /Account:\s*(\S+)/i.exec(text)?.[1] ?? null;
      const usage = await fetchUsage();
      tier = usage?.tier ?? null;
      value = {
        installed: true,
        signedIn: true,
        account,
        usage: (usage?.windows ?? []).map((w) => ({
          window: w.window,
          remaining: `${Number(w.percent_remaining).toFixed(1)}% left, resets ${w.resets_at}`,
        })),
        error: null,
      };
    } else {
      const line = text.split('\n').map((l) => l.replace(/[✓✗✘×]/g, '').trim()).filter(Boolean).slice(-2).join(' ');
      value = fail(true, line || 'Not signed in to NotebookLM.');
    }
  } catch (err) {
    value = err instanceof NlmMissingError ? fail(false, 'The nlm command was not found. Install notebooklm-mcp-cli.') : fail(true, err instanceof Error ? err.message : String(err));
  }
  statusCache = { at: Date.now(), value, tier };
  return value;
}

/** Sources one notebook can hold: Plus/Pro/Ultra accounts get far more than the free tier. A margin is kept. */
export async function notebookCapacity(): Promise<number> {
  if (!statusCache) await notebookStatus();
  const tier = statusCache?.tier ?? '';
  return /PRO|PLUS|ULTRA|PREMIUM/i.test(tier) ? 280 : 45;
}
