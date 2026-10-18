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
import {
  renderManagementDefect,
  renderManagementError,
} from "../http/renderers/management.ts";
import {
  renderStandardDefect,
  renderStandardError,
} from "../http/renderers/standard.ts";
import type { BoundaryOutcome, RenderedHttpError } from "../http/renderers/types.ts";

/** Standard (catalogue) rendering vs legacy version 1; see http/error-context.ts. */
export type RenderStyle = {
  readonly standard: boolean;
  /** Admin-only upstream provider detail (standard only). */
  readonly debug: boolean;
};

export const LEGACY_STYLE: RenderStyle = { standard: false, debug: false };

export type ToHttpResponseOptions = {
  readonly surface: HttpSurface;
  /** Defaults to legacy version 1 rendering. */
  readonly style?: RenderStyle;
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

function renderError(
  surface: HttpSurface,
  err: AppError,
  style: RenderStyle = LEGACY_STYLE,
): RenderedHttpError {
  // The OpenAI/Anthropic-compatible surfaces have a single (standard)
  // behavior; only the native surfaces keep a legacy version 1 renderer.
  if (style.standard || surface === "openai" || surface === "anthropic") {
    return renderStandardError(surface, err, { debug: style.debug });
  }
  return surface === "admin" ? renderAdminError(err) : renderManagementError(err);
}

function renderDefect(
  surface: HttpSurface,
  style: RenderStyle = LEGACY_STYLE,
): RenderedHttpError {
  if (style.standard || surface === "openai" || surface === "anthropic") {
    return renderStandardDefect(surface);
  }
  return surface === "admin" ? renderAdminDefect() : renderManagementDefect();
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
      response: renderError(options.surface, firstFailure, options.style),
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
    return {
      kind: "defect",
      response: renderDefect(options.surface, options.style),
      privateLog,
    };
  }

  return {
    kind: "defect",
    response: renderDefect(options.surface, options.style),
    privateLog,
  };
}

/**
 * Convenience: render a known AppError without an Exit.
 */
export function renderAppError(
  err: AppError,
  surface: HttpSurface,
  style?: RenderStyle,
): RenderedHttpError {
  return renderError(surface, err, style);
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
    style?: RenderStyle;
  },
): RenderedHttpError {
  if (isAppError(err)) {
    return renderError(surface, err, options?.style);
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
  return renderDefect(surface, options?.style);
}
