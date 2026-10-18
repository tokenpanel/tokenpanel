/**
 * Standard error renderer: the admin API, Management API with
 * TokenPanel-Version 2, and the OpenAI/Anthropic-compatible `/v1` routes.
 *
 * One PublicError (errors/catalog.ts) per failure, wrapped the way each
 * surface's clients expect:
 *   native (admin, management): { error: { code, message, details?, upstream? } }
 *   openai:    { error: { message, type, param, code, details? } }
 *   anthropic: { type: "error", error: { type, code, message, details? } }
 *
 * The protocol surfaces follow the providers' published contracts, because
 * SDKs choose exception classes and retries from the HTTP status:
 * - OpenAI: no 402 (quota is 429 `insufficient_quota`); `code` uses OpenAI's
 *   own value where one exists (invalid_api_key, model_not_found,
 *   rate_limit_exceeded, insufficient_quota).
 * - Anthropic: `type` per the documented status table.
 * Every standard error sets `x-should-retry` (honored by both SDKs before
 * their default 408/409/429/5xx retry rules) and Retry-After when known.
 */

import type { AppError } from "../../errors/families.ts";
import {
  ERROR_CATALOG,
  publicError,
  toPublicError,
  type CatalogEntry,
  type PublicError,
  type PublicErrorCode,
} from "../../errors/catalog.ts";
import type { HttpSurface } from "../../errors/variants.ts";
import type { RenderedHttpError } from "./types.ts";
import { emptyHeaders, withRetryAfter } from "./types.ts";

/** HTTP status for a public error on a surface (OpenAI has no 402). */
export function statusOnSurface(surface: HttpSurface, e: PublicError): number {
  if (surface === "openai") {
    if (e.code === "insufficient_balance") return 429;
    if (e.code === "currency_mismatch") return 400;
  }
  return e.status;
}

/** OpenAI `error.type` (values observed in OpenAI's API and error docs). */
export function openAIStandardType(status: number, code: PublicErrorCode): string {
  if (code === "insufficient_balance" || code === "budget_exceeded") {
    return "insufficient_quota";
  }
  if (status === 429) return "rate_limit_error";
  if (status === 503) return "service_unavailable_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

/** OpenAI's own `error.code` where an equivalent exists. */
const OPENAI_CODES: Partial<Record<PublicErrorCode, string>> = {
  unauthorized: "invalid_api_key",
  rate_limited: "rate_limit_exceeded",
  insufficient_balance: "insufficient_quota",
};

/** Anthropic `error.type` per its documented status table. */
export function anthropicStandardType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 402) return "billing_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 504) return "timeout_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

/** First validation issue path, for OpenAI's `param`. */
function paramOf(e: PublicError): string | null {
  const issues = e.details?.issues;
  if (!Array.isArray(issues)) return null;
  const first: unknown = issues[0];
  if (first && typeof first === "object" && "path" in first) {
    const path = (first as { path: unknown }).path;
    return typeof path === "string" && path.length > 0 ? path : null;
  }
  return null;
}

/** JSON body for a PublicError on a surface. */
export function standardErrorBody(
  surface: HttpSurface,
  e: PublicError,
): Record<string, unknown> {
  const details = e.details !== undefined ? { details: e.details } : {};
  const upstream = e.upstream !== undefined ? { upstream: e.upstream } : {};
  const status = statusOnSurface(surface, e);
  switch (surface) {
    case "openai":
      return {
        error: {
          message: e.message,
          type: openAIStandardType(status, e.code),
          param: paramOf(e),
          code: OPENAI_CODES[e.code] ?? e.code,
          ...details,
          ...upstream,
        },
      };
    case "anthropic":
      return {
        type: "error",
        error: {
          type: anthropicStandardType(status),
          code: e.code,
          message: e.message,
          ...details,
          ...upstream,
        },
      };
    case "admin":
    case "management":
      return {
        error: {
          code: e.code,
          message: e.message,
          ...details,
          ...upstream,
        },
      };
    default: {
      const _e: never = surface;
      void _e;
      return { error: { code: e.code, message: e.message } };
    }
  }
}

export function renderPublicError(
  surface: HttpSurface,
  e: PublicError,
): RenderedHttpError {
  const entry: CatalogEntry = ERROR_CATALOG[e.code];
  return {
    status: statusOnSurface(surface, e),
    body: standardErrorBody(surface, e),
    headers: {
      ...withRetryAfter(emptyHeaders(), e.retryAfterSeconds),
      "x-should-retry": entry.retryable ? "true" : "false",
    },
  };
}

/** Render an AppError under the standard. `debug` = admin upstream detail. */
export function renderStandardError(
  surface: HttpSurface,
  err: AppError,
  opts?: { readonly debug?: boolean },
): RenderedHttpError {
  return renderPublicError(surface, toPublicError(err, opts));
}

/** Render a catalogue code directly (route-level checks, middleware). */
export function renderStandardCode(
  surface: HttpSurface,
  code: PublicErrorCode,
  extra?: Parameters<typeof publicError>[1],
): RenderedHttpError {
  return renderPublicError(surface, publicError(code, extra));
}

export function renderStandardDefect(surface: HttpSurface): RenderedHttpError {
  return renderStandardCode(surface, "internal_error");
}

/** Validation issue as rendered under the standard (`path` dot-joined). */
export type StandardIssue = { readonly path: string; readonly message: string };

/**
 * validation_error with every issue in `details.issues` and the first one in
 * the message, so clients that only print `message` still see what failed.
 */
export function renderStandardValidation(
  surface: HttpSurface,
  issues: readonly StandardIssue[],
): RenderedHttpError {
  const first = issues[0];
  const message =
    first === undefined
      ? undefined
      : `Invalid request: ${first.path ? `${first.path}: ` : ""}${first.message}` +
        (issues.length > 1 ? ` (and ${issues.length - 1} more)` : "");
  return renderStandardCode(surface, "validation_error", {
    message,
    details: issues.length > 0 ? { issues } : undefined,
  });
}

/** SSE `data:` line for a terminal stream error (OpenAI or native). */
export function standardSseData(surface: HttpSurface, e: PublicError): string {
  return `data: ${JSON.stringify(standardErrorBody(surface, e))}\n\n`;
}

/** Anthropic SSE `event: error` frame. */
export function standardAnthropicSseEvent(e: PublicError): string {
  return `event: error\ndata: ${JSON.stringify(standardErrorBody("anthropic", e))}\n\n`;
}
