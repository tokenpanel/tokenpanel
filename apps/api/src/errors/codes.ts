/**
 * Stable internal error codes (snake_case). Public envelopes may map several
 * codes to one protocol type while logs retain the precise code.
 */

export const ErrorCodes = {
  // Validation
  validation_error: "validation_error",

  // Auth
  unauthorized: "unauthorized",
  invalid_credentials: "invalid_credentials",
  forbidden: "forbidden",
  missing_scope: "missing_scope",
  user_disabled: "user_disabled",
  model_not_allowed: "model_not_allowed",

  // Resource / state
  not_found: "not_found",
  conflict: "conflict",
  invalid_state: "invalid_state",

  // Billing / limits
  insufficient_balance: "insufficient_balance",
  budget_exceeded: "budget_exceeded",
  rate_limited: "rate_limited",
  currency_mismatch: "currency_mismatch",

  // Provider
  provider_rejected: "provider_rejected",
  provider_unavailable: "provider_unavailable",
  provider_timeout: "provider_timeout",
  provider_protocol: "provider_protocol",
  all_providers_failed: "all_providers_failed",
  no_active_entries: "no_active_entries",
  adapter_missing: "adapter_missing",
  upstream_error: "upstream_error",

  // Persistence
  persistence_duplicate_key: "persistence_duplicate_key",
  persistence_conflict: "persistence_conflict",
  persistence_unavailable: "persistence_unavailable",
  persistence_timeout: "persistence_timeout",
  persistence_data: "persistence_data",

  // Config / system
  configuration_error: "configuration_error",
  server_misconfigured: "server_misconfigured",
  internal_server_error: "internal_server_error",
  system_error: "system_error",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
