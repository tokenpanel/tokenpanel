/**
 * Management API JSON error renderer (task 4.5).
 * Same core envelope as admin; preserves missing_scope + 401 vs 403 rules.
 */

import type { AppError } from "../../errors/families.ts";
import { publicMessageForCode } from "../../errors/safe-messages.ts";
import type { RenderedHttpError } from "./types.ts";
import { emptyHeaders, withRetryAfter } from "./types.ts";
import { renderValidationError } from "./validation.ts";

function bodyError(
  error: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { error, ...(extra ?? {}) };
}

/**
 * Management keys: customer keys hitting management routes get 401 (not 403).
 * Scope failures: 403 { error: "forbidden", reason: "missing_scope" }.
 */
export function renderManagementError(err: AppError): RenderedHttpError {
  switch (err._tag) {
    case "ValidationError":
      return renderValidationError(err);

    case "AuthenticationError": {
      const headers = withRetryAfter(emptyHeaders(), err.retryAfterSeconds);
      // Management principal failures stay enumeration-safe 401 unauthorized.
      return { status: 401, body: bodyError("unauthorized"), headers };
    }

    case "AuthorizationError": {
      if (err.code === "missing_scope" || err.reason === "missing_scope") {
        return {
          status: 403,
          body: bodyError("forbidden", { reason: "missing_scope" }),
          headers: emptyHeaders(),
        };
      }
      if (err.code === "user_disabled") {
        return {
          status: 403,
          body: bodyError("forbidden", { reason: "user_disabled" }),
          headers: emptyHeaders(),
        };
      }
      return {
        status: 403,
        body: bodyError("forbidden"),
        headers: emptyHeaders(),
      };
    }

    case "NotFoundError":
      return {
        status: 404,
        body: bodyError(err.code === "not_found" ? "not_found" : err.code),
        headers: emptyHeaders(),
      };

    case "ConflictError":
      return {
        status: 409,
        body: bodyError(err.code),
        headers: emptyHeaders(),
      };

    case "InvalidStateError":
      return {
        status: 409,
        body: bodyError(err.code),
        headers: emptyHeaders(),
      };

    case "InsufficientBalanceError":
      return {
        status: 402,
        body: bodyError(err.code, {
          message: publicMessageForCode(err.code, err.message),
        }),
        headers: emptyHeaders(),
      };

    case "BudgetExceededError":
      return {
        status: 429,
        body: bodyError(err.code, {
          message: publicMessageForCode(err.code, err.message),
        }),
        headers: emptyHeaders(),
      };

    case "RateLimitExceededError":
      return {
        status: 429,
        body: bodyError("rate_limited", {
          message: publicMessageForCode("rate_limited", err.message),
          retryAfterSeconds: err.retryAfterSeconds,
        }),
        headers: withRetryAfter(emptyHeaders(), err.retryAfterSeconds),
      };

    case "ProviderRejectedError":
    case "ProviderUnavailableError":
    case "ProviderTimeoutError":
    case "ProviderProtocolError":
      return {
        status: 502,
        body: bodyError(err.code, {
          message: publicMessageForCode(err.code, err.message),
        }),
        headers: emptyHeaders(),
      };

    case "PersistenceDuplicateKeyError":
      return {
        status: 409,
        body: bodyError("conflict"),
        headers: emptyHeaders(),
      };

    case "PersistenceConflictError":
      return {
        status: 409,
        body: bodyError("conflict"),
        headers: emptyHeaders(),
      };

    case "PersistenceUnavailableError":
    case "PersistenceTimeoutError":
      return {
        status: 503,
        body: bodyError("dependency_unavailable"),
        headers: emptyHeaders(),
      };

    case "PersistenceDataError":
    case "SystemError":
      return {
        status: 500,
        body: bodyError("internal_server_error"),
        headers: emptyHeaders(),
      };

    case "ConfigurationError":
      return {
        status: 500,
        body: bodyError("server_misconfigured"),
        headers: emptyHeaders(),
      };

    default: {
      const _exhaustive: never = err;
      void _exhaustive;
      return {
        status: 500,
        body: bodyError("internal_server_error"),
        headers: emptyHeaders(),
      };
    }
  }
}

export function renderManagementDefect(): RenderedHttpError {
  return {
    status: 500,
    body: bodyError("internal_server_error"),
    headers: emptyHeaders(),
  };
}
