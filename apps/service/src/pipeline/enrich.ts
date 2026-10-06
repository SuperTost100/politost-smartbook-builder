// Extras: the bulk model picks where graphs and Python examples help; the writer creates them; we check them.
import { sampleFunctionGraph } from '@smartbuilder/content';
import { Worker } from 'node:worker_threads';
import type { AppContext } from '../context.ts';
import { newId, now, json } from '../db/db.ts';
import { runRole } from '../llm/index.ts';
import type { TaskContext } from '../queue/queue.ts';
import { enrichPickPrompt, enrichPickSchema, graphPrompt, graphSchema, idePrompt, ideSchema } from './prompts.ts';
import { headRevision, loadOutline, loadProject, truncate } from './util.ts';

export async function chapterEnrich(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const project = loadProject(ctx, projectId);
  if (!project.options.graphs && !project.options.ide) return { skipped: 'disabled' };
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true };
  const existing = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM enrichments WHERE project_id = ? AND node_id IN (${chapter.sections.map(() => '?').join(',')})`, projectId, ...chapter.sections.map((s) => s.id));
  if (existing && existing.n > 0 && !t.task.input.force) return { reused: existing.n };

  const sections = chapter.sections.map((s) => {
    const head = headRevision(ctx, projectId, s.id);
    return { id: s.id, title: s.title, text: head?.markdown ?? '' };
  }).filter((s) => s.text);
  const { data } = await runRole(ctx, {
    role: 'bulk', ...enrichPickPrompt({ sections: sections.map((s) => `${s.id} | ${s.title} | ${truncate(s.text.replace(/\s+/g, ' '), 600)}`).join('\n'), graphs: project.options.graphs, ide: project.options.ide }),
    schema: enrichPickSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const byId = new Map(sections.map((s) => [s.id, s]));
  let made = 0;
  for (const pick of project.options.graphs ? data.graphs.slice(0, 2) : []) {
    const s = byId.get(pick.sectionId);
    if (!s) continue;
    const g = await runRole(ctx, { role: 'writer', ...graphPrompt({ language: project.language, purpose: pick.purpose, section: truncate(s.text, 8000) }), schema: graphSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
    const sampled = sampleFunctionGraph({
      id: g.data.id, title: g.data.title, xDomain: g.data.xDomain, yDomain: g.data.yDomain, xLabel: g.data.xLabel, yLabel: g.data.yLabel,
      functions: g.data.functions.map((f) => ({ expr: f.fn, label: f.label })),
    });
    saveEnrichment(ctx, projectId, s.id, 'graph', sampled.payload, [{ method: 'numeric', ok: sampled.ok, detail: `${g.data.description}\n${sampled.detail}` }]);
    made++;
  }
  for (const pick of project.options.ide ? data.ide.slice(0, 1) : []) {
    const s = byId.get(pick.sectionId);
    if (!s) continue;
    const g = await runRole(ctx, { role: 'writer', ...idePrompt({ language: project.language, purpose: pick.purpose, section: truncate(s.text, 8000) }), schema: ideSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
    const payload = { id: g.data.id, title: g.data.title, language: 'python', description: g.data.description, code: g.data.code };
    t.progress('Running the Python example');
    const run = await runPython(g.data.code, 20_000);
    const ok = run.ok && run.stdout.trim().length > 0;
    saveEnrichment(ctx, projectId, s.id, 'ide', payload, [{ method: 'numeric', ok, detail: ok ? `Ran in Pyodide ${run.version}. Output:\n${truncate(run.stdout, 800)}` : `Did not run: ${run.error ?? 'no output'}` }]);
    made++;
  }
  return { made };
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
  }
}

/**
 * Runs Python in Pyodide inside a worker thread with a hard timeout. Pyodide is WebAssembly: the code has no access to
 * the host filesystem or network beyond what we pass in (we pass nothing), and terminating the worker frees everything.
 */
export function runPython(code: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; error?: string; version: string }> {
  const src = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { loadPyodide } = await import('pyodide');
      const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
      let out = '';
      py.setStdout({ batched: (s) => { out += s + '\\n'; } });
      py.setStderr({ batched: (s) => { out += s + '\\n'; } });
      try {
        // Block modules that reach outside the sandbox.
        py.runPython("import sys\\nfor m in ['js','pyodide.http','micropip','socket','urllib.request']: sys.modules[m] = None");
        py.runPython(workerData.code);
        parentPort.postMessage({ ok: true, stdout: out, version: py.version });
      } catch (e) {
        parentPort.postMessage({ ok: false, stdout: out, error: String(e && e.message || e).slice(-1500), version: py.version });
      }
    })().catch((e) => parentPort.postMessage({ ok: false, stdout: '', error: String(e), version: 'unavailable' }));`;
  return new Promise((resolve) => {
    const w = new Worker(src, { eval: true, workerData: { code }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const timer = setTimeout(() => { void w.terminate(); resolve({ ok: false, stdout: '', error: `Timed out after ${timeoutMs / 1000} s`, version: '?' }); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(timer); void w.terminate(); resolve(m); });
    w.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, stdout: '', error: e.message, version: '?' }); });
  });
}

export { json };
