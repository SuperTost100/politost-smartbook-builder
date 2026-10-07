// Run planning: turns an author action into a task graph.
import { createHash } from 'node:crypto';
import type { RunSummary } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { now } from '../db/db.ts';
import { HttpError } from '../server.ts';
import type { TaskSpec } from '../queue/queue.ts';
import { headRevision, loadOutline, loadProject } from './util.ts';

export interface RunScope { chapterIds?: string[]; nodeIds?: string[]; issueIds?: string[]; questionIds?: string[]; instruction?: string; selection?: string }

const ACTIVE = `('running', 'pausing', 'paused', 'waiting')`;

function activeRun(ctx: AppContext, projectId: string, kind: string) {
  return ctx.db.get<{ id: string }>(`SELECT id FROM runs WHERE project_id = ? AND kind = ? AND status IN ${ACTIVE} ORDER BY created_at DESC LIMIT 1`, projectId, kind)?.id ?? null;
}

export function startRun(ctx: AppContext, projectId: string, kind: RunSummary['kind'], scope: RunScope = {}): RunSummary {
  const project = loadProject(ctx, projectId);
  let runId: string;
  switch (kind) {
    case 'prepare': runId = prepareRun(ctx, projectId); break;
    case 'plan': {
      const existing = activeRun(ctx, projectId, 'plan');
      if (existing) { runId = existing; break; }
      const specs: TaskSpec[] = [{ kind: 'outline.plan', key: 'outline', label: 'Plan the common index', pool: 'planner', maxAttempts: 2 }];
      if (!project.options.outlineGate) specs.push({ kind: 'outline.autoapprove', key: 'autoapprove', label: 'Approve the outline and start drafting', deps: ['outline'] });
      runId = ctx.queue.createRun(projectId, 'plan', specs);
      break;
    }
    case 'generate': {
      const existing = activeRun(ctx, projectId, 'generate');
      if (existing) { runId = existing; break; }
      runId = ctx.queue.createRun(projectId, 'generate', generateSpecs(ctx, projectId, scope.chapterIds));
      ctx.db.run(`UPDATE projects SET stage = 'drafting', updated_at = ? WHERE id = ?`, now(), projectId);
      break;
    }
    case 'regenerate': runId = ctx.queue.createRun(projectId, 'regenerate', regenerateSpecs(ctx, projectId, scope)); break;
    case 'review': {
      const specs: TaskSpec[] = scope.questionIds?.length
        ? scope.questionIds.flatMap((id) => {
          // Authentic questions go through import first (a no-op once imported), which also writes missing solutions.
          const authentic = ctx.db.get<{ origin: string }>('SELECT origin FROM questions WHERE id = ?', id)?.origin === 'authentic';
          const verify: TaskSpec = { kind: 'question.verify', key: `verify:${id}`, label: 'Check the solution again', input: { questionId: id }, pool: 'reviewer', deps: authentic ? [`import:${id}`] : [] };
          return authentic ? [{ kind: 'question.import', key: `import:${id}`, label: 'Read the exam question', input: { questionId: id }, pool: 'vision' }, verify] : [verify];
        })
        : (loadOutline(ctx, projectId)?.outline.chapters ?? [])
          .filter((c) => (!scope.chapterIds?.length || scope.chapterIds.includes(c.id)) && c.sections.some((s) => headRevision(ctx, projectId, s.id)))
          .map((c) => ({ kind: 'chapter.review', key: `review:${c.id}`, label: `Review "${c.title}"`, input: { chapterId: c.id, force: true }, pool: 'reviewer' }));
      if (!specs.length) throw new HttpError(409, 'nothing_to_review', 'There is nothing to review yet.', 'Approve the outline and generate at least one chapter.');
      runId = ctx.queue.createRun(projectId, 'review', specs);
      break;
    }
    default:
      throw new HttpError(400, 'bad_kind', `Runs of kind "${kind}" are not started this way.`);
  }
  return ctx.queue.runSummary(runId)!;
}

