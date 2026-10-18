/**
 * Shared Hono ↔ Effect boundary helpers (section 10 / 13.8).
 *
 * Thin adapters: decode → principal → domain Effect → classify → render.
 * One ManagedRuntime (getAppRuntime); no per-request Layer rebuild.
 * Correlation IDs on responses; structured redacted logging via toHttpResponse.
 */
import { Cause, Exit, type Effect } from "effect";
import type { Context } from "hono";
import { toHttpResponse, type RenderStyle } from "../../errors/boundary.ts";
import { logFieldsForAppError } from "../../errors/observability.ts";
import { policyFor } from "../../errors/policy.ts";
import { errorStyleOf } from "../error-context.ts";
import { renderStandardError } from "../renderers/standard.ts";
import type { HttpSurface } from "../../errors/variants.ts";
import type { AppError } from "../../errors/families.ts";
import { isAppError } from "../../errors/families.ts";
import {
  newCorrelationIds,
  type CorrelationIds,
  type StructuredLogFields,
} from "../../errors/observability.ts";
import type { RenderedHttpError } from "../renderers/types.ts";
import {
  getAppRuntime,
  type AppRuntime,
} from "../../runtime/app-runtime.ts";
import type { AppServices } from "../../runtime/layers/live.ts";

export type SuccessMapper<A> = (
  value: A,
  c: Context,
) => Response | Promise<Response>;

export type ErrorMapper<E> = (
  err: E,
  c: Context,
) => RenderedHttpError | null | undefined;

export type DomainEffectOptions<A, E> = {
  readonly surface: HttpSurface;
  readonly operation?: string;
  /** Default 200. Ignored when mapSuccess is set. */
  readonly successStatus?: number;
  readonly mapSuccess?: SuccessMapper<A>;
  /**
   * Legacy (version 1) override before default toHttpResponse rendering.
   * Return null/undefined to fall through to surface renderer. Never used
   * under the standard (admin, TokenPanel-Version 2): put client-facing data
   * on the AppError instead so the catalogue renders it.
   */
  readonly mapError?: ErrorMapper<E>;
  /** Standard only: convert a non-AppError failure into an AppError. */
  readonly toAppError?: (err: E) => AppError | null | undefined;
  /** Injected correlation; default: newCorrelationIds() per request. */
  readonly correlation?: CorrelationIds;
  /** Structured log sink; default: redacted console. */
  readonly log?: (fields: StructuredLogFields) => void;
};

const CORRELATION_HEADER = "x-request-id";
const TRACE_HEADER = "x-trace-id";

function defaultLog(fields: StructuredLogFields): void {
  const level = fields.level;
  const line = {
    ...fields,
    // Ensure private diagnostics never travel with a wrong key name.
  };
  if (level === "error") console.error(JSON.stringify(line));
  else if (level === "warn") console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

export function renderedToResponse(
  r: RenderedHttpError,
  correlation?: CorrelationIds,
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(r.headers)) {
    headers.set(k, v);
  }
  if (correlation) {
    headers.set(CORRELATION_HEADER, correlation.requestId);
    headers.set(TRACE_HEADER, correlation.traceId);
  }
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers,
  });
}

export function jsonSuccess(
  value: unknown,
  status = 200,
  correlation?: CorrelationIds,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (correlation) {
    headers[CORRELATION_HEADER] = correlation.requestId;
    headers[TRACE_HEADER] = correlation.traceId;
  }
  return new Response(JSON.stringify(value), { status, headers });
}

/**
 * Map Exit → Response using centralized toHttpResponse + optional overrides.
 * Never surfaces raw err.message from untyped failures — renderers only.
 */
export function mapExitToHttpResponse<A, E>(
  exit: Exit.Exit<A, E>,
  c: Context,
  options: DomainEffectOptions<A, E>,
  causeFailures: readonly E[],
): Response | Promise<Response> {
  const correlation = options.correlation ?? newCorrelationIds();
  const log = options.log ?? defaultLog;
  const requestStyle = errorStyleOf(c);
  const style: RenderStyle = {
    standard: requestStyle.standard,
    debug: requestStyle.debug,
  };

  if (Exit.isSuccess(exit)) {
    if (options.mapSuccess) {
      return options.mapSuccess(exit.value, c);
    }
    return jsonSuccess(exit.value, options.successStatus ?? 200, correlation);
  }

  const first = causeFailures[0];
  if (style.standard) {
    if (first !== undefined && !isAppError(first) && options.toAppError) {
      const converted = options.toAppError(first);
      if (converted) {
        log(
          logFieldsForAppError(converted, {
            level: policyFor(converted._tag).logLevel,
            correlation,
            surface: options.surface,
            ...(options.operation !== undefined
              ? { operation: options.operation }
              : {}),
          }),
        );
        return renderedToResponse(
          renderStandardError(options.surface, converted, style),
          correlation,
        );
      }
    }
  } else if (first !== undefined && options.mapError) {
    const override = options.mapError(first, c);
    if (override) return renderedToResponse(override, correlation);
  }

  // Password-change contract: invalid_credentials includes message.
  if (!style.standard && first !== undefined && isAppError(first as AppError)) {
    const appErr = first as AppError;
    if (
      options.surface === "admin" &&
      appErr._tag === "AuthenticationError" &&
      appErr.code === "invalid_credentials" &&
      appErr.message.length > 0 &&
      appErr.message !== "Invalid credentials"
    ) {
      return renderedToResponse(
        {
          status: 401,
          body: { error: "invalid_credentials", message: appErr.message },
          headers: {},
        },
        correlation,
      );
    }
  }

  const outcome = toHttpResponse(exit, {
    surface: options.surface,
    style,
    correlation,
    log,
    ...(options.operation !== undefined
      ? { operation: options.operation }
      : {}),
  });

  switch (outcome.kind) {
    case "success":
      return jsonSuccess(outcome.value, options.successStatus ?? 200, correlation);
    case "interruption":
      // Control flow only — no fabricated error body (13.6 / 4.8).
      return new Response(null, {
        status: 499,
        headers: {
          [CORRELATION_HEADER]: correlation.requestId,
          [TRACE_HEADER]: correlation.traceId,
        },
      });
    case "error":
    case "defect":
      return renderedToResponse(outcome.response, correlation);
    default: {
      const _e: never = outcome;
      void _e;
      return renderedToResponse(
        {
          status: 500,
          body: { error: "internal_server_error" },
          headers: {},
        },
        correlation,
      );
    }
  }
}

