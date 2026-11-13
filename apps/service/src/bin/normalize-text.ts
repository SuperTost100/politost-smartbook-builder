// Mechanical text repair: npm run normalize-text -- --project <id> [--dry-run] [--include-hand-edits] [--data-dir <dir>]
// Runs the formatter (`formatModelText`) on the model-written text of a project, without a model: tool-call markup goes, function
// names KaTeX lacks are rewritten, every heading of a section becomes ###, and display math gets its layout (no blank line
// inside $$, display math separated from inline math).
// A section whose current text the author wrote or edited by hand, and a question the author edited, are left alone and counted,
// unless --include-hand-edits is given. --dry-run changes nothing and lists what a real run would change.
// Safe while the service runs: the database is in WAL mode and each section is one short transaction.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatModelText } from '@smartbuilder/content';
import { parseArgs, paths } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import { findSection, loadOutline } from '../pipeline/util.ts';
import { currentHeads, getProject, listQuestions, repairHead, repairQuestionText } from '../repo/index.ts';
import { relint } from '../routes/views.ts';

export interface NormalizeResult {
  /** Sections (and chapter introductions) changed, or that a dry run would change. */
  sections: number;
  questions: number;
  /** Sections and questions with hand edits that were left alone, whether or not they would have changed. */
  handEdited: number;
  /** What changed, one line each: the title of a section, "Introduction of <chapter>", or "Question <number>". */
  changed: string[];
}

/** Rewrites the sections (and chapter introductions) and the questions of a project that the formatter changes. */
export function normalizeText(ctx: AppContext, projectId: string, opts: { dryRun?: boolean; handEdits?: boolean } = {}): NormalizeResult {
  getProject(ctx, projectId);
  const outline = loadOutline(ctx, projectId, true)?.outline;
  const nameOf = (nodeId: string) => {
    const found = outline && findSection(outline, nodeId);
    if (found) return `${found.chapter.title}: ${found.section.title}`;
    const chapter = outline?.chapters.find((c) => c.id === nodeId);
    return chapter ? `Introduction of ${chapter.title}` : nodeId;
  };
  const out: NormalizeResult = { sections: 0, questions: 0, handEdited: 0, changed: [] };
  for (const [nodeId, head] of currentHeads(ctx, projectId)) {
    if (head.origin === 'human' && !opts.handEdits) { out.handEdited++; continue; }
    if (opts.dryRun ? formatModelText(head.markdown) === head.markdown : !repairHead(ctx, projectId, nodeId, (md) => formatModelText(md))) continue;
    if (!opts.dryRun) relint(ctx, projectId, nodeId);
    out.sections++;
    out.changed.push(nameOf(nodeId));
  }
  const edited = new Set(ctx.db.all<{ id: string }>('SELECT id FROM questions WHERE project_id = ? AND edited_at IS NOT NULL', projectId).map((r) => r.id));
  const format = (text: string) => formatModelText(text, { kind: 'question' });
  for (const q of listQuestions(ctx, projectId)) {
    if (edited.has(q.id) && !opts.handEdits) { out.handEdited++; continue; }
    const changes = opts.dryRun ? [q.statement, q.hint, q.solution].some((t) => format(t) !== t) : repairQuestionText(ctx, q.id, format);
    if (!changes) continue;
    out.questions++;
    out.changed.push(`Question ${q.number ?? q.id.slice(0, 8)}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const projectId = args[args.indexOf('--project') + 1];
  if (!args.includes('--project') || !projectId || projectId.startsWith('--')) {
    console.log('Usage: npm run normalize-text -- --project <id> [--dry-run] [--include-hand-edits] [--data-dir dir]');
    process.exit(1);
  }
  const config = parseArgs(args);
  if (!existsSync(paths.db(config))) {
    console.error(`No database in ${config.dataDir}.`);
    process.exit(1);
  }
  const ctx = createContext(config);
  try {
    const dryRun = args.includes('--dry-run');
    const r = normalizeText(ctx, projectId, { dryRun, handEdits: args.includes('--include-hand-edits') });
    for (const line of r.changed) console.log(`${dryRun ? 'Would change' : 'Changed'}: ${line}`);
    console.log(`${dryRun ? 'Would change' : 'Changed'} ${r.sections} sections and ${r.questions} questions.`);
    if (r.handEdited) console.log(`Left ${r.handEdited} hand-edited sections and questions alone. --include-hand-edits includes them.`);
  } finally {
    ctx.db.close();
  }
}
