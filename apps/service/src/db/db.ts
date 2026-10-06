import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { MIGRATIONS } from './migrations.ts';

export type Row = Record<string, SQLInputValue>;

/** Thin wrapper over node:sqlite with JSON helpers and transactions. */
export class Db {
  readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.raw.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.raw.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (; version < MIGRATIONS.length; version++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[version]);
        this.raw.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      });
    }
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  /** Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  /** Insert a row from an object whose keys are column names. JSON-encodes objects and arrays. */
  insert(table: string, values: Record<string, unknown>) {
    const keys = Object.keys(values);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    return this.run(sql, ...keys.map((k) => encode(values[k])));
  }

  /** Update columns of one row by id. */
  update(table: string, id: string, values: Record<string, unknown>) {
    const keys = Object.keys(values);
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    return this.run(sql, ...keys.map((k) => encode(values[k])), id);
  }

  close() {
    this.raw.close();
  }
}

export function encode(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v as SQLInputValue;
}

export function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
