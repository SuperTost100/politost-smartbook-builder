// Review: independent model pass over a chapter, and targeted revisions requested by the author.
import { compileChapter, lintSection, splitBlocks } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import type { TaskContext } from '../queue/queue.ts';
import { commitAiRevision, bookFormulaKeys, evidenceText, recordLintIssues } from './draft.ts';
import { revisePrompt, reviewPrompt, reviewSchema, repairSchema } from './prompts.ts';
import { extractCitations, findSection, headRevision, loadOutline, loadProject, truncate } from './util.ts';

export async function chapterReview(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true };
  const sections = chapter.sections.map((s) => ({ s, head: headRevision(ctx, projectId, s.id) })).filter((x) => x.head);
  const reviewed = sections.map((x) => x.head!.id).sort().join(',');
  // Re-reviewing identical text wastes quota.
  const prior = ctx.db.get<{ result: string }>(`SELECT result FROM tasks WHERE project_id = ? AND kind = 'chapter.review' AND state = 'succeeded' AND json_extract(input, '$.chapterId') = ? ORDER BY finished_at DESC LIMIT 1`, projectId, chapterId);
  if (prior && json<{ reviewed?: string }>(prior.result, {}).reviewed === reviewed && !t.task.input.force) return { reused: true, reviewed };

  const text = sections.map(({ s, head }) => `=== [${s.id}] ${s.title} ===\n${head!.markdown}`).join('\n\n');
  const evidence = sections.map(({ s }) => {
    const p = ctx.db.get('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1', projectId, s.id);
    if (!p) return '';
    return `[${s.id}]\n${evidenceText(ctx, { id: p.id as string, projectId, nodeId: s.id, provider: p.provider as 'local', query: '', answer: '', notes: json(p.notes, []), createdAt: '' }, 6000).notes}`;
  }).filter(Boolean).join('\n\n');
  const objectives = chapter.sections.map((s) => `[${s.id}] ${s.title}: ${s.objectives.join('; ')}`).join('\n');

  const { data, route } = await runRole(ctx, {
    role: 'reviewer', ...reviewPrompt({ language: project.language, chapterTitle: chapter.title, chapter: truncate(text, 120_000), evidence: truncate(evidence, 40_000), objectives }),
    schema: reviewSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const valid = new Map(sections.map(({ s, head }) => [s.id, head!.id]));
  ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'open' AND node_id IN (${chapter.sections.map(() => '?').join(',')})`, projectId, ...chapter.sections.map((s) => s.id));
    for (const i of data.issues) {
      const nodeId = valid.has(i.sectionId) ? i.sectionId : null;
      ctx.db.insert('review_issues', {
        id: newId(), project_id: projectId, node_id: nodeId ?? chapterId, question_id: null, rev_id: nodeId ? valid.get(nodeId) : null, source: 'review',
        severity: i.severity, category: i.category, quote: i.quote, message: i.message, suggestion: i.suggestion, status: 'open', resolution: '', created_at: now(),
      });
    }
  });
  // Compile check of the whole chapter, so broken refs surface here rather than at export.
  try {
    compileChapter({ id: chapter.id, slug: chapter.slug, number: outline!.outline.chapters.indexOf(chapter) + 1, title: chapter.title, intro: headRevision(ctx, projectId, chapterId)?.markdown ?? '', sections: sections.map(({ s, head }) => ({ id: s.id, title: s.title, markdown: head!.markdown })) });
  } catch (err) {
    ctx.db.insert('review_issues', { id: newId(), project_id: projectId, node_id: chapterId, question_id: null, rev_id: null, source: 'lint', severity: 'blocker', category: 'compile', quote: '', message: `The chapter does not compile: ${err instanceof Error ? err.message : err}`, suggestion: '', status: 'open', resolution: '', created_at: now() });
  }
  ctx.events.emit('issue.created', { chapterId, count: data.issues.length }, { projectId, runId: t.task.runId });
  return { issues: data.issues.length, reviewed, model: route.model };
}

/** Rewrites a section for author instructions or selected issues. The result is always a proposal for the author. */
export async function sectionRevise(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  const head = headRevision(ctx, projectId, nodeId);
  if (!head) return { skipped: 'no text yet' };
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const issueIds = (t.task.input.issueIds as string[] | undefined) ?? [];
  const issues = issueIds.length ? ctx.db.all<{ id: string; quote: string; message: string; suggestion: string }>(`SELECT id, quote, message, suggestion FROM review_issues WHERE id IN (${issueIds.map(() => '?').join(',')}) AND node_id = ?`, ...issueIds, nodeId) : [];
  const requests = [
    t.task.input.instruction ? `Author's instruction: ${t.task.input.instruction}` : '',
    t.task.input.selection ? `Apply it to this passage: "${t.task.input.selection}"` : '',
    ...issues.map((i, n) => `${n + 1}. ${i.message}${i.quote ? ` (at: "${i.quote}")` : ''}${i.suggestion ? ` Suggested fix: ${i.suggestion}` : ''}`),
  ].filter(Boolean).join('\n');
  if (!requests) return { skipped: 'nothing requested' };
  const p = ctx.db.get('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1', projectId, nodeId);
  const ev = p ? evidenceText(ctx, { id: p.id as string, projectId, nodeId, provider: 'local', query: '', answer: '', notes: json(p.notes, []), createdAt: '' }).notes : '';
  const known = bookFormulaKeys(ctx, projectId, nodeId).map((k) => `${k.key}: ${k.label}`).join('\n');
  const sectionIds = outline ? outline.outline.chapters.flatMap((c) => c.sections.map((s) => `${s.id}: ${s.title}`)).join('\n') : '';
  const { data, route } = await runRole(ctx, {
    role: 'writer', ...revisePrompt({ language: project.language, markdown: head.markdown, requests, evidence: ev, knownFormulas: known, sectionIds }),
    schema: repairSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const { markdown, citations } = extractCitations(data.markdown, splitBlocks);
  const isIntro = !findSection(outline?.outline ?? { chapters: [], exclusions: [], notation: '' }, nodeId);
  const committed = commitAiRevision(ctx, { projectId, nodeId, kind: isIntro ? 'chapter-intro' : 'section', markdown, baseRevId: head.id, model: route.model, origin: 'repair', citations, forceProposal: true, runId: t.task.runId });
  if (issues.length) ctx.db.run(`UPDATE review_issues SET status = 'proposed', resolution = ? WHERE id IN (${issues.map(() => '?').join(',')})`, `Proposal ${committed.revId}`, ...issues.map((i) => i.id));
  const findings = lintSection(markdown, { sectionId: nodeId, language: project.language });
  return { revId: committed.revId, status: committed.status, findings: findings.length };
}

export { recordLintIssues };
