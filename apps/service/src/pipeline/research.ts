// Outside research: web material a section lacks, proposed with the pages that support it. Every quote is checked on its page.
import { lintSection, splitBlocks } from '@smartbuilder/content';
import type { EvidenceNote } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { quoteInText } from '../evidence/verify.ts';
import { decodeEntities } from '../extract/html.ts';
import { safeFetch } from '../extract/safe-fetch.ts';
import { runRole } from '../llm/index.ts';
import { currentHead, insertEvidence, latestEvidence } from '../repo/content.ts';
import type { TaskContext } from '../queue/queue.ts';
import { commitAiRevision } from './draft.ts';
import { researchPrompt, researchSchema } from './prompts.ts';
import { findSection, loadOutline, loadProject, revisionForTask, truncate } from './util.ts';

/** Pages a model picked are read with a smaller size limit than sources the author adds. */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

/**
 * Fetches a page as plain text. The model chooses these URLs, so the page may be hostile: the text is taken with
 * linear-time scans only (the HTML-to-Markdown converter has regexes that slow down on crafted markup). Tests replace it.
 */
export const researchDeps = {
  fetchPage: async (url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string }> => {
    const page = await safeFetch(url, { signal, maxBytes: MAX_PAGE_BYTES });
    return { url: page.finalUrl, ...pageText(page.contentType, page.body.toString('utf8')) };
  },
};

export function pageText(contentType: string, body: string): { title: string; text: string } {
  if (!contentType.includes('html')) return { title: '', text: body };
  return { title: pageTitle(body), text: decodeEntities(body.replace(/<[^>]*>/g, ' ')) };
}

function pageTitle(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf('<title');
  const start = open < 0 ? -1 : lower.indexOf('>', open);
  const end = start < 0 ? -1 : lower.indexOf('</title', start);
  return end < 0 ? '' : decodeEntities(html.slice(start + 1, end)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

const MAX_ADDITIONS = 3;

export async function sectionResearch(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  const mine = revisionForTask(ctx, projectId, nodeId, t.task.id);
  if (mine) return { revId: mine.id, reused: true };
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const found = outline ? findSection(outline.outline, nodeId) : null;
  const head = currentHead(ctx, projectId, nodeId);
  if (!found || !head) return { skipped: 'section not drafted' };

  const blocks = splitBlocks(head.markdown);
  const { data, route } = await runRole(ctx, {
    role: 'research', web: true,
    ...researchPrompt({
      language: project.language, bookTitle: project.title, chapterTitle: found.chapter.title, sectionTitle: found.section.title,
      objectives: found.section.objectives, notation: outline!.outline.notation, blocks: truncate(blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n\n'), 60_000),
    }),
    schema: researchSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });

  // Only additions with at least one quote found on its page survive, and only if they pass lint. Note ids are given
  // when the proposal is committed, from the packet as it is then, so concurrent runs never reuse one.
  type Found = Omit<EvidenceNote, 'id'>;
  const kept: { after: number; blocks: string[]; notes: Found[] }[] = [];
  const dropped: string[] = [];
  for (const a of data.additions.slice(0, MAX_ADDITIONS)) {
    const notes: Found[] = [];
    for (const s of a.sources.slice(0, 2)) {
      try {
        const page = await researchDeps.fetchPage(s.url, t.signal);
        if (quoteInText(page.text, s.quote)) notes.push({ quote: s.quote.trim(), resourceId: null, page: null, verified: true, claim: a.why, url: page.url, title: page.title || s.title });
        else dropped.push(`${s.url}: quote not found on the page`);
      } catch (err) {
        if (t.signal.aborted) throw err;
        dropped.push(`${s.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const text = a.markdown.trim();
    const blockers = lintSection(text, { sectionId: nodeId, language: project.language }).filter((f) => f.severity === 'blocker');
    if (!notes.length || !text || blockers.length) {
      if (blockers.length) dropped.push(`addition after block ${a.afterBlock}: ${blockers[0].message}`);
      continue;
    }
    // An addition may hold several blocks (a sentence and its display formula); each one cites the pages.
    kept.push({ after: Math.min(Math.max(a.afterBlock, 0), blocks.length), blocks: splitBlocks(text).map((b) => b.text), notes });
  }
  if (!kept.length) return { proposed: 0, dropped };

  return ctx.db.tx(() => {
    const packet = latestEvidence(ctx, projectId, nodeId);
    const taken = new Set(packet?.notes.map((n) => n.id) ?? []);
    let next = 0;
    const nextId = () => { do next++; while (taken.has(`w${next}`)); return `w${next}`; };
    const withIds = kept.map((k) => ({ ...k, notes: k.notes.map((n) => ({ ...n, id: nextId() })) }));

    // New blocks go in after the block they follow; existing citations move with their blocks.
    const texts: string[] = [];
    const citations: Record<string, string[]> = {};
    const place = (n: number) => {
      for (const k of withIds.filter((x) => x.after === n)) for (const b of k.blocks) { citations[String(texts.length)] = k.notes.map((x) => x.id); texts.push(b); }
    };
    place(0);
    blocks.forEach((b, i) => {
      if (head.citations[String(i)]?.length) citations[String(texts.length)] = head.citations[String(i)];
      texts.push(b.text);
      place(i + 1);
    });

    const webNotes = withIds.flatMap((k) => k.notes);
    if (packet) ctx.db.run('UPDATE evidence_packets SET notes = ? WHERE id = ?', JSON.stringify([...packet.notes, ...webNotes]), packet.id);
    else insertEvidence(ctx, { projectId, nodeId, provider: 'web', query: found.section.title, answer: '', notes: webNotes });
    const committed = commitAiRevision(ctx, { projectId, nodeId, kind: 'section', markdown: texts.join('\n\n'), baseRevId: head.id, model: route.model, citations, forceProposal: true, runId: t.task.runId, taskId: t.task.id });
    return { revId: committed.revId, proposed: kept.length, sources: webNotes.length, dropped };
  });
}
