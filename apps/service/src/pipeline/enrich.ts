// Extras: the bulk model picks where graphs and lab examples (Python or MATLAB) help; the writer creates them; we check them.
import { compareExpected, graphLintCheck, graphSourceCheck, sampleGraph, type GraphSpec, type SampledGraph } from '@smartbuilder/content';
import type { QuestionCheck } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import { setIssuesStatus } from '../repo/issues.ts';
import type { TaskContext, TaskSpec } from '../queue/queue.ts';
import { runMatlab } from './matlab.ts';
import { runPython } from './python.ts';
import { enrichPickPrompt, enrichPickSchema, graphCheckPrompt, graphCheckSchema, graphPrompt, graphSchema, idePrompt, ideParser } from './prompts.ts';
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
    role: 'bulk', ...enrichPickPrompt({ sections: sections.map((s) => `${s.id} | ${s.title} | ${pickSummary(s.text)}`).join('\n'), graphs: project.options.graphs, ide: project.options.ide, lab, maxIde }),
    schema: enrichPickSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const have = new Set(sections.map((s) => s.id));
  // Drop unknown and repeated sections before the cap, so they don't use up places.
  const usable = <T extends { sectionId: string }>(picks: T[]) => uniqueSections(picks.filter((p) => have.has(p.sectionId)));
  const force = t.task.input.force ? { force: true } : {};
  const titleOf = (id: string) => chapter.sections.find((s) => s.id === id)?.title ?? '';
  const specs: TaskSpec[] = [
    // A pick that names no relation is a graph the section does not support (a classification, a structure): none is drawn.
    ...(project.options.graphs ? usable(data.graphs.filter((p) => p.relation.trim())).slice(0, 2) : [])
      .map((p) => ({ kind: 'enrich.graph', key: `enrich.graph:${p.sectionId}`, label: `Draw a graph for "${titleOf(p.sectionId)}"`, input: { nodeId: p.sectionId, purpose: p.purpose, relation: p.relation.trim(), ...force }, pool: 'editor' })),
    ...(project.options.ide ? usable(data.ide).slice(0, maxIde) : [])
      .map((p) => ({ kind: 'enrich.ide', key: `enrich.ide:${p.sectionId}`, label: `Write a ${LAB_NAME[lab]} example for "${titleOf(p.sectionId)}"`, input: { nodeId: p.sectionId, purpose: p.purpose, ...force }, pool: 'editor' })),
  ];
  t.enqueue(specs);
  return { picked: specs.length };
}

const LAB_NAME = { python: 'Python', matlab: 'MATLAB' } as const;

