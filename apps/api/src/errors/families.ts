/**
 * Canonical tagged error families (task 4.1).
 * Expected failures only — defects stay on Effect Cause; interruption is control flow.
 */

import { Data } from "effect";
import type { ErrorCode } from "./codes.ts";
import type {
  AcceptanceClass,
  FallbackClass,
  ProviderErrorCategory,
  ProviderErrorPhase,
  RetryClass,
  StreamCommitClass,
  ValidationMode,
} from "./variants.ts";

/** Single field-level validation issue (safe; no rejected secret values). */
export type ValidationIssue = {
  readonly path: string;
  readonly message: string;
};

// ---------------------------------------------------------------------------
// Boundary / validation
// ---------------------------------------------------------------------------

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly code: "validation_error";
  readonly message: string;
  readonly mode: ValidationMode;
  /** Field errors for 422 contracts (Effect Schema / field-errors compatible). */
  readonly details?: Readonly<Record<string, readonly string[] | undefined>>;
  readonly issues?: readonly ValidationIssue[];
}> {}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export class AuthenticationError extends Data.TaggedError("AuthenticationError")<{
  readonly code: "unauthorized" | "invalid_credentials";
  readonly message: string;
  /**
   * Public-safe reason when the surface historically exposes one
   * (e.g. no_active_org_membership). Never put credentials here.
   */
  readonly reason?: string;
  /** Private structured JWT/crypto cause (logs only). */
  readonly privateReason?: string;
  readonly retryAfterSeconds?: number;
}> {}

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly code:
    | "forbidden"
    | "missing_scope"
    | "user_disabled"
    | "model_not_allowed"
    | "customer_not_found";
  readonly message: string;
  readonly reason?: string;
  readonly scope?: string;
}> {}

// ---------------------------------------------------------------------------
// Resource / conflict / state
// ---------------------------------------------------------------------------

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly code: string;
  readonly message: string;
  readonly resource?: string;
  readonly id?: string;
}> {}

export class ConflictError extends Data.TaggedError("ConflictError")<{
  /** Stable public conflict code (e.g. duplicate_external_id_or_email). */
  readonly code: string;
  readonly message: string;
  readonly fields?: readonly string[];
}> {}

export class InvalidStateError extends Data.TaggedError("InvalidStateError")<{
  readonly code: string;
  readonly message: string;
  readonly resource?: string;
}> {}

// ---------------------------------------------------------------------------
// Billing / limits
// ---------------------------------------------------------------------------

export class InsufficientBalanceError extends Data.TaggedError(
  "InsufficientBalanceError",
)<{
  readonly code: "insufficient_balance" | "currency_mismatch";
  readonly message: string;
  readonly balanceUnits?: number;
  readonly requiredUnits?: number;
  readonly currency?: string;
  readonly balanceCurrency?: string;
  readonly modelCurrency?: string;
}> {}

export class BudgetExceededError extends Data.TaggedError("BudgetExceededError")<{
  readonly code: "budget_exceeded";
  readonly message: string;
  readonly budgetId?: string;
  readonly dimension?: string;
}> {}

export class RateLimitExceededError extends Data.TaggedError(
  "RateLimitExceededError",
)<{
  readonly code: "rate_limited";
  readonly message: string;
  readonly retryAfterSeconds: number;
  readonly dimension?: string;
  readonly cap?: number;
  readonly current?: number;
  readonly windowSeconds?: number;
}> {}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ProviderMeta = {
  readonly message: string;
  readonly category: ProviderErrorCategory;
  readonly phase: ProviderErrorPhase;
  readonly retryClass: RetryClass;
  readonly fallbackClass: FallbackClass;
  readonly acceptanceClass: AcceptanceClass;
  readonly streamCommitClass: StreamCommitClass;
  readonly httpStatus?: number;
  readonly providerRequestId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly operation?: string;
  /** Bounded private diagnostic (never public). */
  readonly diagnostic?: string;
};

export class ProviderRejectedError extends Data.TaggedError(
  "ProviderRejectedError",
)<ProviderMeta & { readonly code: "provider_rejected" | "upstream_error" }> {}

export class ProviderUnavailableError extends Data.TaggedError(
  "ProviderUnavailableError",
)<
  ProviderMeta & {
    readonly code:
      | "provider_unavailable"
      | "all_providers_failed"
      | "no_active_entries"
      | "adapter_missing"
      | "upstream_error";
  }
> {}

export class ProviderTimeoutError extends Data.TaggedError("ProviderTimeoutError")<
  ProviderMeta & {
    readonly code: "provider_timeout";
    readonly timeoutMs?: number;
  }
> {}

export class ProviderProtocolError extends Data.TaggedError(
  "ProviderProtocolError",
)<ProviderMeta & { readonly code: "provider_protocol" | "upstream_error" }> {}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export class PersistenceDuplicateKeyError extends Data.TaggedError(
  "PersistenceDuplicateKeyError",
)<{
  readonly code: "persistence_duplicate_key";
  readonly message: string;
  /** Index or field names when safely extractable (no values). */
  readonly indexName?: string;
  readonly fields?: readonly string[];
  readonly retryClass: RetryClass;
}> {}

