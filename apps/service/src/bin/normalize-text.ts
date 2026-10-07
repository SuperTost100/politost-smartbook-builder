// Mechanical text repair: npm run normalize-text -- --project <id> [--data-dir <dir>]
// Display math that shares a block with inline math is moved to blocks of its own (or made inline in lists), without a model.
// Safe while the service runs: the database is in WAL mode and each section is one short transaction.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { separateDisplayMath } from '@smartbuilder/content';
import { parseArgs, paths } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import { currentHeads, getProject, repairHead, repairQuestionText } from '../repo/index.ts';
import { relint } from '../routes/views.ts';

/** Rewrites the sections (and chapter introductions) and the questions of a project that the fix changes. */
export function normalizeText(ctx: AppContext, projectId: string): { sections: number; questions: number } {
  getProject(ctx, projectId);
  let sections = 0;
  for (const nodeId of currentHeads(ctx, projectId).keys()) {
    if (!repairHead(ctx, projectId, nodeId, separateDisplayMath)) continue;
    relint(ctx, projectId, nodeId);
    sections++;
  }
  let questions = 0;
  for (const { id } of ctx.db.all<{ id: string }>('SELECT id FROM questions WHERE project_id = ?', projectId)) if (repairQuestionText(ctx, id, separateDisplayMath)) questions++;
  return { sections, questions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const projectId = args[args.indexOf('--project') + 1];
  if (!args.includes('--project') || !projectId || projectId.startsWith('--')) {
    console.log('Usage: npm run normalize-text -- --project <id> [--data-dir dir]');
    process.exit(1);
  }
  const config = parseArgs(args);
  if (!existsSync(paths.db(config))) {
    console.error(`No database in ${config.dataDir}.`);
    process.exit(1);
  }
  const ctx = createContext(config);
  try {
    const { sections, questions } = normalizeText(ctx, projectId);
    console.log(`Changed ${sections} sections and ${questions} questions.`);
  } finally {
    ctx.db.close();
  }
}
