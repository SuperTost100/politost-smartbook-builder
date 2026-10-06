// Collaborators of the routes. Defaults are the real modules; tests replace them with overrideDeps().
import { compileBook, compileChapter, lintSection, packPtsb, readBackPtsb } from '@smartbuilder/content';
import { renderPageImage, storeResource } from '../extract/index.ts';
import { transcribePage } from '../evidence/index.ts';
import { getConnections, probeRole } from '../llm/index.ts';
import { startRun } from '../pipeline/runs.ts';

export interface RouteDeps {
  storeResource: typeof storeResource;
  renderPageImage: typeof renderPageImage;
  transcribePage: typeof transcribePage;
  startRun: typeof startRun;
  getConnections: typeof getConnections;
  probeRole: typeof probeRole;
  compileBook: typeof compileBook;
  compileChapter: typeof compileChapter;
  lintSection: typeof lintSection;
  packPtsb: typeof packPtsb;
  readBackPtsb: typeof readBackPtsb;
  /** Called after the shutdown response was sent. */
  shutdown: () => void;
}

export const deps: RouteDeps = {
  storeResource, renderPageImage, transcribePage, startRun, getConnections, probeRole,
  compileBook, compileChapter, lintSection, packPtsb, readBackPtsb,
  shutdown: () => { process.kill(process.pid, 'SIGTERM'); },
};

/** Replaces some collaborators and returns a function that restores the previous ones. */
export function overrideDeps(patch: Partial<RouteDeps>): () => void {
  const before = { ...deps };
  Object.assign(deps, patch);
  return () => { Object.assign(deps, before); };
}
