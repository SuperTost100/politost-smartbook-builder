import { mkdirSync } from 'node:fs';
import { DEFAULT_ROUTES, ROLES, settingsSchema, type Role, type Settings } from '@smartbuilder/domain';
import { type Config, paths, toDataPath } from './config.ts';
import { Db, json } from './db/db.ts';
import { Events } from './events.ts';
import { Queue } from './queue/queue.ts';

/** Everything route handlers and task handlers need. Created once at startup. */
export interface AppContext {
  config: Config;
  db: Db;
  events: Events;
  queue: Queue;
  settings(): Settings;
  saveSettings(patch: Partial<Settings>): Settings;
}

export function createContext(config: Config): AppContext {
  mkdirSync(paths.tmp(config), { recursive: true });
  mkdirSync(paths.scratch(config), { recursive: true });
  const db = new Db(paths.db(config));
  const events = new Events(db);
  relativizeStoredPaths(db, config);

  const settings = (): Settings => {
    const row = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'settings'`);
    // Settings saved by an older version lack roles added since; they get their defaults before validation.
    const raw = json<Record<string, unknown>>(row?.value, {});
    return settingsSchema.parse({ ...raw, routes: { ...DEFAULT_ROUTES, ...(raw.routes as object | undefined) } });
  };
  const saveSettings = (patch: Partial<Settings>) => {
    const current = settings();
    const next = settingsSchema.parse({ ...current, ...patch, routes: { ...current.routes, ...(patch.routes ?? {}) } });
    db.run(`INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(next));
    return next;
  };

  const queue = new Queue(db, events, (pool) => {
    if (pool === 'local') return 2;
    if (pool === '*') return 12;
    // Pools named after a role share the limit of that role's provider.
    const provider = (ROLES as readonly string[]).includes(pool) ? settings().routes[pool as Role].primary.provider : pool;
    return settings().concurrency[provider] ?? 1;
  });

  return { config, db, events, queue, settings, saveSettings };
}

const PATHS_KEY = 'paths_relative';
const PATH_COLUMNS: [table: string, column: string][] = [['resources', 'path'], ['assets', 'path'], ['exports', 'path']];

/**
 * One-time pass: stored file paths used to be absolute. Rows under the configured data directory become relative to
 * it (so backups restore anywhere); rows pointing elsewhere stay as they are.
 */
export function relativizeStoredPaths(db: Db, config: Config) {
  if (db.get(`SELECT 1 FROM settings WHERE key = ?`, PATHS_KEY)) return;
  db.tx(() => {
    for (const [table, column] of PATH_COLUMNS) {
      for (const r of db.all<{ id: string; p: string }>(`SELECT id, ${column} AS p FROM ${table}`)) {
        const rel = toDataPath(config, r.p);
        if (rel !== r.p) db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, rel, r.id);
      }
    }
    db.run(`INSERT INTO settings (key, value) VALUES (?, '1')`, PATHS_KEY);
  });
}
