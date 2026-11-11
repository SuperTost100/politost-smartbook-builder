// Figures for sections that are already written: the text stays as it is, each figure goes in after the block it illustrates.
import { splitBlocks } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { bookFigureList, bookFigures, buildFigures, commitFigures, discardUnstored, existingAssetNames, rewriteImageRefs } from '../figures/materialize.ts';
import { photosAvailable } from '../figures/stock.ts';
import { runRole } from '../llm/index.ts';
import { currentHead } from '../repo/content.ts';
import { setIssuesStatus } from '../repo/issues.ts';
import type { TaskContext } from '../queue/queue.ts';
import { relint } from '../routes/views.ts';
import { commitAiRevision } from './draft.ts';
import { dropDecorative } from './figureCheck.ts';
import { figureSetupOf, figuresPassPrompt, figuresPassSchemaFor } from './prompts.ts';
import { findSection, loadOutline, loadProject, revisionForTask, truncate } from './util.ts';

/** Same limits as drafting: at most 3 figures in a section, at most 1 of them a photo. */
const MAX_FIGURES = 3;

const IMAGE_SRC = /^:::image\{[^}]*src="assets\/([^"]+)"/;

/**
 * The figures pass for one section. When Auto Fix routed review issues here (`issueIds` and a numbered `brief` in the input), the
 * issue text is the brief and each proposed figure says which issue it answers. An issue closes only when a figure that answers
 * it landed. The others stay open with the reason.
 */
export async function sectionFigures(ctx: AppContext, t: TaskContext) {
  const result = await figuresPass(ctx, t);
  const issueIds = (t.task.input.issueIds as string[] | undefined) ?? [];
  if (issueIds.length) {
    const r = result as { revId?: string; status?: string; answered?: number[]; reused?: boolean; skipped?: string; noFigureReason?: string; figureProblems?: string[] };
    const why = r.skipped ?? r.noFigureReason ?? (r.figureProblems?.length ? r.figureProblems.join('; ') : 'the figures pass proposed none');
    // A retry that finds its earlier result does not know which figures answered which issue.
    const answered = new Set(r.reused ? [] : r.answered ?? []);
    const hit = issueIds.filter((_, n) => answered.has(n + 1));
    const missed = issueIds.filter((id) => !hit.includes(id));
    if (hit.length) setIssuesStatus(ctx, t.task.projectId, hit, r.status === 'current' ? 'fixed' : 'proposed', r.status === 'current' ? `Figure added by the figures pass in revision ${r.revId}` : `Proposal ${r.revId}`);
    if (missed.length) setIssuesStatus(ctx, t.task.projectId, missed, 'open', hit.length ? 'No figure answered this issue: the figures pass added figures for the other issues only.' : r.reused ? 'An earlier attempt of this task stored its result, and which issue each figure answers was not kept.' : `No figure was added: ${why}`);
  }
  return result;
}

