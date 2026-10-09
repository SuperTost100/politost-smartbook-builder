// Outside research: web material a section lacks, proposed with the pages that support it. Every quote is checked on its page.
import { lintSection, splitBlocks } from '@smartbuilder/content';
import type { EvidenceNote } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { quoteInText } from '../evidence/verify.ts';
import { htmlTitle, htmlToMarkdown } from '../extract/html.ts';
import { safeFetch } from '../extract/safe-fetch.ts';
import { runRole } from '../llm/index.ts';
import { currentHead, insertEvidence, latestEvidence } from '../repo/content.ts';
import type { TaskContext } from '../queue/queue.ts';
import { commitAiRevision } from './draft.ts';
import { researchPrompt, researchSchema } from './prompts.ts';
import { findSection, loadOutline, loadProject, revisionForTask, truncate } from './util.ts';

/** Fetches a page as plain text. Tests replace it. */
export const researchDeps = {
  fetchPage: async (url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string }> => {
    const page = await safeFetch(url, { signal });
    const body = page.body.toString('utf8');
    if (!page.contentType.includes('html')) return { url: page.finalUrl, title: '', text: body };
    return { url: page.finalUrl, title: htmlTitle(body), text: htmlToMarkdown(body).markdown };
  },
};

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

  // Only additions with at least one quote found on its page survive, and only if they pass lint.
  const packet = latestEvidence(ctx, projectId, nodeId);
  let next = packet?.notes.filter((n) => n.id.startsWith('w')).length ?? 0;
  const kept: { after: number; text: string; notes: EvidenceNote[] }[] = [];
  const dropped: string[] = [];
  for (const a of data.additions.slice(0, MAX_ADDITIONS)) {
    const notes: EvidenceNote[] = [];
    for (const s of a.sources.slice(0, 2)) {
      try {
        const page = await researchDeps.fetchPage(s.url, t.signal);
        if (quoteInText(page.text, s.quote)) notes.push({ id: `w${++next}`, quote: s.quote.trim(), resourceId: null, page: null, verified: true, claim: a.why, url: page.url, title: page.title || s.title });
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
    kept.push({ after: Math.min(Math.max(a.afterBlock, 0), blocks.length), text, notes });
  }
  if (!kept.length) return { proposed: 0, dropped };

  // New blocks go in after the block they follow; existing citations move with their blocks.
  const texts: string[] = [];
  const citations: Record<string, string[]> = {};
  const old = head.citations;
  const place = (n: number) => { for (const k of kept.filter((x) => x.after === n)) { citations[String(texts.length)] = k.notes.map((x) => x.id); texts.push(k.text); } };
  place(0);
  blocks.forEach((b, i) => {
    if (old[String(i)]?.length) citations[String(texts.length)] = old[String(i)];
    texts.push(b.text);
    place(i + 1);
  });

  const webNotes = kept.flatMap((k) => k.notes);
  return ctx.db.tx(() => {
    if (packet) ctx.db.run('UPDATE evidence_packets SET notes = ? WHERE id = ?', JSON.stringify([...packet.notes, ...webNotes]), packet.id);
    else insertEvidence(ctx, { projectId, nodeId, provider: 'web', query: found.section.title, answer: '', notes: webNotes });
    const committed = commitAiRevision(ctx, { projectId, nodeId, kind: 'section', markdown: texts.join('\n\n'), baseRevId: head.id, model: route.model, citations, forceProposal: true, runId: t.task.runId, taskId: t.task.id });
    return { revId: committed.revId, proposed: kept.length, sources: webNotes.length, dropped };
  });
}
