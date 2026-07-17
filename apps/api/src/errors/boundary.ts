/**
 * Effect Exit → HTTP boundary handling (task 4.8).
 * - Interruption = control flow (no fabricated error body)
 * - Defects log once with private cause; sanitized 500 when response possible
 * - Expected AppError → surface renderer
 */

import { Cause, Exit } from "effect";
import type { AppError } from "./families.ts";
import { isAppError } from "./families.ts";
import {
  logFieldsForAppError,
  logFieldsForDefect,
  logFieldsForInterruption,
  type CorrelationIds,
  type StructuredLogFields,
} from "./observability.ts";
import { policyFor } from "./policy.ts";
import { SAFE_MESSAGES } from "./safe-messages.ts";
import type { HttpSurface } from "./variants.ts";
import { renderAdminDefect, renderAdminError } from "../http/renderers/admin.ts";
import { renderAnthropicDefect, renderAnthropicError } from "../http/renderers/anthropic.ts";
import {
  renderManagementDefect,
  renderManagementError,
} from "../http/renderers/management.ts";
import { renderOpenAIDefect, renderOpenAIError } from "../http/renderers/openai.ts";
import type { BoundaryOutcome, RenderedHttpError } from "../http/renderers/types.ts";

export type ToHttpResponseOptions = {
  readonly surface: HttpSurface;
  readonly correlation?: CorrelationIds;
  readonly operation?: string;
  /**
   * When false, defects/interruptions that occur after the response started
   * must not attempt another write (streaming). Default true.
   */
  readonly responsePossible?: boolean;
  /** Optional sink for structured logs (defaults to no-op; tests inject). */
  readonly log?: (fields: StructuredLogFields) => void;
};

function renderError(surface: HttpSurface, err: AppError): RenderedHttpError {
  switch (surface) {
    case "admin":
      return renderAdminError(err);
    case "management":
      return renderManagementError(err);
    case "openai":
      return renderOpenAIError(err);
    case "anthropic":
      return renderAnthropicError(err);
    default: {
      const _e: never = surface;
      void _e;
      return renderAdminError(err);
    }
  }
}

function renderDefect(surface: HttpSurface): RenderedHttpError {
  switch (surface) {
    case "admin":
      return renderAdminDefect();
    case "management":
      return renderManagementDefect();
    case "openai":
      return renderOpenAIDefect();
    case "anthropic":
      return renderAnthropicDefect();
    default: {
      const _e: never = surface;
      void _e;
      return renderAdminDefect();
    }
  }
}

const loggedDefects = new WeakSet<object>();

/**
 * Map an Effect Exit to a boundary outcome for Hono adapters.
 */
export function toHttpResponse<A, E>(
  exit: Exit.Exit<A, E>,
  options: ToHttpResponseOptions,
): BoundaryOutcome {
  const responsePossible = options.responsePossible !== false;
  const log = options.log ?? (() => {});
  const ctx = {
    ...(options.correlation !== undefined
      ? { correlation: options.correlation }
      : {}),
    surface: options.surface,
    ...(options.operation !== undefined ? { operation: options.operation } : {}),
  };

  if (Exit.isSuccess(exit)) {
    return { kind: "success", value: exit.value };
  }

  const cause = exit.cause;

  // Interruption-only: control flow, not an application error.
  if (Cause.isInterruptedOnly(cause)) {
    log(logFieldsForInterruption(ctx));
    return { kind: "interruption" };
  }

  // Expected failures on the error channel.
  const failures = [...Cause.failures(cause)];
  const firstFailure = failures[0];
  if (firstFailure !== undefined && isAppError(firstFailure)) {
    const policy = policyFor(firstFailure._tag);
    log(
      logFieldsForAppError(firstFailure, {
        level: policy.logLevel,
        ...ctx,
      }),
    );
    return {
      kind: "error",
      response: renderError(options.surface, firstFailure),
    };
  }

  // Mixed interruption + failure: prefer failure rendering if AppError present.
  if (Cause.isInterrupted(cause) && failures.length === 0) {
    log(logFieldsForInterruption(ctx));
    return { kind: "interruption" };
  }

  // Defects (die) or untyped failures.
  const defects = [...Cause.defects(cause)];
  const defectCause =
    defects[0] ??
    (firstFailure !== undefined ? firstFailure : Cause.squash(cause));

  const privateLog = logFieldsForDefect(defectCause, ctx);
  // Log once per defect object when possible.
  if (typeof defectCause === "object" && defectCause !== null) {
    if (!loggedDefects.has(defectCause as object)) {
      loggedDefects.add(defectCause as object);
      log(privateLog);
    }
  } else {
    log(privateLog);
  }

  if (!responsePossible) {
    return { kind: "defect", response: renderDefect(options.surface), privateLog };
  }

  return {
    kind: "defect",
    response: renderDefect(options.surface),
    privateLog,
  };
}

/**
 * Convenience: render a known AppError without an Exit.
 */
export function renderAppError(
  err: AppError,
  surface: HttpSurface,
): RenderedHttpError {
  return renderError(surface, err);
}

/**
 * Map unknown thrown values (legacy Promise handlers) into RenderedHttpError.
 * Preferred path is Effect Exit + toHttpResponse.
 */
export function renderUnknownThrow(
  err: unknown,
  surface: HttpSurface,
  options?: {
    correlation?: CorrelationIds;
    operation?: string;
    log?: (fields: StructuredLogFields) => void;
  },
): RenderedHttpError {
  if (isAppError(err)) {
    return renderError(surface, err);
  }
  const log = options?.log ?? (() => {});
  log(
    logFieldsForDefect(err, {
      ...(options?.correlation !== undefined
        ? { correlation: options.correlation }
        : {}),
      surface,
      ...(options?.operation !== undefined
        ? { operation: options.operation }
        : {}),
    }),
  );
  void SAFE_MESSAGES;
  return renderDefect(surface);
}
