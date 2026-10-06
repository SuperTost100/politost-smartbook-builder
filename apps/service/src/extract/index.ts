// Source ingestion. Every format ends up as pages(resource_id, idx, label, text, quality) + pages_fts.
import type { Question, SourceIndex } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';

/** Extract a stored resource into pages, FTS rows and its source index. Idempotent: replaces existing pages. */
export async function extractResource(_ctx: AppContext, _resourceId: string, _signal: AbortSignal): Promise<{ pages: number; garbled: number; index: SourceIndex | null }> { throw new Error('not implemented'); }

/** PNG bytes of a page, cached on disk by scale. If highlight is given, the matching passage is marked in translucent orange. */
export async function renderPageImage(_ctx: AppContext, _resourceId: string, _idx: number, _opts: { scale?: number; highlight?: string }): Promise<Buffer> { throw new Error('not implemented'); }

/** Locate a passage (e.g. NotebookLM cited_text) among pages of the given resources. Tolerates whitespace and garbled math. */
export function findPassage(_ctx: AppContext, _resourceIds: string[], _passage: string): { resourceId: string; idx: number; score: number } | null { throw new Error('not implemented'); }

/** FTS5 search over pages of a project's included resources. */
export function searchPages(_ctx: AppContext, _projectId: string, _query: string, _opts?: { limit?: number; resourceIds?: string[] }): { resourceId: string; idx: number; snippet: string; rank: number }[] { throw new Error('not implemented'); }

/** Split an exam/exercise resource into authentic questions with page ranges and exam sessions. Text-layer heuristics; statements may be garbled until transcribed. */
export function segmentQuestions(_ctx: AppContext, _resourceId: string): Omit<Question, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'rev'>[] { throw new Error('not implemented'); }

/** Store an uploaded file or fetched URL as a resource row (dedupes by sha256). */
export async function storeResource(_ctx: AppContext, _projectId: string, _input: { filename: string; bytes: Buffer; role: string } | { url: string; role: string }): Promise<string> { throw new Error('not implemented'); }
