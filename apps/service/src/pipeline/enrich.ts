// Extras: the bulk model picks where graphs and lab examples (Python or MATLAB) help; the writer creates them; we check them.
import { compareExpected, graphLintCheck, graphSourceCheck, lintGraph, lintKey, sampleGraph, type GraphSpec, type GraphTrace, type SampledGraph } from '@smartbuilder/content';
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

/** One graph of the writer's answer with the result of its checks. `jumps` are the joined-jump keys the sampler vouches for. */
interface DrawnGraph { spec: GraphSpec; sampled: SampledGraph; checks: QuestionCheck[]; failed: string[]; jumps: string[] }

/**
 * One writer call and the checks that need no model: sampling, the graph lint and the section quotes. The writer gets the
 * whole section, so a worked example late in it can be drawn.
 */
async function drawGraphs(ctx: AppContext, t: TaskContext, p: { language: string; purpose: string; relation?: string; section: string }): Promise<{ none: string } | { graphs: DrawnGraph[] }> {
  const g = await runRole(ctx, { role: 'editor', ...graphPrompt(p), schema: graphSchema, projectId: t.task.projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  const main = g.data;
  if (main.verdict === 'none') return { none: main.reason };
  const toSpec = (id: string, title: string, yDomain: [number, number], yScale: 'linear' | 'log' | undefined, yLabel: string, traces: GraphSpec['traces']): GraphSpec => ({
    id, title, xDomain: main.xDomain, yDomain, xScale: main.xScale, yScale, xLabel: main.xLabel, yLabel, traces,
  });
  const graphs = [{ spec: toSpec(main.id, main.title, main.yDomain, main.yScale, main.yLabel, main.traces), description: main.description }];
  // A pair (the phase under a Bode magnitude) shares the first graph's x axis, so the two line up when read one after the other.
  if (main.pair) graphs.push({ spec: toSpec(main.pair.id === main.id ? `${main.pair.id}-2` : main.pair.id, main.pair.title, main.pair.yDomain, main.pair.yScale, main.pair.yLabel, main.pair.traces), description: main.pair.description });
  return {
    graphs: graphs.map(({ spec, description }) => {
      const sampled = sampleGraph(spec);
      const lint = graphLintCheck(sampled.payload, [], { sampled: true });
      const source = graphSourceCheck(spec.traces, p.section);
      const checks: QuestionCheck[] = [
        { method: 'numeric', ok: sampled.ok, detail: `${description}\n${sampled.detail}` },
        { method: 'lint', ok: lint.ok, detail: lint.detail },
        { method: 'source', ok: source.ok, detail: source.detail },
      ];
      const failed = [sampled.ok ? '' : sampled.detail, lint.ok ? '' : lint.detail, source.ok ? '' : source.detail].filter(Boolean);
      // The sampler bisected every visible step, so a joined jump the data alone suggests is a steep curve. Its key is stored
      // as accepted, so an edit in Extras or the export does not report it again.
      const jumps = lintGraph(sampled.payload).filter((f) => f.code === 'joined-jump').map(lintKey);
      return { spec, sampled, checks, failed, jumps };
    }),
  };
}

/**
 * One graph for one section. Idempotent: skipped when the section already has a graph. A graph that fails its checks is drawn
 * once more with what failed; when it fails again nothing is saved, as for a section with no relation to plot. A redraw for
 * issues (Fix) replaces the failing graph only when the new one passes, and otherwise leaves the issues open with the reason.
 */
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
  // A redraw answers the issues of one graph row. Its replacement is the graph of the answer with that row's id, or the only
  // graph of the answer when none has the id. A pair has two rows, and each gets its own redraw.
  const wanted = before ? json<{ id?: string }>(before.payload, {}).id : undefined;
  // A redraw is told what failed last: the checks of the graph it replaces that did not pass.
  const lastFailure = before ? json<QuestionCheck[]>(before.checks, []).filter((c) => !c.ok).map((c) => c.detail).join('; ') : '';
  const purpose = `${String(t.task.input.purpose ?? '')}${lastFailure ? `\nThe last check of the graph failed: ${lastFailure}` : ''}`;
  const relation = typeof t.task.input.relation === 'string' ? t.task.input.relation : undefined;
  const call = { projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal };

  type Attempt = { skipped: string } | { graphs: DrawnGraph[]; failed: string };
  const attempt = async (why: string): Promise<Attempt> => {
    const drawn = await drawGraphs(ctx, t, { language: project.language, purpose: why, relation, section: head.markdown });
    if ('none' in drawn) return { skipped: `The section states no relation a graph can show: ${drawn.none}` };
    let graphs = drawn.graphs;
    if (issueIds.length) {
      const pick = graphs.find((b) => b.spec.id === wanted) ?? (graphs.length === 1 ? graphs[0] : undefined);
      if (!pick) return { skipped: `The redrawn answer has no graph with the id "${wanted ?? ''}" and holds ${graphs.length} graphs, so none of them is taken for this one.` };
      graphs = [pick];
    }
    // One independent call per graph, only when every graph passed the checks that cost nothing: a graph about to be drawn
    // again costs no checker call.
    if (graphs.every((b) => !b.failed.length)) {
      for (const b of graphs) {
        const check = await independentGraphCheck(ctx, call, { language: project.language, section: head.markdown, payload: b.sampled.payload, spec: b.spec });
        b.checks.push(check);
        if (!check.ok) b.failed.push(check.detail);
      }
    }
    return { graphs, failed: graphs.flatMap((b) => b.failed).join('; ') };
  };
  let result = await attempt(purpose);
  if ('graphs' in result && result.failed) {
    result = await attempt(`${purpose}\nA first draft failed its checks: ${result.failed}\nDraw the graph again so that it passes, or answer verdict "none" if the section states no relation a graph can show.`);
  }
  if ('skipped' in result) {
    if (issueIds.length) setIssuesStatus(ctx, projectId, issueIds, 'open', `The graph was not redrawn. ${result.skipped} Delete the graph in Extras, or fix it there.`);
    return { made: 0, skipped: result.skipped };
  }
  if (result.failed) {
    if (issueIds.length) {
      setIssuesStatus(ctx, projectId, issueIds, 'open', `The graph was redrawn but failed its check again: ${result.failed}`);
      return { made: 0, failed: result.failed };
    }
    return { made: 0, skipped: `The graph failed its checks twice and was not saved: ${result.failed}` };
  }
  const saved = { checkedRevisionId: head.id };
  if (issueIds.length) {
    const { spec, sampled, checks, jumps } = result.graphs[0]!;
    if (replaceId) {
      // Work done while the author changed the same graph is never applied over it: the check and the write are one transaction.
      const stale = ctx.db.tx(() => {
        const reason = changedSince(before, enrichmentState(ctx, replaceId));
        if (!reason) {
          const accepted = json<string[]>(ctx.db.get<{ lint_accepted: string }>('SELECT lint_accepted FROM enrichments WHERE id = ?', replaceId)?.lint_accepted ?? '[]', []);
          ctx.db.update('enrichments', replaceId, { payload: sampled.payload, status: 'verified', checks, spec, lint_accepted: [...new Set([...accepted, ...jumps])], checked_rev_id: saved.checkedRevisionId });
        }
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
    saveEnrichment(ctx, projectId, nodeId, 'graph', sampled.payload, checks, { spec, lintAccepted: jumps, ...saved });
    setIssuesStatus(ctx, projectId, issueIds, 'fixed', 'The graph was redrawn and passes its check.');
    return { made: 1, replaced: false };
  }
  // One transaction: a pair is kept whole or not at all, because a retry without force returns `reused` as soon as one graph exists.
  ctx.db.tx(() => { for (const { sampled, checks, spec, jumps } of result.graphs) saveEnrichment(ctx, projectId, nodeId, 'graph', sampled.payload, checks, { spec, lintAccepted: jumps, ...saved }); });
  return { made: result.graphs.length };
}

/** What the checker is told about one trace of a graph, read from the payload, and the data to compare when it is a curve y = f(x). */
export interface CheckedTrace { label: string; source?: string; kind: GraphTrace['kind'] | 'polyline'; where: string; x?: unknown[]; y?: unknown[] }

const axisTitleOf = (a: unknown): string => {
  const t = (a as { title?: unknown } | undefined)?.title;
  if (typeof t === 'string') return t;
  const text = (t as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
};
const short = (v: number) => String(Number(v.toPrecision(4)));

/**
 * The traces of a graph payload as the checker sees them: kind, the x interval of a curve, the values of points, bars and
 * vertical lines. The spec, when there is one, adds each trace's section quote and tells a parametric curve apart.
 */
export function checkedTraces(payload: Record<string, unknown>, spec?: GraphSpec | null): CheckedTrace[] {
  const data = ((asPlotly(payload).config as { data?: unknown } | undefined)?.data ?? []) as Record<string, unknown>[];
  return (Array.isArray(data) ? data : []).map((d, k) => {
    const label = typeof d.name === 'string' && d.name.trim() ? d.name : `trace ${k + 1}`;
    const source = spec?.traces[k]?.source?.trim() || undefined;
    const base = { label, ...(source ? { source } : {}) };
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const ys = Array.isArray(d.y) ? (d.y as unknown[]) : [];
    // Without an x array Plotly counts up by 1 from x0, as the lint and the numeric check read it.
    const xs = Array.isArray(d.x) ? (d.x as unknown[]) : ys.map((_, i) => (finite(d.x0) ? d.x0 : 0) + i);
    const symbols = (d.marker as { symbol?: unknown } | undefined)?.symbol;
    const pts = xs.map((x, i) => ({ x, y: ys[i], open: Array.isArray(symbols) && symbols[i] === 'circle-open' })).filter((p): p is { x: number; y: number; open: boolean } => finite(p.x) && finite(p.y));
    const list = (ps: typeof pts) => `${ps.slice(0, 40).map((p) => `(${short(p.x)}, ${short(p.y)})${p.open ? ' hole' : ''}`).join(', ')}${ps.length > 40 ? `, … (${ps.length} in all)` : ''}`;
    if (d.type === 'bar') return { ...base, kind: 'bars' as const, where: `bars ${xs.map((c, i) => `${String(c)} = ${finite(ys[i]) ? short(ys[i]) : '?'}`).join(', ')}` };
    if (!/lines/.test(typeof d.mode === 'string' ? d.mode : 'lines+markers')) return { ...base, kind: 'points' as const, where: `points ${list(pts)}` };
    if (pts.length === 2 && pts[0]!.x === pts[1]!.x) return { ...base, kind: 'vline' as const, where: `vertical line at x = ${short(pts[0]!.x)}` };
    const increasing = pts.every((p, i) => i === 0 || p.x > pts[i - 1]!.x);
    if (spec?.traces[k]?.kind === 'parametric' || !increasing || !pts.length) return { ...base, kind: 'parametric' as const, where: 'a parametric or closed curve' };
    if (pts.length <= 10) return { ...base, kind: 'polyline' as const, where: `straight segments through ${list(pts)}` };
    return { ...base, kind: 'function' as const, where: `a curve y = f(x) drawn for x from ${short(pts[0]!.x)} to ${short(pts.at(-1)!.x)}`, x: xs, y: ys };
  });
}

/** The reader's own "function" graphs hold formulas, not points: they are sampled here, so the checker reads them as any other graph. */
function asPlotly(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type !== 'function') return payload;
  const c = (payload.config ?? {}) as { functions?: { fn?: unknown; label?: unknown }[]; xDomain?: [number, number]; yDomain?: [number, number]; xLabel?: unknown; yLabel?: unknown };
  const xDomain = c.xDomain ?? [-5, 5];
  return sampleGraph({
    id: String(payload.id ?? ''), title: String(payload.title ?? ''), xDomain, yDomain: c.yDomain ?? xDomain,
    xLabel: typeof c.xLabel === 'string' ? c.xLabel : 'x', yLabel: typeof c.yLabel === 'string' ? c.yLabel : 'y',
    traces: (c.functions ?? []).map((f) => ({ kind: 'function', fn: String(f.fn ?? ''), label: String(f.label ?? '') })),
  }).payload;
}

/**
 * One call on the checker route: from the whole section, without the data, the checker writes the curve each trace must show,
 * and the builder compares it with the drawn points. It is told each trace's kind and where it lies (a curve's x interval, the
 * values of points, bars and vertical lines), so a branch on the wrong side of the axis is a contradiction it can report.
 * A mismatch, a contradiction, a constant fitted to different values in different traces, or its verdict that the section
 * states no relation for this graph fails the check, and the detail carries the expected curve for a redraw. It needs only the
 * payload, so graphs drawn before specs were kept can be checked too (check-graphs).
 * shortcut: traces on a log y axis are not compared numerically (1% of a window spanning decades says little), upgrade by
 * comparing in the exponent.
 */
export async function independentGraphCheck(
  ctx: AppContext,
  call: { projectId: string; runId?: string | null; taskId?: string | null; signal?: AbortSignal },
  p: { language: string; section: string; payload: Record<string, unknown>; spec?: GraphSpec | null },
): Promise<QuestionCheck> {
  const payload = asPlotly(p.payload);
  const layout = ((payload.config as { layout?: unknown } | undefined)?.layout ?? {}) as { xaxis?: unknown; yaxis?: { type?: unknown; range?: unknown } };
  const traces = checkedTraces(payload, p.spec);
  if (!traces.length) return { method: 'independent', ok: false, detail: 'The graph has no trace to check.' };
  const r = await runRole(ctx, {
    role: 'checker',
    ...graphCheckPrompt({ language: p.language, section: p.section, graph: { title: typeof p.payload.title === 'string' ? p.payload.title : '', xLabel: axisTitleOf(layout.xaxis), yLabel: axisTitleOf(layout.yaxis), traces } }),
    schema: graphCheckSchema, projectId: call.projectId, runId: call.runId ?? null, taskId: call.taskId ?? null, signal: call.signal,
  });
  const yLog = layout.yaxis?.type === 'log';
  const range = layout.yaxis?.range;
  const ys = traces.flatMap((tr) => (tr.y ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  const yspan = Array.isArray(range) && range.length === 2 && range.every((v) => typeof v === 'number') ? (range[1] as number) - (range[0] as number) : ys.length ? Math.max(...ys) - Math.min(...ys) : 1;
  const lines: string[] = [];
  let ok = r.data.fit === 'fits';
  if (!ok) lines.push('The checker finds no relation in the section that this graph can show.');
  // An answer that skips traces checked only some of them, so it cannot vouch for the graph.
  if (r.data.traces.length !== traces.length) {
    ok = false;
    lines.push(`The checker answered for ${r.data.traces.length} of ${traces.length} traces.`);
  }
  const fitted = new Map<string, { label: string; value: number }[]>();
  traces.forEach((tr, k) => {
    const answer = r.data.traces[k];
    if (!answer) return;
    const cmp = tr.kind === 'function' && !yLog && tr.x && tr.y ? compareExpected(answer.expected, tr.x, tr.y, yspan) : null;
    if (cmp && !cmp.ok) ok = false;
    for (const [name, value] of Object.entries(cmp?.constants ?? {})) fitted.set(name, [...(fitted.get(name) ?? []), { label: tr.label, value }]);
    if (answer.problem.trim()) ok = false;
    const parts = [cmp ? cmp.detail : answer.expected.trim() ? `expected ${answer.expected} (not compared)` : '', answer.problem.trim() ? `problem: ${answer.problem.trim()}` : ''].filter(Boolean);
    if (parts.length) lines.push(`"${tr.label}": ${parts.join('; ')}`);
  });
  // C, C1 and C2 stand for one value in the whole graph: fitted per trace, they would hide traces drawn in the wrong ratio.
  for (const [name, values] of fitted) {
    const first = values[0]!.value;
    const differs = values.some((v) => Math.abs(v.value - first) > 0.01 * Math.max(Math.abs(v.value), Math.abs(first)) && Math.max(Math.abs(v.value), Math.abs(first)) > 1e-12);
    if (!differs) continue;
    ok = false;
    lines.push(`${name} is fitted to ${values.map((v) => `${short(v.value)} on "${v.label}"`).join(', ')}: one constant has one value in a graph, so the traces are not in the ratio the section states.`);
  }
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

/** Saves an extra. A graph keeps its spec, the lint keys accepted for it and the section revision its checker read. */
export function saveEnrichment(ctx: AppContext, projectId: string, nodeId: string, kind: 'ide' | 'graph', payload: Record<string, unknown>, checks: { method: string; ok: boolean; detail: string }[], graph: { spec?: GraphSpec | null; lintAccepted?: string[]; checkedRevisionId?: string | null } = {}) {
  const ok = checks.every((c) => c.ok);
  ctx.db.insert('enrichments', { id: newId(), project_id: projectId, node_id: nodeId, kind, payload, status: ok ? 'verified' : 'issue', checks, spec: graph.spec ?? null, lint_accepted: graph.lintAccepted ?? [], checked_rev_id: graph.checkedRevisionId ?? null, created_at: now() });
  if (!ok) openCheckIssue(ctx, projectId, nodeId, kind, payload, checks);
  ctx.events.emit('enrichment.updated', { nodeId, kind }, { projectId });
}

/** A major issue for an extra that failed its check, which Fix sends to a redraw (graphs) and the author sees in Extras. */
export function openCheckIssue(ctx: AppContext, projectId: string, nodeId: string, kind: 'ide' | 'graph', payload: Record<string, unknown>, checks: { ok: boolean; detail: string }[]) {
  ctx.db.insert('review_issues', {
    id: newId(), project_id: projectId, node_id: nodeId, question_id: null, rev_id: null, source: 'verification', severity: 'major',
    category: kind, quote: String(payload.title ?? ''), message: `The ${kind === 'ide' ? `${LAB_NAME[payload.language === 'matlab' ? 'matlab' : 'python']} example` : 'graph'} failed its check: ${checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`,
    suggestion: 'Edit it in Extras or delete it.', status: 'open', resolution: '', created_at: now(),
  });
  ctx.events.emit('issue.created', { nodeId, severity: 'major' }, { projectId });
}

export { runPython };
