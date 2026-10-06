import { EventEmitter } from 'node:events';
import type { ServiceEvent } from '@smartbuilder/domain';
import { type Db, json, now } from './db/db.ts';

/** Persists events with a sequence number so SSE clients can resume, and fans them out live. */
export class Events {
  private bus = new EventEmitter();
  constructor(private db: Db) {
    this.bus.setMaxListeners(100);
  }

  emit(type: ServiceEvent['type'], data: Record<string, unknown>, ids: { projectId?: string | null; runId?: string | null; taskId?: string | null } = {}) {
    const createdAt = now();
    const res = this.db.run(
      'INSERT INTO events (project_id, run_id, task_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ids.projectId ?? null, ids.runId ?? null, ids.taskId ?? null, type, JSON.stringify(data), createdAt,
    );
    const event: ServiceEvent = {
      seq: Number(res.lastInsertRowid), projectId: ids.projectId ?? null, runId: ids.runId ?? null, taskId: ids.taskId ?? null,
      type, data, createdAt,
    };
    this.bus.emit('event', event);
    return event;
  }

  since(seq: number, projectId?: string): ServiceEvent[] {
    const rows = projectId
      ? this.db.all('SELECT * FROM events WHERE seq > ? AND (project_id = ? OR project_id IS NULL) ORDER BY seq LIMIT 1000', seq, projectId)
      : this.db.all('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 1000', seq);
    return rows.map((r) => ({
      seq: Number(r.seq), projectId: r.project_id as string | null, runId: r.run_id as string | null, taskId: r.task_id as string | null,
      type: r.type as ServiceEvent['type'], data: json(r.data, {}), createdAt: r.created_at as string,
    }));
  }

  subscribe(fn: (e: ServiceEvent) => void) {
    this.bus.on('event', fn);
    return () => this.bus.off('event', fn);
  }

  /** Keep the table bounded: drop events older than the newest `keep`. */
  prune(keep = 50_000) {
    this.db.run('DELETE FROM events WHERE seq < (SELECT MAX(seq) FROM events) - ?', keep);
  }
}