/** What the picker reads of a section: its opening and its first display formulas, where the relations a graph needs are stated. */
export function pickSummary(text: string): string {
  const formulas = [...text.matchAll(/\$\$([\s\S]+?)\$\$/g)].slice(0, 4).map((m) => truncate(m[1]!.replace(/\s+/g, ' ').trim(), 160));
  const opening = truncate(text.replace(/\s+/g, ' '), 600);
  return formulas.length ? `${opening} | formulas: ${formulas.join(' ; ')}` : opening;
}

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
  // The task may have waited in the queue: a graph the author fixed or deleted since is not redrawn, and no model is asked.
  const replaceId = t.task.input.replaceId as string | undefined;
  const before = replaceId ? enrichmentState(ctx, replaceId) : undefined;
  const issueIds = (t.task.input.issueIds as string[] | undefined) ?? [];
  if (replaceId && before?.status !== 'issue') {
    const reason = before ? 'The graph passes its check now.' : 'The graph that failed its check is no longer in the book.';
    setIssuesStatus(ctx, projectId, issueIds, 'fixed', reason);
    return { made: 0, skipped: reason };
  }
  const g = await runRole(ctx, { role: 'editor', ...graphPrompt({ language: project.language, purpose: String(t.task.input.purpose ?? ''), relation: typeof t.task.input.relation === 'string' ? t.task.input.relation : undefined, section: truncate(head.markdown, 8000) }), schema: graphSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  const main = g.data;
  if (main.verdict === 'none') {
    const reason = `The section states no relation a graph can show: ${main.reason}`;
    if (issueIds.length) setIssuesStatus(ctx, projectId, issueIds, 'open', `The graph was not redrawn. ${reason} Delete the graph in Extras, or fix it there.`);
    return { made: 0, skipped: reason };
  }
  const toSpec = (id: string, title: string, yDomain: [number, number], yScale: 'linear' | 'log' | undefined, yLabel: string, traces: GraphSpec['traces']): GraphSpec => ({
    id, title, xDomain: main.xDomain, yDomain, xScale: main.xScale, yScale, xLabel: main.xLabel, yLabel, traces,
  });
  const graphs = [{ spec: toSpec(main.id, main.title, main.yDomain, main.yScale, main.yLabel, main.traces), description: main.description }];
  // A pair (the phase under a Bode magnitude) shares the first graph's x axis, so the two line up when read one after the other.
  if (main.pair) graphs.push({ spec: toSpec(main.pair.id === main.id ? `${main.pair.id}-2` : main.pair.id, main.pair.title, main.pair.yDomain, main.pair.yScale, main.pair.yLabel, main.pair.traces), description: main.pair.description });
  // A graph that draws can still be wrong in ways its data shows (a joined jump, two traces in one place), and each trace
  // must quote what it draws from the section. These checks cost no model call.
  const built = graphs.map(({ spec, description }) => {
    const sampled = sampleGraph(spec);
    const lint = graphLintCheck(sampled.payload, [], { sampled: true });
    const source = graphSourceCheck(spec.traces, head.markdown);
    const checks: QuestionCheck[] = [
      { method: 'numeric', ok: sampled.ok, detail: `${description}\n${sampled.detail}` },
      { method: 'lint', ok: lint.ok, detail: lint.detail },
      { method: 'source', ok: source.ok, detail: source.detail },
    ];
    const failed = [sampled.ok ? '' : sampled.detail, lint.ok ? '' : lint.detail, source.ok ? '' : source.detail].filter(Boolean);
    return { spec, sampled, checks, failed };
  });
  // Then one independent call per graph that passed them, so a graph about to be redrawn anyway costs no checker call.
  const checkIndependently = async (b: (typeof built)[number]) => {
    if (b.failed.length) return;
    const check = await independentGraphCheck(ctx, t, { language: project.language, section: head.markdown, spec: b.spec, sampled: b.sampled });
    b.checks.push(check);
    if (!check.ok) b.failed.push(check.detail);
  };
  // A redraw that Auto Fix asked for (issues about a graph that failed its check) replaces the failing graph only when the
  // new one passes. A new failure adds no graph and no second issue: the issues stay open with the reason.
  if (issueIds.length) {
    // A redraw answers the issues of one graph row. Its replacement is the graph of the answer with that row's id, or the only
    // graph of the answer when none has the id. A pair has two rows, and each gets its own redraw.
    const wanted = before ? json<{ id?: string }>(before.payload, {}).id : undefined;
    const pick = built.find((b) => b.spec.id === wanted) ?? (built.length === 1 ? built[0] : undefined);
    if (!pick) {
      const reason = `The redrawn answer has no graph with the id "${wanted ?? ''}" and holds ${built.length} graphs, so none of them is taken for this one.`;
      setIssuesStatus(ctx, projectId, issueIds, 'open', reason);
      return { made: 0, skipped: reason };
    }
    await checkIndependently(pick);
    const { spec, sampled, checks } = pick;
    if (pick.failed.length) {
      const failed = pick.failed.join('; ');
      setIssuesStatus(ctx, projectId, issueIds, 'open', `The graph was redrawn but failed its check again: ${failed}`);
      return { made: 0, failed };
    }
    if (replaceId) {
      // Work done while the author changed the same graph is never applied over it: the check and the write are one transaction.
      const stale = ctx.db.tx(() => {
        const reason = changedSince(before, enrichmentState(ctx, replaceId));
        if (!reason) ctx.db.update('enrichments', replaceId, { payload: sampled.payload, status: 'verified', checks, spec });
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
    saveEnrichment(ctx, projectId, nodeId, 'graph', sampled.payload, checks, spec);
    setIssuesStatus(ctx, projectId, issueIds, 'fixed', 'The graph was redrawn and passes its check.');
    return { made: 1, replaced: false };
  }
  for (const b of built) await checkIndependently(b);
  // One transaction: a pair is kept whole or not at all, because a retry without force returns `reused` as soon as one graph exists.
  ctx.db.tx(() => { for (const { sampled, checks, spec } of built) saveEnrichment(ctx, projectId, nodeId, 'graph', sampled.payload, checks, spec); });
  return { made: built.length };
}

/**
 * One call on the checker route: from the section alone, without the data, the checker writes the curve each trace must
 * show, and the builder compares it with the sampled points. A mismatch, a contradiction the checker reports, or its verdict
 * that the section states no relation for this graph fails the check, and the detail carries the expected curve for the redraw.
 * shortcut: traces on a log y axis are not compared numerically (1% of a window spanning decades says little), upgrade by
 * comparing in the exponent.
 */
export async function independentGraphCheck(ctx: AppContext, t: TaskContext, p: { language: string; section: string; spec: GraphSpec; sampled: SampledGraph }): Promise<QuestionCheck> {
  const { spec } = p;
  const r = await runRole(ctx, {
    role: 'checker',
    ...graphCheckPrompt({ language: p.language, section: truncate(p.section, 8000), graph: { title: spec.title, xLabel: spec.xLabel, yLabel: spec.yLabel, traces: spec.traces.map((tr) => ({ label: tr.label, source: tr.source })) } }),
    schema: graphCheckSchema, projectId: t.task.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const data = p.sampled.payload.config.data as { x?: unknown[]; y?: unknown[] }[];
  const yspan = spec.yDomain[1] - spec.yDomain[0];
  const lines: string[] = [];
  let ok = r.data.fit === 'fits';
  if (!ok) lines.push('The checker finds no relation in the section that this graph can show.');
  spec.traces.forEach((tr, k) => {
    const answer = r.data.traces[k];
    if (!answer) return;
    const d = data[k];
    const cmp = tr.kind === 'function' && spec.yScale !== 'log' && d?.x && d.y ? compareExpected(answer.expected, d.x, d.y, yspan) : null;
    if (cmp && !cmp.ok) ok = false;
    if (answer.problem.trim()) ok = false;
    const parts = [cmp ? cmp.detail : answer.expected.trim() ? `expected ${answer.expected} (not compared)` : '', answer.problem.trim() ? `problem: ${answer.problem.trim()}` : ''].filter(Boolean);
    if (parts.length) lines.push(`"${tr.label}": ${parts.join('; ')}`);
  });
  return { method: 'independent', ok, detail: lines.join('\n') || 'The checker found nothing to compare.', model: `${r.route.provider}:${r.route.model}` };
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

function saveEnrichment(ctx: AppContext, projectId: string, nodeId: string, kind: 'ide' | 'graph', payload: Record<string, unknown>, checks: { method: string; ok: boolean; detail: string }[], spec: GraphSpec | null = null) {
  const ok = checks.every((c) => c.ok);
  ctx.db.insert('enrichments', { id: newId(), project_id: projectId, node_id: nodeId, kind, payload, status: ok ? 'verified' : 'issue', checks, spec, created_at: now() });
  if (!ok) {
    ctx.db.insert('review_issues', {
      id: newId(), project_id: projectId, node_id: nodeId, question_id: null, rev_id: null, source: 'verification', severity: 'major',
      category: kind, quote: String(payload.title ?? ''), message: `The ${kind === 'ide' ? `${LAB_NAME[payload.language === 'matlab' ? 'matlab' : 'python']} example` : 'graph'} failed its check: ${checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`,
      suggestion: 'Edit it in Extras or delete it.', status: 'open', resolution: '', created_at: now(),
    });
    ctx.events.emit('issue.created', { nodeId, severity: 'major' }, { projectId });
  }
  ctx.events.emit('enrichment.updated', { nodeId, kind }, { projectId });
}

export { runPython };
