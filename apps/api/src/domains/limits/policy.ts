/**
 * Rate-limit / window policy (server-only).
 *
 * Policy version: 2026-07-15
 * Owner: domains/limits. Window presets are documentation + human labels;
 * stored rules use arbitrary windowSeconds within the max bound.
 */

export const LIMITS_POLICY_VERSION = "2026-07-15" as const;

/** Max rate-limit window length accepted by schemas. Unit: seconds. */
export const RATE_LIMIT_WINDOW_MAX_SECONDS = 31_536_000; // 365d

/**
 * Common window lengths used in UI / human labels.
 * Unit: seconds. Not exhaustive — rules may use any positive value ≤ max.
 */
export const RATE_LIMIT_PRESET_WINDOWS_SECONDS = Object.freeze({
  oneHour: 3_600,
  fiveHours: 18_000,
  oneDay: 86_400,
  oneWeek: 604_800,
  thirtyDays: 2_592_000,
} as const);

/** Rate-limit rule id max length (schema). Unit: count (chars). */
export const RATE_LIMIT_RULE_ID_MAX_CHARS = 40;

/** scopeTarget max length (schema). Unit: count (chars). */
export const RATE_LIMIT_SCOPE_TARGET_MAX_CHARS = 120;
