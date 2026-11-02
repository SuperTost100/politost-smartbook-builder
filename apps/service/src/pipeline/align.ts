// Alignment of a written book with the course program: a report (Check) and its deterministic application (Align book).
import { dropReferences, quoteInBlock, splitBlocks } from '@smartbuilder/content';
import type { z } from 'zod';
import { outlineSchema, type AlignmentFinding, type AlignmentReport, type Outline, type OutlineSection, type ProgramItem } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import { TaskError, type TaskContext, type TaskSpec } from '../queue/queue.ts';
import { questionsChanged } from '../repo/questions.ts';
import { approveOutline, getReport, insertIssue, insertReport, readyProgram, repairHead, reportInputs, saveOutline } from '../repo/index.ts';
import { programFingerprint } from './program.ts';
import { HttpError } from '../server.ts';
import { chapterExamStats, chaptersMissingGuide, examGuideSection, examSessionTotal } from './exam.ts';
import { alignPrompt, alignSchema, examFormatText, programItemsText } from './prompts.ts';
import { generateSpecs, regenerateSpecs } from './runs.ts';
import { findSection, formulaKeyLabels, headRevision, loadOutline, loadProject, loadTopics } from './util.ts';

type Raw = z.infer<typeof alignSchema>;

// ---------- what the checker reads ----------

