// Draft: evidence per section, the section text with figures, then the chapter introduction.
import { lintSection, renderPlotSvg, splitBlocks, validatePlotSpec, type LintFinding } from '@smartbuilder/content';
import type { EvidencePacket } from '@smartbuilder/domain';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, resolveDataPath, toDataPath } from '../config.ts';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { gatherEvidence, transcribePage } from '../evidence/index.ts';
import { runRole } from '../llm/index.ts';
import { insertProposal } from '../repo/content.ts';
import { TaskError, type TaskContext } from '../queue/queue.ts';
import { draftPrompt, draftSchema, introPrompt, repairPrompt, repairSchema } from './prompts.ts';
import { chapterPlanText, extractCitations, findSection, formulaKeyLabels, headRevision, loadOutline, loadProject, loadTopics, revisionForTask, truncate } from './util.ts';

const MAX_TRANSCRIBED_PAGES = 4;

export async function sectionEvidence(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const found = outline && findSection(outline.outline, nodeId);
  if (!found) return { skipped: 'section not in the approved outline' };
  const topics = loadTopics(ctx, projectId).filter((tp) => found.section.topicIds.includes(tp.id));
  const theory = ctx.db.all<{ id: string }>(`SELECT id FROM resources WHERE project_id = ? AND included = 1 AND status = 'ready' AND role IN ('theory', 'mixed')`, projectId).map((r) => r.id);
  const it = project.language === 'it';
  const query = [
    it ? `Sezione del libro: "${found.section.title}" (capitolo "${found.chapter.title}").` : `Book section: "${found.section.title}" (chapter "${found.chapter.title}").`,
    it ? 'Obiettivi:' : 'Objectives:', ...found.section.objectives.map((o) => `- ${o}`),
    topics.length ? (it ? `Argomenti: ${topics.map((tp) => tp.name).join('; ')}.` : `Topics: ${topics.map((tp) => tp.name).join('; ')}.`) : '',
    it
      ? 'Riporta, citando testualmente le fonti, le definizioni, gli enunciati dei teoremi con tutte le ipotesi, le formule principali, gli esempi svolti e le osservazioni sugli errori tipici relativi a questa sezione.'
      : 'Quoting the sources verbatim, give the definitions, theorem statements with all hypotheses, main formulas, worked examples and remarks on typical mistakes for this section.',
  ].filter(Boolean).join('\n');

  const packet = await gatherEvidence(ctx, {
    projectId, nodeId, query, resourceIds: theory,
    pageHints: topics.flatMap((tp) => tp.sources).filter((s) => theory.includes(s.resourceId)),
    runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  }, { force: !!t.task.input.force });

  // Clean math for the pages the writer will lean on most.
  const pages = topCitedPages(packet).slice(0, MAX_TRANSCRIBED_PAGES);
  for (const p of pages) {
    const q = ctx.db.get<{ quality: string; transcript: string | null }>('SELECT quality, transcript FROM pages WHERE resource_id = ? AND idx = ?', p.resourceId, p.idx);
    if (q && q.quality !== 'good' && !q.transcript) {
      t.progress(`Reading page ${p.idx + 1} with the vision model`);
      await transcribePage(ctx, p.resourceId, p.idx, { signal: t.signal, runId: t.task.runId, taskId: t.task.id });
    }
  }
  return { packetId: packet.id, notes: packet.notes.length, verified: packet.notes.filter((n) => n.verified).length, provider: packet.provider };
}

function topCitedPages(packet: EvidencePacket) {
  const count = new Map<string, { resourceId: string; idx: number; n: number }>();
  for (const n of packet.notes) {
    if (!n.verified || n.resourceId === null || n.page === null) continue;
    const k = `${n.resourceId}:${n.page}`;
    const e = count.get(k) ?? { resourceId: n.resourceId, idx: n.page, n: 0 };
    e.n++;
    count.set(k, e);
  }
  return [...count.values()].sort((a, b) => b.n - a.n);
}

