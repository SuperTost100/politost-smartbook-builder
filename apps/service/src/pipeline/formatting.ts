// Formatting findings are settled by code, never by a model: the formatter runs on the current text, the lint runs again, and
// each issue closes when its rule no longer finds anything. What the formatter cannot change stays open with a plain reason.
import { formatModelText, formatterHandles, lintQuestionText, lintSection, type LintFinding, type TextKind } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { getQuestion, issuesChanged, repairQuestionText, rewriteHead } from '../repo/index.ts';
import { knownFormulaKeys, relint } from '../routes/views.ts';

interface FormatIssue { id: string; category: string; source: string; severity: string; status: string }

/** An open lint issue about a rule the formatter settles. */
export const isFormatIssue = (i: FormatIssue, kind: TextKind): boolean => i.source === 'lint' && formatterHandles(i.category, i.severity, kind);

const ruleOf = (category: string) => category.replace(/^compile:/, '');

/** The first message of each formatting rule that still finds something. */
function remaining(findings: LintFinding[], kind: TextKind): Map<string, string> {
  const left = new Map<string, string>();
  for (const f of findings) if (formatterHandles(f.rule, f.severity, kind) && !left.has(f.rule)) left.set(f.rule, f.message);
  return left;
}

/** Closes the issues whose rule finds nothing any more, with `fixed` as the resolution, and gives the others the reason. Returns how many closed. */
function settle(ctx: AppContext, projectId: string, issues: FormatIssue[], left: Map<string, string>, fixed: string): number {
  let closed = 0;
  ctx.db.tx(() => {
    for (const i of issues) {
      const message = left.get(ruleOf(i.category));
      if (message === undefined) {
        ctx.db.run(`UPDATE review_issues SET status = 'fixed', resolution = ? WHERE id = ?`, fixed, i.id);
        closed++;
      } else ctx.db.run(`UPDATE review_issues SET status = 'open', resolution = ? WHERE id = ?`, `The formatter could not fix this, so it stays open for you to edit by hand: ${message}`, i.id);
    }
  });
  issuesChanged(ctx, projectId, issues.map((i) => i.id));
  return closed;
}

/**
 * Settles the open formatting issues of a section with no model call. The formatter runs on the head; a changed text becomes a
 * new current revision (origin "repair", no model) and the lint issues of the section are made again from it, with the reason
 * of each issue left open put back on its new row.
 */
export function settleSectionFormatting(ctx: AppContext, p: { projectId: string; nodeId: string; language: string; head: { id: string; markdown: string }; issues: FormatIssue[]; /** Other open issues of the same fix: the new lint run keeps their rows. */ keep?: string[] }): { revId: string | null; markdown: string; closed: number } {
  const { projectId, nodeId, head } = p;
  const issues = p.issues.filter((i) => i.status === 'open');
  if (!issues.length) return { revId: null, markdown: head.markdown, closed: 0 };
  const formatted = formatModelText(head.markdown);
  // The head was read in this same step, so a conflict means another save came in between: nothing is settled and the issues stay as they are.
  const revision = formatted === head.markdown ? null : rewriteHead(ctx, projectId, nodeId, () => formatted, { origin: 'repair', expectedHeadId: head.id });
  const left = remaining(lintSection(formatted, { sectionId: nodeId, language: p.language, knownFormulaKeys: knownFormulaKeys(ctx, projectId) }), 'section');
  const closed = settle(ctx, projectId, issues, left, revision ? `Fixed by the formatter in revision ${revision.id}` : 'The text already has it right, so nothing was changed.');
  if (revision) {
    relint(ctx, projectId, nodeId, p.keep);
    for (const [rule, message] of left) {
      ctx.db.run(`UPDATE review_issues SET resolution = ? WHERE project_id = ? AND node_id = ? AND source = 'lint' AND status = 'open' AND category = ? AND resolution = ''`, `The formatter could not fix this, so it stays open for you to edit by hand: ${message}`, projectId, nodeId, rule);
    }
  }
  return { revId: revision?.id ?? null, markdown: formatted, closed };
}

/** The same for the issues of a question: statement, hint and solution are formatted, the check and the status stay because the mathematics does not change. */
export function settleQuestionFormatting(ctx: AppContext, p: { projectId: string; questionId: string; language: string; issues: FormatIssue[] }): { changed: boolean; closed: number } {
  const issues = p.issues.filter((i) => i.status === 'open');
  if (!issues.length) return { changed: false, closed: 0 };
  const changed = repairQuestionText(ctx, p.questionId, (text) => formatModelText(text, { kind: 'question' }));
  const q = getQuestion(ctx, p.questionId);
  const left = remaining((['statement', 'hint', 'solution'] as const).flatMap((part) => lintQuestionText(q[part], { file: part, language: p.language, skipRules: ['formula-ref-unknown'] })), 'question');
  const closed = settle(ctx, p.projectId, issues, left, changed ? 'Fixed by the formatter.' : 'The text already has it right, so nothing was changed.');
  return { changed, closed };
}
