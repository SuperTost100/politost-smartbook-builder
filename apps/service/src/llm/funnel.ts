// One cli-funnel instance per process, created on first use. Tests inject a fake.
import type { Config } from '../config.ts';
import { codexEnv } from './homes.ts';
import { createFunnel, type Capabilities, type LiveSessionInfo, type ModelInfo, type ProcessOptions, type ProviderOverview, type RateLimits, type RunInput, type RunResult } from 'cli-funnel';

/** The slice of cli-funnel this app uses. The real Funnel satisfies it. */
export interface FunnelLike {
  run(input: RunInput): Promise<RunResult>;
  providers: Record<string, { displayName: string; capabilities: Capabilities }>;
  overview(): Promise<ProviderOverview[]>;
  models(id: never): Promise<ModelInfo[]>;
  sessions(): LiveSessionInfo[];
  closeSession(sessionId: string, provider?: never): boolean;
  rateLimits(id: never, opts?: ProcessOptions): Promise<RateLimits>;
}

let instance: FunnelLike | null = null;
let usageCache = new Map<string, { at: number; value: Promise<RateLimits | null> }>();
const USAGE_CACHE_MS = 60_000;

export function getFunnel(): FunnelLike {
  // The model catalog is bundled and can lag behind the CLIs; routes may name newer models.
  // Claude Code and Codex keep their process after a turn, so a repair turn in the same session skips the startup.
  // runRole closes each session when its route is done; idleMs only catches one that was left open.
  instance ??= createFunnel({ allowUnlistedModels: true, sessions: { keepAlive: true, idleMs: 60_000 } }) as unknown as FunnelLike;
  return instance;
}

/** Replace the process-wide funnel (tests). Pass null to go back to the real one. */
export function setFunnel(fake: FunnelLike | null) {
  instance = fake;
  usageCache = new Map();
}

/** The account's usage windows, read at most once a minute. Null for providers that cannot report them (only Codex can). Read through the same Codex home as the calls. */
export function accountUsage(provider: string, config: Config): Promise<RateLimits | null> {
  if (provider !== 'codex') return Promise.resolve(null);
  const hit = usageCache.get(provider);
  if (hit && Date.now() - hit.at < USAGE_CACHE_MS) return hit.value;
  const value = getFunnel().rateLimits(provider as never, { env: codexEnv(config) }).catch(() => null);
  usageCache.set(provider, { at: Date.now(), value });
  return value;
}
