import type { FastifyInstance } from 'fastify';
import type { ServiceEvent } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';

const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events. Each event is `id: <seq>` plus the ServiceEvent JSON as data (no `event:` line, so
 * EventSource.onmessage receives all of them). Missed events are replayed from Last-Event-ID or ?since=.
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext) {
  const open = new Set<() => void>();
  app.addHook('onClose', async () => { for (const close of [...open]) close(); });

  app.get('/api/events', async (req, reply) => {
    const q = req.query as { projectId?: string; since?: string };
    const projectId = q.projectId || undefined;
    const header = req.headers['last-event-id'];
    const sinceRaw = (Array.isArray(header) ? header[0] : header) ?? q.since;
    const since = sinceRaw !== undefined && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // `last` is the highest seq written; with a resume point, anything at or below it is a duplicate.
    let last = since ?? 0;
    let replaying = since !== null;
    const buffered: ServiceEvent[] = [];
    const wanted = (e: ServiceEvent) => !projectId || e.projectId === null || e.projectId === projectId;
    const send = (e: ServiceEvent) => {
      if (since !== null && e.seq <= last) return;
      last = e.seq;
      if (wanted(e)) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    // Subscribe before replaying so nothing emitted in between is lost; duplicates are dropped by seq.
    const unsubscribe = ctx.events.subscribe((e) => (replaying ? buffered.push(e) : send(e)));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(close);
      if (!res.writableEnded) res.end();
    };
    open.add(close);
    req.raw.on('close', close);
    res.on('error', close);

    if (since !== null) {
      for (;;) {
        const batch = ctx.events.since(last, projectId);
        for (const e of batch) send(e);
        if (batch.length < 1000) break;
      }
      replaying = false;
      for (const e of buffered) send(e);
    }
  });
}
