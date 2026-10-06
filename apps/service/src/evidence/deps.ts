// Collaborators that tests replace: the extraction functions and the model runner.
import type { AppContext } from '../context.ts';
import * as extract from '../extract/index.ts';
import { runRole, type RunRoleOptions, type RunRoleResult } from '../llm/index.ts';

export interface EvidenceDeps {
  findPassage: typeof extract.findPassage;
  searchPages: typeof extract.searchPages;
  renderPageImage: typeof extract.renderPageImage;
  runRole: <T>(ctx: AppContext, opts: RunRoleOptions<T>) => Promise<RunRoleResult<T>>;
}

const defaults: EvidenceDeps = {
  findPassage: (...a) => extract.findPassage(...a),
  searchPages: (...a) => extract.searchPages(...a),
  renderPageImage: (...a) => extract.renderPageImage(...a),
  runRole: (ctx, opts) => runRole(ctx, opts),
};

export const deps: EvidenceDeps = { ...defaults };

/** Override collaborators (tests). Call with no argument to restore the defaults. */
export function setEvidenceDeps(partial?: Partial<EvidenceDeps>) {
  Object.assign(deps, defaults, partial ?? {});
}