const DIGEST_LINES = 12;
/** A line that opens with a bold label: **Teorema** (di Weierstrass), **Definizione** ... */
const labelLines = (md: string) => md.split('\n').map((l) => l.trim()).filter((l) => /^\*\*[^*\n]{1,60}\*\*/.test(l)).map((l) => l.slice(0, 160));
const headingLines = (md: string) => md.split('\n').map((l) => l.trim()).filter((l) => /^###\s+\S/.test(l)).map((l) => l.slice(0, 160));
// shortcut: a proof is recognised by its label ("Dimostrazione", "Proof"), not by reading the argument; upgrade if books label them differently.
const hasProof = (md: string) => /^\s*(\*\*)?\s*(Dimostrazione|Dim\.|Proof)\b/im.test(md);

/** One compact description of every section: enough to judge coverage, nowhere near the section texts. */
export function bookDigest(ctx: AppContext, projectId: string, outline: Outline, total: number): string {
  const topics = new Map(loadTopics(ctx, projectId).map((t) => [t.id, t]));
  // Which other sections rely on each section (a link to it, or a formula it defines), so the checker can tell a
  // prerequisite from material nothing needs.
  const nodes = outline.chapters.flatMap((c) => [{ id: c.id, title: `${c.title} (chapter introduction)` }, ...c.sections.map((s) => ({ id: s.id, title: s.title }))]);
  const texts = new Map(nodes.map((n) => [n.id, headRevision(ctx, projectId, n.id)?.markdown]));
  const titles = new Map(nodes.map((n) => [n.id, n.title]));
  const usedBy = (id: string) => {
    const keys = formulaKeyLabels(texts.get(id) ?? '').map((f) => f.key);
    return [...texts].filter(([other, md]) => other !== id && md).flatMap(([other, md]) => {
      const how = [md!.includes(`ref:section/${id})`) ? 'link' : '', ...keys.filter((k) => md!.includes(`formula:@${k}}}`) || md!.includes(`ref:formula/@${k})`)).map((k) => `formula ${k}`)].filter(Boolean);
      return how.length ? [`${titles.get(other)} (${how.join(', ')})`] : [];
    });
  };
  return outline.chapters.map((c, ci) => {
    const lines = c.sections.map((s) => {
      if (s.role === 'exam-guide') return `  [${s.id}] ${s.title} | exam guide (closing section of the chapter)`;
      const md = headRevision(ctx, projectId, s.id)?.markdown;
      const exams = s.topicIds.map((id) => topics.get(id)).filter((t) => !!t).map((t) => `${t.name} ${t.examSessions}/${total}`).join('; ') || '-';
      const head = `  [${s.id}] ${s.title} | ${s.depth} | ${md === undefined ? 'not written yet' : `${md.length} chars | proof: ${hasProof(md) ? 'yes' : 'no'}`} | items: ${s.programItems.join(', ') || '-'} | exams: ${exams}`;
      const more = [
        `      objectives: ${s.objectives.join('; ').slice(0, 300) || '-'}`,
        md === undefined ? '' : `      headings: ${headingLines(md).slice(0, DIGEST_LINES).join(' ; ') || '-'}`,
        md === undefined ? '' : `      statements: ${labelLines(md).slice(0, DIGEST_LINES * 2).join(' ; ') || '-'}`,
        md === undefined ? '' : `      used by: ${usedBy(s.id).join(' ; ') || '-'}`,
      ].filter(Boolean);
      return [head, ...more].join('\n');
    });
    return `Chapter ${ci + 1} [${c.id}] ${c.title}\n${lines.join('\n') || '  (no sections)'}`;
  }).join('\n\n');
}

// ---------- validation of the model's answer ----------

export interface AlignEnv {
  program: ProgramItem[];
  outline: Outline;
  /** Section texts (current revisions) by node id; a section without text is absent. */
  texts: Map<string, string>;
  /** Findings the builder computes itself, appended after the model's. */
  guides: AlignmentFinding[];
}

/**
 * Keeps the model's findings that point at things that exist: program items, chapters, sections, quotes. An invalid
 * finding is dropped, not repaired, except a position after the exam guide, which becomes the position before it.
 * Exam-guide findings come only from the builder.
 */
export function validateAlignment(raw: Raw, env: AlignEnv): { coverage: AlignmentReport['coverage']; findings: AlignmentFinding[] } {
  const items = new Set(env.program.map((i) => i.key));
  const sections = new Map<string, OutlineSection>(env.outline.chapters.flatMap((c) => c.sections.map((s) => [s.id, s] as const)));
  const content = (id: string | null) => (id ? sections.get(id) : undefined)?.role === 'content' ? sections.get(id!) : undefined;
  const written = (id: string | null) => !!content(id) && env.texts.has(id!);
  const findings: AlignmentFinding[] = [];
  const seen = new Set<string>();
  const once = (...key: (string | null)[]) => { const k = key.join('|'); if (seen.has(k)) return false; seen.add(k); return true; };

  for (const f of raw.findings) {
    const message = f.message.trim();
    if (!message) continue;
    const item = f.item && items.has(f.item) ? f.item : null;
    switch (f.kind) {
      case 'missing': {
        const chapter = env.outline.chapters.find((c) => c.id === f.chapterId);
        const title = f.title?.trim();
        if (!item || !chapter || !title || !once('missing', item)) break;
        let after = f.afterSectionId;
        if (after && !chapter.sections.some((s) => s.id === after)) break;
        if (after && sections.get(after)?.role === 'exam-guide') after = [...chapter.sections].reverse().find((s) => s.role === 'content')?.id ?? null;
        const objectives = f.objectives.map((o) => o.trim()).filter(Boolean).slice(0, 4);
        findings.push({ kind: 'missing', item, message, suggested: { chapterId: chapter.id, afterSectionId: after, title, objectives: objectives.length ? objectives : [title], depth: f.depth ?? 'standard' } });
        break;
      }
      case 'thin':
      case 'proof':
        if (item && written(f.nodeId) && once(f.kind, item, f.nodeId)) findings.push({ kind: f.kind, item, nodeId: f.nodeId!, message });
        break;
      case 'off-program': {
        if (!content(f.nodeId) || !once('off', f.nodeId, f.whole ? 'whole' : f.quote)) break;
        if (f.whole) { findings.push({ kind: 'off-program', nodeId: f.nodeId!, whole: true, message, quote: '' }); break; }
        // A passage is only worth a fix when its quote is really in the text.
        const quote = f.quote?.trim() ?? '';
        const text = env.texts.get(f.nodeId!);
        if (quote && text && splitBlocks(text).some((b) => quoteInBlock(quote, b.text))) findings.push({ kind: 'off-program', nodeId: f.nodeId!, whole: false, message, quote });
        break;
      }
      case 'order':
        if (content(f.nodeId) && once('order', f.nodeId)) findings.push({ kind: 'order', nodeId: f.nodeId!, message });
        break;
    }
  }

  const validNodes = new Set([...sections].filter(([, s]) => s.role === 'content').map(([id]) => id));
  const given = new Map(raw.coverage.map((c) => [c.item, c.nodeIds.filter((id) => validNodes.has(id))]));
  const coverage = env.program.map((i) => ({
    item: i.key,
    nodeIds: given.get(i.key) ?? [...validNodes].filter((id) => sections.get(id)!.programItems.includes(i.key)),
  }));
  return { coverage, findings: [...findings, ...env.guides] };
}

/** Chapters the exams ask about that still lack their closing exam guide (and have written text to link to). */
export function guideFindings(ctx: AppContext, projectId: string, outline: Outline): AlignmentFinding[] {
  return chaptersMissingGuide(ctx, projectId, outline)
    .filter(({ chapter }) => chapter.sections.some((s) => headRevision(ctx, projectId, s.id)))
    .map(({ chapter, stats }): AlignmentFinding => ({
      kind: 'exam-guide', chapterId: chapter.id,
      message: `Chapter "${chapter.title}" has no exam guide. ${stats.asked} of ${stats.total} past exam sessions asked about its topics.`,
    }));
}

// ---------- check ----------

/** Why a book cannot be checked, or null. Shared by the route and the task. */
export function checkBlocker(ctx: AppContext, projectId: string): HttpError | null {
  if (!readyProgram(ctx, projectId)) return new HttpError(409, 'no_program', 'This book has no course program yet.', 'Add the program in Setup and press Read program, then check again.');
  if (!loadOutline(ctx, projectId)) return new HttpError(409, 'outline_not_approved', 'The outline is not approved yet.', 'Approve the outline in the Outline tab first.');
  if (!ctxHasText(ctx, projectId)) return new HttpError(409, 'nothing_written', 'No section is written yet.', 'Write at least one chapter first; a new book follows the program from the start.');
  return null;
}
const ctxHasText = (ctx: AppContext, projectId: string) => {
  const outline = loadOutline(ctx, projectId)?.outline;
  return !!outline?.chapters.some((c) => c.sections.some((s) => headRevision(ctx, projectId, s.id)));
};

/** `program.check`: one planner call over the program and the book digest, then validation against the data. */
export async function alignCheck(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const blocked = checkBlocker(ctx, projectId);
  if (blocked) throw new TaskError(blocked.message, 'input', blocked.action);
  const program = readyProgram(ctx, projectId)!;
  const current = loadOutline(ctx, projectId)!;
  const project = loadProject(ctx, projectId);
  const total = examSessionTotal(ctx, projectId);
  // The texts the planner reads, taken with the digest: the report must be checked against these revisions, not against
  // edits made while the planner works.
  const texts = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const c of current.outline.chapters) for (const id of [c.id, ...c.sections.map((s) => s.id)]) {
    const h = headRevision(ctx, projectId, id);
    if (h) { texts.set(id, h.markdown); seen.set(id, h.id); }
  }
  t.progress('Reading the book against the program');
  const { data, route } = await runRole(ctx, {
    role: 'planner',
    ...alignPrompt({ language: project.language, program: programItemsText(program.items), exam: examFormatText(program.examFormat), outline: bookDigest(ctx, projectId, current.outline, total), sessions: total }),
    schema: alignSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const { coverage, findings } = validateAlignment(data, { program: program.items, outline: current.outline, texts, guides: guideFindings(ctx, projectId, current.outline) });
  // A report that removes a whole section also depends on every other section, because a reference added later would
  // make that section a prerequisite; the other reports only on the sections they name.
  const removes = findings.some((f) => f.kind === 'off-program' && f.whole);
  const named = removes ? current.outline.chapters.flatMap((c) => [c.id, ...c.sections.map((s) => s.id)]) : [...new Set(findings.flatMap((f) => ('nodeId' in f ? [f.nodeId] : [])))];
  const heads = Object.fromEntries(named.map((id) => [id, seen.get(id) ?? null]));
  const report = insertReport(ctx, { projectId, outlineRevId: current.revId, coverage, findings, model: route.model, inputs: { program: programFingerprint(program), heads } });
  const count = (kind: AlignmentFinding['kind']) => findings.filter((f) => f.kind === kind).length;
  return {
    reportId: report.id, findings: findings.length, missing: count('missing'), thin: count('thin'), proof: count('proof'), offProgram: count('off-program'), order: count('order'),
    examGuide: count('exam-guide'), dropped: data.findings.length - (findings.length - count('exam-guide')),
  };
}

// ---------- apply ----------

/** Why a report cannot be applied now, or null. Shared by the route and the task. */
export function applyBlocker(ctx: AppContext, projectId: string, report: AlignmentReport): HttpError | null {
  if (report.appliedAt) return new HttpError(409, 'report_applied', 'This report was already applied.', 'Check alignment again to get a fresh report.');
  if (report.outlineRevId !== loadProject(ctx, projectId).outlineRevId) {
    return new HttpError(409, 'report_stale', 'The outline changed after this report was made.', 'Check alignment again, then apply the new report.');
  }
  // A finding read against an older program or older section text could remove or cut what is now in scope.
  const inputs = reportInputs(ctx, report.id);
  const program = readyProgram(ctx, projectId);
  if (inputs.program && (!program || programFingerprint(program) !== inputs.program)) {
    return new HttpError(409, 'report_stale', 'The course program changed after this report was made.', 'Check alignment again, then apply the new report.');
  }
  const edited = Object.entries(inputs.heads ?? {}).find(([id, rev]) => (headRevision(ctx, projectId, id)?.id ?? null) !== rev);
  if (edited) return new HttpError(409, 'report_stale', 'A section the report talks about changed after the report was made.', 'Check alignment again, then apply the new report.');
  return null;
}

const markNote = (language: string, part: 'section' | 'passage') => language === 'it'
  ? (part === 'section' ? "*Questa sezione va oltre il programma del corso: all'esame non viene chiesta.*" : "*Questo passaggio va oltre il programma del corso: all'esame non viene chiesto.*")
  : (part === 'section' ? '*This section goes beyond the course program: it is not asked at the exam.*' : '*This passage goes beyond the course program: it is not asked at the exam.*');
const proofMark = (language: string) => (language === 'it' ? "**Dimostrazione richiesta all'esame.**" : '**Proof asked at the exam.**');

const q = (s: string) => `"${s}"`;

/** `program.apply`: edits the outline and the texts as the report says, then queues the writing and the fixes in this run. */
export async function alignApply(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const reportId = t.task.input.reportId as string;
  const report = getReport(ctx, projectId, reportId);
  // A retry after the changes were saved must not apply them again.
  if (report.appliedAt) return { reused: true, applied: report.applied.length };
  const blocked = applyBlocker(ctx, projectId, report);
  if (blocked) throw new TaskError(blocked.message, 'input', blocked.action);
  const program = readyProgram(ctx, projectId);
  if (!program) throw new TaskError('The course program was removed.', 'input', 'Add the program again in Setup, then check alignment again.');
  const current = loadOutline(ctx, projectId)!;
  const project = loadProject(ctx, projectId);
  const language = project.language;
  const chosen = ((t.task.input.findings as number[] | undefined) ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < report.findings.length);
  const wanted = new Set(chosen.length ? chosen : report.findings.map((_, i) => i));
  // Removals come first: a section that goes away needs no other fix.
  const findings = report.findings.filter((_, i) => wanted.has(i)).sort((a, b) => Number(b.kind === 'off-program' && b.whole) - Number(a.kind === 'off-program' && a.whole));
  const mode = project.options.offProgram;
  const outline: Outline = structuredClone(current.outline);
  const item = (key: string) => program.items.find((i) => i.key === key);
  const chapterOf = (nodeId: string) => outline.chapters.find((c) => c.sections.some((s) => s.id === nodeId));

  const lines: string[] = [];
  const removed: AlignmentReport['removed'] = [];
  const newNodes: string[] = [];
  const unwritten: string[] = [];
  const issueIds: string[] = [];
  const inserted = new Map<string, number>();
  let changed = false;

  // What still holds a section back: past exam questions in the book that point at it, or being the only section of its
  // chapter. Links from other sections and their uses of its formulas are rewritten as plain text when it goes, and the
  // generated exercises that point at it leave the book with it (the check only calls a section off-program when the rest
  // of the book does not need it).
  const heads = ctx.db.all<{ node_id: string; markdown: string }>(`SELECT node_id, markdown FROM content_revisions WHERE project_id = ? AND status = 'current'`, projectId);
  const questions = ctx.db.all<{ id: string; origin: string; t: string }>(`SELECT id, origin, statement || ' ' || hint || ' ' || solution AS t FROM questions WHERE project_id = ? AND chapter_id IS NOT NULL`, projectId);
  const ownFormulas = (nodeId: string) => formulaKeyLabels(heads.find((h) => h.node_id === nodeId)?.markdown ?? '');
  const refersTo = (md: string, nodeId: string) => md.includes(`ref:section/${nodeId})`) || ownFormulas(nodeId).some((f) => md.includes(`formula:@${f.key}}}`) || md.includes(`ref:formula/@${f.key})`));
  const removalBlocker = (nodeId: string): string | null => {
    if (questions.some((q) => q.origin === 'authentic' && refersTo(q.t, nodeId))) return 'past exam questions in the book refer to it';
    const chapter = chapterOf(nodeId);
    if (chapter && !chapter.sections.some((s) => s.id !== nodeId && s.role === 'content')) return 'it is the only section of its chapter';
    return null;
  };
  /** Takes the generated exercises that point at a removed section out of the book; returns how many. */
  const dropExercises = (nodeId: string) => {
    const ids = questions.filter((q) => q.origin !== 'authentic' && refersTo(q.t, nodeId)).map((q) => q.id);
    for (const id of ids) ctx.db.run('UPDATE questions SET chapter_id = NULL, rev = rev + 1, updated_at = ? WHERE id = ?', now(), id);
    questionsChanged(ctx, projectId, ids);
    return ids.length;
  };
  /** Rewrites the links and formula references other sections make to a removed section; returns how many sections changed. */
  const unreference = (nodeId: string) => {
    const formulas = ownFormulas(nodeId);
    // Only text still in the book: a section removed earlier keeps its text as it was, for Put back.
    const inBook = new Set(outline.chapters.flatMap((c) => [c.id, ...c.sections.map((s) => s.id)]));
    // A formula key that a section still in the book also defines keeps its references.
    const kept = new Set(heads.filter((h) => h.node_id !== nodeId && inBook.has(h.node_id)).flatMap((h) => formulaKeyLabels(h.markdown).map((f) => f.key)));
    const gone = formulas.filter((f) => !kept.has(f.key));
    return heads.filter((h) => h.node_id !== nodeId && inBook.has(h.node_id) && refersTo(h.markdown, nodeId))
      .filter((h) => repairHead(ctx, projectId, h.node_id, (md) => dropReferences(md, nodeId, gone))).length;
  };

  /** An open program issue on a written section, reused when a repeat asks the same; the suggestion names the item, so two items never share one. */
  const programIssue = (nodeId: string, revId: string, category: 'program-thin' | 'program-proof', message: string, suggestion: string) => {
    const existing = ctx.db.get<{ id: string }>(`SELECT id FROM review_issues WHERE project_id = ? AND node_id = ? AND source = 'program' AND category = ? AND status IN ('open', 'proposed') AND message = ? AND suggestion = ?`, projectId, nodeId, category, message, suggestion);
    issueIds.push(existing?.id ?? insertIssue(ctx, { projectId, nodeId, revId, source: 'program', severity: 'major', category, message, suggestion }).id);
  };
  const teach = (it: ProgramItem) => `Teach ${q(it.title)} fully, as the course program words it: ${it.details || it.title}. Add the definitions, the statements with every hypothesis and the worked examples the exam needs, in the style of the section.`;

  ctx.db.tx(() => {
    for (const f of findings) {
      switch (f.kind) {
        case 'missing': {
          const chapter = outline.chapters.find((c) => c.id === f.suggested.chapterId);
          const it = item(f.item);
          if (!chapter || !it) { lines.push(`Skipped the new section for "${f.item}": ${chapter ? 'the program item was removed' : 'the chapter is gone'}.`); break; }
          const assigned = outline.chapters.flatMap((c) => c.sections).filter((s) => s.programItems.includes(f.item) && s.role === 'content');
          // The checker read the written section and found the item not taught there: the section is extended, not doubled.
          const written = assigned.map((s) => ({ s, head: headRevision(ctx, projectId, s.id) })).find((x) => x.head);
          if (written) {
            programIssue(written.s.id, written.head!.id, 'program-thin', f.message, teach(it));
            lines.push(`Asked the fixer to teach ${q(it.title)} in ${q(written.s.title)}, the section planned for it.`);
            break;
          }
          // A section planned for the item but never written is written now, not doubled.
          if (assigned[0]) {
            if (!unwritten.includes(assigned[0].id)) unwritten.push(assigned[0].id);
            lines.push(`Queued the section ${q(assigned[0].title)} for writing: it is planned for ${q(it.title)} but not written yet.`);
            break;
          }
          const section: OutlineSection = { id: newId(), title: f.suggested.title, objectives: f.suggested.objectives, topicIds: [], depth: f.suggested.depth, subsections: [], programItems: [f.item], role: 'content' };
          // Sections added after the same section keep the report's order, and none goes behind the exam guide.
          const anchor = `${chapter.id}:${f.suggested.afterSectionId ?? ''}`;
          // An anchor removed earlier in this apply puts the section at the end of the chapter, not at its start.
          const afterAt = f.suggested.afterSectionId ? chapter.sections.findIndex((s) => s.id === f.suggested.afterSectionId) : -1;
          const index = (!f.suggested.afterSectionId ? 0 : afterAt >= 0 ? afterAt + 1 : chapter.sections.length) + (inserted.get(anchor) ?? 0);
          inserted.set(anchor, (inserted.get(anchor) ?? 0) + 1);
          const guideAt = chapter.sections.findIndex((s) => s.role === 'exam-guide');
          chapter.sections.splice(guideAt >= 0 ? Math.min(index, guideAt) : index, 0, section);
          outline.programExclusions = outline.programExclusions.filter((e) => e.item !== f.item);
          newNodes.push(section.id);
          changed = true;
          lines.push(`Added the section ${q(section.title)} to chapter ${q(chapter.title)} for the program item ${q(it.title)}.`);
          break;
        }
        case 'exam-guide': {
          const chapter = outline.chapters.find((c) => c.id === f.chapterId);
          if (!chapter) { lines.push('Skipped an exam guide: the chapter is gone.'); break; }
          if (chapter.sections.some((s) => s.role === 'exam-guide')) { lines.push(`Skipped the exam guide of chapter ${q(chapter.title)}: it has one already.`); break; }
          // The exam questions can change after the check without touching the outline; a guide with none would never be written.
          if (chapterExamStats(ctx, projectId, chapter).asked === 0) { lines.push(`Skipped the exam guide of chapter ${q(chapter.title)}: no past exam question is on its topics any more.`); break; }
          const guide = examGuideSection(language);
          chapter.sections.push(guide);
          newNodes.push(guide.id);
          changed = true;
          lines.push(`Added the exam guide ${q(guide.title)} to the end of chapter ${q(chapter.title)}.`);
          break;
        }
        case 'thin':
        case 'proof': {
          const it = item(f.item);
          const found = findSection(outline, f.nodeId);
          const head = headRevision(ctx, projectId, f.nodeId);
          if (!it || !found || !head) { lines.push(`Skipped a ${f.kind === 'thin' ? 'depth' : 'proof'} fix for ${q(f.item)}: ${!it ? 'the program item was removed' : !found ? 'the section is gone' : 'the section has no text'}.`); break; }
          const category = f.kind === 'thin' ? 'program-thin' : 'program-proof';
          const suggestion = f.kind === 'thin'
            ? teach(it)
            : `Add the complete proof of ${it.proofs.length ? it.proofs.join('; ') : `the main results of ${q(it.title)}`}, and put the line ${proofMark(language)} on its own immediately before it.`;
          programIssue(f.nodeId, head.id, category, f.message, suggestion);
          lines.push(f.kind === 'thin'
            ? `Asked the fixer to teach ${q(it.title)} in more depth in ${q(found.section.title)}.`
            : `Asked the fixer to add the proof of ${q(it.title)} to ${q(found.section.title)}.`);
          break;
        }
        case 'off-program': {
          const found = findSection(outline, f.nodeId);
          if (!found || found.section.role === 'exam-guide') { lines.push('Skipped an off-program finding: the section is gone.'); break; }
          const { section } = found;
          const head = headRevision(ctx, projectId, f.nodeId);
          if (f.whole) {
            const why = mode === 'delete' ? removalBlocker(f.nodeId) : null;
            if (mode === 'delete' && !why) {
              removed.push({ nodeId: section.id, title: section.title, chapterId: found.chapter.id, afterSectionId: found.chapter.sections[found.sectionIndex - 1]?.id ?? null, restoredAt: null });
              found.chapter.sections.splice(found.sectionIndex, 1);
              changed = true;
              const rewritten = unreference(section.id);
              const exercises = dropExercises(section.id);
              lines.push(`Removed the section ${q(section.title)}: it is outside the course program and the rest of the book does not need it. Its text is kept, and Put back restores it.${rewritten ? ` Links and formula references to it in ${rewritten} other section${rewritten > 1 ? 's' : ''} became plain text.` : ''}${exercises ? ` ${exercises} generated exercise${exercises > 1 ? 's' : ''} on it left the book.` : ''}`);
              break;
            }
            if (!head) { lines.push(`Left the section ${q(section.title)} as it is: it has no text to mark${why ? ` and ${why}` : ''}.`); break; }
            const note = markNote(language, 'section');
            const done = repairHead(ctx, projectId, f.nodeId, (md) => (md.startsWith(note) ? md : `${note}\n\n${md}`));
            lines.push(`${why ? `Kept the section ${q(section.title)} instead of removing it, because ${why}. ` : ''}${done ? `Marked ${q(section.title)} as beyond the program.` : `${q(section.title)} was already marked as beyond the program.`}`);
            break;
          }
          if (!head) { lines.push(`Skipped a passage of ${q(section.title)}: the section has no text.`); break; }
          const note = markNote(language, 'passage');
          const suggestion = mode === 'delete'
            ? 'Remove this passage, and any sentence that only exists to support it. It is outside the course program. Change nothing else.'
            : `Add this line as its own paragraph immediately before the passage, and change nothing else: ${note}`;
          const existing = ctx.db.get<{ id: string }>(`SELECT id FROM review_issues WHERE project_id = ? AND node_id = ? AND source = 'program' AND category = 'program-off' AND status IN ('open', 'proposed') AND quote = ?`, projectId, f.nodeId, f.quote);
          const id = existing?.id ?? insertIssue(ctx, { projectId, nodeId: f.nodeId, revId: head.id, source: 'program', severity: 'minor', category: 'program-off', quote: f.quote, message: f.message, suggestion }).id;
          issueIds.push(id);
          lines.push(`Asked the fixer to ${mode === 'delete' ? 'remove' : 'mark'} a passage of ${q(section.title)} that is outside the program.`);
          break;
        }
        case 'order':
          break;
      }
    }

    if (changed) {
      const rev = saveOutline(ctx, projectId, { outline, baseRevId: null, origin: 'ai', note: `align:${reportId}`, check: false });
      approveOutline(ctx, projectId, rev.id);
      ctx.events.emit('outline.created', { revId: rev.id, origin: 'ai', align: reportId }, { projectId, runId: t.task.runId });
    }
    // The tasks join this run, so it stays active until the new sections are written and the fixes are done.
    const toWrite = [...newNodes, ...unwritten];
    // Fixes go first. A chapter's new drafts and its review wait for the fixes in that chapter, so they read the fixed text
    // and its formula keys.
    const fixes = issueIds.length ? regenerateSpecs(ctx, projectId, { issueIds }) : [];
    const fixKeys = (chapterId: string | undefined) => fixes.filter((f) => f.kind === 'section.revise' && chapterId && chapterOf(f.input!.nodeId as string)?.id === chapterId).map((f) => f.key);
    const chapterOfSpec = (w: { kind: string; input?: Record<string, unknown> }) => (w.kind === 'chapter.review' ? w.input!.chapterId as string : w.kind === 'section.draft' ? chapterOf(w.input!.nodeId as string)?.id : undefined);
    const writes = (toWrite.length ? writeSpecs(ctx, projectId, toWrite) : [])
      .map((w) => { const extra = fixKeys(chapterOfSpec(w)); return extra.length ? { ...w, deps: [...(w.deps ?? []), ...extra] } : w; });
    const specs = [...fixes, ...writes];
    if (specs.length) t.enqueue(specs);
    ctx.db.run('UPDATE alignment_reports SET applied_at = ?, applied = ?, removed = ? WHERE id = ?', now(), JSON.stringify(lines), JSON.stringify(removed), reportId);
  });
  ctx.queue.wake();
  return { applied: lines.length, added: newNodes.length, fixes: issueIds.length, outlineChanged: changed };
}

/**
 * The generate tasks for sections added to chapters that are already written: their evidence and drafts, then a review
 * of the chapter. A section-scoped generate would also redo the chapter's introduction, practice and graph picks, which
 * the existing chapter already has (the picks would add a second graph to sections that have one).
 */
export function writeSpecs(ctx: AppContext, projectId: string, nodeIds: string[]): TaskSpec[] {
  const specs = generateSpecs(ctx, projectId, undefined, nodeIds).filter((s) => ['section.evidence', 'section.draft', 'chapter.review'].includes(s.kind));
  const drafts = specs.filter((s) => s.kind === 'section.draft');
  return specs.map((s) => s.kind !== 'chapter.review' ? s
    : { ...s, deps: drafts.filter((d) => findSection(loadOutline(ctx, projectId)!.outline, d.input!.nodeId as string)?.chapter.id === s.input!.chapterId).map((d) => d.key) });
}

/**
 * Puts a section Align book removed back into the approved outline, after the section it followed (or where that one
 * was), never behind the chapter's exam guide. Its text was never deleted, so it comes back as it was.
 */
export function restoreRemoved(ctx: AppContext, projectId: string, reportId: string, nodeId: string): AlignmentReport {
  return ctx.db.tx(() => {
    const report = getReport(ctx, projectId, reportId);
    const entry = report.removed.find((r) => r.nodeId === nodeId);
    if (!entry) throw new HttpError(404, 'not_found', 'This report did not remove that section.', 'Reload the report.');
    if (entry.restoredAt) throw new HttpError(409, 'already_restored', 'This section is back in the outline already.', 'Reload the report.');
    const current = loadOutline(ctx, projectId);
    if (!current) throw new HttpError(409, 'outline_not_approved', 'The outline is not approved.', 'Approve the outline in the Outline tab first.');
    if (current.outline.chapters.some((c) => c.sections.some((s) => s.id === nodeId))) throw new HttpError(409, 'already_restored', 'This section is in the outline already.', 'Reload the report.');
    const before = ctx.db.get<{ outline: string }>('SELECT outline FROM outline_revisions WHERE id = ? AND project_id = ?', report.outlineRevId, projectId);
    const source = before ? outlineSchema.parse(JSON.parse(before.outline)) : null;
    const section = source?.chapters.flatMap((c) => c.sections).find((s) => s.id === nodeId);
    if (!section) throw new HttpError(409, 'gone', 'The outline this section came from is gone.', 'Add the section again in the Outline tab.');
    const outline: Outline = structuredClone(current.outline);
    // Items the section teaches again are no longer left out.
    outline.programExclusions = outline.programExclusions.filter((e) => !section.programItems.includes(e.item));
    const chapter = outline.chapters.find((c) => c.id === entry.chapterId);
    if (!chapter) throw new HttpError(409, 'chapter_gone', 'The chapter this section belonged to is no longer in the outline.', 'Add the chapter again in the Outline tab, then put the section back.');
    // After the nearest section that preceded it in the report's outline and is still there, so neighbours removed together
    // come back in their order whichever is put back first.
    const original = source!.chapters.find((c) => c.id === entry.chapterId)?.sections.map((s) => s.id) ?? [];
    const earlier = original.slice(0, Math.max(0, original.indexOf(nodeId))).reverse();
    const after = earlier.map((id) => chapter.sections.findIndex((s) => s.id === id)).find((i) => i >= 0) ?? -1;
    const guide = chapter.sections.findIndex((s) => s.role === 'exam-guide');
    const at = Math.min(after + 1, guide >= 0 ? guide : chapter.sections.length);
    chapter.sections.splice(at, 0, section);
    const rev = saveOutline(ctx, projectId, { outline, baseRevId: null, origin: 'human', note: `restore:${reportId}:${nodeId}`, check: false });
    approveOutline(ctx, projectId, rev.id);
    // The restored text may point at sections that are still out of the book (removed with it, or later): those links and
    // formula references become plain text in a new revision; the stored one stays in the history.
    const inBook = new Set(outline.chapters.flatMap((c) => [c.id, ...c.sections.map((x) => x.id)]));
    const all = ctx.db.all<{ node_id: string; markdown: string }>(`SELECT node_id, markdown FROM content_revisions WHERE project_id = ? AND status = 'current'`, projectId);
    const kept = new Set(all.filter((h) => inBook.has(h.node_id)).flatMap((h) => formulaKeyLabels(h.markdown).map((f) => f.key)));
    const outside = all.filter((h) => !inBook.has(h.node_id));
    repairHead(ctx, projectId, nodeId, (md) => {
      const withFormulas = outside.reduce((text, h) => dropReferences(text, h.node_id, formulaKeyLabels(h.markdown).filter((f) => !kept.has(f.key))), md);
      // Links to any other id outside the book too, written or not.
      const missing = [...new Set([...withFormulas.matchAll(/\]\(ref:section\/([^)\s]+)\)/g)].map((m) => m[1]))].filter((id) => !inBook.has(id));
      return missing.reduce((text, id) => dropReferences(text, id, []), withFormulas);
    });
    const removed = report.removed.map((r) => (r.nodeId === nodeId ? { ...r, restoredAt: now() } : r));
    ctx.db.run('UPDATE alignment_reports SET removed = ? WHERE id = ?', JSON.stringify(removed), reportId);
    ctx.events.emit('outline.created', { revId: rev.id, origin: 'human', restore: nodeId }, { projectId });
    return getReport(ctx, projectId, reportId);
  });
}
