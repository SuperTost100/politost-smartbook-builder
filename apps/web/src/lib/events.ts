import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ServiceEvent } from '@smartbuilder/domain';
import { apiUrl } from './api';

const EVENT_TYPES: ServiceEvent['type'][] = [
  'task.state', 'task.progress', 'run.state', 'resource.state', 'content.saved', 'proposal.created',
  'issue.created', 'outline.created', 'export.ready', 'log',
];

/** Query keys touched by each event type. A key is the first element of the query key. */
const INVALIDATE: Record<string, string[]> = {
  'task.state': ['runs', 'run', 'project', 'projects'],
  'task.progress': ['run'],
  'run.state': ['runs', 'run', 'project', 'projects'],
  'content.saved': ['manuscript', 'section', 'history', 'preview', 'project', 'projects'],
  'proposal.created': ['manuscript', 'section', 'history'],
  'issue.created': ['issues', 'section', 'project', 'projects'],
  'resource.state': ['resources', 'pages', 'page', 'source-index', 'project', 'projects'],
  'outline.created': ['outline', 'topics', 'project', 'projects'],
  'export.ready': ['exports', 'project', 'projects'],
};

function invalidateKeys(qc: QueryClient, keys: Iterable<string>) {
  for (const k of keys) void qc.invalidateQueries({ queryKey: [k] });
}

export type StreamState = 'connecting' | 'live' | 'reconnecting';

/**
 * One EventSource for the whole app. EventSource reconnects by itself and resends Last-Event-ID,
 * so events are replayed by the service; after an error we also refresh everything once, in case the
 * service restarted and lost the stream position.
 */
export function useServiceEvents(projectId: string | undefined): StreamState {
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');

  useEffect(() => {
    const url = apiUrl('GET /api/events', { query: { projectId } });
    const es = new EventSource(url);
    let hadError = false;
    let pending = new Set<string>();
    let timer: number | undefined;

    const flush = () => {
      timer = undefined;
      const keys = pending;
      pending = new Set();
      invalidateKeys(qc, keys);
    };
    const schedule = (keys: string[]) => {
      keys.forEach((k) => pending.add(k));
      if (timer === undefined) timer = window.setTimeout(flush, 200);
    };

    let errTimer: number | undefined;
    es.onopen = () => {
      window.clearTimeout(errTimer);
      setState('live');
      if (hadError) {
        hadError = false;
        void qc.invalidateQueries();
      }
    };
    es.onerror = () => {
      hadError = true;
      window.clearTimeout(errTimer);
      errTimer = window.setTimeout(() => setState('reconnecting'), 3000);
    };
    const onMessage = (e: MessageEvent<string>) => {
      let type: string | undefined;
      try {
        type = (JSON.parse(e.data) as Partial<ServiceEvent>).type;
      } catch {
        /* the type may only be in the SSE event name */
      }
      type = type && type in INVALIDATE ? type : (e.type !== 'message' ? e.type : undefined);
      if (type && INVALIDATE[type]) schedule(INVALIDATE[type]);
    };
    es.onmessage = onMessage;
    for (const t of EVENT_TYPES) es.addEventListener(t, onMessage as EventListener);

    return () => {
      es.close();
      window.clearTimeout(errTimer);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectId, qc]);

  return state;
}
