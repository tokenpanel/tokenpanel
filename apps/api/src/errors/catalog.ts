/**
 * Standard error catalogue (TokenPanel-Version 2 and the admin API).
 *
 * Every error a client can receive under the standard maps to exactly one
 * public code here, and each code has exactly one HTTP status. Messages are
 * TokenPanel's own text: provider, persistence and system failures always use
 * the catalogue message so upstream or infrastructure detail never reaches
 * API clients. Codes marked `domainMessage` may instead carry the curated
 * message written by TokenPanel domain code (e.g. "Customer not found").
 *
 * Legacy (version 1) responses do not use this table; see http/renderers/*.
 * The wiki page Errors.md documents this table — keep them in sync.
 */

import type { AppError } from "./families.ts";
import { isProviderAppError } from "./families.ts";
import { redactString } from "./observability.ts";
import { looksLikeUnsafeDiagnostic } from "./safe-messages.ts";

export type CatalogEntry = {
  readonly status: number;
  readonly message: string;
  /** Curated domain messages (TokenPanel-authored) may replace `message`. */
  readonly domainMessage?: true;
  /**
   * Whether repeating the same request can succeed. Sent as `x-should-retry`
   * (honored by the OpenAI and Anthropic SDKs before their status rules).
   */
  readonly retryable?: true;
};

export const ERROR_CATALOG = {
  // --- Request -------------------------------------------------------------
  validation_error: {
    status: 400,
    message: "The request is invalid.",
    domainMessage: true,
  },
  unsupported_api_version: {
    status: 400,
    message: "Unsupported TokenPanel-Version header. Supported versions: 1, 2.",
  },
  invalid_idempotency_key: {
    status: 400,
    message: "Idempotency-Key must be between 1 and 128 characters.",
  },
  payload_too_large: {
    status: 413,
    message: "The request body is too large.",
  },

  // --- Authentication / authorization ------------------------------------
  unauthorized: {
    status: 401,
    message: "Missing or invalid credentials.",
  },
  invalid_credentials: {
    status: 401,
    message: "Invalid username or password.",
    domainMessage: true,
  },
  forbidden: {
    status: 403,
    message: "You do not have permission to perform this action.",
    domainMessage: true,
  },
  missing_scope: {
    status: 403,
    message: "The API key is missing a required scope.",
  },
  user_disabled: {
    status: 403,
    message: "This user account is disabled.",
  },
  customer_inactive: {
    status: 403,
    message: "The customer account is not active.",
  },
  model_not_allowed: {
    status: 403,
    message: "This API key is not allowed to use the requested model.",
    domainMessage: true,
  },

  // --- Resources -------------------------------------------------------------
  not_found: {
    status: 404,
    message: "The requested resource was not found.",
    domainMessage: true,
  },
  model_not_found: {
    status: 404,
    message: "The requested model does not exist or is not active.",
    domainMessage: true,
  },
  customer_not_found: {
    status: 404,
    message: "Customer not found.",
  },
  plan_not_found: {
    status: 404,
    message: "Plan not found.",
  },
  invite_not_found: {
    status: 404,
    message: "The invite link is invalid or has expired.",
  },
  invite_expired: {
    status: 410,
    message: "This invite has expired.",
  },

  // --- Conflicts / state -----------------------------------------------------
  conflict: {
    status: 409,
    message: "The request conflicts with the current state of the resource.",
  },
  invalid_state: {
    status: 409,
    message: "The resource is not in a state that allows this action.",
    domainMessage: true,
  },
  duplicate_external_id_or_email: {
    status: 409,
    message: "A customer with this external ID or email already exists.",
  },
  email_taken: { status: 409, message: "This email address is already in use." },
  username_or_email_taken: {
    status: 409,
    message: "This username or email address is already in use.",
  },
  slug_taken: { status: 409, message: "This organization slug is already taken." },
  setup_already_complete: {
    status: 409,
    message: "First-run setup has already been completed.",
  },
  organization_creation_failed: {
    status: 409,
    message: "The organization could not be created. Try again.",
  },
  last_org: {
    status: 409,
    message: "You cannot delete your only organization.",
  },
  org_not_empty: {
    status: 409,
    message: "The organization still has data. Remove it before deleting the organization.",
  },
  provider_in_use: {
    status: 409,
    message: "The provider is still used by one or more models.",
    domainMessage: true,
  },
  last_entry: {
    status: 409,
    message: "A model must keep at least one provider entry.",
  },
  plan_not_active: { status: 409, message: "The selected plan is not active." },
  subscription_already_active: {
    status: 409,
    message: "The customer already has an active subscription.",
  },
  idempotency_key_reused: {
    status: 409,
    message: "This Idempotency-Key was already used for a different balance adjustment.",
  },

  // --- Billing / limits --------------------------------------------------
  insufficient_balance: {
    status: 402,
    message: "Insufficient balance to complete the request.",
  },
  currency_mismatch: {
    status: 402,
    message: "The customer's balance currency does not match the model's currency.",
  },
  rate_limited: {
    status: 429,
    message: "Rate limit exceeded. Retry after the time given in Retry-After.",
    retryable: true,
  },
  budget_exceeded: { status: 429, message: "Budget exceeded." },
  too_many_attempts: {
    status: 429,
    message: "Too many attempts. Try again after the time given in Retry-After.",
    retryable: true,
  },

  // --- Model providers (never upstream text) -----------------------------
  provider_rejected: {
    status: 502,
    message: "The model provider rejected the request.",
  },
  provider_unavailable: {
    status: 502,
    message: "The model provider is unavailable. Try again later.",
    retryable: true,
  },
  all_providers_failed: {
    status: 502,
    message: "All providers for this model failed. Try again later.",
    retryable: true,
  },
  provider_protocol: {
    status: 502,
    message: "The model provider returned an invalid response.",
  },
  provider_not_supported: {
    status: 502,
    message: "The model's provider type is not supported by this server.",
  },
  no_active_providers: {
    status: 503,
    message: "This model has no active providers.",
  },
  provider_timeout: {
    status: 504,
    message: "The model provider did not respond in time.",
    retryable: true,
  },
  stream_interrupted: {
    // Only sent as an SSE error event; the HTTP status is already 200.
    status: 502,
    message: "The response stream ended before it completed; the output may be incomplete.",
    retryable: true,
  },

  // --- Server --------------------------------------------------------------
  service_unavailable: {
    status: 503,
    message: "The service is temporarily unavailable. Try again later.",
    retryable: true,
  },
  server_misconfigured: {
    status: 500,
    message: "The server is misconfigured. Contact the operator.",
  },
  internal_error: { status: 500, message: "An internal error occurred.", retryable: true },
} as const satisfies Record<string, CatalogEntry>;

