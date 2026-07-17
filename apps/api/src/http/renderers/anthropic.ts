/**
 * Anthropic-compatible JSON/SSE error renderers (task 4.6).
 * Preserves anthropicError envelope:
 *   { type: "error", error: { type, message, ...extra } }
 */

import type { AppError } from "../../errors/families.ts";
import { publicMessageForCode, SAFE_MESSAGES } from "../../errors/safe-messages.ts";
import type { RenderedHttpError } from "./types.ts";
import { emptyHeaders, withRetryAfter } from "./types.ts";

/**
 * Same shape as routes/public/anthropic.ts anthropicError.
 */
export function formatAnthropicErrorBody(
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): {
  type: "error";
  error: { type: string; message: string; [key: string]: unknown };
} {
  return {
    type: "error",
    error: { type, message, ...(extra ?? {}) },
  };
}

function anthropicTypeFor(err: AppError): string {
  switch (err._tag) {
    case "ValidationError":
      return "invalid_request_error";
    case "AuthenticationError":
      return "authentication_error";
    case "AuthorizationError":
      return "permission_error";
    case "NotFoundError":
      return "not_found_error";
    case "RateLimitExceededError":
      return "rate_limit_error";
    case "InsufficientBalanceError":
      return "billing_error";
    case "BudgetExceededError":
      return "rate_limit_error";
    case "ProviderRejectedError":
    case "ProviderUnavailableError":
    case "ProviderTimeoutError":
    case "ProviderProtocolError":
      return "api_error";
    case "PersistenceUnavailableError":
    case "PersistenceTimeoutError":
      return "api_error";
    default:
      return "api_error";
  }
}

function statusForAnthropic(err: AppError): number {
  switch (err._tag) {
    case "ValidationError":
      return 400;
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

function extraFor(err: AppError): Record<string, unknown> | undefined {
  if (err._tag === "RateLimitExceededError") {
    return { retryAfterSeconds: err.retryAfterSeconds };
  }
  return undefined;
}

/**
 * Map BillingError-style codes the way public Anthropic routes do today.
 */
export function anthropicTypeFromBillingCode(code: string): string {
  if (code === "rate_limited") return "rate_limit_error";
  if (code === "insufficient_balance") return "billing_error";
  return "invalid_request_error";
}

export function renderAnthropicError(err: AppError): RenderedHttpError {
  const type = anthropicTypeFor(err);
  // Prefer historical billing-code mapping for rate/balance so golden tests hold.
  const typeOut =
    err._tag === "RateLimitExceededError"
      ? "rate_limit_error"
      : err._tag === "InsufficientBalanceError"
        ? "billing_error"
        : type;

  const message = publicMessageForCode(err.code, err.message);
  const body = formatAnthropicErrorBody(typeOut, message, extraFor(err));

  let headers = emptyHeaders();
  if (err._tag === "RateLimitExceededError") {
    headers = withRetryAfter(headers, err.retryAfterSeconds);
  }
  if (err._tag === "AuthenticationError" && err.retryAfterSeconds !== undefined) {
    headers = withRetryAfter(headers, err.retryAfterSeconds);
  }

  return {
    status: statusForAnthropic(err),
    body,
    headers,
  };
}

export function renderAnthropicDefect(): RenderedHttpError {
  return {
    status: 500,
    body: formatAnthropicErrorBody(
      "api_error",
      SAFE_MESSAGES.internal_server_error,
    ),
    headers: emptyHeaders(),
  };
}

/**
 * SSE terminal error event (Anthropic error event JSON).
 */
export function anthropicSseTerminalError(
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): string {
  const payload = formatAnthropicErrorBody(
    type,
    publicMessageForCode(type, message),
    extra,
  );
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function anthropicSseTerminalFromAppError(err: AppError): string {
  const rendered = renderAnthropicError(err);
  return `event: error\ndata: ${JSON.stringify(rendered.body)}\n\n`;
}