function latestPacket(ctx: AppContext, projectId: string, nodeId: string): EvidencePacket | null {
  const r = ctx.db.get('SELECT * FROM evidence_packets WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1', projectId, nodeId);
  if (!r) return null;
  return { id: r.id as string, projectId, nodeId, provider: r.provider as EvidencePacket['provider'], query: r.query as string, answer: r.answer as string, notes: json(r.notes, []), createdAt: r.created_at as string };
}

export function evidenceText(ctx: AppContext, packet: EvidencePacket | null, maxChars = 24_000) {
  if (!packet) return { notes: '', pages: '', summary: '' };
  const files = new Map(ctx.db.all<{ id: string; filename: string }>('SELECT id, filename FROM resources WHERE project_id = ?', packet.projectId).map((r) => [r.id, r.filename]));
  const notes = packet.notes.filter((n) => n.verified).map((n) => {
    const where = n.resourceId ? `${files.get(n.resourceId) ?? '?'}, p. ${n.page !== null ? n.page + 1 : '?'}` : 'source';
    return `[${n.id}] (${where}) "${truncate(n.quote.replace(/\s+/g, ' '), 700)}"${n.claim ? `\n    supports: ${truncate(n.claim, 300)}` : ''}`;
  }).join('\n');
  const pageTexts = topCitedPages(packet).slice(0, MAX_TRANSCRIBED_PAGES).map((p) => {
    const row = ctx.db.get<{ text: string; transcript: string | null; label: string }>('SELECT text, transcript, label FROM pages WHERE resource_id = ? AND idx = ?', p.resourceId, p.idx);
    if (!row) return '';
    return `--- ${files.get(p.resourceId)}, page ${row.label} ---\n${truncate(row.transcript || row.text, 6000)}`;
  }).filter(Boolean).join('\n\n');
  // The evidence reader's own answer often has the formulas in clean LaTeX, while quotes from the text layer do not.
  const summary = truncate(packet.answer.replace(/<!--[\s\S]*?-->/g, '').trim(), 10_000);
  return { notes: truncate(notes, maxChars), pages: truncate(pageTexts, maxChars), summary };
}

/**
 * Commit AI text: becomes current if nobody edited since baseRevId, otherwise (or with forceProposal) a proposal whose
 * parent is baseRevId. One implementation with the repo (older pending proposals of the node become 'superseded').
 * `taskId` is stored so a retried task returns its own committed revision instead of calling the model again.
 */
export function commitAiRevision(ctx: AppContext, p: { projectId: string; nodeId: string; kind: 'section' | 'chapter-intro'; markdown: string; baseRevId: string | null; model: string; origin?: 'ai' | 'repair'; citations?: Record<string, string[]>; forceProposal?: boolean; runId?: string; taskId?: string }) {
  return ctx.db.tx(() => {
    const { revision, applied } = insertProposal(ctx, p.projectId, p.nodeId, p.markdown, p.baseRevId, p.origin ?? 'ai', p.model, p.citations ?? {}, { kind: p.kind, forceProposal: p.forceProposal, taskId: p.taskId });
    ctx.events.emit(applied ? 'content.saved' : 'proposal.created', { nodeId: p.nodeId, revId: revision.id, origin: p.origin ?? 'ai' }, { projectId: p.projectId, runId: p.runId ?? null });
    return { revId: revision.id, status: applied ? 'current' as const : 'proposal' as const };
  });
}

