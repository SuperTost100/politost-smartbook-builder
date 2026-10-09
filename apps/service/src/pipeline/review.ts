// Review: independent model pass over a chapter, and targeted revisions requested by the author.
import { applyGuardedChanges, compileChapter, lintSection, quoteInBlock, sameQuote, splitBlocks } from '@smartbuilder/content';
import { currentHeads } from '../repo/content.ts';
import { issuesChanged } from '../repo/issues.ts';
import { bookContext, chapterInput, relint } from '../routes/views.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { commitAiRevision, bookFormulaKeys, evidenceText, recordLintIssues, withMarkers } from './draft.ts';
import { fixCheckPrompt, fixCheckSchema, patchPrompt, patchSchema, reviewPrompt, reviewSchema, repairSchema } from './prompts.ts';
import { extractCitations, findSection, headRevision, loadOutline, loadProject, revisionForTask, truncate } from './util.ts';

const cut = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export async function chapterReview(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true };
  const sections = chapter.sections.map((s) => ({ s, head: headRevision(ctx, projectId, s.id) })).filter((x) => x.head);
  // Nothing written yet: a review would only report that every objective is missing.
  if (!sections.length) return { skipped: 'no drafted sections' };
  const reviewed = sections.map((x) => x.head!.id).sort().join(',');
  // Re-reviewing identical text wastes quota.
  const prior = ctx.db.get<{ result: string }>(`SELECT result FROM tasks WHERE project_id = ? AND kind = 'chapter.review' AND state = 'succeeded' AND json_extract(input, '$.chapterId') = ? ORDER BY finished_at DESC LIMIT 1`, projectId, chapterId);
  const priorReviewed = prior ? json<{ reviewed?: string }>(prior.result, {}).reviewed : undefined;
  if (priorReviewed === reviewed && !t.task.input.force) return { reused: true, reviewed };
  const reviewNodes = [chapterId, ...chapter.sections.map((s) => s.id)];
  const inNodes = reviewNodes.map(() => '?').join(',');

  const text = sections.map(({ s, head }) => `=== [${s.id}] ${s.title} ===\n${head!.markdown}`).join('\n\n');
  const evidence = sections.map(({ s }) => {
    const p = ctx.db.get('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1', projectId, s.id);
    if (!p) return '';
    return `[${s.id}]\n${evidenceText(ctx, { id: p.id as string, projectId, nodeId: s.id, provider: p.provider as 'local', query: '', answer: '', notes: json(p.notes, []), createdAt: '' }, 6000).notes}`;
  }).filter(Boolean).join('\n\n');
  const objectives = chapter.sections.map((s) => `[${s.id}] ${s.title}: ${s.objectives.join('; ')}`).join('\n');

  // What the reviewer already knows: sections that did not change since the last review, and issues the author or an earlier fix settled.
  const seen = new Set((priorReviewed ?? '').split(',').filter(Boolean));
  const changes = priorReviewed
    ? `SINCE THE LAST REVIEW: changed sections: ${sections.filter((x) => !seen.has(x.head!.id)).map((x) => `[${x.s.id}]`).join(', ') || '(none)'}. Unchanged sections: ${sections.filter((x) => seen.has(x.head!.id)).map((x) => `[${x.s.id}]`).join(', ') || '(none)'}. In unchanged sections report only blockers; they were reviewed before.`
    : 'This is the first review: every section is new, review all of it.';
  const handledRows = ctx.db.all<{ node_id: string; status: string; quote: string; message: string }>(
    `SELECT node_id, status, quote, message FROM review_issues WHERE project_id = ? AND source = 'review' AND status IN ('dismissed', 'accepted', 'fixed') AND node_id IN (${inNodes}) ORDER BY rowid DESC LIMIT 60`, projectId, ...reviewNodes);
  const handledLine = (r: { node_id: string; quote: string; message: string }) => `- [${r.node_id}] ${r.quote ? `"${cut(r.quote, 120)}" ` : ''}${cut(r.message, 200)}`;
  const decided = handledRows.filter((r) => r.status !== 'fixed');
  const fixed = handledRows.filter((r) => r.status === 'fixed');
  const handled = [
    decided.length ? `ISSUES THE AUTHOR DECIDED ARE FINE (newest first). Never report these again, in any wording:\n${decided.map(handledLine).join('\n')}` : '',
    fixed.length ? `ISSUES ALREADY FIXED (newest first). Report one again only if the text above still has the problem:\n${fixed.map(handledLine).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const { data, route } = await runRole(ctx, {
    role: 'reviewer', ...reviewPrompt({ language: project.language, notation: outline!.outline.notation, chapterTitle: chapter.title, chapter: truncate(text, 120_000), evidence: truncate(evidence, 40_000), objectives, changes, handled }),
    schema: reviewSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const valid = new Map(sections.map(({ s, head }) => [s.id, head!.id]));

  // Compile check of the whole chapter with the book's reference context, so broken refs surface here rather than at export.
  const compileIssues: { nodeId: string; severity: string; rule: string; quote: string; message: string }[] = [];
  try {
    const heads = currentHeads(ctx, projectId);
    const { known, opts } = bookContext(ctx, projectId, outline!.outline, heads);
    const compiled = compileChapter(chapterInput(outline!.outline, outline!.outline.chapters.indexOf(chapter), heads), known, opts);
    const unwritten = new Set(chapter.sections.filter((s) => !valid.has(s.id)).map((s) => s.id));
    const mine = new Set([chapterId, ...chapter.sections.map((s) => s.id)]);
    for (const f of compiled.findings) {
      if (f.severity === 'minor' || unwritten.has(f.file)) continue;
      compileIssues.push({ nodeId: mine.has(f.file) ? f.file : chapterId, severity: f.severity, rule: f.rule, quote: f.quote ?? '', message: f.line ? `${f.message} (line ${f.line})` : f.message });
    }
  } catch (err) {
    compileIssues.push({ nodeId: chapterId, severity: 'blocker', rule: '', quote: '', message: `The chapter does not compile: ${err instanceof Error ? err.message : err}` });
  }

  // Issues the author settled are not raised again when the quote matches.
  const settled = ctx.db.all<{ node_id: string; quote: string }>(`SELECT node_id, quote FROM review_issues WHERE project_id = ? AND source = 'review' AND status IN ('dismissed', 'accepted') AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
  let stored = 0;
  ctx.db.tx(() => {
    // Findings that match no section are stored under the chapter id, so it is part of the cleanup. Resolved history stays.
    // In sections that did not change the reviewer reports only blockers, so only their open blockers are replaced.
    const unchanged = priorReviewed ? sections.filter((x) => seen.has(x.head!.id)).map((x) => x.s.id) : [];
    const replaced = reviewNodes.filter((id) => !unchanged.includes(id));
    if (replaced.length) ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'open' AND node_id IN (${replaced.map(() => '?').join(',')})`, projectId, ...replaced);
    if (unchanged.length) ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'open' AND severity = 'blocker' AND node_id IN (${unchanged.map(() => '?').join(',')})`, projectId, ...unchanged);
    // Fixes that wait on a proposal that no longer exists are leftovers of earlier passes; a live proposal keeps its issues.
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'proposed' AND node_id IN (${inNodes}) AND resolution NOT IN (SELECT 'Proposal ' || id FROM content_revisions WHERE project_id = ? AND status = 'proposal')`, projectId, ...reviewNodes, projectId);
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'lint' AND status = 'open' AND (category = 'compile' OR category LIKE 'compile:%') AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
    for (const i of data.issues) {
      const nodeId = valid.has(i.sectionId) ? i.sectionId : null;
      if (settled.some((x) => x.node_id === (nodeId ?? chapterId) && sameQuote(x.quote, i.quote))) continue;
      stored++;
      ctx.db.insert('review_issues', {
        id: newId(), project_id: projectId, node_id: nodeId ?? chapterId, question_id: null, rev_id: nodeId ? valid.get(nodeId) : null, source: 'review',
        severity: i.severity, category: i.category, quote: i.quote, message: i.message, suggestion: i.suggestion, status: 'open', resolution: '', created_at: now(),
      });
    }
    for (const c of compileIssues) {
      ctx.db.insert('review_issues', {
        id: newId(), project_id: projectId, node_id: c.nodeId, question_id: null, rev_id: valid.get(c.nodeId) ?? null, source: 'lint', severity: c.severity,
        category: c.rule ? `compile:${c.rule}` : 'compile', quote: c.quote, message: c.message, suggestion: '', status: 'open', resolution: '', created_at: now(),
      });
    }
  });
  ctx.events.emit('issue.created', { chapterId, count: stored }, { projectId, runId: t.task.runId });
  return { issues: stored, skippedSettled: data.issues.length - stored, compileIssues: compileIssues.length, reviewed, model: route.model };
}

/**
 * Rewrites a section for author instructions or selected issues. An author instruction always becomes a proposal. A fix for
 * issues is applied as the current text when the guards and the cheap check allow it and the head did not change meanwhile;
 * otherwise it waits as a proposal. Changes that would damage the section are dropped and their issues stay open.
 */
export interface ReviseResult { revId?: string; status?: string; reused?: boolean; skipped?: string; findings?: number; reverted?: string[]; checked?: boolean; shrunk?: boolean }

export async function sectionRevise(ctx: AppContext, t: TaskContext): Promise<ReviseResult> {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  // Checkpoint: this task already stored its result in an earlier attempt.
  const mine = revisionForTask(ctx, projectId, nodeId, t.task.id);
  if (mine) return { revId: mine.id, status: mine.status, reused: true };
  const head = headRevision(ctx, projectId, nodeId);
  if (!head) return { skipped: 'no text yet' };
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const issueIds = (t.task.input.issueIds as string[] | undefined) ?? [];
  const issues = issueIds.length ? ctx.db.all<{ id: string; quote: string; message: string; suggestion: string; severity: string; category: string }>(`SELECT id, quote, message, suggestion, severity, category FROM review_issues WHERE id IN (${issueIds.map(() => '?').join(',')}) AND node_id = ?`, ...issueIds, nodeId) : [];
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
  // Stored text has no citation markers; put the base revision's back so the model can keep them.
  const baseCitations = json<Record<string, string[]>>(ctx.db.get<{ citations: string }>('SELECT citations FROM content_revisions WHERE id = ?', head.id)?.citations, {});
  const blocks = splitBlocks(withMarkers(head.markdown, baseCitations)).map((b) => b.text);
  // Blockers and the author's own instructions get the strongest writer; everything else the cheaper editor.
  const instructed = !!t.task.input.instruction;
  const role = instructed || issues.some((i) => i.severity === 'blocker') ? 'writer' : 'editor';
  const { data, route } = await runRole(ctx, {
    role, ...patchPrompt({ language: project.language, blocks: blocks.map((b, i) => `[B${i}]\n${b}`).join('\n\n'), requests, evidence: ev, knownFormulas: known, sectionIds }),
    schema: patchSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const isIntro = !findSection(outline?.outline ?? { chapters: [], exclusions: [], notation: '' }, nodeId);
  const kind = isIntro ? 'chapter-intro' as const : 'section' as const;

  // An author's instruction is taken as written and waits as a proposal. A fix for issues passes the guards first.
  let working = [...blocks];
  let reverted: { block: number; reason: string }[] = [];
  const unresolved = new Map<number, string>();
  let checked: boolean | undefined;
  if (instructed || !issues.length) {
    for (const c of data.changes) if (c.block >= 0 && c.block < blocks.length) working[c.block] = c.text.trim();
  } else {
    const lint = (md: string) => lintSection(extractCitations(md, splitBlocks).markdown, { sectionId: nodeId, language: project.language });
    const guarded = applyGuardedChanges(blocks, data.changes, lint);
    working = guarded.blocks;
    reverted = guarded.reverted;
    if (guarded.kept.length) {
      // One cheap model looks at what is left: a change that breaks the mathematics or removes more than asked is dropped.
      const clip = (b: string | undefined) => (b === undefined ? '(none)' : b.length > 1500 ? `${b.slice(0, 1500)}\n[…]` : b);
      try {
        const verdict = await runRole(ctx, {
          role: 'checker',
          ...fixCheckPrompt({
            language: project.language,
            issues: issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.message}${i.quote ? ` (at: "${i.quote}")` : ''}${i.suggestion ? ` Suggested fix: ${i.suggestion}` : ''}`).join('\n'),
            changes: guarded.kept.map((n) => `[B${n}]\nBLOCK BEFORE:\n${clip(blocks[n - 1])}\nOLD:\n${clip(blocks[n])}\nNEW:\n${working[n].trim() ? clip(working[n]) : '(deleted)'}\nBLOCK AFTER:\n${clip(blocks[n + 1])}`).join('\n\n'),
          }),
          schema: fixCheckSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
        });
        checked = true;
        for (const c of verdict.data.changes) {
          if (c.verdict !== 'harmful' || !guarded.kept.includes(c.block) || working[c.block] === blocks[c.block]) continue;
          working[c.block] = blocks[c.block];
          reverted.push({ block: c.block, reason: `the check found it harmful${c.reason ? ` (${c.reason.trim()})` : ''}` });
        }
        for (const i of verdict.data.issues) if (!i.fixed && i.index >= 1 && i.index <= issues.length) unresolved.set(i.index - 1, i.reason.trim() || 'the check found the problem still there');
      } catch (err) {
        // The check is a safeguard, not a gate: when it cannot run, the guards alone decide.
        if (!(err instanceof TaskError) || t.signal.aborted) throw err;
        checked = false;
      }
    }
  }
  const surviving = working.some((b, i) => b !== blocks[i]);
  // An issue whose quote lies in a block whose change was dropped is not answered.
  const dropped = (i: { quote: string }) => reverted.find((r) => quoteInBlock(i.quote, blocks[r.block]))?.reason;
  const fallback = reverted[0]?.reason ?? 'the model suggested no change';
  const reopen = (list: { id: string }[], resolution: (id: string) => string) => {
    for (const i of list) ctx.db.run(`UPDATE review_issues SET status = 'open', resolution = ? WHERE id = ?`, resolution(i.id), i.id);
  };
  const reasons = reverted.map((r) => r.reason);

  if (!surviving) {
    reopen(issues, (id) => `The AI fix was not applied: ${dropped(issues.find((i) => i.id === id)!) ?? fallback}`);
    issuesChanged(ctx, projectId, issues.map((i) => i.id));
    return { skipped: 'no change survived the checks', reverted: reasons, ...(checked === undefined ? {} : { checked }) };
  }

  const { markdown, citations } = extractCitations(working.filter((b) => b.trim()).join('\n\n'), splitBlocks);
  // Losing more than a fifth of the text is the author's call, unless the fix was about repetition.
  const shrunk = !!issues.length && markdown.length < head.markdown.length * 0.8 && !issues.some((i) => i.category === 'repetition');
  const answered = issues.filter((i) => !dropped(i) && !unresolved.has(issues.indexOf(i)));
  let committed!: ReturnType<typeof commitAiRevision>;
  ctx.db.tx(() => {
    committed = commitAiRevision(ctx, { projectId, nodeId, kind, markdown, baseRevId: head.id, model: route.model, origin: 'repair', citations, forceProposal: instructed || shrunk || !issues.length, runId: t.task.runId, taskId: t.task.id });
    const applied = committed.status === 'current';
    const done = new Set(answered.map((i) => i.id));
    if (answered.length) ctx.db.run(`UPDATE review_issues SET status = ?, resolution = ? WHERE id IN (${answered.map(() => '?').join(',')})`, applied ? 'fixed' : 'proposed', applied ? `Fixed by AI in revision ${committed.revId}` : `Proposal ${committed.revId}`, ...answered.map((i) => i.id));
    reopen(issues.filter((i) => !done.has(i.id)), (id) => {
      const i = issues.find((x) => x.id === id)!;
      const r = dropped(i);
      return r ? `The AI fix was not applied: ${r}` : `The AI fix did not resolve it: ${unresolved.get(issues.indexOf(i))}`;
    });
  });
  if (issues.length) issuesChanged(ctx, projectId, issues.map((i) => i.id));
  if (committed.status === 'current') relint(ctx, projectId, nodeId);
  const findings = lintSection(markdown, { sectionId: nodeId, language: project.language });
  return { revId: committed.revId, status: committed.status, findings: findings.length, reverted: reasons, ...(checked === undefined ? {} : { checked }), ...(shrunk ? { shrunk: true } : {}) };
}

export { recordLintIssues };
