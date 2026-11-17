// Review: independent model pass over a chapter, and targeted revisions requested by the author.
import { applyGuardedChanges, compileChapter, dropReferences, formatModelText, lintSection, MIN_KEPT_SHARE, quoteInBlock, sameQuote, splitBlocks } from '@smartbuilder/content';
import { outlineSchema, subjectProfileOf, type EvidenceNote } from '@smartbuilder/domain';
import { currentHeads, repairHead } from '../repo/content.ts';
import { countOpenSerious, issuesChanged, setIssuesStatus, sweepDue } from '../repo/issues.ts';
import { questionsChanged, recordQuestionRevision } from '../repo/questions.ts';
import { bookContext, chapterInput, relint } from '../routes/views.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { buildFigures, commitFigures, discardUnstored, existingAssetNames, rewriteImageRefs } from '../figures/materialize.ts';
import { photosAvailable } from '../figures/stock.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext, type TaskSpec } from '../queue/queue.ts';
import { commitAiRevision, bookFormulaKeys, evidenceText, recordLintIssues } from './draft.ts';
import { readyProgram } from '../repo/program.ts';
import { dropDecorative, figurePlaces } from './figureCheck.ts';
import { isFormatIssue, settleSectionFormatting } from './formatting.ts';
import { chapterTopicIds, examSymbols } from './exam.ts';
import { CUT, figureSetupOf, fixCheckPrompt, fixCheckSchema, patchParser, patchPrompt, programItemsText, reviewPrompt, reviewSchema, repairSchema, resolutionCheckPrompt, resolutionCheckSchema, secondOpinionPrompt, secondOpinionSchema } from './prompts.ts';
import { extractCitations, findSection, formulaKeyLabels, headRevision, loadOutline, loadProject, revisionForTask, truncate } from './util.ts';

const cut = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

type Severity = 'blocker' | 'major' | 'minor';
const RANK: Record<Severity, number> = { minor: 0, major: 1, blocker: 2 };
interface Finding { sectionId: string; severity: Severity; quote: string; message: string; suggestion: string; category?: string; points?: Point[] }

/**
 * A finding that says the text is false as written (category correctness) and that the reviewer rated blocker or major stays
 * at least major after the second opinion. Reviews of changed text drop minors, so a lowered one was never read again: 9 of 13
 * known errors a replay caught ended as minor this way.
 */
export function severityAfterOpinion(f: { severity: Severity; category?: string }, opinion: Severity): Severity {
  if (RANK[opinion] >= RANK[f.severity]) return f.severity;
  return (f.category ?? 'correctness') === 'correctness' && RANK[f.severity] >= RANK.major && RANK[opinion] < RANK.major ? 'major' : opinion;
}

/** One problem a reviewer raised about a passage. A merged finding keeps one per distinct problem its members raised. */
interface Point { severity: Severity; category?: string; quote: string; message: string; suggestion: string }
const flatText = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
/** Where a quote sits in its block, as a character range of the whitespace-normalised block (the whole block when the quote holds it). */
function spanIn(quote: string, block: string): [number, number] {
  const b = flatText(block);
  const q = flatText(quote);
  const at = b.indexOf(q.slice(0, 60));
  return at < 0 ? [0, b.length] : [at, at + q.length];
}

/** The finding as one issue: a single point as it is, several as a numbered list with the passage each one is about. */
function withPoints<F extends Finding>(f: F, points: Point[]): F {
  const top = points.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a));
  const category = points.some((x) => (x.category ?? 'correctness') === 'correctness') ? 'correctness' : top.category;
  const base = { ...f, severity: top.severity, category, quote: top.quote };
  if (points.length === 1) return { ...base, message: top.message, suggestion: top.suggestion, points: undefined };
  return {
    ...base,
    message: points.map((x, n) => `(${n + 1}) ${x.quote ? `"${x.quote}": ` : ''}${x.message}`).join(' '),
    suggestion: points.map((x, n) => (x.suggestion ? `(${n + 1}) ${x.suggestion}` : '')).filter(Boolean).join(' '),
    points,
  };
}

/**
 * Findings of several reviewer calls on one passage, merged before the second opinion: same section, and quotes in the same
 * block of at least 20 characters (a shorter block, such as one that is only ".", says nothing about the problem). Members
 * whose quotes overlap in the block or whose messages are the same are one point; members that raise different problems in
 * the block stay separate points of the merged finding, so a second error in the same sentence is not lost (Analisi 2 ch. 8
 * has one sentence with two wrong claims). The most severe point stands for each point and for the group, with category
 * `correctness` when any member has it, so the floor of severityAfterOpinion still applies. On the 47 stored findings of
 * three runs it made 11 groups and merged 15 findings.
 */
export function mergeRepeats<F extends Finding>(findings: F[], blocksOf: (sectionId: string) => string[]): { findings: F[]; merged: number } {
  const groups = new Map<string, { block: string; members: F[] }>();
  const order: (string | F)[] = [];
  for (const f of findings) {
    const blocks = f.quote.trim() ? blocksOf(f.sectionId) : [];
    const n = blocks.findIndex((b) => quoteInBlock(f.quote, b));
    if (n < 0 || blocks[n].trim().length < 20) { order.push(f); continue; }
    const key = `${f.sectionId}\n${n}`;
    if (!groups.has(key)) { groups.set(key, { block: blocks[n], members: [] }); order.push(key); }
    groups.get(key)!.members.push(f);
  }
  let merged = 0;
  const out = order.map((x) => {
    if (typeof x !== 'string') return x;
    const { block, members } = groups.get(x)!;
    merged += members.length - 1;
    // Each member joins the first point it repeats: a quote that overlaps one of the point's quotes, or the same message.
    const points: F[][] = [];
    for (const f of members) {
      const [a, b] = spanIn(f.quote, block);
      const same = points.find((p) => p.some((g) => {
        const [c, d] = spanIn(g.quote, block);
        return (a < d && c < b) || flatText(g.message).toLowerCase() === flatText(f.message).toLowerCase();
      }));
      if (same) same.push(f); else points.push([f]);
    }
    const top = members.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a));
    return withPoints(top, points.map((p) => {
      const lead = p.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a));
      const category = p.some((f) => (f.category ?? 'correctness') === 'correctness') ? 'correctness' : lead.category;
      return { severity: lead.severity, category, quote: lead.quote, message: lead.message, suggestion: lead.suggestion };
    }));
  });
  return { findings: out, merged };
}

