import type { RunSummary, TaskState } from '@smartbuilder/domain';

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (!rtf) return new Date(iso).toLocaleString();
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function shortHash(h: string): string {
  return h.slice(0, 10);
}

export function tokenCount(n: number | null): string {
  return n === null || n === undefined ? 'unknown' : n.toLocaleString('en');
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export const RUN_KIND_LABEL: Record<RunSummary['kind'], string> = {
  prepare: 'Preparing sources',
  plan: 'Planning outline',
  generate: 'Drafting',
  review: 'Reviewing',
  export: 'Exporting',
  regenerate: 'Regenerating',
  research: 'Researching',
};

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  retry_wait: 'Waiting to retry',
  waiting_for_user: 'Waiting for you',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

export const TERMINAL_RUN = new Set(['cancelled', 'completed', 'failed']);

export function runCounts(run: RunSummary): { done: number; total: number; running: number; failed: number } {
  const c = run.counts;
  const sum = (...k: TaskState[]) => k.reduce((a, s) => a + (c[s] ?? 0), 0);
  const total = sum('queued', 'running', 'succeeded', 'retry_wait', 'waiting_for_user', 'failed', 'interrupted', 'cancelled', 'skipped');
  return { done: sum('succeeded', 'skipped'), total, running: sum('running'), failed: sum('failed', 'interrupted') };
}

/** Text and tone for the Run pill. */
export function runPill(run: RunSummary | null): { text: string; tone: 'idle' | 'running' | 'waiting' | 'paused' | 'failed' } {
  if (!run || TERMINAL_RUN.has(run.status)) {
    if (run?.status === 'failed') return { text: 'Run failed', tone: 'failed' };
    return { text: 'Idle', tone: 'idle' };
  }
  const { done, total } = runCounts(run);
  const progress = total ? ` ${done}/${total}` : '';
  switch (run.status) {
    case 'waiting': return { text: 'Waiting for you', tone: 'waiting' };
    case 'paused': return { text: 'Paused', tone: 'paused' };
    case 'pausing': return { text: 'Pausing…', tone: 'paused' };
    case 'cancelling': return { text: 'Cancelling…', tone: 'paused' };
    default: return { text: `${RUN_KIND_LABEL[run.kind].split(' ')[0]}${progress}`, tone: 'running' };
  }
}
