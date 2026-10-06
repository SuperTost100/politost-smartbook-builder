// Evidence: NotebookLM (nlm CLI) or local FTS + evidence-reader model. Every quote is verified against page text.
import type { EvidencePacket, Page } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';

export interface EvidenceRequest {
  projectId: string;
  nodeId: string;
  /** Natural-language question in the book language. */
  query: string;
  /** Restrict to these resources (e.g. the topic's sources). Empty = all included theory resources. */
  resourceIds: string[];
  /** Page hints from topic mapping, used by the local reader. */
  pageHints?: { resourceId: string; pageFrom: number; pageTo: number }[];
  runId?: string;
  taskId?: string;
  signal?: AbortSignal;
}

/** Gathers and stores an evidence packet (reuses the latest one for the node unless force). */
export async function gatherEvidence(_ctx: AppContext, _req: EvidenceRequest, _opts?: { force?: boolean }): Promise<EvidencePacket> { throw new Error('not implemented'); }

/** Ensures the project's notebook exists and every included resource is uploaded once (sha-tracked). */
export async function syncNotebook(_ctx: AppContext, _projectId: string, _signal?: AbortSignal): Promise<{ notebookId: string; uploaded: number; skipped: number }> { throw new Error('not implemented'); }

/** Vision transcription of a page into Markdown + LaTeX, cached in pages.transcript. */
export async function transcribePage(_ctx: AppContext, _resourceId: string, _idx: number, _opts?: { signal?: AbortSignal; force?: boolean; runId?: string; taskId?: string }): Promise<Page> { throw new Error('not implemented'); }

/** NotebookLM availability for the Connections screen. */
export async function notebookStatus(): Promise<{ installed: boolean; signedIn: boolean; account: string | null; usage: { window: string; remaining: string }[]; error: string | null }> { throw new Error('not implemented'); }
