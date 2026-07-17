/**
 * Admin JSON error renderer (task 4.5).
 * Envelope: { error: string, reason?, details?, message?, ... } per golden matrix.
 */

import type { AppError } from "../../errors/families.ts";
import { publicMessageForCode, SAFE_MESSAGES } from "../../errors/safe-messages.ts";
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
 * Exhaustive admin mapping. Status + body match current route/middleware shapes.
 */
export function renderAdminError(err: AppError): RenderedHttpError {
  switch (err._tag) {
    case "ValidationError":
      return renderValidationError(err);

    case "AuthenticationError": {
      const headers = withRetryAfter(emptyHeaders(), err.retryAfterSeconds);
      if (err.reason !== undefined) {
        return {
          status: 401,
          body: bodyError("unauthorized", { reason: err.reason }),
          headers,
        };
      }
      if (err.code === "invalid_credentials") {
        return {
          status: 401,
          body: bodyError("invalid_credentials"),
          headers,
        };
      }
      return { status: 401, body: bodyError("unauthorized"), headers };
    }

    case "AuthorizationError": {
      if (err.code === "user_disabled" || err.reason === "user_disabled") {
        return {
          status: 403,
          body: bodyError("forbidden", { reason: "user_disabled" }),
          headers: emptyHeaders(),
        };
      }
      if (err.code === "missing_scope" || err.reason === "missing_scope") {
        return {
          status: 403,
          body: bodyError("forbidden", { reason: "missing_scope" }),
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
      return {
        status: err.httpStatus && err.httpStatus >= 400 && err.httpStatus < 500
          ? err.httpStatus
          : 400,
        body: bodyError(err.code, {
          message: publicMessageForCode(err.code, err.message),
        }),
        headers: emptyHeaders(),
      };

    case "ProviderUnavailableError":
      return {
        status: 502,
        body: bodyError(err.code, {
          message: publicMessageForCode(err.code, err.message),
        }),
        headers: emptyHeaders(),
      };

    case "ProviderTimeoutError":
      return {
        status: 504,
        body: bodyError(err.code, {
          message: publicMessageForCode(err.code, err.message),
        }),
        headers: emptyHeaders(),
      };

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
      return {
        status: 503,
        body: bodyError("dependency_unavailable"),
        headers: emptyHeaders(),
      };

    case "PersistenceTimeoutError":
      return {
        status: 503,
        body: bodyError("dependency_unavailable"),
        headers: emptyHeaders(),
      };

    case "PersistenceDataError":
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

    case "SystemError":
      return {
        status: 500,
        body: bodyError("internal_server_error"),
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

/** Sanitized admin 500 used for defects. */
export function renderAdminDefect(): RenderedHttpError {
  return {
    status: 500,
    body: bodyError("internal_server_error"),
    headers: emptyHeaders(),
  };
}

export function renderAdminMessage(
  status: number,
  error: string,
  extra?: Record<string, unknown>,
): RenderedHttpError {
  return {
    status,
    body: bodyError(error, extra),
    headers: emptyHeaders(),
  };
}

export { SAFE_MESSAGES };
