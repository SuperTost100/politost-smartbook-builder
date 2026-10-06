// Connections screen: which CLIs are installed and signed in, which models they offer, and what they can do.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ConnectionsResponse, ProviderStatus } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { notebookStatus, NLM_LOGIN_COMMAND } from '../evidence/nlm.ts';
import { getFunnel, type FunnelLike } from './funnel.ts';

const CLI_PROVIDERS = ['claude', 'codex', 'agent', 'antigravity'];
const CACHE_MS = 60_000;

let cache: { at: number; funnel: FunnelLike; value: ProviderStatus[] } | null = null;

export function resetConnectionsCache() {
  cache = null;
}

async function detectProviders(funnel: FunnelLike): Promise<ProviderStatus[]> {
  const overview = await funnel.overview();
  const byId = new Map(overview.map((o) => [o.id as string, o]));
  return Promise.all(
    CLI_PROVIDERS.filter((id) => byId.has(id)).map(async (id): Promise<ProviderStatus> => {
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
  return {
    providers: cache.value,
    notebooklm: { ...nb, loginCommand: NLM_LOGIN_COMMAND },
    libreoffice: { installed: soffice !== null, path: soffice },
    node: process.version,
    dataDir: ctx.config.dataDir,
  };
}
