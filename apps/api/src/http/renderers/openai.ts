/**
 * OpenAI-compatible JSON/SSE error renderers (task 4.6).
 * Preserves formatOpenAIError envelope:
 *   { error: { message, type, code, ...extra } }
 */

import type { AppError } from "../../errors/families.ts";
import { publicMessageForCode, SAFE_MESSAGES } from "../../errors/safe-messages.ts";
import { OPENAI_SSE_DONE_LINE } from "../../providers/openai-protocol.ts";
import type { RenderedHttpError } from "./types.ts";
import { emptyHeaders, withRetryAfter } from "./types.ts";

export type OpenAIErrorType =
  | "rate_limit_error"
  | "billing_error"
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "api_error";

/**
 * Same mapping as routes/public/openai.ts formatOpenAIError.
 * Exported for routes to adopt later without changing wire shape.
 */
export function formatOpenAIErrorBody(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): {
  error: {
    message: string;
    type: string;
    code: string;
    [key: string]: unknown;
  };
} {
  const type =
    code === "rate_limited"
      ? "rate_limit_error"
      : code === "insufficient_balance"
        ? "billing_error"
        : "invalid_request_error";
  return {
    error: {
      message,
      type,
      code,
      ...(extra ?? {}),
    },
  };
}

function openAITypeForAppError(err: AppError): OpenAIErrorType {
  switch (err._tag) {
    case "RateLimitExceededError":
      return "rate_limit_error";
    case "InsufficientBalanceError":
      return "billing_error";
    case "AuthenticationError":
      return "authentication_error";
    case "AuthorizationError":
      return "permission_error";
    case "NotFoundError":
      return "not_found_error";
    case "ValidationError":
      return "invalid_request_error";
    default:
      return "invalid_request_error";
  }
}

function statusForOpenAI(err: AppError): number {
  switch (err._tag) {
    case "ValidationError":
      return err.mode === "field_422" ? 400 : 400;
    case "AuthenticationError":
      return 401;
    case "AuthorizationError":
      return 403;
    case "NotFoundError":
      return 404;
    case "ConflictError":
    case "InvalidStateError":
      return 409;
    case "InsufficientBalanceError":
      return 402;
    case "BudgetExceededError":
    case "RateLimitExceededError":
      return 429;
    case "ProviderRejectedError":
      return err.httpStatus && err.httpStatus >= 400 && err.httpStatus < 600
        ? err.httpStatus
        : 400;
    case "ProviderUnavailableError":
      return err.code === "no_active_entries" ? 503 : 502;
    case "ProviderProtocolError":
      return 502;
    case "ProviderTimeoutError":
      return 504;
    case "PersistenceUnavailableError":
    case "PersistenceTimeoutError":
      return 503;
    case "PersistenceDuplicateKeyError":
    case "PersistenceConflictError":
      return 409;
    case "ConfigurationError":
    case "PersistenceDataError":
    case "SystemError":
      return 500;
    default: {
      const _e: never = err;
      void _e;
      return 500;
    }
  }
}

function publicCode(err: AppError): string {
  switch (err._tag) {
    case "ValidationError":
      return "invalid_request";
    case "AuthenticationError":
      return err.code === "invalid_credentials" ? "unauthorized" : "unauthorized";
    case "AuthorizationError":
      return err.code === "missing_scope" ? "missing_scope" : err.code;
    case "RateLimitExceededError":
      return "rate_limited";
    case "InsufficientBalanceError":
      return err.code;
    case "ProviderUnavailableError":
    case "ProviderTimeoutError":
    case "ProviderProtocolError":
    case "ProviderRejectedError":
      return err.code === "provider_protocol" || err.code === "provider_timeout"
        ? "upstream_error"
        : err.code === "provider_rejected"
          ? "upstream_error"
          : err.code;
    case "SystemError":
    case "ConfigurationError":
    case "PersistenceDataError":
      return "internal_error";
    default:
      return err.code;
  }
}

function extraFor(err: AppError): Record<string, unknown> | undefined {
  if (err._tag === "RateLimitExceededError") {
    const extra: Record<string, unknown> = {
      retryAfterSeconds: err.retryAfterSeconds,
    };
    if (err.dimension !== undefined) extra.dimension = err.dimension;
    if (err.cap !== undefined) extra.cap = err.cap;
    if (err.current !== undefined) extra.current = err.current;
    if (err.windowSeconds !== undefined) extra.windowSeconds = err.windowSeconds;
    return extra;
  }
  if (err._tag === "InsufficientBalanceError") {
    const extra: Record<string, unknown> = {};
    if (err.balanceUnits !== undefined) extra.balanceUnits = err.balanceUnits;
    if (err.requiredUnits !== undefined) extra.requiredUnits = err.requiredUnits;
    if (err.currency !== undefined) extra.currency = err.currency;
    return Object.keys(extra).length > 0 ? extra : undefined;
  }
  return undefined;
}

/**
 * Render AppError to OpenAI JSON envelope + HTTP status/headers.
 */
export function renderOpenAIError(err: AppError): RenderedHttpError {
  const code = publicCode(err);
  const message = publicMessageForCode(code, err.message);
  const type = openAITypeForAppError(err);
  // Keep formatOpenAIError type mapping for rate_limited / insufficient_balance
  // even when openAITypeForAppError is more precise — wire compatibility first.
  const body = formatOpenAIErrorBody(code, message, extraFor(err));
  // Override type for auth-ish codes when formatOpenAIError would force invalid_request
  if (type === "authentication_error" || type === "permission_error") {
    body.error.type =
      type === "authentication_error"
        ? "invalid_request_error"
        : "invalid_request_error";
  }
  void type;

  let headers = emptyHeaders();
  if (err._tag === "RateLimitExceededError") {
    headers = withRetryAfter(headers, err.retryAfterSeconds);
  }
  if (err._tag === "AuthenticationError" && err.retryAfterSeconds !== undefined) {
    headers = withRetryAfter(headers, err.retryAfterSeconds);
  }

  return {
    status: statusForOpenAI(err),
    body,
    headers,
  };
}

export function renderOpenAIDefect(): RenderedHttpError {
  return {
    status: 500,
    body: formatOpenAIErrorBody(
      "internal_error",
      SAFE_MESSAGES.internal_server_error,
    ),
    headers: emptyHeaders(),
  };
}

/**
 * SSE terminal error event payload (same JSON as formatOpenAIError).
 * Emit once per stream; caller owns terminalErrorEmitted flag.
 */
export function openAISseTerminalError(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): string {
  const payload = formatOpenAIErrorBody(
    code,
    publicMessageForCode(code, message),
    extra,
  );
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function openAISseTerminalFromAppError(err: AppError): string {
  const rendered = renderOpenAIError(err);
  return `data: ${JSON.stringify(rendered.body)}\n\n`;
}

/** SSE done marker (protocol). Authority: providers/openai-protocol.ts. */
export const OPENAI_SSE_DONE = OPENAI_SSE_DONE_LINE;
