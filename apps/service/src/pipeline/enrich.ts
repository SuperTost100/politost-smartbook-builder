// Extras: the bulk model picks where graphs and Python examples help; the writer creates them; we check them.
import { sampleFunctionGraph } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import type { TaskContext, TaskSpec } from '../queue/queue.ts';
import { runPython } from './python.ts';
import { enrichPickPrompt, enrichPickSchema, graphPrompt, graphSchema, idePrompt, ideSchema } from './prompts.ts';
import { headRevision, loadOutline, loadProject, truncate } from './util.ts';

const ENRICH_KINDS = ['enrich.graph', 'enrich.ide'];

/**
 * Picks where graphs and Python examples help (one bulk call) and enqueues one child task per extra. A retry finds the
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

  const children = ctx.db.all<{ kind: string; input: string }>(`SELECT kind, input FROM tasks WHERE run_id = ? AND kind IN (${ENRICH_KINDS.map(() => '?').join(',')})`, t.task.runId, ...ENRICH_KINDS)
    .filter((c) => ids.has(json<{ nodeId?: string }>(c.input, {}).nodeId ?? ''));
  if (children.length && !t.task.input.force) return { reused: children.length };

  const sections = chapter.sections.map((s) => {
    const head = headRevision(ctx, projectId, s.id);
    return { id: s.id, title: s.title, text: head?.markdown ?? '' };
  }).filter((s) => s.text);
  const { data } = await runRole(ctx, {
    role: 'bulk', ...enrichPickPrompt({ sections: sections.map((s) => `${s.id} | ${s.title} | ${truncate(s.text.replace(/\s+/g, ' '), 600)}`).join('\n'), graphs: project.options.graphs, ide: project.options.ide }),
    schema: enrichPickSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const have = new Set(sections.map((s) => s.id));
  const force = t.task.input.force ? { force: true } : {};
  const titleOf = (id: string) => chapter.sections.find((s) => s.id === id)?.title ?? '';
  const specs: TaskSpec[] = [
    ...(project.options.graphs ? data.graphs.slice(0, 2) : []).filter((p) => have.has(p.sectionId))
      .map((p) => ({ kind: 'enrich.graph', key: `enrich.graph:${p.sectionId}`, label: `Draw a graph for "${titleOf(p.sectionId)}"`, input: { nodeId: p.sectionId, purpose: p.purpose, ...force }, pool: 'editor' })),
    ...(project.options.ide ? data.ide.slice(0, 1) : []).filter((p) => have.has(p.sectionId))
      .map((p) => ({ kind: 'enrich.ide', key: `enrich.ide:${p.sectionId}`, label: `Write a Python example for "${titleOf(p.sectionId)}"`, input: { nodeId: p.sectionId, purpose: p.purpose, ...force }, pool: 'editor' })),
  ];
  t.enqueue(specs);
  return { picked: specs.length };
}

function existingEnrichment(ctx: AppContext, projectId: string, nodeId: string, kind: 'graph' | 'ide') {
  return ctx.db.get('SELECT id FROM enrichments WHERE project_id = ? AND node_id = ? AND kind = ?', projectId, nodeId, kind);
}

/** One graph for one section. Idempotent: skipped when the section already has a graph. */
export async function enrichGraph(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  if (!t.task.input.force && existingEnrichment(ctx, projectId, nodeId, 'graph')) return { reused: true };
  const head = headRevision(ctx, projectId, nodeId);
  if (!head) return { skipped: 'no text yet' };
  const project = loadProject(ctx, projectId);
  const g = await runRole(ctx, { role: 'editor', ...graphPrompt({ language: project.language, purpose: String(t.task.input.purpose ?? ''), section: truncate(head.markdown, 8000) }), schema: graphSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  const sampled = sampleFunctionGraph({
    id: g.data.id, title: g.data.title, xDomain: g.data.xDomain, yDomain: g.data.yDomain, xLabel: g.data.xLabel, yLabel: g.data.yLabel,
    functions: g.data.functions.map((f) => ({ expr: f.fn, label: f.label })),
  });
  saveEnrichment(ctx, projectId, nodeId, 'graph', sampled.payload, [{ method: 'numeric', ok: sampled.ok, detail: `${g.data.description}\n${sampled.detail}` }]);
  return { made: 1 };
}

/** One Python example for one section, run in the sandbox. Idempotent: skipped when the section already has one. */
export async function enrichIde(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  if (!t.task.input.force && existingEnrichment(ctx, projectId, nodeId, 'ide')) return { reused: true };
  const head = headRevision(ctx, projectId, nodeId);
  if (!head) return { skipped: 'no text yet' };
  const project = loadProject(ctx, projectId);
  const g = await runRole(ctx, { role: 'editor', ...idePrompt({ language: project.language, purpose: String(t.task.input.purpose ?? ''), section: truncate(head.markdown, 8000) }), schema: ideSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  const payload = { id: g.data.id, title: g.data.title, language: 'python', description: g.data.description, code: g.data.code };
  t.progress('Running the Python example');
  const run = await runPython(g.data.code, 20_000);
  const ok = run.ok && run.stdout.trim().length > 0;
  saveEnrichment(ctx, projectId, nodeId, 'ide', payload, [{ method: 'numeric', ok, detail: ok ? `Ran in Pyodide ${run.version}. Output:\n${truncate(run.stdout, 800)}` : `Did not run: ${run.error ?? 'no output'}` }]);
  return { made: 1 };
}

function saveEnrichment(ctx: AppContext, projectId: string, nodeId: string, kind: 'ide' | 'graph', payload: Record<string, unknown>, checks: { method: string; ok: boolean; detail: string }[]) {
  const ok = checks.every((c) => c.ok);
  ctx.db.insert('enrichments', { id: newId(), project_id: projectId, node_id: nodeId, kind, payload, status: ok ? 'verified' : 'issue', checks, created_at: now() });
  if (!ok) {
    ctx.db.insert('review_issues', {
      id: newId(), project_id: projectId, node_id: nodeId, question_id: null, rev_id: null, source: 'verification', severity: 'major',
      category: kind, quote: String(payload.title ?? ''), message: `The ${kind === 'ide' ? 'Python example' : 'graph'} failed its check: ${checks.map((c) => c.detail).join('; ')}`,
      suggestion: 'Edit it in Extras or delete it.', status: 'open', resolution: '', created_at: now(),
    });
    ctx.events.emit('issue.created', { nodeId, severity: 'major' }, { projectId });
  }
  ctx.events.emit('enrichment.updated', { nodeId, kind }, { projectId });
}

export { runPython };
