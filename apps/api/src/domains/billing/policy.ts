/**
 * Billing estimation / denomination / reservation policy (server-only).
 *
 * Policy version: 2026-07-15
 * Owner: domains/billing. Pre-flight spend estimates, completion caps,
 * token accounting denominators, currency, and reservation invariants.
 * Note: DEFAULT_COMPLETION_CAP_TOKENS (4096) is intentionally separate from
 * Anthropic protocol ANTHROPIC_DEFAULT_MAX_TOKENS (also 4096) — same primitive,
 * different owners (design §7: do not merge coincidentally equal values).
 */

import { TOKENS_PER_MILLION_COUNT } from "@tokenpanel/contracts";

export const BILLING_POLICY_VERSION = "2026-07-15" as const;

/**
 * Fallback completion token cap when request and model omit max output.
 * Unit: count (tokens). Matches historical DEFAULT_COMPLETION_CAP.
 */
export const DEFAULT_COMPLETION_CAP_TOKENS = 4096;

/**
 * Non-text message part (image/audio) overhead for prompt estimation.
 * Unit: count (tokens). Over-estimate is safe for pre-flight.
 */
export const NON_TEXT_PART_TOKENS_COUNT = 768;

/**
 * Character-to-token divisor for text prompt estimation (~4 chars/token).
 * Unit: count (chars per token).
 */
export const CHARS_PER_TOKEN_ESTIMATE_COUNT = 4;

/**
 * Money denomination: all charges use integer units of an ISO currency.
 * Never floats at the billing boundary. Product constant tokens-per-million
 * converts token counts → units via ceil per bucket.
 */
export const MONEY_DENOMINATION = {
  /** Storage unit for balances and charges. */
  unit: "units" as const,
  /** Never free-bill when provider usage is missing/malformed/overflow. */
  freeBillMissingUsage: false as const,
  /** Prices are per this many tokens (units per million). */
  tokensPerMillion: TOKENS_PER_MILLION_COUNT,
} as const;

/**
 * Currency policy: customer balance currency must match model currency for
 * pre-flight and settlement. Mismatch is a hard 402-class failure (never
 * silent bypass).
 */
export const CURRENCY_POLICY = {
  requireBalanceMatchModel: true as const,
  /** Settlement guard refuses debit when currency diverges mid-flight. */
  settlementGuardCurrency: true as const,
} as const;

/**
 * Reservation policy: every org holds estimated spend in reservedUnits
 * before the provider call; settle debits actual and releases the hold.
 */
export const RESERVATION_POLICY = {
  /** Available = max(0, amountUnits - max(0, reservedUnits)). */
  availableFormula: "amount_minus_reserved" as const,
  /** Zero need always succeeds without write. */
  zeroNeedAlwaysOk: true as const,
  /** Release holds on upstream failure / cancel (best-effort). */
  releaseOnFailure: true as const,
} as const;

/** Re-export product constant for billing math (units per million tokens). */
export { TOKENS_PER_MILLION_COUNT };

/** Historical alias used by billing.ts / tests (same value, tokens unit). */
export const DEFAULT_COMPLETION_CAP = DEFAULT_COMPLETION_CAP_TOKENS;