/**
 * Second opinion on review findings: another model re-reads each one against the text and the sources, drops the ones that
 * are not real and may lower (never raise) the severity, down to the floor of severityAfterOpinion. A merged finding with
 * several points is real when any point is; only the points the verifier says hold are kept, or all of them when it names
 * none. When the check cannot run, the findings stay as they are.
 */
async function secondOpinion<F extends Finding>(ctx: AppContext, t: TaskContext, p: { projectId: string; language: string; notation?: string; examSymbols?: string[]; findings: F[]; text: string; evidence: string }) {
  const kept: F[] = [];
  const dropped: { finding: F; reason: string }[] = [];
  let lowered = 0;
  if (!p.findings.length) return { kept, dropped, lowered, checked: undefined as boolean | undefined, model: undefined as string | undefined };
  const line = (x: { quote: string; message: string; suggestion: string }) => `${x.quote ? `"${x.quote}" ` : ''}${x.message}${x.suggestion ? ` Suggested fix: ${x.suggestion}` : ''}`;
  const list = p.findings.map((f, n) => `${n + 1}. [${f.sectionId}] [${f.severity}] ${f.points
    ? `${f.points.length} points raised by independent reviewers about this passage:${f.points.map((x, k) => `\n   ${n + 1}.${k + 1} ${line(x)}`).join('')}`
    : line(f)}`).join('\n');
  try {
    const { data, route } = await runRole(ctx, {
      role: 'verifier', ...secondOpinionPrompt({ language: p.language, notation: p.notation, examSymbols: p.examSymbols, findings: list, text: p.text, evidence: p.evidence }),
      schema: secondOpinionSchema, projectId: p.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
    });
    const verdicts = new Map(data.findings.map((v) => [v.index - 1, v]));
    p.findings.forEach((f, n) => {
      const v = verdicts.get(n);
      if (v?.verdict === 'not-real') { dropped.push({ finding: f, reason: v.reason.trim() }); return; }
      const holding = f.points?.filter((_, k) => v?.points?.includes(k + 1));
      const g = f.points && holding?.length ? withPoints(f, holding) : f;
      const severity = v ? severityAfterOpinion(g, v.severity) : g.severity;
      if (RANK[severity] < RANK[g.severity]) lowered++;
      kept.push({ ...g, severity });
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
 * since the last review, except for a sweep the author asked for (`input.sweep`, see sweepDue); "full" reviews every section on its own
 * call; "recheck" asks for a second opinion on the issues already open, without a new review. A read of the whole chapter
 * (the first review and the sweep) is made by several independent calls, because each call finds a different part of the
 * errors. Every finding gets the second opinion before it is stored.
 */
export interface ReviewResult {
  /** The round left no open blocker or major in the chapter (any source), and how many there are. See ReviewState for the book as a whole. */
  clean?: boolean; openSerious?: number;
  skipped?: boolean | string; reused?: boolean; reviewed?: string; mode?: string; full?: boolean; model?: string; verifier?: string;
  /** The whole chapter was read again after a fix round, because the author asked for it. */
  sweep?: boolean;
  /** Reviewer calls that read the chapter, and the cross review next to them (its model, or false when it could not run). */
  samples?: number; crossModel?: string | false;
  /** The model of each reviewer call, in order. */
  sampleModels?: string[];
  /** A whole-chapter read (the first review or a sweep) whose reviewer calls all ran on the primary route: the read sweepDue counts from. */
  chapterRead?: boolean;
  issues?: number; dropped?: number; lowered?: number; merged?: number; checked?: boolean; rechecked?: number; skippedSettled?: number; outOfScope?: number; minorsDropped?: number; compileIssues?: number;
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
  const reviewNodes = [chapterId, ...chapter.sections.map((s) => s.id)];
  // What the round left: blockers and majors still open (or waiting as a proposal) in the chapter, from every source.
  const standing = () => { const openSerious = countOpenSerious(ctx, projectId, reviewNodes); return { clean: openSerious === 0, openSerious }; };
  // Only a review run the author started with the sweep sweeps; the review at the end of a generate run never does. A sweep
  // can run on unchanged text: a chapter whose reviews were all made before whole-chapter reads were recorded is due for one.
  const sweepAsked = mode === 'changed' && !!priorReviewed && !!t.task.input.sweep && sweepDue(ctx, projectId, chapterId, reviewNodes, reviewed);
  if (mode === 'changed' && priorReviewed === reviewed && !t.task.input.force && !sweepAsked) return { reused: true, reviewed, ...standing() };
  const inNodes = reviewNodes.map(() => '?').join(',');
  const notation = outline!.outline.notation;
  // The reviewer learns what the exam covers, so it flags extra material as minor instead of inventing scope.
  const program = readyProgram(ctx, projectId);
  const chapterItems = program ? program.items.filter((i) => chapter.sections.some((s) => s.programItems.includes(i.key))) : [];
  const symbols = examSymbols(ctx, projectId, [...chapterTopicIds(chapter)]);
  const programText = chapterItems.length ? programItemsText(chapterItems, 300) : undefined;

  const sectionText = (x: (typeof sections)[number]) => `=== [${x.s.id}] ${x.s.title} ===\n${x.head!.markdown}`;
  const sectionEvidence = (id: string, max = 6000) => {
    const p = ctx.db.get('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1', projectId, id);
    if (!p) return '';
    return `[${id}]\n${evidenceText(ctx, { id: p.id as string, projectId, nodeId: id, provider: p.provider as 'local', query: '', answer: '', notes: json(p.notes, []), createdAt: '' }, max).notes}`;
  };
  // The summary the section's draft task recorded for the writers of later sections: what a reviewer needs of a section it does not read in full.
  const summaryOf = (x: (typeof sections)[number]) => {
    const done = ctx.db.get<{ result: string }>(`SELECT result FROM tasks WHERE project_id = ? AND kind = 'section.draft' AND state = 'succeeded' AND json_extract(input, '$.nodeId') = ? ORDER BY finished_at DESC LIMIT 1`, projectId, x.s.id);
    return json<{ summary?: string }>(done?.result, {}).summary || x.s.objectives.join('; ');
  };
  // The second opinion reads only the sections that have findings. A finding filed under no section (a chapter-level one)
  // belongs to the sections that hold its quote; only when none does, every section is shown.
  const contextFor = (ids: Set<string>, quotes: string[] = []) => {
    const sectionIds = new Set([...ids].filter((id) => id !== chapterId));
    if (ids.has(chapterId)) {
      const holding = sections.filter((x) => quotes.some((q) => quoteInBlock(q, x.head!.markdown)));
      for (const x of holding.length ? holding : sections) sectionIds.add(x.s.id);
    }
    const involved = sections.filter((x) => sectionIds.has(x.s.id));
    return { text: truncate(involved.map(sectionText).join('\n\n'), 100_000), evidence: truncate(involved.map((x) => sectionEvidence(x.s.id)).filter(Boolean).join('\n\n'), 30_000) };
  };

  if (mode === 'recheck') {
    const open = ctx.db.all<{ id: string; node_id: string; severity: Severity; category: string; quote: string; message: string; suggestion: string }>(
      `SELECT id, node_id, severity, category, quote, message, suggestion FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'open' AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
    const opinion = await secondOpinion(ctx, t, { projectId, language: project.language, notation, examSymbols: symbols, findings: open.map((o) => ({ ...o, sectionId: o.node_id })), ...contextFor(new Set(open.map((o) => o.node_id)), open.map((o) => o.quote)) });
    ctx.db.tx(() => {
      for (const d of opinion.dropped) ctx.db.run(`UPDATE review_issues SET status = 'dismissed', resolution = ? WHERE id = ?`, notRealResolution(d.reason), d.finding.id);
      for (const k of opinion.kept) ctx.db.run('UPDATE review_issues SET severity = ? WHERE id = ?', k.severity, k.id);
    });
    issuesChanged(ctx, projectId, open.map((o) => o.id));
    // The text was not reviewed again: the next review compares with the same revisions as before.
    return { rechecked: open.length, dropped: opinion.dropped.length, lowered: opinion.lowered, checked: opinion.checked, model: opinion.model, ...standing(), ...(priorReviewed ? { reviewed: priorReviewed } : {}) };
  }

  // After the first review only the blocks written since the last one are reviewed. Re-reading text that was already reviewed
  // made every pass report a different handful of old passages, so the issues never ran out.
  const full = !priorReviewed || mode === 'full';
  // The sweep reads the whole chapter and keeps minors as the first review does, but replaces open issues as a `changed` review does.
  const sweep = !full && sweepAsked;
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
  const line = (r: { node_id: string; quote: string; message: string }) => `- [${r.node_id}] ${r.quote ? `"${cut(r.quote, 120)}" ` : ''}${cut(r.message, 200)}`;
  const handledFor = (nodes: Set<string>) => {
    const rows = handledRows.filter((r) => nodes.has(r.node_id));
    const decided = rows.filter((r) => r.status !== 'fixed');
    const fixed = rows.filter((r) => r.status === 'fixed');
    return [
      decided.length ? `ISSUES THE AUTHOR DECIDED ARE FINE (newest first). Never report these again, in any wording:\n${decided.map(line).join('\n')}` : '',
      fixed.length ? `ISSUES ALREADY FIXED (newest first). Report one again only if the text above still has the problem:\n${fixed.map(line).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  };
  // The sweep also learns what is still open, so it does not report it twice, and the mistakes fixed in other chapters, because
  // the same wrong claim can stand in two chapters (Analisi 2: fixed in 1.4, left in 2.5).
  const sweepContext = () => {
    // Only the issues the sweep keeps: one whose quote is gone from its section is deleted below, so it must be reported again.
    const open = ctx.db.all<{ node_id: string; quote: string; message: string }>(
      `SELECT node_id, quote, message FROM review_issues WHERE project_id = ? AND source = 'review' AND status IN ('open', 'proposed') AND node_id IN (${inNodes}) ORDER BY rowid DESC LIMIT 60`, projectId, ...reviewNodes)
      .filter((r) => { const head = sections.find((x) => x.s.id === r.node_id)?.head; return !head || !r.quote.trim() || quoteInBlock(r.quote, head.markdown); });
    const elsewhere = ctx.db.all<{ node_id: string; quote: string; message: string }>(
      `SELECT node_id, quote, message FROM review_issues WHERE project_id = ? AND source = 'review' AND status = 'fixed' AND category IN ('correctness', 'missing-hypothesis') AND (node_id IS NULL OR node_id NOT IN (${inNodes})) ORDER BY rowid DESC LIMIT 30`, projectId, ...reviewNodes);
    return [
      open.length ? `ISSUES STILL OPEN (already reported, waiting for a fix). Do not report these again:\n${open.map(line).join('\n')}` : '',
      elsewhere.length ? `MISTAKES FIXED IN OTHER CHAPTERS (newest first). Look for the same kind of mistake in this chapter:\n${elsewhere.map(line).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  };

  const review = (p: { text: string; evidence: string; objectives: string; changes: string; handled: string }, role: 'reviewer' | 'crossReviewer' = 'reviewer') => runRole(ctx, {
    role, ...reviewPrompt({ language: project.language, notation, examSymbols: symbols, program: programText, chapterTitle: chapter.title, chapter: truncate(p.text, 120_000), evidence: truncate(p.evidence, 40_000), objectives: p.objectives, changes: p.changes, handled: p.handled, profile: subjectProfileOf(project) }),
    schema: reviewSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const objectivesOf = (list: typeof chapter.sections) => list.map((s) => `[${s.id}] ${s.title}: ${s.objectives.join('; ')}`).join('\n');
  const raw: Finding[] = [];
  let model: string | undefined;
  let samples = 0;
  const sampleModels: string[] = [];
  let onFallback = false;
  let crossModel: string | false | undefined;
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
  } else if (full || sweep) {
    // Each call reports a different part of the errors (three identical calls caught 8, 6 and 4 of 9 known errors, and 9
    // together), so the whole chapter is read by `reviewSamples` reviewer calls and the union is kept. The cross review reads it
    // once more on another model, which finds broken text the reviewer misses; the review goes on without it when it fails.
    const input = {
      text: sections.map(sectionText).join('\n\n'), evidence: sections.map((x) => sectionEvidence(x.s.id)).filter(Boolean).join('\n\n'), objectives: objectivesOf(chapter.sections),
      handled: [handledFor(new Set(reviewNodes)), sweep ? sweepContext() : ''].filter(Boolean).join('\n\n'),
      changes: sweep
        ? 'This is a sweep after a round of fixes: review all of the text again, not only what changed. Earlier reviews found the issues listed below as already fixed. Report what they did not cover, and look for the same kind of mistake as each fixed issue elsewhere in this chapter.'
        : 'This is a full review: review all of the text.',
    };
    for (let n = 0; n < project.options.reviewSamples; n++) {
      const call = await review(input);
      model = call.route.model;
      samples++;
      sampleModels.push(call.route.model);
      onFallback ||= call.fallback;
      raw.push(...call.data.issues);
    }
    try {
      const call = await review(input, 'crossReviewer');
      crossModel = call.route.model;
      raw.push(...call.data.issues);
    } catch (err) {
      if (!(err instanceof TaskError) || t.signal.aborted) throw err;
      crossModel = false;
    }
  } else if (changedText) {
    // Text that changed only in blocks already reviewed (or not at all) needs no model call. A review of changed text gets the
    // sections that changed in full, the others as their summaries, and the evidence of the changed sections only.
    const shown = sections.filter(({ s }) => changedBlocks.get(s.id)!.length);
    const call = await review({
      text: sections.map((x) => (shown.includes(x) ? sectionText(x) : `=== [${x.s.id}] ${x.s.title} (reviewed before, summary only) ===\n${summaryOf(x)}`)).join('\n\n'),
      evidence: shown.map((x) => sectionEvidence(x.s.id)).filter(Boolean).join('\n\n'), objectives: objectivesOf(chapter.sections), handled: handledFor(new Set(reviewNodes)),
      changes: `SINCE THE LAST REVIEW only the passages below are new or rewritten. Sections that did not change are shown as short summaries for context. Report only problems inside these passages, quoting them; anything else is ignored. Report only blockers and majors: a minor issue is dropped without being read, so do not spend words on one.\n\n${truncate(changedText, 60_000) || '(no changed passages)'}`,
    });
    model = call.route.model;
    samples = 1;
    raw.push(...call.data.issues);
  }
  const valid = new Map(sections.map(({ s, head }) => [s.id, head!.id]));

  // Findings outside the text under review, and ones matching an issue the author settled, never reach the second opinion.
  const settled = ctx.db.all<{ node_id: string; quote: string }>(`SELECT node_id, quote FROM review_issues WHERE project_id = ? AND source = 'review' AND status IN ('dismissed', 'accepted') AND node_id IN (${inNodes})`, projectId, ...reviewNodes);
  let outOfScope = 0;
  let skippedSettled = 0;
  let minorsDropped = 0;
  const candidates: Finding[] = [];
  for (const i of raw) {
    const nodeId = valid.has(i.sectionId) ? i.sectionId : chapterId;
    if (!full && !sweep && !(nodeId !== chapterId && inChanged(nodeId, i.quote))) { outOfScope++; continue; }
    // After the first review, text that was rewritten attracts new minor remarks on every pass, so the loop never ends:
    // only blockers and majors count, and a minor never reaches the second opinion. The one sweep per round keeps them.
    if (!full && !sweep && i.severity === 'minor') { minorsDropped++; continue; }
    if (settled.some((x) => x.node_id === nodeId && sameQuote(x.quote, i.quote))) { skippedSettled++; continue; }
    candidates.push({ ...i, sectionId: nodeId });
  }
  // Findings in the order of the text, and one per problem: the reviewer calls of a whole-chapter read report the same problem
  // more than once.
  const order = new Map(sections.map((x, n) => [x.s.id, n]));
  candidates.sort((a, b) => (order.get(a.sectionId) ?? -1) - (order.get(b.sectionId) ?? -1));
  const blocks = new Map(sections.map((x) => [x.s.id, splitBlocks(x.head!.markdown).map((b) => b.text)]));
  const { findings: distinct, merged } = mergeRepeats(candidates, (id) => blocks.get(id) ?? []);
  const opinion = await secondOpinion(ctx, t, { projectId, language: project.language, notation, examSymbols: symbols, findings: distinct, ...contextFor(new Set(distinct.map((c) => c.sectionId)), distinct.map((c) => c.quote)) });

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
        // The sweep is told not to report open issues again, so it replaces only those whose passage is gone.
        if (head && o.quote.trim() && ((!sweep && inChanged(o.node_id, o.quote)) || !quoteInBlock(o.quote, head.markdown))) ctx.db.run('DELETE FROM review_issues WHERE id = ?', o.id);
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
    issues: opinion.kept.length, dropped: opinion.dropped.length, lowered: opinion.lowered, ...(merged ? { merged } : {}), checked: opinion.checked,
    skippedSettled, outOfScope, ...(minorsDropped ? { minorsDropped } : {}), mode: sweep ? 'sweep' : mode, full, ...(sweep ? { sweep } : {}), samples,
    ...(sampleModels.length ? { sampleModels } : {}), ...(sampleModels.length && !onFallback ? { chapterRead: true } : {}), ...(crossModel !== undefined ? { crossModel } : {}), compileIssues: compileIssues.length, reviewed, model, verifier: opinion.model, ...standing(),
  };
}

/**
 * Rewrites a section for author instructions or selected issues. An author instruction always becomes a proposal. A fix for
 * issues is applied as the current text when the guards and the cheap check allow it and the head did not change meanwhile;
 * otherwise it waits as a proposal. Changes that would damage the section are dropped and their issues stay open.
 */
export interface ReviseResult { routed?: { figures?: number; graphs?: number }; resolved?: number; revId?: string; status?: string; reused?: boolean; skipped?: string; findings?: number; reverted?: string[]; checked?: boolean; shrunk?: boolean; figureProblems?: string[] }

/** Program issues about thin coverage or a missing proof ask the fix to add material; every other fix stays minimal. */
const adds = (i: { category: string }) => i.category === 'program-thin' || i.category === 'program-proof';

/**
 * The ids of the evidence notes cited by the blocks that hold the issues' quotes. Empty when it cannot be told which blocks
 * the fix touches (an issue without a quote or whose quote is in no block) or when any of those blocks cites nothing, because
 * the fix of that block would run without its sources.
 */
function citedNotes(blocks: string[], issues: { quote: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const i of issues) {
    const holding = blocks.filter((b) => quoteInBlock(i.quote, b));
    if (!holding.length) return new Set();
    for (const b of holding) {
      const cited = [...b.matchAll(/\[\[([^\]]+)\]\]/g)].flatMap((m) => m[1].split(/[,\s]+/)).filter(Boolean);
      if (!cited.length) return new Set();
      for (const id of cited) ids.add(id);
    }
  }
  return ids;
}

/** The block is an image block (:::image). */
const isImageBlock = (b: string) => /^\s*:::image\{/.test(b);

/**
 * A figure issue asks for a figure that is not there when its quote is not inside an existing image block (a caption or alt
 * text), or when it has no quote and the section has no image at all. Issues about an existing figure (it does not match the
 * text, it is useless) stay with the text fix, which may rewrite or delete the image block.
 * shortcut: a mismatch issue that quotes a paragraph instead of the caption is taken for a missing figure, upgrade by
 * asking the reviewer for an explicit "missing" flag on figure issues.
 */
function asksForFigure(i: { category: string; quote: string }, blocks: string[]): boolean {
  if (i.category !== 'figure') return false;
  if (i.quote.trim()) return !blocks.some((b) => isImageBlock(b) && quoteInBlock(i.quote, b));
  return !blocks.some(isImageBlock);
}

/**
 * Sends the issues the text writer cannot fix to the tasks that can, as tasks of the same run that start after this one
 * (the text fix goes first, so the figures pass reads the new text). Each task closes its issues when its result lands, or
 * leaves them open with the reason. A graph issue whose failing graph is gone, or passes now, closes here with no model call.
 */
function routeIssues(ctx: AppContext, t: TaskContext, p: { nodeId: string; title: string; figures: { id: string; quote: string; message: string; suggestion: string }[]; graphs: { id: string; quote: string; message: string; resolution: string }[] }): ReviseResult['routed'] | undefined {
  const { projectId } = t.task;
  const out: NonNullable<ReviseResult['routed']> = {};
  if (p.figures.length) {
    const brief = p.figures.map((i, n) => `${n + 1}. ${i.message}${i.quote ? ` (at: "${cut(i.quote, 200)}")` : ''}${i.suggestion ? ` Suggested: ${i.suggestion}` : ''}`).join('\n');
    t.enqueue([{ kind: 'section.figures', key: `fixfig:${t.task.id}`, label: `Add the missing figure to "${p.title}"`, input: { nodeId: p.nodeId, issueIds: p.figures.map((i) => i.id), brief }, pool: 'writer', maxAttempts: 2, deps: [t.task.id] }]);
    out.figures = p.figures.length;
  }
  if (p.graphs.length) {
    // A Bode pair is two graph rows, and each can fail. Every failing row is redrawn for the issues about that row. An issue
    // belongs to the row whose title it quotes (saveEnrichment writes the title as the quote). One that matches no row goes to
    // the failing row when there is only one. With several failing it stays open (also when several carry that title), because a redraw of the wrong graph would
    // close it while its own graph still fails. One whose row passes now, or is gone, closes with no model call.
    const rows = ctx.db.all<{ id: string; status: string; payload: string }>(`SELECT id, status, payload FROM enrichments WHERE project_id = ? AND node_id = ? AND kind = 'graph' ORDER BY rowid`, projectId, p.nodeId)
      .map((r) => ({ id: r.id, failing: r.status === 'issue', title: json<{ title?: string }>(r.payload, {}).title ?? '', graphId: json<{ id?: string }>(r.payload, {}).id ?? '' }));
    const failing = rows.filter((r) => r.failing);
    const byRow = new Map<string, typeof p.graphs>();
    const closed: typeof p.graphs = [];
    const unclear: typeof p.graphs = [];
    for (const g of p.graphs) {
      // Two failing graphs with one title cannot be told apart by the quote: the redraw of the first would close both issues.
      const alike = failing.filter((r) => r.title === g.quote);
      if (alike.length > 1) { unclear.push(g); continue; }
      const named = alike[0] ?? rows.find((r) => r.title === g.quote);
      if (!named && failing.length > 1) { unclear.push(g); continue; }
      const row = named ?? failing[0];
      if (!row?.failing) { closed.push(g); continue; }
      byRow.set(row.id, [...(byRow.get(row.id) ?? []), g]);
    }
    if (unclear.length) setIssuesStatus(ctx, projectId, unclear.map((g) => g.id), 'open', `${failing.length} graphs of this section fail their check and this issue does not identify one of them by its title, so no graph was redrawn for it. Edit the graph it is about in Extras, where a saved graph is checked again.`);
    if (closed.length) setIssuesStatus(ctx, projectId, closed.map((g) => g.id), 'fixed', rows.length ? 'The graph passes its check now.' : 'The graph that failed its check is no longer in the book.');
    const specs: TaskSpec[] = [...byRow].map(([rowId, graphs]) => {
      const row = failing.find((r) => r.id === rowId)!;
      // The resolution says why an earlier redraw failed, which the next one must not repeat.
      const purpose = `Redraw the interactive graph "${row.title}" of this section. The old one failed its check, so choose expressions and domains that pass${row.graphId ? `, and give the graph the id "${row.graphId}"` : ''}. ${graphs.map((g) => [g.message, g.resolution].filter((x) => x.trim()).join(' ')).join(' ')}`;
      return { kind: 'enrich.graph', key: `fixgraph:${t.task.id}:${rowId}`, label: `Redraw the graph "${row.title}" of "${p.title}"`, input: { nodeId: p.nodeId, purpose, force: true, replaceId: rowId, issueIds: graphs.map((g) => g.id) }, pool: 'editor', deps: [t.task.id] };
    });
    if (specs.length) t.enqueue(specs);
    out.graphs = [...byRow.values()].reduce((n, g) => n + g.length, 0) || undefined;
  }
  return out.figures || out.graphs ? out : undefined;
}

export async function sectionRevise(ctx: AppContext, t: TaskContext): Promise<ReviseResult> {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  // Checkpoint: this task already stored its result in an earlier attempt.
  const mine = revisionForTask(ctx, projectId, nodeId, t.task.id);
  if (mine) return { revId: mine.id, status: mine.status, reused: true };
  let head = headRevision(ctx, projectId, nodeId);
  if (!head) return { skipped: 'no text yet' };
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const issueIds = (t.task.input.issueIds as string[] | undefined) ?? [];
  const selected = issueIds.length ? ctx.db.all<{ id: string; quote: string; message: string; suggestion: string; severity: string; category: string; source: string; status: string; resolution: string }>(`SELECT id, quote, message, suggestion, severity, category, source, status, resolution FROM review_issues WHERE id IN (${issueIds.map(() => '?').join(',')}) AND node_id = ?`, ...issueIds, nodeId) : [];
  // Two kinds of issue the text writer cannot fix go elsewhere: a missing figure to the figures pass, a graph that failed its check to a redraw.
  const sectionBlocks = splitBlocks(head.markdown).map((b) => b.text);
  const kindOf = (i: (typeof selected)[number]) => (i.source === 'verification' && i.category === 'graph' ? 'graph' as const : asksForFigure(i, sectionBlocks) ? 'figure' as const : null);
  // Formatting findings are settled by code and never listed in a prompt (see settleSectionFormatting).
  const unrouted = selected.filter((i) => !kindOf(i));
  const issues = unrouted.filter((i) => !isFormatIssue(i, 'section'));
  const routed = routeIssues(ctx, t, { nodeId, title: findSection(outline?.outline ?? outlineSchema.parse({ chapters: [] }), nodeId)?.section.title ?? '', figures: selected.filter((i) => kindOf(i) === 'figure'), graphs: selected.filter((i) => kindOf(i) === 'graph') });
  const settled = settleSectionFormatting(ctx, { projectId, nodeId, language: project.language, head, issues: unrouted.filter((i) => isFormatIssue(i, 'section')), keep: issues.map((i) => i.id) });
  // The model works on the text the formatter left, so it is never asked about a layout the code already fixed.
  if (settled.revId) head = { ...head, id: settled.revId, markdown: settled.markdown };
  const requests = [
    t.task.input.instruction ? `Author's instruction: ${t.task.input.instruction}` : '',
    t.task.input.selection ? `Apply it to this passage: "${t.task.input.selection}"` : '',
    ...issues.map((i, n) => `${n + 1}. ${adds(i) ? '[add material] ' : ''}${i.message}${i.quote ? ` (at: "${i.quote}")` : ''}${i.suggestion ? ` Suggested fix: ${i.suggestion}` : ''}`),
  ].filter(Boolean).join('\n');
  if (!requests) {
    if (routed) return { skipped: 'routed', routed, ...(settled.closed ? { resolved: settled.closed } : {}) };
    if (settled.revId) return { revId: settled.revId, status: 'current', resolved: settled.closed };
    return settled.closed || unrouted.length > issues.length ? { skipped: 'the formatter changed nothing', ...(settled.closed ? { resolved: settled.closed } : {}) } : { skipped: 'nothing requested' };
  }
  // Stored text has no citation markers; put the base revision's back so the model can keep them.
  const baseCitations = json<Record<string, string[]>>(ctx.db.get<{ citations: string }>('SELECT citations FROM content_revisions WHERE id = ?', head.id)?.citations, {});
  // One string per block, marker included. withMarkers joins the blocks and splits them again, and a marker after a closing ":::"
  // keeps that fence open, so the rest of the section became one block (30 of 243 live sections), the fix model saw too few
  // blocks and its change was reverted for an open fence.
  const blocks = splitBlocks(head.markdown).map((b, i) => (baseCitations[String(i)]?.length ? `${b.text} [[${baseCitations[String(i)].join(',')}]]` : b.text));
  // Blockers and the author's own instructions get the strongest writer; everything else the cheaper editor.
  const instructed = !!t.task.input.instruction;
  const grows = issues.some(adds);
  const p = ctx.db.get('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1', projectId, nodeId);
  const notes = json<EvidenceNote[]>(p?.notes, []);
  // A fix for issues reads the notes its blocks cite. The whole packet goes only when that cannot be told: an instruction,
  // material to add, an issue whose passage is not found, or blocks that cite nothing.
  const cited = instructed || grows ? new Set<string>() : citedNotes(blocks, issues);
  const ev = p ? evidenceText(ctx, { id: p.id as string, projectId, nodeId, provider: 'local', query: '', answer: '', notes: cited.size ? notes.filter((n) => cited.has(n.id)) : notes, createdAt: '' }).notes : '';
  const known = bookFormulaKeys(ctx, projectId, nodeId).map((k) => `${k.key}: ${k.label}`).join('\n');
  const sectionIds = outline ? outline.outline.chapters.flatMap((c) => c.sections.map((s) => `${s.id}: ${s.title}`)).join('\n') : '';
  const role = instructed || grows || issues.some((i) => i.severity === 'blocker') ? 'writer' : 'editor';
  // The figure rules and specs go to the model only when the fix may add a figure: a figure problem, or the author's instruction.
  const figures = project.options.figures && (instructed || issues.some((i) => i.category === 'figure')) ? figureSetupOf(project, photosAvailable(ctx)) : null;
  const { data, route } = await runRole(ctx, {
    role, ...patchPrompt({ language: project.language, blocks: blocks.map((b, i) => `[B${i}]\n${b}`).join('\n\n'), requests, evidence: ev, knownFormulas: known, sectionIds, minimal: !instructed && issues.length > 0, additive: grows, issues: issues.length > 0, figures, guards: !instructed && issues.length > 0 ? { figures: issues.some((i) => i.category === 'figure'), removals: issues.some((i) => i.category === 'program-off') } : null }),
    parse: patchParser(figures, { blocks: blocks.length, issues: issues.length }), projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  // The model may say that the section already fixes a problem and change nothing for it (an earlier fix or an edit by hand did).
  // A cheap model confirms that against the text as it stands: a confirmed problem is closed as fixed, an unconfirmed one stays
  // open with the reason shown. A problem the model also changed text for is not a claim.
  const touched = new Set(data.changes.flatMap((c) => c.issues));
  const claims = new Map(data.resolved.flatMap((r) => r.issues.filter((n) => !touched.has(n)).map((n) => [issues[n - 1].id, r.reason] as const)));
  const claimed = issues.filter((i) => claims.has(i.id));
  // The problems the changed blocks must fix, which the check of the changes judges.
  const fixable = issues.filter((i) => !claims.has(i.id));
  const confirmed = new Map<string, string>();
  const rejected = new Map<string, string>();
  if (claimed.length) {
    const near = new Set<number>();
    let located = true;
    for (const i of claimed) {
      const at = blocks.flatMap((b, n) => (quoteInBlock(i.quote, b) ? [n] : []));
      if (!at.length) located = false;
      for (const n of at) for (const m of [n - 1, n, n + 1]) if (m >= 0 && m < blocks.length) near.add(m);
    }
    const shown = located ? [...near].sort((a, b) => a - b) : blocks.map((_, n) => n);
    const text = shown.map((n, k) => `${k && n !== shown[k - 1] + 1 ? '[…]\n\n' : ''}[B${n}]\n${blocks[n]}`).join('\n\n');
    try {
      const verdict = await runRole(ctx, {
        role: 'checker',
        ...resolutionCheckPrompt({
          language: project.language,
          issues: claimed.map((i, n) => `${n + 1}. [${i.severity}] ${i.message}${i.quote ? ` (at: "${i.quote}"${blocks.some((b) => quoteInBlock(i.quote, b)) ? '' : ', a passage that is no longer in the section'})` : ''}\n   Claim: ${claims.get(i.id) || 'the text already fixes it'}`).join('\n'),
          text: truncate(text, 30_000),
        }),
        schema: resolutionCheckSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
      });
      claimed.forEach((i, n) => {
        const v = verdict.data.issues.find((x) => x.index === n + 1);
        if (v?.resolved) confirmed.set(i.id, v.reason.trim() || claims.get(i.id) || 'the text already fixes it');
        else rejected.set(i.id, v ? v.reason.trim() || 'the check found the problem still there' : 'the check gave no verdict');
      });
    } catch (err) {
      if (!(err instanceof TaskError) || t.signal.aborted) throw err;
      for (const i of claimed) rejected.set(i.id, 'the check could not run');
    }
  }
  // The checker read the blocks captured before the calls. A verdict is applied only while the section is still the revision those
  // blocks came from (or the one this fix just wrote on top of it), like a revision is only applied over the head it was based on.
  const settleClaims = (expectedHead: string) => {
    const stale = claimed.length > 0 && headRevision(ctx, projectId, nodeId)?.id !== expectedHead;
    for (const i of claimed) {
      if (stale) {
        ctx.db.run(`UPDATE review_issues SET status = 'open', resolution = ? WHERE id = ?`, 'The section changed while the fix and the check ran, so the check of the old text was not applied. Review it again against the new text.', i.id);
        continue;
      }
      const gone = i.quote.trim() && !blocks.some((b) => quoteInBlock(i.quote, b)) ? ' The passage it quoted is no longer in the section.' : '';
      if (confirmed.has(i.id)) ctx.db.run(`UPDATE review_issues SET status = 'fixed', resolution = ? WHERE id = ?`, `Already resolved in the current text: ${confirmed.get(i.id)}${gone}`, i.id);
      else ctx.db.run(`UPDATE review_issues SET status = 'open', resolution = ? WHERE id = ?`, `The AI said the text already fixes this, but the check disagreed: ${rejected.get(i.id)}`, i.id);
    }
  };
  // A fix may add figures. The check that drops decorative ones runs first; image blocks pointing at neither a new figure
  // nor an existing asset are removed.
  let proposed = figures ? data.figures ?? [] : [];
  const figureNotes: string[] = [];
  if (figures && proposed.length) {
    const after = blocks.map((b, i) => data.changes.find((c) => c.block === i)?.text ?? b);
    const { text, afterBlock } = figurePlaces(splitBlocks(after.join('\n\n')).map((b) => b.text), proposed);
    const checked = await dropDecorative(ctx, t, { projectId, language: project.language, figures, proposed, blocks: text, afterBlock: (f) => afterBlock.get(f), soft: true });
    proposed = checked.kept;
    figureNotes.push(...checked.notes);
  }
  const built = await buildFigures(ctx, {
    projectId, nodeId, language: project.language, figures: proposed, photos: photosAvailable(ctx), keepOwn: true,
    runId: t.task.runId, taskId: t.task.id, signal: t.signal, progress: (m) => t.progress(m),
  });
  figureNotes.push(...built.notes);
  const existing = existingAssetNames(ctx, projectId);
  // The model's own text is formatted before the guards compare it, so a patch cannot leave a blank line in $$ or a fourth-level heading behind. Blocks it did not change are not touched.
  for (const c of data.changes) c.text = formatModelText(rewriteImageRefs(c.text, built, existing));
  const isIntro = !findSection(outline?.outline ?? outlineSchema.parse({ chapters: [] }), nodeId);
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
    const guarded = applyGuardedChanges(blocks, fixable.length ? data.changes : [], lint, { figures: issues.some((i) => i.category === 'figure'), removals: issues.some((i) => i.category === 'program-off') });
    working = guarded.blocks;
    reverted = guarded.reverted;
    if (guarded.kept.length) {
      // One cheap model looks at what is left: a change that breaks the mathematics or removes more than asked is dropped.
      // The context blocks are cut for length; the new text is what is judged, so it goes in whole (a cut proof would look
      // unfinished and be rejected for that).
      const clip = (b: string | undefined, max = 1500) => (b === undefined ? '(none)' : b.length > max ? `${b.slice(0, max)}\n${CUT}` : b);
      try {
        const verdict = await runRole(ctx, {
          role: 'checker',
          ...fixCheckPrompt({
            language: project.language, additive: grows,
            issues: fixable.map((i, n) => `${n + 1}. ${adds(i) ? '[add material] ' : ''}[${i.severity}] ${i.message}${i.quote ? ` (at: "${i.quote}")` : ''}${i.suggestion ? ` Suggested fix: ${i.suggestion}` : ''}`).join('\n'),
            changes: guarded.kept.map((n) => `[B${n}]\nBLOCK BEFORE:\n${clip(blocks[n - 1])}\nOLD:\n${clip(blocks[n])}\nNEW:\n${working[n].trim() ? clip(working[n], 12_000) : '(deleted)'}\nBLOCK AFTER:\n${clip(blocks[n + 1])}`).join('\n\n'),
          }),
          schema: fixCheckSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
        });
        checked = true;
        for (const c of verdict.data.changes) {
          if (c.verdict !== 'harmful' || !guarded.kept.includes(c.block) || working[c.block] === blocks[c.block]) continue;
          working[c.block] = blocks[c.block];
          reverted.push({ block: c.block, reason: `the check found it harmful${c.reason ? ` (${c.reason.trim()})` : ''}` });
        }
        for (const i of verdict.data.issues) if (!i.fixed && i.index >= 1 && i.index <= fixable.length) unresolved.set(i.index - 1, i.reason.trim() || 'the check found the problem still there');
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
    ctx.db.tx(() => {
      reopen(fixable, (id) => `The AI fix was not applied: ${dropped(fixable.find((i) => i.id === id)!) ?? fallback}`);
      settleClaims(head.id);
    });
    issuesChanged(ctx, projectId, issues.map((i) => i.id));
    return { skipped: confirmed.size && !fixable.length ? 'the text already fixes the issues' : 'no change survived the checks', reverted: reasons, ...(confirmed.size + settled.closed ? { resolved: confirmed.size + settled.closed } : {}), ...(routed ? { routed } : {}), ...(checked === undefined ? {} : { checked }), ...(figureNotes.length ? { figureProblems: figureNotes } : {}) };
  }

  const { markdown, citations } = extractCitations(working.filter((b) => b.trim()).join('\n\n'), splitBlocks);
  // Losing more than a fifth of the text is the author's call, unless the fix was about repetition.
  // Image blocks are not text: removing a useless figure does not shrink the section.
  const prose = (md: string) => md.replace(/:::image\{[^}]*\}\s*\n\s*:::/g, '').length;
  const shrunk = !!issues.length && prose(markdown) < prose(head.markdown) * MIN_KEPT_SHARE && !issues.some((i) => i.category === 'repetition' || i.category === 'program-off');
  const answered = fixable.filter((i) => !dropped(i) && !unresolved.has(fixable.indexOf(i)));
  let committed!: ReturnType<typeof commitAiRevision>;
  let stored: string[] = [];
  let saved = false;
  try {
    ctx.db.tx(() => {
      let text = markdown;
      ({ markdown: text, stored } = commitFigures(ctx, { projectId, nodeId, built, markdown: text, replace: false, replaced: [] }));
      committed = commitAiRevision(ctx, { projectId, nodeId, kind, markdown: text, baseRevId: head.id, model: route.model, origin: 'repair', citations, forceProposal: instructed || shrunk || !issues.length, runId: t.task.runId, taskId: t.task.id, format: false });
      const applied = committed.status === 'current';
      // Formulas a removal took out of this section: other sections in the book refer to them by name from now on.
      if (applied && issues.some((i) => i.category === 'program-off')) {
        const left = new Set(formulaKeyLabels(text).map((f) => f.key));
        const gone = formulaKeyLabels(head.markdown).filter((f) => !left.has(f.key));
        // Only definitions still in the book count: a section Align book removed keeps its text for Put back.
        const inBook = new Set((loadOutline(ctx, projectId)?.outline.chapters ?? []).flatMap((c) => [c.id, ...c.sections.map((s) => s.id)]));
        const elsewhere = new Set([...currentHeads(ctx, projectId)].filter(([id]) => id !== nodeId && inBook.has(id)).flatMap(([, h]) => formulaKeyLabels(h.markdown).map((f) => f.key)));
        const lost = gone.filter((f) => !elsewhere.has(f.key));
        if (lost.length) {
          for (const other of inBook) if (other !== nodeId) repairHead(ctx, projectId, other, (md) => dropReferences(md, '', lost));
          // Generated exercises on a removed formula leave the book; other questions name it instead.
          const uses = (t: string) => lost.some((f) => t.includes(`formula:@${f.key}}}`) || t.includes(`ref:formula/@${f.key})`));
          const qs = ctx.db.all<{ id: string; origin: string; statement: string; hint: string; solution: string }>(`SELECT id, origin, statement, hint, solution FROM questions WHERE project_id = ? AND chapter_id IS NOT NULL`, projectId)
            .filter((x) => uses(x.statement + x.hint + x.solution));
          for (const x of qs) {
            if (x.origin === 'generated') ctx.db.run('UPDATE questions SET chapter_id = NULL, rev = rev + 1, updated_at = ? WHERE id = ?', now(), x.id);
            else {
              const after = { statement: dropReferences(x.statement, '', lost), hint: dropReferences(x.hint, '', lost), solution: dropReferences(x.solution, '', lost) };
              ctx.db.run('UPDATE questions SET statement = ?, hint = ?, solution = ?, rev = rev + 1, updated_at = ? WHERE id = ?', after.statement, after.hint, after.solution, now(), x.id);
              recordQuestionRevision(ctx, x.id, x, after, { origin: 'reference-dropped', taskId: t.task.id });
            }
          }
          if (qs.length) questionsChanged(ctx, projectId, qs.map((x) => x.id));
        }
      }
      const done = new Set(answered.map((i) => i.id));
      if (answered.length) ctx.db.run(`UPDATE review_issues SET status = ?, resolution = ? WHERE id IN (${answered.map(() => '?').join(',')})`, applied ? 'fixed' : 'proposed', applied ? `Fixed by AI in revision ${committed.revId}` : `Proposal ${committed.revId}`, ...answered.map((i) => i.id));
      reopen(fixable.filter((i) => !done.has(i.id)), (id) => {
        const i = fixable.find((x) => x.id === id)!;
        const r = dropped(i);
        return r ? `The AI fix was not applied: ${r}` : `The AI fix did not resolve it: ${unresolved.get(fixable.indexOf(i))}`;
      });
      settleClaims(applied ? committed.revId : head.id);
    });
    saved = true;
  } finally {
    discardUnstored(built, saved ? stored : []);
  }
  if (stored.length) ctx.events.emit('asset.updated', { nodeId, assetIds: stored }, { projectId });
  if (issues.length) issuesChanged(ctx, projectId, issues.map((i) => i.id));
  if (committed.status === 'current') relint(ctx, projectId, nodeId);
  const findings = lintSection(committed.markdown, { sectionId: nodeId, language: project.language });
  return { revId: committed.revId, status: committed.status, findings: findings.length, reverted: reasons, ...(confirmed.size + settled.closed ? { resolved: confirmed.size + settled.closed } : {}), ...(routed ? { routed } : {}), ...(checked === undefined ? {} : { checked }), ...(shrunk ? { shrunk: true } : {}), ...(figureNotes.length ? { figureProblems: figureNotes } : {}) };
}

export { recordLintIssues };
