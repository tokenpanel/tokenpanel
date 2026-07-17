/**
 * Hono-to-Effect execution adapter (task 3.6).
 *
 * - Reuses one ManagedRuntime (no per-request Layer rebuild)
 * - Propagates request AbortSignal → fiber interruption
 * - Maps Exit to Response via pluggable renderer (default JSON)
 */
import { Cause, Exit, type Effect, type ManagedRuntime } from "effect";
import type { Context } from "hono";

export type ExitRenderer<A, E> = (
  exit: Exit.Exit<A, E>,
  c: Context,
) => Response | Promise<Response>;

/**
 * Default JSON renderer for Effect exits (fallback only — production routes
 * use boundary mapExitToHttpResponse with safe renderers).
 * - Success → 200 JSON body
 * - Interruption only → 499 (client closed; no body)
 * - Expected failure → 400 with stable sanitized message (no private cause)
 * - Defect → 500 internal_server_error (no private cause leak)
 */
export function defaultJsonRenderer<A, E>(
  exit: Exit.Exit<A, E>,
  _c: Context,
): Response {
  if (Exit.isSuccess(exit)) {
    return Response.json(exit.value);
  }
  const cause = exit.cause;
  if (Cause.isInterruptedOnly(cause)) {
    return new Response(null, { status: 499 });
  }
  const failures = [...Cause.failures(cause)];
  if (failures[0] !== undefined) {
    // Never echo raw Error.message — may contain driver/JWT/stack diagnostics.
    return Response.json(
      { error: "request_failed", message: "Request failed" },
      { status: 400 },
    );
  }
  return Response.json({ error: "internal_server_error" }, { status: 500 });
}

export type EffectHandlerOptions<A, E> = {
  readonly renderer?: ExitRenderer<A, E>;
};

/**
 * Bind a ManagedRuntime into a Hono-compatible handler factory.
 * The returned factory builds one handler per route; the runtime is shared.
 */
export function createEffectHandlerFactory<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
) {
  return function effectHandler<A, E>(
    program: (
      c: Context,
      signal: AbortSignal,
    ) => Effect.Effect<A, E, R>,
    options?: EffectHandlerOptions<A, E | ER>,
  ): (c: Context) => Promise<Response> {
    const renderer: ExitRenderer<A, E | ER> =
      options?.renderer ??
      ((exit, ctx) => defaultJsonRenderer<A, E | ER>(exit, ctx));
    return async (c: Context): Promise<Response> => {
      const signal = c.req.raw.signal;
      const exit = await runtime.runPromiseExit(program(c, signal), {
        signal,
      });
      return renderer(exit, c);
    };
  };
}

/**
 * One-shot run helper for routes that already hold a runtime reference.
 */
export async function runEffectAsResponse<R, ER, A, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  effect: Effect.Effect<A, E, R>,
  c: Context,
  options?: EffectHandlerOptions<A, E | ER>,
): Promise<Response> {
  const renderer: ExitRenderer<A, E | ER> =
    options?.renderer ??
    ((exit, ctx) => defaultJsonRenderer<A, E | ER>(exit, ctx));
  const signal = c.req.raw.signal;
  const exit = await runtime.runPromiseExit(effect, { signal });
  return renderer(exit, c);
}
