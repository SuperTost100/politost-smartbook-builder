import type { ProjectStage, ProjectSummary } from '@smartbuilder/domain';

export const STEPS = ['Sources', 'Outline', 'Drafting', 'Review', 'Export'] as const;

export function stepIndex(stage: ProjectStage): number {
  switch (stage) {
    case 'sources': case 'mapping': return 0;
    case 'outline': return 1;
    case 'drafting': return 2;
    case 'review': return 3;
    case 'export': return 4;
  }
}

export interface NextAction { label: string; to: string; kind?: 'download'; /** Why this action is needed, shown as text next to the button. */ note?: string }

/** The one thing the author should do next, named as the action it performs. */
export function nextAction(p: ProjectSummary): NextAction {
  const base = `/books/${p.id}`;
  const run = p.activeRun;
  if (run && run.waiting?.kind === 'quota') return { label: 'Open run', to: `${base}/run`, note: 'Waiting for a provider limit to reset.' };
  if (run && run.status === 'waiting') return { label: 'Resolve waiting step', to: `${base}/run`, note: run.waiting?.reason };
  switch (p.stage) {
    case 'sources':
    case 'mapping':
      if (p.counts.resources === 0) return { label: 'Add sources', to: `${base}/sources` };
      if (run) return { label: 'Open run', to: `${base}/run` };
      return { label: 'Generate outline', to: `${base}/outline` };
    case 'outline':
      if (run) return { label: 'Open run', to: `${base}/run` };
      return p.outlineRevId ? { label: 'Approve outline', to: `${base}/outline` } : { label: 'Generate outline', to: `${base}/outline` };
    case 'drafting':
      if (run?.status === 'paused') return { label: 'Resume drafting', to: `${base}/run` };
      if (run) return { label: 'Open manuscript', to: `${base}/manuscript` };
      if (p.counts.drafted < p.counts.sections) return { label: 'Resume drafting', to: `${base}/run` };
      return { label: 'Open manuscript', to: `${base}/manuscript` };
    case 'review':
      return p.counts.openIssues > 0
        ? { label: `Fix ${p.counts.openIssues} ${p.counts.openIssues === 1 ? 'issue' : 'issues'}`, to: `${base}/review` }
        : { label: 'Run review', to: `${base}/review` };
    case 'export':
      return { label: 'Download .ptsb', to: `${base}/export`, kind: 'download' };
  }
}