function prepareRun(ctx: AppContext, projectId: string) {
  const resources = ctx.db.all<{ id: string; filename: string; role: string }>(`SELECT id, filename, role FROM resources WHERE project_id = ? AND included = 1 ORDER BY created_at`, projectId);
  if (!resources.length) throw new HttpError(409, 'no_sources', 'This book has no sources yet.', 'Add sources first.');
  const specs: TaskSpec[] = [];
  for (const r of resources) {
    specs.push({ kind: 'resource.extract', key: `extract:${r.id}`, label: `Read ${r.filename}`, input: { resourceId: r.id } });
    if (r.role !== 'exams') specs.push({ kind: 'resource.index', key: `index:${r.id}`, label: `Find the index of ${r.filename}`, input: { resourceId: r.id }, deps: [`extract:${r.id}`], pool: 'bulk' });
    if (r.role !== 'theory') specs.push({ kind: 'resource.questions', key: `questions:${r.id}`, label: `Split ${r.filename} into questions`, input: { resourceId: r.id }, deps: [`extract:${r.id}`] });
  }
  const set = createHash('sha1').update(resources.map((r) => r.id).join(',')).digest('hex').slice(0, 10);
  if (ctx.settings().evidenceMode === 'notebooklm') {
    specs.push({ kind: 'notebook.sync', key: `notebook:${set}`, label: 'Upload sources to NotebookLM', deps: resources.map((r) => `extract:${r.id}`), pool: 'notebooklm' });
  }
  specs.push({
    kind: 'topics.map', key: `topics:${set}`, label: 'Map topics and exam frequency',
    deps: specs.filter((s) => s.kind === 'resource.index' || s.kind === 'resource.questions').map((s) => s.key), pool: 'writer',
  });
  ctx.db.run(`UPDATE projects SET stage = 'mapping', updated_at = ? WHERE id = ? AND stage = 'sources'`, now(), projectId);
  const existing = activeRun(ctx, projectId, 'prepare');
  if (existing) {
    ctx.queue.addTasks(existing, projectId, specs);
    ctx.queue.wake();
    return existing;
  }
  return ctx.queue.createRun(projectId, 'prepare', specs);
}

export function generateSpecs(ctx: AppContext, projectId: string, chapterIds?: string[]): TaskSpec[] {
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  if (!outline) throw new HttpError(409, 'outline_not_approved', 'The outline is not approved yet.', 'Open the Outline tab and press Approve outline.');
  const wanted = chapterIds?.length ? chapterIds : project.options.chapterScope;
  const chapters = outline.outline.chapters.filter((c) => !wanted.length || wanted.includes(c.id));
  if (!chapters.length) throw new HttpError(409, 'empty_scope', 'No chapters match the selected scope.');
  const evidencePool = ctx.settings().evidenceMode === 'notebooklm' ? 'notebooklm' : 'evidence';
  const specs: TaskSpec[] = [];
  const gated = project.options.firstChapterGate && chapters.length > 1;
  chapters.forEach((c, i) => {
    const after = gated && i > 0 ? ['gate:first-chapter'] : [];
    for (const s of c.sections) {
      specs.push({ kind: 'section.evidence', key: `evidence:${s.id}`, label: `Gather evidence for "${s.title}"`, input: { nodeId: s.id }, deps: after, pool: evidencePool });
      specs.push({ kind: 'section.draft', key: `draft:${s.id}`, label: `Write "${s.title}"`, input: { nodeId: s.id }, deps: [`evidence:${s.id}`], pool: 'writer' });
    }
    const drafts = c.sections.map((s) => `draft:${s.id}`);
    specs.push({ kind: 'chapter.intro', key: `intro:${c.id}`, label: `Introduce "${c.title}"`, input: { chapterId: c.id }, deps: drafts, pool: 'writer' });
    specs.push({ kind: 'chapter.practice', key: `practice:${c.id}`, label: `Plan practice for "${c.title}"`, input: { chapterId: c.id }, deps: drafts });
    specs.push({ kind: 'chapter.enrich', key: `enrich:${c.id}`, label: `Add graphs and examples to "${c.title}"`, input: { chapterId: c.id }, deps: drafts, pool: 'bulk' });
    specs.push({ kind: 'chapter.review', key: `review:${c.id}`, label: `Review "${c.title}"`, input: { chapterId: c.id }, deps: [`intro:${c.id}`, `enrich:${c.id}`], pool: 'reviewer' });
    if (gated && i === 0) {
      // The planner only enqueues the practice work; this barrier waits until all of it (imports, generation, checks) is done.
      specs.push({ kind: 'practice.done', key: `practice-done:${c.id}`, label: `Wait for the practice of "${c.title}"`, input: { chapterId: c.id }, deps: [`practice:${c.id}`] });
      specs.push({
        kind: 'gate', key: 'gate:first-chapter', label: 'Your review of the first chapter', deps: [`review:${c.id}`, `practice-done:${c.id}`],
        input: { reason: `"${c.title}" is ready for your review.`, action: 'Read it in the Manuscript tab and fix what you need, then press Continue to write the remaining chapters.' },
      });
    }
  });
  return specs;
}

