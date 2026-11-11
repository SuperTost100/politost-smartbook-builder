// Extras: the bulk model picks where graphs and lab examples (Python or MATLAB) help; the writer creates them; we check them.
import { sampleFunctionGraph } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import { setIssuesStatus } from '../repo/issues.ts';
import type { TaskContext, TaskSpec } from '../queue/queue.ts';
import { runMatlab } from './matlab.ts';
import { runPython } from './python.ts';
import { enrichPickPrompt, enrichPickSchema, graphPrompt, graphSchema, idePrompt, ideParser } from './prompts.ts';
import { headRevision, loadOutline, loadProject, truncate } from './util.ts';

const ENRICH_KINDS = ['enrich.graph', 'enrich.ide'];

/**
 * Picks where graphs and lab examples help (one bulk call) and enqueues one child task per extra. A retry finds the
 * children already in the run and reuses them instead of picking again.
 */
export async function chapterEnrich(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const project = loadProject(ctx, projectId);
  if (!project.options.graphs && !project.options.ide) return { skipped: 'disabled' };
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true };
  const ids = new Set(chapter.sections.map((s) => s.id));
  const lab = project.options.labLanguage;
  // A MATLAB book teaches the language, so most sections get a script; elsewhere code is an occasional extra.
  const maxIde = lab === 'matlab' ? chapter.sections.length : 1;

  const children = ctx.db.all<{ kind: string; input: string }>(`SELECT kind, input FROM tasks WHERE run_id = ? AND kind IN (${ENRICH_KINDS.map(() => '?').join(',')})`, t.task.runId, ...ENRICH_KINDS)
    .filter((c) => ids.has(json<{ nodeId?: string }>(c.input, {}).nodeId ?? ''));
  if (children.length && !t.task.input.force) return { reused: children.length };

  const sections = chapter.sections.map((s) => {
    const head = headRevision(ctx, projectId, s.id);
    return { id: s.id, title: s.title, text: head?.markdown ?? '' };
  }).filter((s) => s.text);
  const { data } = await runRole(ctx, {
    role: 'bulk', ...enrichPickPrompt({ sections: sections.map((s) => `${s.id} | ${s.title} | ${truncate(s.text.replace(/\s+/g, ' '), 600)}`).join('\n'), graphs: project.options.graphs, ide: project.options.ide, lab, maxIde }),
    schema: enrichPickSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const have = new Set(sections.map((s) => s.id));
  // Drop unknown and repeated sections before the cap, so they don't use up places.
  const usable = <T extends { sectionId: string }>(picks: T[]) => uniqueSections(picks.filter((p) => have.has(p.sectionId)));
  const force = t.task.input.force ? { force: true } : {};
  const titleOf = (id: string) => chapter.sections.find((s) => s.id === id)?.title ?? '';
  const specs: TaskSpec[] = [
    ...(project.options.graphs ? usable(data.graphs).slice(0, 2) : [])
      .map((p) => ({ kind: 'enrich.graph', key: `enrich.graph:${p.sectionId}`, label: `Draw a graph for "${titleOf(p.sectionId)}"`, input: { nodeId: p.sectionId, purpose: p.purpose, ...force }, pool: 'editor' })),
    ...(project.options.ide ? usable(data.ide).slice(0, maxIde) : [])
      .map((p) => ({ kind: 'enrich.ide', key: `enrich.ide:${p.sectionId}`, label: `Write a ${LAB_NAME[lab]} example for "${titleOf(p.sectionId)}"`, input: { nodeId: p.sectionId, purpose: p.purpose, ...force }, pool: 'editor' })),
  ];
  t.enqueue(specs);
  return { picked: specs.length };
}

const LAB_NAME = { python: 'Python', matlab: 'MATLAB' } as const;

/** The task key is per section, so a section picked twice would enqueue one task and use up two places. */
function uniqueSections<T extends { sectionId: string }>(picks: T[]): T[] {
  const seen = new Set<string>();
  return picks.filter((p) => !seen.has(p.sectionId) && seen.add(p.sectionId));
}

function existingEnrichment(ctx: AppContext, projectId: string, nodeId: string, kind: 'graph' | 'ide') {
  return ctx.db.get('SELECT id FROM enrichments WHERE project_id = ? AND node_id = ? AND kind = ?', projectId, nodeId, kind);
}

/** What an enrichment row holds that an edit changes. shortcut: the row has no revision column, so a comparison of the stored texts stands in for one, upgrade by adding an updated_at column. */
function enrichmentState(ctx: AppContext, id: string) {
  return ctx.db.get<{ payload: string; status: string; checks: string }>('SELECT payload, status, checks FROM enrichments WHERE id = ?', id);
}

/** Why a graph can no longer be replaced: it was deleted, or its stored state is not what it was when the model started. */
function changedSince(before: ReturnType<typeof enrichmentState>, now: ReturnType<typeof enrichmentState>): string | undefined {
  if (!now) return 'the author deleted the graph while it was being redrawn';
  if (!before) return 'the graph was no longer there when the redraw started';
  if (before.payload !== now.payload || before.status !== now.status || before.checks !== now.checks) return 'the author edited the graph while it was being redrawn';
  return undefined;
}

/** One graph for one section. Idempotent: skipped when the section already has a graph. */
export async function enrichGraph(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  if (!t.task.input.force && existingEnrichment(ctx, projectId, nodeId, 'graph')) return { reused: true };
  const head = headRevision(ctx, projectId, nodeId);
  if (!head) return { skipped: 'no text yet' };
  const project = loadProject(ctx, projectId);
  // A redraw replaces one graph. What it looked like before the model ran is what the author's edits are measured against.
  const replaceId = t.task.input.replaceId as string | undefined;
  const before = replaceId ? enrichmentState(ctx, replaceId) : undefined;
  const g = await runRole(ctx, { role: 'editor', ...graphPrompt({ language: project.language, purpose: String(t.task.input.purpose ?? ''), section: truncate(head.markdown, 8000) }), schema: graphSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  const main = g.data;
  const toSpec = (id: string, title: string, yDomain: [number, number], yScale: 'linear' | 'log' | undefined, yLabel: string, functions: { fn: string; label: string }[]) => ({
    id, title, xDomain: main.xDomain, yDomain, xScale: main.xScale, yScale, xLabel: main.xLabel, yLabel,
    functions: functions.map((f) => ({ expr: f.fn, label: f.label })),
  });
  const graphs = [{ spec: toSpec(main.id, main.title, main.yDomain, main.yScale, main.yLabel, main.functions), description: main.description }];
  // A pair (the phase under a Bode magnitude) shares the first graph's x axis, so the two line up when read one after the other.
  if (main.pair) graphs.push({ spec: toSpec(main.pair.id === main.id ? `${main.pair.id}-2` : main.pair.id, main.pair.title, main.pair.yDomain, main.pair.yScale, main.pair.yLabel, main.pair.functions), description: main.pair.description });
  const built = graphs.map(({ spec, description }) => {
    const sampled = sampleFunctionGraph(spec);
    return { sampled, checks: [{ method: 'numeric', ok: sampled.ok, detail: `${description}\n${sampled.detail}` }] };
  });
  // A redraw that Auto Fix asked for (issues about a graph that failed its check) replaces the failing graph only when the
  // new one passes. A new failure adds no graph and no second issue: the issues stay open with the reason.
  const issueIds = (t.task.input.issueIds as string[] | undefined) ?? [];
  if (issueIds.length) {
    // A redraw answers issues about one graph, so it uses the first graph of the answer and leaves a pair aside.
    const { sampled, checks } = built[0]!;
    if (!sampled.ok) {
      setIssuesStatus(ctx, projectId, issueIds, 'open', `The graph was redrawn but failed its check again: ${sampled.detail}`);
      return { made: 0, failed: sampled.detail };
    }
    if (replaceId) {
      // Work done while the author changed the same graph is never applied over it: the check and the write are one transaction.
      const stale = ctx.db.tx(() => {
        const reason = changedSince(before, enrichmentState(ctx, replaceId));
        if (!reason) ctx.db.update('enrichments', replaceId, { payload: sampled.payload, status: 'verified', checks });
        return reason;
      });
      if (stale) {
        setIssuesStatus(ctx, projectId, issueIds, 'open', `The redrawn graph was not applied: ${stale}`);
        return { made: 0, skipped: stale };
      }
      ctx.events.emit('enrichment.updated', { enrichmentId: replaceId, nodeId, kind: 'graph' }, { projectId });
      setIssuesStatus(ctx, projectId, issueIds, 'fixed', 'The graph was redrawn and passes its check.');
      return { made: 1, replaced: true };
    }
    saveEnrichment(ctx, projectId, nodeId, 'graph', sampled.payload, checks);
    setIssuesStatus(ctx, projectId, issueIds, 'fixed', 'The graph was redrawn and passes its check.');
    return { made: 1, replaced: false };
  }
  for (const { sampled, checks } of built) saveEnrichment(ctx, projectId, nodeId, 'graph', sampled.payload, checks);
  return { made: built.length };
}

/** One lab example (Python or MATLAB) for one section, run in its sandbox. Idempotent: skipped when the section already has one. */
export async function enrichIde(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  if (!t.task.input.force && existingEnrichment(ctx, projectId, nodeId, 'ide')) return { reused: true };
  const head = headRevision(ctx, projectId, nodeId);
  if (!head) return { skipped: 'no text yet' };
  const project = loadProject(ctx, projectId);
  const lab = project.options.labLanguage;
  const g = await runRole(ctx, { role: 'editor', ...idePrompt({ language: project.language, purpose: String(t.task.input.purpose ?? ''), section: truncate(head.markdown, 8000), lab }), parse: ideParser, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  const payload = { id: g.data.id, title: g.data.title, language: lab, description: g.data.description, code: g.data.code };
  t.progress(`Running the ${LAB_NAME[lab]} example`);
  saveEnrichment(ctx, projectId, nodeId, 'ide', payload, [await checkLabCode(lab, g.data.code)]);
  return { made: 1 };
}

/** Runs a lab example where the reader would: Pyodide for Python, numbl for MATLAB. It must print something or draw a figure. */
export async function checkLabCode(lab: 'python' | 'matlab', code: string): Promise<{ method: string; ok: boolean; detail: string }> {
  if (lab === 'matlab') {
    const run = await runMatlab(code, 20_000);
    const ok = run.ok && (run.stdout.trim().length > 0 || run.figures > 0);
    const figures = run.figures ? ` and drew ${run.figures} figure${run.figures === 1 ? '' : 's'}` : '';
    return { method: 'numeric', ok, detail: ok ? `Ran in numbl${figures}. Output:\n${truncate(run.stdout, 800)}` : `Did not run: ${run.error ?? 'no output'}` };
  }
  const run = await runPython(code, 20_000);
  const ok = run.ok && run.stdout.trim().length > 0;
  return { method: 'numeric', ok, detail: ok ? `Ran in Pyodide ${run.version}. Output:\n${truncate(run.stdout, 800)}` : `Did not run: ${run.error ?? 'no output'}` };
}

function saveEnrichment(ctx: AppContext, projectId: string, nodeId: string, kind: 'ide' | 'graph', payload: Record<string, unknown>, checks: { method: string; ok: boolean; detail: string }[]) {
  const ok = checks.every((c) => c.ok);
  ctx.db.insert('enrichments', { id: newId(), project_id: projectId, node_id: nodeId, kind, payload, status: ok ? 'verified' : 'issue', checks, created_at: now() });
  if (!ok) {
    ctx.db.insert('review_issues', {
      id: newId(), project_id: projectId, node_id: nodeId, question_id: null, rev_id: null, source: 'verification', severity: 'major',
      category: kind, quote: String(payload.title ?? ''), message: `The ${kind === 'ide' ? `${LAB_NAME[payload.language === 'matlab' ? 'matlab' : 'python']} example` : 'graph'} failed its check: ${checks.map((c) => c.detail).join('; ')}`,
      suggestion: 'Edit it in Extras or delete it.', status: 'open', resolution: '', created_at: now(),
    });
    ctx.events.emit('issue.created', { nodeId, severity: 'major' }, { projectId });
  }
  ctx.events.emit('enrichment.updated', { nodeId, kind }, { projectId });
}

export { runPython };
