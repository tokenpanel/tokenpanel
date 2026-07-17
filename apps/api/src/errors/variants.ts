/**
 * Closed typed variants for provider orchestration facts (task 4.2).
 * Integrates with apps/api/src/providers/provider-errors.ts — same unions,
 * re-exported here so domain/error code does not invent open string bags.
 */

import type {
  ProviderErrorCategory,
  ProviderErrorPhase,
} from "../providers/provider-errors.ts";

export type {
  ProviderErrorCategory,
  ProviderErrorPhase,
} from "../providers/provider-errors.ts";

/** Whether a classified failure may be retried (operation still must be idempotent). */
export type RetryClass = "never" | "transient";

/** Whether fallback to the next provider entry is allowed (pre-commit only). */
export type FallbackClass = "ineligible" | "eligible";

/** Whether the upstream may already have accepted the request. */
export type AcceptanceClass = "not_accepted" | "maybe_accepted";

/** Whether any client-visible stream byte/delta was already emitted. */
export type StreamCommitClass = "not_committed" | "committed";

/** Closed HTTP surfaces that own a renderer. */
export type HttpSurface = "admin" | "management" | "openai" | "anthropic";

/** Closed validation response modes matching golden matrix. */
export type ValidationMode = "default_400" | "field_422";

/** Map boolean-style provider facts into closed classes. */
export function retryClassOf(retryable: boolean): RetryClass {
  return retryable ? "transient" : "never";
}

export function fallbackClassOf(eligible: boolean): FallbackClass {
  return eligible ? "eligible" : "ineligible";
}

export function acceptanceClassOf(maybe: boolean): AcceptanceClass {
  return maybe ? "maybe_accepted" : "not_accepted";
}

export function streamCommitClassOf(committed: boolean): StreamCommitClass {
  return committed ? "committed" : "not_committed";
}

/** Provider categories that map to timeout tagged errors. */
export const TIMEOUT_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  "timeout_pre_send",
  "timeout_ambiguous",
]);

/** Provider categories that map to unavailable tagged errors. */
export const UNAVAILABLE_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  "connection",
  "capacity",
  "http_5xx",
]);

/** Provider categories that map to rejected (client/upstream policy) errors. */
export const REJECTED_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  "auth",
  "validation",
  "http_4xx",
  "abort",
]);

/** Provider categories that map to protocol/malformed errors. */
export const PROTOCOL_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  "malformed_response",
  "missing_usage",
  "unknown",
]);

/** All closed provider phases (for exhaustiveness). */
export const PROVIDER_PHASES = [
  "connect",
  "request",
  "headers",
  "body",
  "stream",
  "parse",
] as const satisfies readonly ProviderErrorPhase[];

/** All closed provider categories (for exhaustiveness). */
export const PROVIDER_CATEGORIES = [
  "connection",
  "timeout_pre_send",
  "timeout_ambiguous",
  "http_4xx",
  "http_5xx",
  "capacity",
  "validation",
  "auth",
  "malformed_response",
  "missing_usage",
  "abort",
  "unknown",
] as const satisfies readonly ProviderErrorCategory[];