/**
 * Run a domain Effect on the process ManagedRuntime and render the Exit.
 * R must be satisfiable by AppServices (repositories + core services).
 * Propagates AbortSignal; classifies all failures before render (13.8).
 */
export async function runDomainEffect<A, E, R extends AppServices>(
  c: Context,
  program: Effect.Effect<A, E, R>,
  options: DomainEffectOptions<A, E>,
  runtime?: AppRuntime,
): Promise<Response> {
  const rt = runtime ?? getAppRuntime();
  const signal = c.req.raw.signal;
  const correlation = options.correlation ?? newCorrelationIds();
  const exit = await rt.runPromiseExit(
    program as Effect.Effect<A, E, AppServices>,
    { signal },
  );
  const failures = Exit.isFailure(exit)
    ? [...Cause.failures(exit.cause)]
    : [];
  return await mapExitToHttpResponse(
    exit,
    c,
    { ...options, correlation },
    failures,
  );
}

/** Admin surface shorthand. */
export function runAdminEffect<A, E, R extends AppServices>(
  c: Context,
  program: Effect.Effect<A, E, R>,
  options?: Omit<DomainEffectOptions<A, E>, "surface">,
): Promise<Response> {
  return runDomainEffect(c, program, {
    surface: "admin",
    ...options,
  });
}

/** Management surface shorthand. */
export function runManagementEffect<A, E, R extends AppServices>(
  c: Context,
  program: Effect.Effect<A, E, R>,
  options?: Omit<DomainEffectOptions<A, E>, "surface">,
): Promise<Response> {
  return runDomainEffect(c, program, {
    surface: "management",
    ...options,
  });
}

/** OpenAI protocol surface. */
export function runOpenAIEffect<A, E, R extends AppServices>(
  c: Context,
  program: Effect.Effect<A, E, R>,
  options?: Omit<DomainEffectOptions<A, E>, "surface">,
): Promise<Response> {
  return runDomainEffect(c, program, {
    surface: "openai",
    ...options,
  });
}

/** Anthropic protocol surface. */
export function runAnthropicEffect<A, E, R extends AppServices>(
  c: Context,
  program: Effect.Effect<A, E, R>,
  options?: Omit<DomainEffectOptions<A, E>, "surface">,
): Promise<Response> {
  return runDomainEffect(c, program, {
    surface: "anthropic",
    ...options,
  });
}

/**
 * Run Effect for middleware (set variables on success; return Response on failure).
 * Returns null when principal resolved so middleware can call next().
 */
export async function runMiddlewareEffect<A, E, R extends AppServices>(
  c: Context,
  program: Effect.Effect<A, E, R>,
  options: {
    /** Legacy (version 1) envelope surface; the standard uses the path's. */
    readonly surface: HttpSurface;
    readonly onSuccess: (value: A) => void;
    /** Legacy (version 1) override; ignored under the standard. */
    readonly mapError?: ErrorMapper<E>;
  },
  runtime?: AppRuntime,
): Promise<Response | null> {
  const rt = runtime ?? getAppRuntime();
  const signal = c.req.raw.signal;
  const correlation = newCorrelationIds();
  const exit = await rt.runPromiseExit(
    program as Effect.Effect<A, E, AppServices>,
    { signal },
  );
  if (Exit.isSuccess(exit)) {
    options.onSuccess(exit.value);
    return null;
  }
  const failures = [...Cause.failures(exit.cause)];
  const first = failures[0];
  const requestStyle = errorStyleOf(c);
  if (!requestStyle.standard && first !== undefined && options.mapError) {
    const override = options.mapError(first, c);
    if (override) return renderedToResponse(override, correlation);
  }
  const outcome = toHttpResponse(exit, {
    surface: requestStyle.standard ? requestStyle.surface : options.surface,
    style: { standard: requestStyle.standard, debug: requestStyle.debug },
    correlation,
    log: defaultLog,
  });
  if (outcome.kind === "interruption") {
    return new Response(null, {
      status: 499,
      headers: {
        [CORRELATION_HEADER]: correlation.requestId,
        [TRACE_HEADER]: correlation.traceId,
      },
    });
  }
  if (outcome.kind === "error" || outcome.kind === "defect") {
    return renderedToResponse(outcome.response, correlation);
  }
  return renderedToResponse(
    { status: 500, body: { error: "internal_server_error" }, headers: {} },
    correlation,
  );
}
