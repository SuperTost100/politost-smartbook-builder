import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Api } from '@smartbuilder/domain';
import { api } from './api';

type Res<K extends keyof Api> = Api[K]['res'];

export const qk = {
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  settings: ['settings'] as const,
  connections: ['connections'] as const,
  resources: (pid: string) => ['resources', pid] as const,
  pages: (rid: string) => ['pages', rid] as const,
  page: (rid: string, idx: number) => ['page', rid, idx] as const,
  sourceIndex: (rid: string) => ['source-index', rid] as const,
  topics: (pid: string) => ['topics', pid] as const,
  outline: (pid: string) => ['outline', pid] as const,
  runs: (pid: string) => ['runs', pid] as const,
  run: (rid: string) => ['run', rid] as const,
  manuscript: (pid: string) => ['manuscript', pid] as const,
  section: (pid: string, nodeId: string) => ['section', pid, nodeId] as const,
  history: (pid: string, nodeId: string) => ['history', pid, nodeId] as const,
  preview: (pid: string, chapterId: string) => ['preview', pid, chapterId] as const,
  questions: (pid: string) => ['questions', pid] as const,
  assets: (pid: string) => ['assets', pid] as const,
  enrichments: (pid: string) => ['enrichments', pid] as const,
  issues: (pid: string) => ['issues', pid] as const,
  exports: (pid: string) => ['exports', pid] as const,
};

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: () => api('GET /api/projects') });
export const useProject = (id: string | undefined) =>
  useQuery({ queryKey: qk.project(id ?? ''), queryFn: () => api('GET /api/projects/:id', { params: { id: id! } }), enabled: !!id });
export const useResources = (pid: string | undefined) =>
  useQuery({ queryKey: qk.resources(pid ?? ''), queryFn: () => api('GET /api/projects/:id/resources', { params: { id: pid! } }), enabled: !!pid });
export const useTopics = (pid: string | undefined) =>
  useQuery({ queryKey: qk.topics(pid ?? ''), queryFn: () => api('GET /api/projects/:id/topics', { params: { id: pid! } }), enabled: !!pid });
export const useOutline = (pid: string | undefined) =>
  useQuery({ queryKey: qk.outline(pid ?? ''), queryFn: () => api('GET /api/projects/:id/outline', { params: { id: pid! } }), enabled: !!pid });
export const useRuns = (pid: string | undefined) =>
  useQuery({ queryKey: qk.runs(pid ?? ''), queryFn: () => api('GET /api/projects/:id/runs', { params: { id: pid! } }), enabled: !!pid });
/** `poll` is a safety net for a live run in case the event stream is down. */
export const useRun = (runId: string | undefined, poll = false) =>
  useQuery({ queryKey: qk.run(runId ?? ''), queryFn: () => api('GET /api/runs/:runId', { params: { runId: runId! } }), enabled: !!runId, refetchInterval: poll ? 6000 : false });
export const useManuscript = (pid: string | undefined) =>
  useQuery({ queryKey: qk.manuscript(pid ?? ''), queryFn: () => api('GET /api/projects/:id/manuscript', { params: { id: pid! } }), enabled: !!pid });
export const useIssues = (pid: string | undefined) =>
  useQuery({ queryKey: qk.issues(pid ?? ''), queryFn: () => api('GET /api/projects/:id/issues', { params: { id: pid! } }), enabled: !!pid });
export const useQuestions = (pid: string | undefined) =>
  useQuery({ queryKey: qk.questions(pid ?? ''), queryFn: () => api('GET /api/projects/:id/questions', { params: { id: pid! } }), enabled: !!pid });
export const useExports = (pid: string | undefined) =>
  useQuery({ queryKey: qk.exports(pid ?? ''), queryFn: () => api('GET /api/projects/:id/exports', { params: { id: pid! } }), enabled: !!pid });
export const useConnections = () => useQuery({ queryKey: qk.connections, queryFn: () => api('GET /api/connections'), staleTime: 15_000 });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => api('GET /api/settings') });

export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: (readonly unknown[])[]) => keys.forEach((k) => void qc.invalidateQueries({ queryKey: k as unknown[] }));
}

export function invalidateProject(qc: QueryClient, pid: string) {
  for (const k of ['project', 'projects', 'runs', 'run']) void qc.invalidateQueries({ queryKey: [k] });
  void qc.invalidateQueries({ queryKey: ['manuscript', pid] });
}

export type { Res };
export { useMutation };
