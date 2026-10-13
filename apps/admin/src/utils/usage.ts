/**
 * Derived usage ratios shared by the dashboard and analytics instruments.
 * All inputs come straight from /admin/analytics/summary; nothing is invented.
 */

export interface CacheTotals {
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Blended prompt-cache hit rate. OpenAI reports cached tokens inside prompt,
 * Anthropic separately — the denominator (prompt + cache write, floored by
 * cache read) approximates total input served for both. `null` when there was
 * no cache activity at all.
 */
export function cacheHitRate(t: CacheTotals): { rate: number | null; served: number } {
  const served = Math.max(t.promptTokens + t.cacheWriteTokens, t.cacheReadTokens, 1);
  if (t.cacheReadTokens <= 0 && t.cacheWriteTokens <= 0) return { rate: null, served };
  return { rate: t.cacheReadTokens / served, served };
}

/** Gross margin of charged price over upstream cost; `null` when nothing was charged. */
export function grossMargin(priceMicros: number, costMicros: number): number | null {
  if (priceMicros <= 0) return null;
  return (priceMicros - costMicros) / priceMicros;
}

export function formatPercent(ratio: number | null, digits = 1): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}
