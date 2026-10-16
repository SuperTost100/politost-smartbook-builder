// Review: independent model pass over a chapter, and targeted revisions requested by the author.
import { applyGuardedChanges, compileChapter, lintSection, quoteInBlock, sameQuote, splitBlocks } from '@smartbuilder/content';
import { currentHeads } from '../repo/content.ts';
import { issuesChanged } from '../repo/issues.ts';
import { bookContext, chapterInput, relint } from '../routes/views.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { buildFigures, commitFigures, discardUnstored, existingAssetNames, rewriteImageRefs } from '../figures/materialize.ts';
import { photosAvailable } from '../figures/stock.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { commitAiRevision, bookFormulaKeys, evidenceText, recordLintIssues, withMarkers } from './draft.ts';
import { fixCheckPrompt, fixCheckSchema, patchPrompt, patchSchema, reviewPrompt, reviewSchema, repairSchema, secondOpinionPrompt, secondOpinionSchema } from './prompts.ts';
import { extractCitations, findSection, headRevision, loadOutline, loadProject, revisionForTask, truncate } from './util.ts';

const cut = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

type Severity = 'blocker' | 'major' | 'minor';
const RANK: Record<Severity, number> = { minor: 0, major: 1, blocker: 2 };
interface Finding { sectionId: string; severity: Severity; quote: string; message: string; suggestion: string; category?: string }

/**
 * Second opinion on review findings: another model re-reads each one against the text and the sources, drops the ones that
 * are not real and may lower (never raise) the severity. When the check cannot run, the findings stay as they are.
 */
