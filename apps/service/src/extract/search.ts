import type { AppContext } from '../context.ts';
import type { Db } from '../db/db.ts';
import { tokenize, scoreInPage, MIN_SCORE } from './match.ts';

interface PageTokens { idx: number; text: string[]; transcript: string[] | null }
interface Cached { sig: string; pages: PageTokens[] }

const caches = new WeakMap<Db, Map<string, Cached>>();
const MAX_CACHED = 24;

function pageTokens(ctx: AppContext, resourceId: string): PageTokens[] {
  const s = ctx.db.get<{ c: number; a: number; b: number; m: number }>(
    `SELECT count(*) AS c, coalesce(sum(length(text)), 0) AS a, coalesce(sum(length(coalesce(transcript, ''))), 0) AS b, coalesce(max(rowid), 0) AS m
       FROM pages WHERE resource_id = ?`, resourceId,
  )!;
  const sig = `${s.c}:${s.a}:${s.b}:${s.m}`;
  let map = caches.get(ctx.db);
  if (!map) caches.set(ctx.db, (map = new Map()));
  const hit = map.get(resourceId);
  if (hit && hit.sig === sig) return hit.pages;
  const rows = ctx.db.all<{ idx: number; text: string; transcript: string | null }>('SELECT idx, text, transcript FROM pages WHERE resource_id = ? ORDER BY idx', resourceId);
  const pages = rows.map((r) => ({
    idx: r.idx,
    text: tokenize(r.text),
    transcript: r.transcript ? tokenize(r.transcript, { latex: true }) : null,
  }));
  map.delete(resourceId);
  map.set(resourceId, { sig, pages });
  if (map.size > MAX_CACHED) map.delete(map.keys().next().value!);
  return pages;
}

/**
 * Locate a passage (e.g. NotebookLM cited_text) among pages of the given resources. Tolerates whitespace, accents,
 * dropped math symbols and passages that begin on one page and run onto the next (the start page is returned).
 */
export function findPassage(ctx: AppContext, resourceIds: string[], passage: string): { resourceId: string; idx: number; score: number } | null {
  const q = tokenize(passage);
  if (!q.length) return null;
  let best: { resourceId: string; idx: number; score: number } | null = null;
  for (const resourceId of resourceIds) {
    const pages = pageTokens(ctx, resourceId);
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const next = pages[i + 1];
      let score = scoreInPage(q, p.text, next?.text ?? []);
      if (p.transcript) score = Math.max(score, scoreInPage(q, p.transcript, next?.transcript ?? []));
      if (score >= MIN_SCORE && (!best || score > best.score)) {
        best = { resourceId, idx: p.idx, score };
        if (score >= 1) return best;
      }
    }
  }
  return best;
}

/** Turn free text into a safe FTS5 query: quoted tokens joined by OR, operators and punctuation dropped. */
export function ftsQuery(query: string): string | null {
  const toks = [...new Set(query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length > 1 || /\d/.test(t)).slice(0, 24);
  if (!toks.length) return null;
  return toks.map((t) => (t.length >= 7 ? `("${t}" OR "${t.slice(0, t.length - 2)}"*)` : `"${t}"`)).join(' OR ');
}

/** FTS5 search over pages of a project's included resources, best match first (bm25: lower rank is better). */
export function searchPages(ctx: AppContext, projectId: string, query: string, opts: { limit?: number; resourceIds?: string[] } = {}): { resourceId: string; idx: number; snippet: string; rank: number }[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const limit = Math.min(200, Math.max(1, opts.limit ?? 20));
  const params: (string | number)[] = [match, projectId];
  let filter = '';
  if (opts.resourceIds) {
    if (!opts.resourceIds.length) return [];
    filter = ` AND r.id IN (${opts.resourceIds.map(() => '?').join(', ')})`;
    params.push(...opts.resourceIds);
  }
  params.push(limit);
  const rows = ctx.db.all<{ resource_id: string; idx: number; snippet: string; rank: number }>(
    `SELECT p.resource_id AS resource_id, p.idx AS idx, snippet(pages_fts, -1, '', '', ' … ', 24) AS snippet, bm25(pages_fts) AS rank
       FROM pages_fts
       JOIN pages p ON p.rowid = pages_fts.rowid
       JOIN resources r ON r.id = p.resource_id
      WHERE pages_fts MATCH ? AND r.project_id = ? AND r.included = 1${filter}
      ORDER BY rank LIMIT ?`,
    ...params,
  );
  return rows.map((r) => ({ resourceId: r.resource_id, idx: Number(r.idx), snippet: r.snippet.replace(/\s+/g, ' ').trim(), rank: Number(r.rank) }));
}
