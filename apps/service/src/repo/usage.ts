import type { UsageRow } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import type { Rec } from './util.ts';

/** Calls and summed tokens per provider, model and role. A total stays null when any call did not report that count. */
export function usageForRun(ctx: AppContext, runId: string): UsageRow[] {
  return ctx.db.all<Rec>(`
    SELECT provider, model, role, COUNT(*) AS calls,
      CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END AS input_tokens,
      CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END AS output_tokens
    FROM usage WHERE run_id = ? GROUP BY provider, model, role ORDER BY provider, model, role`, runId)
    .map((r) => ({
      provider: r.provider, model: r.model, role: r.role, calls: Number(r.calls),
      inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
      outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
    }));
}
