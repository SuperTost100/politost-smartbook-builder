import type { ProviderUsage, UsageRow, UsageSummary } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import type { Rec } from './util.ts';

/** Calls and summed tokens per provider, model and role. A total stays null when any call did not report that count, except the cached tokens, which are the sum of those that were reported. */
export function usageForRun(ctx: AppContext, runId: string): UsageRow[] {
  return ctx.db.all<Rec>(`
    SELECT provider, model, role, COUNT(*) AS calls,
      CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END AS input_tokens,
      CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END AS output_tokens,
      SUM(cached_input_tokens) AS cached_input_tokens
    FROM usage WHERE run_id = ? GROUP BY provider, model, role ORDER BY provider, model, role`, runId)
    .map((r) => ({
      provider: r.provider, model: r.model, role: r.role, calls: Number(r.calls),
      inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
      outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
      cachedInputTokens: r.cached_input_tokens === null ? null : Number(r.cached_input_tokens),
    }));
}

/** A sum that stays null until some call reported a count, so "not reported" is not shown as zero. */
const addCount = (sum: number | null, n: unknown) => (n === null || n === undefined ? sum : (sum ?? 0) + Number(n));

/** Model calls of the last `days` days per provider. Calls the author stopped are not counted as failed. */
export function usageSummary(ctx: AppContext, days: number, at = new Date()): UsageSummary {
  const since = new Date(at.getTime() - days * 86_400_000).toISOString();
  const rows = ctx.db.all<Rec>(`
    SELECT provider, model, COUNT(*) AS calls,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached, COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens END), 0) AS cached_basis,
      SUM(cached_input_tokens IS NOT NULL) AS reported,
      SUM(ok = 0 AND COALESCE(error_kind, '') != 'aborted') AS failed, SUM(error_kind = 'timeout') AS timeouts
    FROM usage WHERE created_at >= ? GROUP BY provider, model`, since);
  type Acc = { models: Map<string, number>; calls: number; input: number | null; output: number | null; cached: number; basis: number; reported: number; failed: number; timeouts: number };
  const blank = (): Acc => ({ models: new Map(), calls: 0, input: null, output: null, cached: 0, basis: 0, reported: 0, failed: 0, timeouts: 0 });
  const by = new Map<string, Acc>();
  const all = blank();
  for (const r of rows) {
    for (const a of [by.get(r.provider) ?? by.set(r.provider, blank()).get(r.provider)!, all]) {
      a.models.set(r.model, (a.models.get(r.model) ?? 0) + Number(r.calls));
      a.calls += Number(r.calls); a.input = addCount(a.input, r.input_tokens); a.output = addCount(a.output, r.output_tokens);
      a.cached += Number(r.cached); a.basis += Number(r.cached_basis); a.reported += Number(r.reported);
      a.failed += Number(r.failed); a.timeouts += Number(r.timeouts);
    }
  }
  const out = (provider: string, a: Acc): ProviderUsage => ({
    provider, models: [...a.models].sort((x, y) => y[1] - x[1]).map(([m]) => m), calls: a.calls, inputTokens: a.input, outputTokens: a.output,
    cachedShare: a.reported > 0 && a.basis > 0 ? Math.min(1, a.cached / a.basis) : null, failed: a.failed, timeouts: a.timeouts,
  });
  return { days, providers: [...by].map(([p, a]) => out(p, a)).sort((x, y) => y.calls - x.calls), total: out('', all) };
}
