/**
 * Rate-limit rule stream identity (browser-safe product policy).
 *
 * A plan or customer rule set may define at most one active stream for a given
 * (dimension, window, scope target, currency). Different windows (hour + week)
 * or different targets (model A vs model B) are allowed; two "tokens / 1h"
 * customer-scope rules are not.
 *
 * Policy version: 2026-07-17
 */

/** Fields needed to identify a rolling-limit stream at config time. */
export type RateLimitStreamFields = {
  readonly windowSeconds: number;
  readonly dimension: string;
  readonly scope?: string | null | undefined;
  readonly scopeTarget?: string | null | undefined;
  readonly currency?: string | null | undefined;
};

/**
 * Normalize scope for stream identity.
 * `customer` and `plan` both count usage on the customer-global counter
 * (resolved scopeTarget is null at enforcement time).
 */
export function rateLimitStreamScope(
  scope: string | null | undefined,
): "customer" | "model" {
  if (scope === "model") return scope;
  return "customer";
}

/**
 * Stable key for the counter stream a rule would write to (config-time).
 * Does not include capValue or rule id — those are not stream identity.
 */
export function rateLimitStreamKey(rule: RateLimitStreamFields): string {
  const scope = rateLimitStreamScope(rule.scope);
  const target =
    scope === "customer"
      ? ""
      : (rule.scopeTarget ?? "").trim().toLowerCase();
  const currency =
    rule.dimension === "spend_minor"
      ? (rule.currency ?? "").trim().toUpperCase()
      : "";
  return `${rule.dimension}\0${rule.windowSeconds}\0${scope}\0${target}\0${currency}`;
}

export type DuplicateRateLimitStream = {
  readonly streamKey: string;
  readonly firstIndex: number;
  readonly secondIndex: number;
  readonly dimension: string;
  readonly windowSeconds: number;
};

/**
 * First pair of rules that share a stream key, or null if all unique.
 * Inactive rules are ignored when `active` is present and false.
 */
export function findDuplicateRateLimitStream(
  rules: readonly (RateLimitStreamFields & {
    readonly active?: boolean | undefined;
  })[],
): DuplicateRateLimitStream | null {
  const seen = new Map<string, number>();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (r.active === false) continue;
    const key = rateLimitStreamKey(r);
    const prev = seen.get(key);
    if (prev !== undefined) {
      return {
        streamKey: key,
        firstIndex: prev,
        secondIndex: i,
        dimension: r.dimension,
        windowSeconds: r.windowSeconds,
      };
    }
    seen.set(key, i);
  }
  return null;
}

/** Human-readable rejection when two rules share a stream. */
export function duplicateRateLimitStreamMessage(
  dup: DuplicateRateLimitStream,
): string {
  return (
    `Duplicate rate limit stream: only one rule allowed per ` +
    `${dup.dimension} / ${dup.windowSeconds}s window (and scope/currency). ` +
    `Use different windows (e.g. hour + week) or different model targets.`
  );
}
