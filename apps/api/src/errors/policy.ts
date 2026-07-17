/**
 * Error policy map: log level, public visibility, retry/fallback, metrics, surfaces.
 * Compile-time exhaustiveness via `satisfies Record<AppErrorTag, ErrorPolicy>`.
 */

import type { AppErrorTag } from "./families.ts";
import type { LogLevel } from "./observability.ts";
import type { FallbackClass, HttpSurface, RetryClass } from "./variants.ts";

export type PublicVisibility =
  | "none"
  | "code"
  | "code_message"
  | "code_message_details";

export type ErrorPolicy = {
  readonly logLevel: LogLevel;
  readonly publicVisibility: PublicVisibility;
  /** Default retry classification for the family (instances may refine). */
  readonly retryClass: RetryClass;
  /** Default fallback classification (provider errors refine per instance). */
  readonly fallbackClass: FallbackClass;
  readonly metricName: string;
  /** Surfaces that must render this tag (exhaustiveness for renderers). */
  readonly surfaces: readonly HttpSurface[];
};

const ALL_SURFACES = [
  "admin",
  "management",
  "openai",
  "anthropic",
] as const satisfies readonly HttpSurface[];

/**
 * Canonical policy table. `satisfies Record<AppErrorTag, ErrorPolicy>` is the
 * compile-time exhaustiveness gate for new tags.
 */
export const ERROR_POLICIES = {
  ValidationError: {
    logLevel: "info",
    publicVisibility: "code_message_details",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.validation",
    surfaces: ALL_SURFACES,
  },
  AuthenticationError: {
    logLevel: "info",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.authentication",
    surfaces: ALL_SURFACES,
  },
  AuthorizationError: {
    logLevel: "info",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.authorization",
    surfaces: ALL_SURFACES,
  },
  NotFoundError: {
    logLevel: "info",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.not_found",
    surfaces: ALL_SURFACES,
  },
  ConflictError: {
    logLevel: "info",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.conflict",
    surfaces: ["admin", "management"],
  },
  InvalidStateError: {
    logLevel: "warn",
    publicVisibility: "code_message",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.invalid_state",
    surfaces: ["admin", "management"],
  },
  InsufficientBalanceError: {
    logLevel: "info",
    publicVisibility: "code_message",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.insufficient_balance",
    surfaces: ALL_SURFACES,
  },
  BudgetExceededError: {
    logLevel: "info",
    publicVisibility: "code_message",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.budget_exceeded",
    surfaces: ALL_SURFACES,
  },
  RateLimitExceededError: {
    logLevel: "info",
    publicVisibility: "code_message",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.rate_limited",
    surfaces: ALL_SURFACES,
  },
  ProviderRejectedError: {
    logLevel: "warn",
    publicVisibility: "code_message",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.provider_rejected",
    surfaces: ALL_SURFACES,
  },
  ProviderUnavailableError: {
    logLevel: "warn",
    publicVisibility: "code_message",
    retryClass: "transient",
    fallbackClass: "eligible",
    metricName: "api.error.provider_unavailable",
    surfaces: ALL_SURFACES,
  },
  ProviderTimeoutError: {
    logLevel: "warn",
    publicVisibility: "code_message",
    retryClass: "transient",
    fallbackClass: "eligible",
    metricName: "api.error.provider_timeout",
    surfaces: ALL_SURFACES,
  },
  ProviderProtocolError: {
    logLevel: "error",
    publicVisibility: "code_message",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.provider_protocol",
    surfaces: ALL_SURFACES,
  },
  PersistenceDuplicateKeyError: {
    logLevel: "info",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.persistence_duplicate",
    surfaces: ["admin", "management"],
  },
  PersistenceConflictError: {
    logLevel: "warn",
    publicVisibility: "code",
    retryClass: "transient",
    fallbackClass: "ineligible",
    metricName: "api.error.persistence_conflict",
    surfaces: ["admin", "management"],
  },
  PersistenceUnavailableError: {
    logLevel: "error",
    publicVisibility: "code",
    retryClass: "transient",
    fallbackClass: "ineligible",
    metricName: "api.error.persistence_unavailable",
    surfaces: ALL_SURFACES,
  },
  PersistenceTimeoutError: {
    logLevel: "error",
    publicVisibility: "code",
    retryClass: "transient",
    fallbackClass: "ineligible",
    metricName: "api.error.persistence_timeout",
    surfaces: ALL_SURFACES,
  },
  PersistenceDataError: {
    logLevel: "error",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.persistence_data",
    surfaces: ["admin", "management"],
  },
  ConfigurationError: {
    logLevel: "error",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.configuration",
    surfaces: ["admin", "management"],
  },
  SystemError: {
    logLevel: "error",
    publicVisibility: "code",
    retryClass: "never",
    fallbackClass: "ineligible",
    metricName: "api.error.system",
    surfaces: ALL_SURFACES,
  },
} as const satisfies Record<AppErrorTag, ErrorPolicy>;

export type ErrorPolicies = typeof ERROR_POLICIES;

export function policyFor(tag: AppErrorTag): ErrorPolicy {
  return ERROR_POLICIES[tag];
}