export class PersistenceConflictError extends Data.TaggedError(
  "PersistenceConflictError",
)<{
  readonly code: "persistence_conflict";
  readonly message: string;
  readonly labels?: readonly string[];
  readonly retryClass: RetryClass;
}> {}

export class PersistenceUnavailableError extends Data.TaggedError(
  "PersistenceUnavailableError",
)<{
  readonly code: "persistence_unavailable";
  readonly message: string;
  readonly retryClass: RetryClass;
  readonly diagnostic?: string;
}> {}

export class PersistenceTimeoutError extends Data.TaggedError(
  "PersistenceTimeoutError",
)<{
  readonly code: "persistence_timeout";
  readonly message: string;
  readonly retryClass: RetryClass;
  readonly diagnostic?: string;
}> {}

export class PersistenceDataError extends Data.TaggedError("PersistenceDataError")<{
  readonly code: "persistence_data";
  readonly message: string;
  readonly collection?: string;
  readonly retryClass: RetryClass;
  readonly diagnostic?: string;
}> {}

// ---------------------------------------------------------------------------
// Configuration / system
// ---------------------------------------------------------------------------

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly code: "configuration_error" | "server_misconfigured";
  readonly message: string;
  readonly variable?: string;
}> {}

/**
 * Classified unexpected infrastructure failure that is still typed
 * (as opposed to an Effect defect). Prefer defects for programmer bugs.
 */
export class SystemError extends Data.TaggedError("SystemError")<{
  readonly code: "system_error" | "internal_server_error";
  readonly message: string;
  readonly diagnostic?: string;
}> {}

// ---------------------------------------------------------------------------
// Union + tag list
// ---------------------------------------------------------------------------

export type AppError =
  | ValidationError
  | AuthenticationError
  | AuthorizationError
  | NotFoundError
  | ConflictError
  | InvalidStateError
  | InsufficientBalanceError
  | BudgetExceededError
  | RateLimitExceededError
  | ProviderRejectedError
  | ProviderUnavailableError
  | ProviderTimeoutError
  | ProviderProtocolError
  | PersistenceDuplicateKeyError
  | PersistenceConflictError
  | PersistenceUnavailableError
  | PersistenceTimeoutError
  | PersistenceDataError
  | ConfigurationError
  | SystemError;

export const APP_ERROR_TAGS = [
  "ValidationError",
  "AuthenticationError",
  "AuthorizationError",
  "NotFoundError",
  "ConflictError",
  "InvalidStateError",
  "InsufficientBalanceError",
  "BudgetExceededError",
  "RateLimitExceededError",
  "ProviderRejectedError",
  "ProviderUnavailableError",
  "ProviderTimeoutError",
  "ProviderProtocolError",
  "PersistenceDuplicateKeyError",
  "PersistenceConflictError",
  "PersistenceUnavailableError",
  "PersistenceTimeoutError",
  "PersistenceDataError",
  "ConfigurationError",
  "SystemError",
] as const;

export type AppErrorTag = (typeof APP_ERROR_TAGS)[number];

const TAG_SET: ReadonlySet<string> = new Set(APP_ERROR_TAGS);

export function isAppError(u: unknown): u is AppError {
  if (typeof u !== "object" || u === null) return false;
  if (!("_tag" in u)) return false;
  return TAG_SET.has((u as { _tag: string })._tag);
}

export function appErrorTag(err: AppError): AppErrorTag {
  return err._tag;
}

export function appErrorCode(err: AppError): string {
  return err.code;
}

/** Narrow provider tagged errors (share orchestration metadata). */
export type ProviderAppError =
  | ProviderRejectedError
  | ProviderUnavailableError
  | ProviderTimeoutError
  | ProviderProtocolError;

export function isProviderAppError(u: unknown): u is ProviderAppError {
  if (!isAppError(u)) return false;
  return (
    u._tag === "ProviderRejectedError" ||
    u._tag === "ProviderUnavailableError" ||
    u._tag === "ProviderTimeoutError" ||
    u._tag === "ProviderProtocolError"
  );
}

export type PersistenceAppError =
  | PersistenceDuplicateKeyError
  | PersistenceConflictError
  | PersistenceUnavailableError
  | PersistenceTimeoutError
  | PersistenceDataError;

export function isPersistenceAppError(u: unknown): u is PersistenceAppError {
  if (!isAppError(u)) return false;
  return (
    u._tag === "PersistenceDuplicateKeyError" ||
    u._tag === "PersistenceConflictError" ||
    u._tag === "PersistenceUnavailableError" ||
    u._tag === "PersistenceTimeoutError" ||
    u._tag === "PersistenceDataError"
  );
}

/** Type-level assertion helper: ErrorCode subset used on some constructors. */
export type _AssertCodes = ErrorCode;