/** Replace a node's open lint issues with fresh findings. */
export function recordLintIssues(ctx: AppContext, projectId: string, nodeId: string, revId: string, findings: LintFinding[]) {
  ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM review_issues WHERE project_id = ? AND node_id = ? AND source = 'lint' AND status = 'open'`, projectId, nodeId);
    for (const f of findings) {
      ctx.db.insert('review_issues', {
        id: newId(), project_id: projectId, node_id: nodeId, question_id: null, rev_id: revId, source: 'lint', severity: f.severity,
        category: f.rule, quote: f.quote ?? '', message: f.message, suggestion: '', status: 'open', resolution: '', created_at: now(),
      });
    }
  });
}

/** Known formula keys across the book (current revisions), excluding one node. */
export function bookFormulaKeys(ctx: AppContext, projectId: string, excludeNode?: string) {
  const rows = ctx.db.all<{ node_id: string; markdown: string }>(`SELECT node_id, markdown FROM content_revisions WHERE project_id = ? AND status = 'current'`, projectId);
  return rows.filter((r) => r.node_id !== excludeNode).flatMap((r) => formulaKeyLabels(r.markdown));
}

export async function sectionDraft(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  // Checkpoint: this task already committed its text in an earlier attempt.
  const mine = revisionForTask(ctx, projectId, nodeId, t.task.id);
  if (mine) return { revId: mine.id, nodeId, status: mine.status, reused: true };
  const head = headRevision(ctx, projectId, nodeId);
  // Never overwrite existing text during a full generation run; regeneration uses section.revise.
  if (head && !t.task.input.force) return { revId: head.id, reused: true };
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const found = outline && findSection(outline.outline, nodeId);
  if (!found) return { skipped: 'section not in the approved outline' };
  const { chapter, section } = found;
  const topics = loadTopics(ctx, projectId).filter((tp) => section.topicIds.includes(tp.id));
  const sessions = ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT exam_group) AS n FROM questions WHERE project_id = ? AND kind = 'exam'`, projectId)?.n ?? 0;
  const ev = evidenceText(ctx, latestPacket(ctx, projectId, nodeId));

  // Continuity: summaries of earlier sections (recorded by their draft tasks) and outline titles.
  const earlier: string[] = [];
  for (const c of outline.outline.chapters) {
    for (const s of c.sections) {
      if (s.id === nodeId) break;
      const done = ctx.db.get<{ result: string }>(`SELECT result FROM tasks WHERE project_id = ? AND kind = 'section.draft' AND state = 'succeeded' AND json_extract(input, '$.nodeId') = ? ORDER BY finished_at DESC LIMIT 1`, projectId, s.id);
      const summary = done ? json<{ summary?: string }>(done.result, {}).summary : undefined;
      if (summary || c.id === chapter.id) earlier.push(`- ${s.title} [${s.id}]${summary ? `: ${summary}` : ''}`);
    }
    if (c.id === chapter.id) break;
  }
  const known = bookFormulaKeys(ctx, projectId, nodeId);
  const sectionIds = outline.outline.chapters.flatMap((c) => c.sections.map((s) => `${s.id}: ${s.title}`)).join('\n');

  const prompt = draftPrompt({
    language: project.language, bookTitle: project.title, audience: project.audience, notation: outline.outline.notation,
    chapterTitle: chapter.title, chapterPlan: chapterPlanText(chapter, nodeId),
    section: { id: section.id, title: section.title, objectives: section.objectives, depth: section.depth, subsections: section.subsections.map((s) => `${s.title} (${s.objectives.join('; ')})`).join(' | ') },
    topics: topics.map((tp) => `- ${tp.name}: ${tp.examSessions} of ${sessions} exam sessions${tp.priority === 'high' ? ' (high priority)' : ''}`).join('\n') || '(none)',
    earlier: earlier.join('\n'), knownFormulas: known.map((k) => `${k.key}: ${k.label}`).join('\n'), sectionIds,
    evidence: ev.notes, pages: ev.pages, summary: ev.summary, figures: project.options.figures, outside: project.options.outsideMaterial,
  });
  t.progress(`Writing "${section.title}"`);
  const { data, route } = await runRole(ctx, { role: 'writer', ...prompt, schema: draftSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
  t.setProvider(route.provider);

  let { markdown, citations } = extractCitations(data.markdown, splitBlocks);
  const knownKeys = new Set([...known.map((k) => k.key), ...formulaKeyLabels(markdown).map((k) => k.key)]);

  // Figures: render plots deterministically; drop image blocks whose plot is invalid. File names are scoped to the
  // section (`<node>-<key>.svg`) so two sections can use the same figure key without touching each other's drawing.
  const figureNotes: string[] = [];
  const assetDir = paths.assets(ctx.config, projectId);
  mkdirSync(assetDir, { recursive: true });
  const prefix = nodeId.slice(0, 8);
  const cleanKey = (key: string) => key.replace(/[^a-z0-9-]/g, '-').slice(0, 50);
  const renames = new Map<string, string>(); // name the model wrote -> stored name
  const newAssets: { id: string; file: string; row: Record<string, unknown> }[] = [];
  for (const fig of data.figures ?? []) {
    const wrote = [`${fig.key}.svg`, `${cleanKey(fig.key)}.svg`];
    const stored = `${prefix}-${cleanKey(fig.key)}.svg`;
    const spec = {
      xRange: fig.plot.xRange, yRange: fig.plot.yRange, xLabel: fig.plot.xLabel ?? undefined, yLabel: fig.plot.yLabel ?? undefined,
      functions: fig.plot.functions.map((f) => ({ expr: f.expr, label: f.label ?? undefined, domain: f.domain ?? undefined, style: f.style ?? undefined })),
      points: (fig.plot.points ?? []).map((pt) => ({ x: pt.x, y: pt.y, label: pt.label ?? undefined, open: pt.open ?? undefined })),
      asymptotes: (fig.plot.asymptotes ?? []).map((a) => ({ kind: a.kind, value: a.value, label: a.label ?? undefined })),
    };
    const v = validatePlotSpec(spec);
    if (!v.ok) {
      for (const w of wrote) markdown = removeImageBlock(markdown, w);
      figureNotes.push(`${stored}: ${v.errors.join('; ')}`);
      continue;
    }
    if (newAssets.some((a) => a.row.filename === stored)) continue;
    const assetId = newId();
    const file = join(assetDir, `${assetId}.svg`);
    writeFileSync(`${file}.tmp`, renderPlotSvg(v.spec));
    renameSync(`${file}.tmp`, file);
    for (const w of wrote) renames.set(w, stored);
    newAssets.push({
      id: assetId, file,
      row: {
        id: assetId, project_id: projectId, node_id: nodeId, filename: stored, mime: 'image/svg+xml', path: toDataPath(ctx.config, file), origin: 'plot', spec: v.spec,
        caption: fig.caption, alt: fig.alt, checks: [{ method: 'lint', ok: true, detail: 'Plot rendered from a validated spec.' }], created_at: now(),
      },
    });
  }
  // Image blocks without a rendered figure would be broken references; the others point at the stored names.
  for (const m of [...markdown.matchAll(/:::image\{[^}]*src="assets\/([^"]+)"/g)]) if (!renames.has(m[1])) markdown = removeImageBlock(markdown, m[1]);
  markdown = markdown.replace(/(:::image\{[^}]*src="assets\/)([^"]+)(")/g, (all, a: string, name: string, c: string) => (renames.has(name) ? `${a}${renames.get(name)}${c}` : all));
  const figureFiles = new Set(newAssets.map((a) => a.row.filename as string));

  // One repair round for problems that break rendering or meaning.
  let findings = lintSection(markdown, { sectionId: nodeId, language: project.language, knownFormulaKeys: knownKeys });
  const serious = findings.filter((f) => f.severity !== 'minor');
  if (serious.length) {
    t.progress(`Fixing ${serious.length} formatting problems`);
    const listing = serious.map((f) => `${f.rule}: ${f.message}${f.line ? ` (line ${f.line})` : ''}${f.quote ? ` — "${truncate(f.quote, 160)}"` : ''}`).join('\n');
    try {
      const fix = await runRole(ctx, { role: 'writer', ...repairPrompt({ language: project.language, markdown: withMarkers(markdown, citations), findings: listing }), schema: repairSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal });
      const repaired = extractCitations(fix.data.markdown, splitBlocks);
      const after = lintSection(repaired.markdown, { sectionId: nodeId, language: project.language, knownFormulaKeys: new Set([...known.map((k) => k.key), ...formulaKeyLabels(repaired.markdown).map((k) => k.key)]) });
      if (after.filter((f) => f.severity !== 'minor').length < serious.length) {
        markdown = repaired.markdown;
        citations = repaired.citations;
        findings = after;
      }
    } catch (err) {
      if (err instanceof TaskError && err.kind !== 'input') throw err;
    }
  }

  // Files are on disk; the asset rows and the revision become visible together, or not at all.
  let committed!: ReturnType<typeof commitAiRevision>;
  const replaced: string[] = [];
  try {
    ctx.db.tx(() => {
      for (const a of newAssets) {
        const old = ctx.db.all<{ id: string; path: string }>('SELECT id, path FROM assets WHERE project_id = ? AND node_id = ? AND filename = ?', projectId, nodeId, a.row.filename as string);
        for (const o of old) { ctx.db.run('DELETE FROM assets WHERE id = ?', o.id); replaced.push(o.path); }
        ctx.db.insert('assets', a.row);
      }
      committed = commitAiRevision(ctx, { projectId, nodeId, kind: 'section', markdown, baseRevId: head?.id ?? null, model: route.model, citations, runId: t.task.runId, taskId: t.task.id });
      recordLintIssues(ctx, projectId, nodeId, committed.revId, findings);
    });
  } catch (err) {
    for (const a of newAssets) rmSync(a.file, { force: true });
    throw err;
  }
  for (const old of replaced) rmSync(resolveDataPath(ctx.config, old), { force: true });
  return { revId: committed.revId, nodeId, status: committed.status, summary: data.summary, figures: figureFiles.size, figureProblems: figureNotes, findings: findings.length, model: route.model };
}

/** Puts [[nX]] citation markers back after their blocks (inverse of extractCitations). */
export function withMarkers(markdown: string, citations: Record<string, string[]>) {
  return splitBlocks(markdown).map((b, i) => (citations[String(i)]?.length ? `${b.text} [[${citations[String(i)].join(',')}]]` : b.text)).join('\n\n');
}

function removeImageBlock(markdown: string, filename: string) {
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return markdown.replace(new RegExp(`:::image\\{[^}]*src="assets/${esc}"[^}]*\\}\\s*\\n:::\\s*\\n?`, 'g'), '').replace(new RegExp(`:::image\\{[^}]*src="assets/${esc}"[^}]*\\}\\s*\\n?`, 'g'), '');
}

export async function chapterIntro(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const chapterId = t.task.input.chapterId as string;
  const mine = revisionForTask(ctx, projectId, chapterId, t.task.id);
  if (mine) return { revId: mine.id, reused: true };
  const head = headRevision(ctx, projectId, chapterId);
  if (head && !t.task.input.force) return { revId: head.id, reused: true };
  const project = loadProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId);
  const chapter = outline?.outline.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { skipped: true };
  const summaries = chapter.sections.map((s) => {
    const r = Object.values(t.deps).find((d) => (d as { revId?: string })?.revId && (d as { nodeId?: string }).nodeId === s.id) as { summary?: string } | undefined;
    const done = r ?? json<{ summary?: string }>(ctx.db.get<{ result: string }>(`SELECT result FROM tasks WHERE project_id = ? AND kind = 'section.draft' AND state = 'succeeded' AND json_extract(input, '$.nodeId') = ? ORDER BY finished_at DESC LIMIT 1`, projectId, s.id)?.result, {});
    return `- ${s.title}: ${done.summary ?? s.objectives.join('; ')}`;
  }).join('\n');
  const { data, route } = await runRole(ctx, {
    role: 'writer', ...introPrompt({ language: project.language, chapterTitle: chapter.title, objectives: chapter.objectives, prerequisites: chapter.prerequisites, summaries }),
    schema: repairSchema, projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  const { markdown } = extractCitations(data.markdown, splitBlocks);
  const committed = commitAiRevision(ctx, { projectId, nodeId: chapterId, kind: 'chapter-intro', markdown, baseRevId: head?.id ?? null, model: route.model, runId: t.task.runId, taskId: t.task.id });
  recordLintIssues(ctx, projectId, chapterId, committed.revId, lintSection(markdown, { sectionId: chapterId, language: project.language }));
  return { revId: committed.revId };
}
