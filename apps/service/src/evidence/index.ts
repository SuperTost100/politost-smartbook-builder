// Evidence: NotebookLM (nlm CLI) or local FTS + evidence-reader model. Every quote is verified against page text.
import type { EvidencePacket, Page } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { gatherEvidence as gather } from './gather.ts';
import { notebookStatus as status } from './nlm.ts';
import { syncNotebook as sync } from './sync.ts';
import { transcribePage as transcribe } from './transcribe.ts';

export { NLM_LOGIN_COMMAND, setNlmRunner } from './nlm.ts';
export { setEvidenceDeps } from './deps.ts';
export { localEvidenceMeta } from './gather.ts';

export interface EvidenceRequest {
  projectId: string;
  nodeId: string;
  /** Natural-language question in the book language. */
  query: string;
  /** Restrict to these resources (e.g. the topic's sources). Empty = all included theory resources. */
  resourceIds: string[];
  /** Page hints from topic mapping, used by the local reader. Page numbers are 0-based indexes. */
  pageHints?: { resourceId: string; pageFrom: number; pageTo: number }[];
  runId?: string;
  taskId?: string;
  signal?: AbortSignal;
}

/** Gathers and stores an evidence packet (reuses the latest one for the node unless force). */
export async function gatherEvidence(ctx: AppContext, req: EvidenceRequest, opts?: { force?: boolean }): Promise<EvidencePacket> {
  return gather(ctx, req, opts);
}

/** Ensures the project's notebook exists and every included resource is uploaded once (sha-tracked). */
export async function syncNotebook(ctx: AppContext, projectId: string, signal?: AbortSignal): Promise<{ notebookId: string; uploaded: number; skipped: number }> {
  return sync(ctx, projectId, signal);
}

/** Vision transcription of a page into Markdown + LaTeX, cached in pages.transcript. */
export async function transcribePage(ctx: AppContext, resourceId: string, idx: number, opts?: { signal?: AbortSignal; force?: boolean; runId?: string; taskId?: string }): Promise<Page> {
  return transcribe(ctx, resourceId, idx, opts);
}

/** NotebookLM availability for the Connections screen. */
export async function notebookStatus(opts?: { fresh?: boolean }): Promise<{ installed: boolean; signedIn: boolean; account: string | null; usage: { window: string; remaining: string }[]; error: string | null }> {
  return status(opts);
}