async function figuresPass(ctx: AppContext, t: TaskContext) {
  const { projectId } = t.task;
  const nodeId = t.task.input.nodeId as string;
  const mine = revisionForTask(ctx, projectId, nodeId, t.task.id);
  if (mine) return { revId: mine.id, status: mine.status, reused: true };
  const project = loadProject(ctx, projectId);
  if (!project.options.figures) return { skipped: 'figures are off for this book' };
  const outline = loadOutline(ctx, projectId);
  const found = outline ? findSection(outline.outline, nodeId) : null;
  const head = currentHead(ctx, projectId, nodeId);
  if (!found || !head) return { skipped: 'section not drafted' };

  const blocks = splitBlocks(head.markdown);
  const images = blocks.map((b) => IMAGE_SRC.exec(b.text)?.[1]).filter((f): f is string => !!f);
  const room = MAX_FIGURES - images.length;
  if (room <= 0) return { skipped: `the section already has ${images.length} figures` };
  const assets = images.length
    ? ctx.db.all<{ filename: string; origin: string; caption: string }>(`SELECT filename, origin, caption FROM assets WHERE project_id = ? AND filename IN (${images.map(() => '?').join(',')})`, projectId, ...images)
    : [];
  const photos = photosAvailable(ctx) && !assets.some((a) => a.origin === 'stock');
  const setup = figureSetupOf(project, photos);

  t.progress(`Looking for places for figures in "${found.section.title}"`);
  const { data, route } = await runRole(ctx, {
    role: 'writer',
    ...figuresPassPrompt({
      language: project.language, bookTitle: project.title, chapterTitle: found.chapter.title, sectionTitle: found.section.title,
      blocks: truncate(blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n\n'), 60_000),
      existing: assets.map((a) => `${a.origin}: ${a.caption}`).join('; '), room, figures: setup, elsewhere: bookFigureList(bookFigures(ctx, projectId, nodeId)),
      brief: typeof t.task.input.brief === 'string' ? t.task.input.brief : undefined,
    }),
    schema: figuresPassSchemaFor(setup), projectId, runId: t.task.runId, taskId: t.task.id, signal: t.signal,
  });
  t.setProvider(route.provider);
  const notes: string[] = [];
  const proposed = data.figures.filter((f) => {
    const ok = Number.isInteger(f.afterBlock) && f.afterBlock >= 1 && f.afterBlock <= blocks.length;
    if (!ok) notes.push(`${f.key}: block ${f.afterBlock} does not exist`);
    return ok;
  }).slice(0, room);
  if (!proposed.length) return { added: 0, figureProblems: notes, noFigureReason: data.noFigureReason ?? undefined, model: route.model };

  // A second model drops figures that decorate or do not match their passage, before any photo is searched or file drawn.
  const { kept, notes: dropped } = await dropDecorative(ctx, t, {
    projectId, language: project.language, figures: setup, proposed, blocks: blocks.map((b) => b.text), afterBlock: (f) => f.afterBlock,
  });
  notes.push(...dropped);
  if (!kept.length) return { added: 0, figureProblems: notes, model: route.model };

  const built = await buildFigures(ctx, {
    projectId, nodeId, language: project.language, figures: kept, photos, keepOwn: true,
    runId: t.task.runId, taskId: t.task.id, signal: t.signal, progress: (m) => t.progress(m),
  });
  notes.push(...built.notes);
  if (!built.assets.length) return { added: 0, figureProblems: notes, model: route.model };

  // Each image block goes in after its block; existing citations move with their blocks. Text is never rewritten.
  const existing = existingAssetNames(ctx, projectId);
  const after = new Map<number, string[]>();
  const answered = new Set<number>();
  const issueCount = Array.isArray(t.task.input.issueIds) ? t.task.input.issueIds.length : 0;
  for (const f of kept) {
    const block = rewriteImageRefs(`:::image{src="assets/${f.key}.svg"}\n:::`, built, existing);
    if (!block.trim()) continue;
    after.set(f.afterBlock, [...(after.get(f.afterBlock) ?? []), block.trim()]);
    // A figure without a valid number answers the only issue there is, and none of several.
    const n = f.issue ?? (issueCount === 1 ? 1 : 0);
    if (Number.isInteger(n) && n >= 1 && n <= issueCount) answered.add(n);
  }
  const texts: string[] = [];
  const citations: Record<string, string[]> = {};
  blocks.forEach((b, i) => {
    if (head.citations[String(i)]?.length) citations[String(texts.length)] = head.citations[String(i)];
    texts.push(b.text);
    texts.push(...(after.get(i + 1) ?? []));
  });

  let committed!: ReturnType<typeof commitAiRevision>;
  let stored: string[] = [];
  let saved = false;
  try {
    ctx.db.tx(() => {
      let markdown = texts.join('\n\n');
      ({ markdown, stored } = commitFigures(ctx, { projectId, nodeId, built, markdown, replace: false, replaced: [] }));
      // Applied when nobody edited the section meanwhile, otherwise a proposal.
      committed = commitAiRevision(ctx, { projectId, nodeId, kind: 'section', markdown, baseRevId: head.id, model: route.model, citations, runId: t.task.runId, taskId: t.task.id });
    });
    saved = true;
  } finally {
    discardUnstored(built, saved ? stored : []);
  }
  if (stored.length) ctx.events.emit('asset.updated', { nodeId, assetIds: stored }, { projectId });
  if (committed.status === 'current') relint(ctx, projectId, nodeId);
  return { revId: committed.revId, status: committed.status, added: stored.length, ...(issueCount ? { answered: [...answered].sort((a, b) => a - b) } : {}), figureProblems: notes, model: route.model };
}

