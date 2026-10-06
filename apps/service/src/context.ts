import { mkdirSync } from 'node:fs';
import { DEFAULT_ROUTES, ROLES, settingsSchema, type Role, type Settings } from '@smartbuilder/domain';
import { type Config, paths } from './config.ts';
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

  const settings = (): Settings => {
    const row = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'settings'`);
    const parsed = settingsSchema.parse(json(row?.value, {}));
    // New roles added in later versions get their defaults.
    parsed.routes = { ...DEFAULT_ROUTES, ...parsed.routes };
    return parsed;
  };
  const saveSettings = (patch: Partial<Settings>) => {
    const next = settingsSchema.parse({ ...settings(), ...patch });
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