async function secondOpinion<F extends Finding>(ctx: AppContext, t: TaskContext, p: { projectId: string; language: string; notation?: string; findings: F[]; text: string; evidence: string }) {
  const kept: F[] = [];
  const dropped: { finding: F; reason: string }[] = [];
  let lowered = 0;
  if (!p.findings.length) return { kept, dropped, lowered, checked: undefined as boolean | undefined, model: undefined as string | undefined };
  const list = p.findings.map((f, n) => `${n + 1}. [${f.sectionId}] [${f.severity}] ${f.quote ? `"${f.quote}" ` : ''}${f.message}${f.suggestion ? ` Suggested fix: ${f.suggestion}` : ''}`).join('\n');
  try {
    const { data, route } = await runRole(ctx, {
      role: 'verifier', ...secondOpinionPrompt({ language: p.language, notation: p.notation, findings: list, text: p.text, evidence: p.evidence }),
      schema: secondOpinionSchema, projectId: p.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    const verdicts = new Map(data.findings.map((v) => [v.index - 1, v]));
    p.findings.forEach((f, n) => {
      const v = verdicts.get(n);
      if (v?.verdict === 'not-real') { dropped.push({ finding: f, reason: v.reason.trim() }); return; }
      if (v && RANK[v.severity] < RANK[f.severity]) { lowered++; kept.push({ ...f, severity: v.severity }); return; }
      kept.push(f);
    });
    return { kept, dropped, lowered, checked: true as boolean | undefined, model: route.model as string | undefined };
  } catch (err) {
    if (!(err instanceof TaskError) || t.signal.aborted) throw err;
    return { kept: [...p.findings], dropped, lowered, checked: false as boolean | undefined, model: undefined as string | undefined };
  }
}

const notRealResolution = (reason: string) => `Second opinion: not a real problem.${reason ? ` ${reason}` : ''}`;

/**
 * Chapter review. Modes: "changed" (the default) reads the whole chapter the first time and afterwards only the blocks written
 * since the last review; "full" reviews every section on its own call; "recheck" asks for a second opinion on the issues
 * already open, without a new review. Every finding gets the second opinion before it is stored.
 */
export interface ReviewResult {
  skipped?: boolean | string; reused?: boolean; reviewed?: string; mode?: string; full?: boolean; model?: string; verifier?: string;
  issues?: number; dropped?: number; lowered?: number; checked?: boolean; rechecked?: number; skippedSettled?: number; outOfScope?: number; compileIssues?: number;
}

export async function chapterReview(ctx: AppContext, t: TaskContext): Promise<ReviewResult> {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const mode = (t.task.input.mode as 'changed' | 'full' | 'recheck' | undefined) ?? (t.task.input.full ? 'full' : 'changed');
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true };
  const sections = chapter.sections.map((s) => ({ s, head: headRevision(ctx, projectId, s.id) })).filter((x) => x.head);
  // Nothing written yet: a review would only report that every objective is missing.
  if (!sections.length) return { skipped: 'no drafted sections' };
  const reviewed = sections.map((x) => x.head!.id).sort().join(',');
  const prior = ctx.db.get<{ result: string }>(`SELECT result FROM tasks WHERE project_id = ? AND kind = 'chapter.review' AND state = 'succeeded' AND json_extract(input, '$.chapterId') = ? AND json_extract(result, '$.reviewed') IS NOT NULL ORDER BY finished_at DESC LIMIT 1`, projectId, chapterId);
  const priorReviewed = prior ? json<{ reviewed?: string }>(prior.result, {}).reviewed : undefined;
  // Re-reviewing identical text wastes quota.
  if (mode === 'changed' && priorReviewed === reviewed && !t.task.input.force) return { reused: true, reviewed };
  const reviewNodes = [chapterId, ...chapter.sections.map((s) => s.id)];
  const inNodes = reviewNodes.map(() => '?').join(',');
  const notation = outline!.outline.notation;

  const sectionText = (x: (typeof sections)[number]) => `=== [${x.s.id}] ${x.s.title} ===\n${x.head!.markdown}`;
  const sectionEvidence = (id: string, max = 6000) => {
    const p = ctx.db.get('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1', projectId, id);
    if (!p) return '';
    return `[${id}]\n${evidenceText(ctx, { id: p.id as string, projectId, nodeId: id, provider: p.provider as 'local', query: '', answer: '', notes: json(p.notes, []), createdAt: '' }, max).notes}`;
  };
  // The second opinion reads only the sections that have findings.
  const contextFor = (ids: Set<string>) => {
    const involved = sections.filter((x) => ids.has(x.s.id) || ids.has(chapterId));
    return { text: truncate(involved.map(sectionText).join('\n\n'), 100_000), evidence: truncate(involved.map((x) => sectionEvidence(x.s.id)).filter(Boolean).join('\n\n'), 30_000) };
  };

  if (mode === 'recheck') {
    const open = ctx.db.all<{ id: string; node_id: string; severity: Severity; quote: string; message: string; suggestion: string }>(
      `SELECT id, node_id, severity, quote, message, suggestion FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'open' AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
    const opinion = await secondOpinion(ctx, t, { projectId, language: project.language, notation, findings: open.map((o) => ({ ...o, sectionId: o.node_id })), ...contextFor(new Set(open.map((o) => o.node_id))) });
    ctx.db.tx(() => {
      for (const d of opinion.dropped) ctx.db.run(`UPDATE review_issues SET status = 'dismissed', resolution = ? WHERE id = ?`, notRealResolution(d.reason), d.finding.id);
      for (const k of opinion.kept) ctx.db.run('UPDATE review_issues SET severity = ? WHERE id = ?', k.severity, k.id);
    });
    issuesChanged(ctx, projectId, open.map((o) => o.id));
    // The text was not reviewed again: the next review compares with the same revisions as before.
    return { rechecked: open.length, dropped: opinion.dropped.length, lowered: opinion.lowered, checked: opinion.checked, model: opinion.model, ...(priorReviewed ? { reviewed: priorReviewed } : {}) };
  }

  // After the first review only the blocks written since the last one are reviewed. Re-reading text that was already reviewed
  // made every pass report a different handful of old passages, so the issues never ran out.
  const full = !priorReviewed || mode === 'full';
  const before = new Map<string, string>();
  if (!full) {
    const ids = priorReviewed!.split(',').filter(Boolean);
    const rows = ctx.db.all<{ node_id: string; markdown: string }>(`SELECT node_id, markdown FROM content_revisions WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    for (const r of rows) before.set(r.node_id, r.markdown);
  }
  const changedBlocks = new Map(sections.map(({ s, head }) => {
    const old = new Set(splitBlocks(before.get(s.id) ?? '').map((b) => b.text.trim()));
    return [s.id, splitBlocks(head!.markdown).map((b) => b.text.trim()).filter((b) => !old.has(b))] as const;
  }));
  const inChanged = (nodeId: string, quote: string) => !!quote.trim() && (changedBlocks.get(nodeId) ?? []).some((b) => quoteInBlock(quote, b));
  const changedText = sections.filter(({ s }) => changedBlocks.get(s.id)!.length).map(({ s }) => `--- [${s.id}] ---\n${changedBlocks.get(s.id)!.join('\n\n')}`).join('\n\n');
  const handledRows = ctx.db.all<{ node_id: string; status: string; quote: string; message: string }>(
    `SELECT node_id, status, quote, message FROM review_issues WHERE project_id = ? AND source = 'review' AND status IN ('dismissed', 'accepted', 'fixed') AND node_id IN (${inNodes}) ORDER BY rowid DESC LIMIT 60`, projectId, ...reviewNodes);
  const handledFor = (nodes: Set<string>) => {
    const rows = handledRows.filter((r) => nodes.has(r.node_id));
    const line = (r: { node_id: string; quote: string; message: string }) => `- [${r.node_id}] ${r.quote ? `"${cut(r.quote, 120)}" ` : ''}${cut(r.message, 200)}`;
    const decided = rows.filter((r) => r.status !== 'fixed');
    const fixed = rows.filter((r) => r.status === 'fixed');
    return [
      decided.length ? `ISSUES THE AUTHOR DECIDED ARE FINE (newest first). Never report these again, in any wording:\n${decided.map(line).join('\n')}` : '',
      fixed.length ? `ISSUES ALREADY FIXED (newest first). Report one again only if the text above still has the problem:\n${fixed.map(line).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  };

  const review = (p: { text: string; evidence: string; objectives: string; changes: string; handled: string }) => runRole(ctx, {
    role: 'reviewer', ...reviewPrompt({ language: project.language, notation, chapterTitle: chapter.title, chapter: truncate(p.text, 120_000), evidence: truncate(p.evidence, 40_000), objectives: p.objectives, changes: p.changes, handled: p.handled }),
    schema: reviewSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const objectivesOf = (list: typeof chapter.sections) => list.map((s) => `[${s.id}] ${s.title}: ${s.objectives.join('; ')}`).join('\n');
  const raw: Finding[] = [];
  let model: string | undefined;
  if (mode === 'full') {
    // One call per section: a whole chapter in one call got a different handful of problems each time.
    for (const x of sections) {
      const others = chapter.sections.filter((s) => s.id !== x.s.id).map((s) => `[${s.id}] ${s.title}`).join('; ');
      const call = await review({
        text: sectionText(x), evidence: sectionEvidence(x.s.id, 12_000), objectives: objectivesOf([x.s]), handled: handledFor(new Set([x.s.id])),
        changes: `This is a full review of one section of the chapter: review all of it. The chapter's other sections, not shown, are: ${others || '(none)'}. Report only problems in this section, with sectionId "${x.s.id}".`,
      });
      model = call.route.model;
      for (const i of call.data.issues) raw.push({ ...i, sectionId: x.s.id });
    }
  } else if (full || changedText) {
    // Text that changed only in blocks already reviewed (or not at all) needs no model call.
    const call = await review({
      text: sections.map(sectionText).join('\n\n'), evidence: sections.map((x) => sectionEvidence(x.s.id)).filter(Boolean).join('\n\n'), objectives: objectivesOf(chapter.sections), handled: handledFor(new Set(reviewNodes)),
      changes: full
        ? 'This is a full review: review all of the text.'
        : `SINCE THE LAST REVIEW only the passages below are new or rewritten. The rest of the chapter was reviewed before and is shown for context. Report only problems inside these passages, quoting them; anything else is ignored.\n\n${truncate(changedText, 60_000) || '(no changed passages)'}`,
    });
    model = call.route.model;
    raw.push(...call.data.issues);
  }
  const valid = new Map(sections.map(({ s, head }) => [s.id, head!.id]));

  // Findings outside the text under review, and ones matching an issue the author settled, never reach the second opinion.
  const settled = ctx.db.all<{ node_id: string; quote: string }>(`SELECT node_id, quote FROM review_issues WHERE project_id = ? AND source = 'review' AND status IN ('dismissed', 'accepted') AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
  let outOfScope = 0;
  let skippedSettled = 0;
  const candidates: Finding[] = [];
  for (const i of raw) {
    const nodeId = valid.has(i.sectionId) ? i.sectionId : chapterId;
    if (!full && !(nodeId !== chapterId && inChanged(nodeId, i.quote))) { outOfScope++; continue; }
    if (settled.some((x) => x.node_id === nodeId && sameQuote(x.quote, i.quote))) { skippedSettled++; continue; }
    candidates.push({ ...i, sectionId: nodeId });
  }
  const opinion = await secondOpinion(ctx, t, { projectId, language: project.language, notation, findings: candidates, ...contextFor(new Set(candidates.map((c) => c.sectionId))) });

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

  ctx.db.tx(() => {
    // A full review replaces every open issue; findings that match no section are stored under the chapter id, so it is part
    // of the cleanup. A later review replaces only the open issues it read again (in changed passages) and those whose passage
    // is gone. Resolved history stays.
    if (full) ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'open' AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
    else {
      const open = ctx.db.all<{ id: string; node_id: string; quote: string }>(`SELECT id, node_id, quote FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'open' AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
      for (const o of open) {
        const head = sections.find((x) => x.s.id === o.node_id)?.head;
        if (head && o.quote.trim() && (inChanged(o.node_id, o.quote) || !quoteInBlock(o.quote, head.markdown))) ctx.db.run('DELETE FROM review_issues WHERE id = ?', o.id);
      }
    }
    // Fixes that wait on a proposal that no longer exists are leftovers of earlier passes; a live proposal keeps its issues.
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'proposed' AND node_id IN (${inNodes}) AND resolution NOT IN (SELECT 'Proposal ' || id FROM content_revisions WHERE project_id = ? AND status = 'proposal')`, projectId, ...reviewNodes, projectId);
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND source = 'lint' AND status = 'open' AND (category = 'compile' OR category LIKE 'compile:%') AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
    const store = (i: Finding, status: string, resolution: string) => ctx.db.insert('review_issues', {
      id: newId(), project_id: projectId, node_id: i.sectionId, question_id: null, rev_id: valid.get(i.sectionId) ?? null, source: 'review',
      severity: i.severity, category: i.category ?? 'correctness', quote: i.quote, message: i.message, suggestion: i.suggestion, status, resolution, created_at: now(),
    });
    for (const i of opinion.kept) store(i, 'open', '');
    // Dropped findings stay visible under "dismissed", and the reviewer is told not to raise them again.
    for (const d of opinion.dropped) store(d.finding, 'dismissed', notRealResolution(d.reason));
    for (const c of compileIssues) {
      ctx.db.insert('review_issues', {
        id: newId(), project_id: projectId, node_id: c.nodeId, question_id: null, rev_id: valid.get(c.nodeId) ?? null, source: 'lint', severity: c.severity,
        category: c.rule ? `compile:${c.rule}` : 'compile', quote: c.quote, message: c.message, suggestion: '', status: 'open', resolution: '', created_at: now(),
      });
    }
  });
  ctx.events.emit('issue.created', { chapterId, count: opinion.kept.length }, { projectId, runId: t.task.runId });
  return {
    issues: opinion.kept.length, dropped: opinion.dropped.length, lowered: opinion.lowered, checked: opinion.checked,
    skippedSettled, outOfScope, mode, full, compileIssues: compileIssues.length, reviewed, model, verifier: opinion.model,
  };
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
    role, ...patchPrompt({ language: project.language, blocks: blocks.map((b, i) => `[B${i}]\n${b}`).join('\n\n'), requests, evidence: ev, knownFormulas: known, sectionIds, minimal: !instructed && issues.length > 0, figures: project.options.figures ? { photos: photosAvailable(ctx) } : null }),
    schema: patchSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  // A fix may add figures; image blocks pointing at neither a new figure nor an existing asset are removed.
  const built = await buildFigures(ctx, {
    projectId, nodeId, language: project.language, figures: project.options.figures ? data.figures ?? [] : [], photos: photosAvailable(ctx),
    runId: t.task.runId, taskId: t.task.id, signal: t.signal, progress: (m) => t.progress(m),
  });
  const existing = existingAssetNames(ctx, projectId);
  for (const c of data.changes) c.text = rewriteImageRefs(c.text, built, existing);
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
    discardUnstored(built, []);
    reopen(issues, (id) => `The AI fix was not applied: ${dropped(issues.find((i) => i.id === id)!) ?? fallback}`);
    issuesChanged(ctx, projectId, issues.map((i) => i.id));
    return { skipped: 'no change survived the checks', reverted: reasons, ...(checked === undefined ? {} : { checked }) };
  }

  const { markdown, citations } = extractCitations(working.filter((b) => b.trim()).join('\n\n'), splitBlocks);
  // Losing more than a fifth of the text is the author's call, unless the fix was about repetition.
  const shrunk = !!issues.length && markdown.length < head.markdown.length * 0.8 && !issues.some((i) => i.category === 'repetition');
  const answered = issues.filter((i) => !dropped(i) && !unresolved.has(issues.indexOf(i)));
  let committed!: ReturnType<typeof commitAiRevision>;
  let stored: string[] = [];
  let saved = false;
  try {
    ctx.db.tx(() => {
      let text = markdown;
      ({ markdown: text, stored } = commitFigures(ctx, { projectId, nodeId, built, markdown: text, replace: false, replaced: [] }));
      committed = commitAiRevision(ctx, { projectId, nodeId, kind, markdown: text, baseRevId: head.id, model: route.model, origin: 'repair', citations, forceProposal: instructed || shrunk || !issues.length, runId: t.task.runId, taskId: t.task.id });
      const applied = committed.status === 'current';
      const done = new Set(answered.map((i) => i.id));
      if (answered.length) ctx.db.run(`UPDATE review_issues SET status = ?, resolution = ? WHERE id IN (${answered.map(() => '?').join(',')})`, applied ? 'fixed' : 'proposed', applied ? `Fixed by AI in revision ${committed.revId}` : `Proposal ${committed.revId}`, ...answered.map((i) => i.id));
      reopen(issues.filter((i) => !done.has(i.id)), (id) => {
        const i = issues.find((x) => x.id === id)!;
        const r = dropped(i);
        return r ? `The AI fix was not applied: ${r}` : `The AI fix did not resolve it: ${unresolved.get(issues.indexOf(i))}`;
      });
    });
    saved = true;
  } finally {
    discardUnstored(built, saved ? stored : []);
  }
  if (stored.length) ctx.events.emit('asset.updated', { nodeId, assetIds: stored }, { projectId });
  if (issues.length) issuesChanged(ctx, projectId, issues.map((i) => i.id));
  if (committed.status === 'current') relint(ctx, projectId, nodeId);
  const findings = lintSection(markdown, { sectionId: nodeId, language: project.language });
  return { revId: committed.revId, status: committed.status, findings: findings.length, reverted: reasons, ...(checked === undefined ? {} : { checked }), ...(shrunk ? { shrunk: true } : {}) };
}

export { recordLintIssues };