export type PublicErrorCode = keyof typeof ERROR_CATALOG;

export function isPublicErrorCode(code: string): code is PublicErrorCode {
  return Object.hasOwn(ERROR_CATALOG, code);
}

/** Admin-only debugging detail from the upstream provider. */
export type UpstreamDebug = {
  readonly status?: number;
  readonly detail?: string;
};

/** Transport-neutral standard error; renderers wrap it per surface. */
export type PublicError = {
  readonly code: PublicErrorCode;
  readonly status: number;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  /** Retry-After seconds (429 only). */
  readonly retryAfterSeconds?: number;
  /** Present only when rendered for the admin API. */
  readonly upstream?: UpstreamDebug;
};

export function publicError(
  code: PublicErrorCode,
  extra?: {
    readonly message?: string | undefined;
    readonly details?: Readonly<Record<string, unknown>> | undefined;
    readonly retryAfterSeconds?: number | undefined;
    readonly upstream?: UpstreamDebug | undefined;
  },
): PublicError {
  const entry: CatalogEntry = ERROR_CATALOG[code];
  const details =
    extra?.details && Object.keys(extra.details).length > 0
      ? extra.details
      : undefined;
  return {
    code,
    status: entry.status,
    message: extra?.message ?? entry.message,
    ...(details !== undefined ? { details } : {}),
    ...(extra?.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: extra.retryAfterSeconds }
      : {}),
    ...(extra?.upstream !== undefined ? { upstream: extra.upstream } : {}),
  };
}

