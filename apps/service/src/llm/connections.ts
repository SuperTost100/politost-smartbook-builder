// Connections screen: which CLIs are installed and signed in, which models they offer, and what they can do.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ConnectionsResponse, ProviderStatus } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { notebookStatus, NLM_LOGIN_COMMAND } from '../evidence/nlm.ts';
import { stockKeys } from '../figures/stock.ts';
import type { RateLimits, UsageWindow } from 'cli-funnel';
import { accountUsage, getFunnel, type FunnelLike } from './funnel.ts';

const CLI_PROVIDERS = ['claude', 'codex', 'agent', 'antigravity'];
const CACHE_MS = 60_000;

type Detected = Omit<ProviderStatus, 'usage' | 'limit'>;
let cache: { at: number; funnel: FunnelLike; value: Detected[] } | null = null;

export function resetConnectionsCache() {
  cache = null;
}

async function detectProviders(funnel: FunnelLike): Promise<Detected[]> {
  const overview = await funnel.overview();
  const byId = new Map(overview.map((o) => [o.id as string, o]));
  return Promise.all(
    CLI_PROVIDERS.filter((id) => byId.has(id)).map(async (id): Promise<Detected> => {
      const o = byId.get(id)!;
      const caps = o.capabilities;
      const installed = o.installation.installed;
      let models: ProviderStatus['models'] = [];
      let error: string | null = null;
      if (installed) {
        try {
          models = (await funnel.models(id as never)).map((m) => ({ id: m.id, label: m.name, efforts: m.efforts.map((e) => e.id) }));
        } catch (err) {
          error = `Could not list models: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (!installed) error = o.installation.detail ?? `${o.displayName} is not installed.`;
      else if (o.auth && !o.auth.loggedIn && !error) error = o.auth.detail ?? 'Not signed in.';
      return {
        provider: id,
        label: o.displayName,
        installed,
        version: o.installation.version ?? null,
        signedIn: installed ? (o.auth ? o.auth.loggedIn : null) : false,
        models,
        capabilities: { images: caps.images, schema: caps.schema, system: caps.system !== undefined },
        error,
      };
    }),
  );
}

/** "5 hours", "7 days": the length of a usage window, or which of the two it is when the CLI does not say. */
function windowLabel(w: UsageWindow, fallback: string): string {
  const m = w.windowMinutes;
  if (!m) return fallback;
  const [n, unit] = m % 1440 === 0 ? [m / 1440, 'day'] : m % 60 === 0 ? [m / 60, 'hour'] : [m, 'minute'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function usageWindows(u: RateLimits): ProviderStatus['usage'] {
  const windows: [UsageWindow | undefined, string][] = [[u.primary, 'Short window'], [u.secondary, 'Long window']];
  return windows.flatMap(([w, name]) => (w ? [{ window: windowLabel(w, name), usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null }] : []));
}

export function findOnPath(names: string[], extra: string[] = []): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [...dirs.flatMap((d) => names.map((n) => join(d, n))), ...extra];
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function getConnections(ctx: AppContext): Promise<ConnectionsResponse> {
  const funnel = getFunnel();
  if (!cache || cache.funnel !== funnel || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), funnel, value: await detectProviders(funnel) };
  }
  const nb = await notebookStatus();
  const soffice = findOnPath(['soffice', 'libreoffice'], ['/Applications/LibreOffice.app/Contents/MacOS/soffice']);
  const keys = stockKeys(ctx);
  // Usage changes with every run, so it is read on each request (accountUsage caches it for a minute).
  const providers = await Promise.all(cache.value.map(async (p): Promise<ProviderStatus> => {
    const u = p.installed && p.signedIn ? await accountUsage(p.provider) : null;
    return { ...p, usage: u ? usageWindows(u) : [], limit: u?.limit?.detail ?? null };
  }));
  return {
    providers,
    notebooklm: { ...nb, loginCommand: NLM_LOGIN_COMMAND },
    libreoffice: { installed: soffice !== null, path: soffice },
    stock: { pixabay: !!keys.pixabay, pexels: !!keys.pexels },
    node: process.version,
    dataDir: ctx.config.dataDir,
  };
}
