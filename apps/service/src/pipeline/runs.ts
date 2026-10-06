// Run planning: turns a user action into a task graph. Implemented with the pipeline handlers.
import type { RunSummary } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';

export function startRun(_ctx: AppContext, _projectId: string, _kind: RunSummary['kind'], _scope?: { chapterIds?: string[]; nodeIds?: string[]; issueIds?: string[]; questionIds?: string[]; instruction?: string; selection?: string }): RunSummary { throw new Error('not implemented'); }