/** Curated domain message when the code allows it and it is safe. */
function messageFor(code: PublicErrorCode, candidate: string): string | undefined {
  const entry: CatalogEntry = ERROR_CATALOG[code];
  if (!entry.domainMessage) return undefined;
  if (
    candidate.length === 0 ||
    candidate.length > 300 ||
    looksLikeUnsafeDiagnostic(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function defined(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Map a domain code that is not itself public onto the catalogue. */
export const DOMAIN_CODE_ALIASES: Readonly<Record<string, PublicErrorCode>> = {
  // NotFoundError / InvalidStateError
  invalid_or_expired: "invite_not_found",
  expired: "invite_expired",
  settlement_guard_failed: "internal_error",
  // Provider orchestration
  upstream_error: "provider_rejected",
  no_active_entries: "no_active_providers",
  adapter_missing: "provider_not_supported",
};

function codeFor(domainCode: string, fallback: PublicErrorCode): PublicErrorCode {
  const alias = DOMAIN_CODE_ALIASES[domainCode];
  if (alias !== undefined) return alias;
  return isPublicErrorCode(domainCode) ? domainCode : fallback;
}

function upstreamOf(err: AppError): UpstreamDebug | undefined {
  if (!isProviderAppError(err)) return undefined;
  const out: { status?: number; detail?: string } = {};
  if (err.httpStatus !== undefined) out.status = err.httpStatus;
  if (err.diagnostic) out.detail = redactString(err.diagnostic);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map any AppError to its standard public error.
 * `debug` adds upstream provider detail (admin API only).
 */
export function toPublicError(
  err: AppError,
  opts?: { readonly debug?: boolean },
): PublicError {
  const debug = opts?.debug === true;
  switch (err._tag) {
    case "ValidationError": {
      const issues =
        err.issues && err.issues.length > 0
          ? err.issues
          : err.details
            ? Object.entries(err.details).flatMap(([path, msgs]) =>
                (msgs ?? []).map((message) => ({ path, message })),
              )
            : [];
      return publicError("validation_error", {
        message: messageFor("validation_error", err.message),
        details: issues.length > 0 ? { issues } : undefined,
      });
    }
    case "AuthenticationError": {
      const code = err.code === "invalid_credentials" ? "invalid_credentials" : "unauthorized";
      return publicError(code, {
        message: messageFor(code, err.message),
        retryAfterSeconds: err.retryAfterSeconds,
      });
    }
    case "AuthorizationError": {
      // Specific reasons that are part of the catalogue become the code.
      const reasonCode =
        err.code === "forbidden" && err.reason !== undefined
          ? codeFor(err.reason, "forbidden")
          : codeFor(err.code, "forbidden");
      const details = defined({
        scope: err.scope,
        reason: reasonCode === "forbidden" ? err.reason : undefined,
      });
      return publicError(reasonCode, {
        message: messageFor(reasonCode, err.message),
        details,
      });
    }
    case "NotFoundError": {
      const code = codeFor(err.code, "not_found");
      return publicError(code, { message: messageFor(code, err.message) });
    }
    case "ConflictError": {
      const code = codeFor(err.code, "conflict");
      return publicError(code, {
        message: messageFor(code, err.message),
        details: defined({ fields: err.fields, ...(err.details ?? {}) }),
      });
    }
    case "InvalidStateError": {
      const code = codeFor(err.code, "invalid_state");
      return publicError(code, { message: messageFor(code, err.message) });
    }
    case "InsufficientBalanceError":
      return publicError(err.code, {
        details: defined({
          balanceMicros: err.balanceMicros,
          requiredMicros: err.requiredMicros,
          currency: err.currency,
          balanceCurrency: err.balanceCurrency,
          modelCurrency: err.modelCurrency,
        }),
      });
    case "BudgetExceededError":
      return publicError("budget_exceeded", {
        details: defined({ budgetId: err.budgetId, dimension: err.dimension }),
      });
    case "RateLimitExceededError":
      return publicError("rate_limited", {
        retryAfterSeconds: err.retryAfterSeconds,
        details: defined({
          retryAfterSeconds: err.retryAfterSeconds,
          dimension: err.dimension,
          cap: err.cap,
          current: err.current,
          windowSeconds: err.windowSeconds,
        }),
      });
    case "ProviderRejectedError":
    case "ProviderUnavailableError":
    case "ProviderTimeoutError":
    case "ProviderProtocolError": {
      const fallback: PublicErrorCode =
        err._tag === "ProviderTimeoutError"
          ? "provider_timeout"
          : err._tag === "ProviderProtocolError"
            ? "provider_protocol"
            : err._tag === "ProviderUnavailableError"
              ? "provider_unavailable"
              : "provider_rejected";
      // `upstream_error` on protocol/timeout errors is a legacy alias only.
      const code =
        err.code === "upstream_error" ? fallback : codeFor(err.code, fallback);
      const upstream = debug ? upstreamOf(err) : undefined;
      return publicError(code, {
        // Admin sees the specific classified message (adapter + status).
        ...(debug ? { message: err.message } : {}),
        upstream,
      });
    }
    case "PersistenceDuplicateKeyError":
    case "PersistenceConflictError":
      return publicError("conflict");
    case "PersistenceUnavailableError":
    case "PersistenceTimeoutError":
      return publicError("service_unavailable");
    case "PersistenceDataError":
    case "SystemError":
      return publicError("internal_error");
    case "ConfigurationError":
      return publicError("server_misconfigured");
    default: {
      const _exhaustive: never = err;
      void _exhaustive;
      return publicError("internal_error");
    }
  }
}