function regenerateSpecs(ctx: AppContext, projectId: string, scope: RunScope): TaskSpec[] {
  const stamp = Date.now().toString(36);
  const specs: TaskSpec[] = [];
  for (const nodeId of scope.nodeIds ?? []) {
    specs.push({ kind: 'section.revise', key: `revise:${nodeId}:${stamp}`, label: 'Regenerate the selection', input: { nodeId, instruction: scope.instruction ?? '', selection: scope.selection ?? '' }, pool: 'writer' });
  }
  if (scope.issueIds?.length) {
    const issues = ctx.db.all<{ id: string; node_id: string | null; question_id: string | null }>(`SELECT id, node_id, question_id FROM review_issues WHERE project_id = ? AND id IN (${scope.issueIds.map(() => '?').join(',')})`, projectId, ...scope.issueIds);
    const byNode = new Map<string, string[]>();
    const byQuestion = new Map<string, string[]>();
    for (const i of issues) {
      if (i.question_id) byQuestion.set(i.question_id, [...(byQuestion.get(i.question_id) ?? []), i.id]);
      else if (i.node_id) byNode.set(i.node_id, [...(byNode.get(i.node_id) ?? []), i.id]);
    }
    for (const [nodeId, ids] of byNode) specs.push({ kind: 'section.revise', key: `fix:${nodeId}:${stamp}`, label: `Fix ${ids.length} issue${ids.length > 1 ? 's' : ''}`, input: { nodeId, issueIds: ids }, pool: 'writer' });
    for (const [questionId, ids] of byQuestion) {
      specs.push({ kind: 'question.revise', key: `qfix:${questionId}:${stamp}`, label: 'Fix an exercise', input: { questionId, issueIds: ids }, pool: 'writer' });
      specs.push({ kind: 'question.verify', key: `qverify:${questionId}:${stamp}`, label: 'Check the corrected exercise', input: { questionId }, deps: [`qfix:${questionId}:${stamp}`], pool: 'reviewer' });
    }
  }
  if (!specs.length) throw new HttpError(400, 'empty', 'Select a passage or at least one issue.');
  return specs;
}

/** Called when the author approves an outline: passes outline gates waiting in active runs. */
export function onOutlineApproved(ctx: AppContext, projectId: string) {
  const waiting = ctx.db.all<{ id: string; input: string }>(`SELECT id, input FROM tasks WHERE project_id = ? AND kind = 'gate' AND state = 'waiting_for_user'`, projectId);
  for (const w of waiting) if (JSON.parse(w.input).check === 'outline') ctx.queue.resolve(w.id, 'continue');
}
