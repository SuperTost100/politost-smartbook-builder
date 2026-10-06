// Maps cli-funnel failures to the queue's TaskError kinds.
import { FunnelError } from 'cli-funnel';

export type FailureKind = 'auth' | 'quota' | 'unavailable' | 'input' | 'fatal' | 'temporary' | 'aborted';
export interface Failure { kind: FailureKind; message: string; retryAfterMs?: number }

export const DEFAULT_QUOTA_WAIT_MS = 15 * 60_000;
const MIN_WAIT_MS = 30_000;
const MAX_WAIT_MS = 7 * 24 * 3600_000;

const QUOTA = /rate[ _-]?limit|usage limit|hit (your|the|our) (usage |daily |weekly )?limit|quota|too many requests|resource[_ ]exhausted|limit (has been )?(reached|exceeded)|exceeded.{0,30}(limit|quota)|out of (usage|credits)|credit balance|insufficient (credits|quota)|\b429\b/i;
const AUTH = /not (logged|signed) in|(log|sign) ?in required|please (log|sign) ?in|\/login|authentication (required|failed|error)|unauthori[sz]ed|invalid (api key|credentials|token)|token.{0,20}(expired|revoked)|\b401\b/i;

/** Classifies whatever funnel.run() threw. cli-funnel throws FunnelError for setup problems and a plain Error with `.code` for failures reported by the CLI. */
export function classifyError(err: unknown, now = Date.now()): Failure {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? ((err as { code: string }).code) : undefined;
  if (err instanceof FunnelError || isFunnelErrorLike(err)) {
    switch (code) {
      case 'aborted': return { kind: 'aborted', message };
      case 'not-logged-in': return { kind: 'auth', message };
      case 'not-installed': return { kind: 'unavailable', message };
      case 'unsupported': return { kind: 'input', message };
      case 'invalid-selection': return { kind: 'fatal', message };
    }
  }
  if (code === '429' || QUOTA.test(message)) return { kind: 'quota', message, retryAfterMs: parseRetryAfter(message, now) };
  if (code === '401' || code === '403' || AUTH.test(message)) return { kind: 'auth', message };
  return { kind: 'temporary', message };
}

function isFunnelErrorLike(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof Error && ['not-installed', 'not-logged-in', 'unsupported', 'invalid-selection', 'aborted'].includes(String(code));
}

const UNIT_MS: [RegExp, number][] = [
  [/^d/i, 86_400_000],
  [/^h/i, 3_600_000],
  [/^ms/i, 1],
  [/^m/i, 60_000],
  [/^s/i, 1000],
];

function unitMs(unit: string): number {
  return UNIT_MS.find(([re]) => re.test(unit))?.[1] ?? 1000;
}

/** Extracts "try again in 3 hours 5 minutes", "retry after 120", "resets 3pm", epoch or ISO reset times from a quota message. */
export function parseRetryAfter(message: string, now = Date.now()): number | undefined {
  const clamp = (ms: number) => Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(ms)));

  const iso = /\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)/.exec(message);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (Number.isFinite(t) && t > now) return clamp(t - now);
  }
  const epoch = /\|(\d{10})\b/.exec(message);
  if (epoch) return clamp(Number(epoch[1]) * 1000 - now);

  const retry = /retry[- ]after[:=\s]+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?)?/i.exec(message);
  if (retry) return clamp(Number(retry[1]) * (retry[2] ? unitMs(retry[2]) : 1000));

  const dur = /\b(?:in|after|within)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(message);
  if (dur) {
    let total = 0;
    for (const m of dur[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) total += Number(m[1]) * unitMs(m[2]);
    if (total > 0) return clamp(total);
  }

  const clock = /(?:resets?|try again|available again|retry)(?:\s+again)?(?:\s+at)?\s+(?:(\d{1,2}):(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm))/i.exec(message);
  if (clock) {
    let h = Number(clock[1] ?? clock[4]);
    const min = Number(clock[2] ?? 0);
    const ampm = (clock[3] ?? clock[5])?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) {
      const d = new Date(now);
      d.setHours(h, min, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return clamp(d.getTime() - now);
    }
  }
  return undefined;
}

/** What to tell the author when a CLI needs a sign-in. */
export const CLI_LOGIN: Record<string, { name: string; command: string }> = {
  claude: { name: 'Claude Code', command: 'claude auth login' },
  codex: { name: 'Codex', command: 'codex login' },
  agent: { name: 'Cursor Agent', command: 'agent login' },
  antigravity: { name: 'Antigravity', command: 'agy' },
};

export function loginAction(provider: string): string {
  const info = CLI_LOGIN[provider] ?? { name: provider, command: `${provider} login` };
  return `Sign in to ${info.name}: run "${info.command}" in a terminal, then press Retry.`;
}
