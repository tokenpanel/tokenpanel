/**
 * Scoped provider HTTP Effects (task 9.5).
 * Timeout/cancel propagation, bounded private diagnostics, safe public failures.
 */

import { Effect, Scope } from "effect";
import {
  ProviderTimeoutError,
  SystemError,
  type ProviderAppError,
} from "../../errors/families.ts";
import { classifyProviderError } from "../../errors/classify-provider.ts";
import {
  providerHttpError,
  publicProviderErrorMessage,
} from "../../providers/provider-errors.ts";

/** Max chars retained in private diagnostic (never public). */
export const PROVIDER_DIAGNOSTIC_MAX_CHARS = 500;

export type ProviderHttpRequest = {
  readonly url: string;
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * App-level timeout. 0 / undefined = only AbortSignal cancels.
   * Unit: ms.
   */
  readonly timeoutMs?: number | undefined;
  readonly label?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly operation?: string | undefined;
};

export type ProviderHttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly diagnostic: string;
};

export type ProviderHttpError = ProviderAppError | SystemError;

function boundDiagnostic(text: string): string {
  return text.slice(0, PROVIDER_DIAGNOSTIC_MAX_CHARS);
}

function classifyOpts(
  req: ProviderHttpRequest,
  label: string,
): {
  label: string;
  streamCommitted: false;
  provider?: string;
  model?: string;
  operation?: string;
} {
  return {
    label,
    streamCommitted: false as const,
    ...(req.provider !== undefined ? { provider: req.provider } : {}),
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.operation !== undefined ? { operation: req.operation } : {}),
  };
}

/**
 * Perform one provider HTTP request as an Effect.
 * Uses AbortController merge of timeout + caller signal.
 * Does not throw raw Error — maps to ProviderAppError | SystemError.
 */
export const providerHttpRequest = (
  req: ProviderHttpRequest,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ProviderHttpResponse, ProviderHttpError> =>
  Effect.gen(function* () {
    const label = req.label ?? "upstream";
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) {
        controller.abort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = req.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const opts = classifyOpts(req, label);
      const res = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(req.url, {
            method: req.method ?? "POST",
            headers: req.headers as Record<string, string> | undefined,
            body: req.body,
            signal: controller.signal,
          }),
        catch: (e) => classifyProviderError(e, opts),
      });

      const bodyText = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (e) => classifyProviderError(e, opts),
      });

      const diagnostic = boundDiagnostic(bodyText);
      if (controller.signal.aborted && timeoutMs > 0 && !req.signal?.aborted) {
        return yield* Effect.fail(
          new ProviderTimeoutError({
            code: "provider_timeout",
            message: publicProviderErrorMessage(label),
            category: "timeout_ambiguous",
            phase: "request",
            retryClass: "transient",
            fallbackClass: "eligible",
            acceptanceClass: "maybe_accepted",
            streamCommitClass: "not_committed",
            timeoutMs,
            diagnostic,
            ...(req.provider !== undefined ? { provider: req.provider } : {}),
            ...(req.model !== undefined ? { model: req.model } : {}),
            ...(req.operation !== undefined
              ? { operation: req.operation }
              : {}),
          }),
        );
      }

      return {
        status: res.status,
        headers: res.headers,
        bodyText,
        diagnostic,
      };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (req.signal) {
        req.signal.removeEventListener("abort", onAbort);
      }
    }
  });

/**
 * Scoped fetch resource: acquires AbortController; aborts on scope close.
 */
export const scopedAbortController = (
  parent?: AbortSignal,
): Effect.Effect<AbortController, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const c = new AbortController();
      if (parent) {
        if (parent.aborted) c.abort();
        else {
          parent.addEventListener("abort", () => c.abort(), { once: true });
        }
      }
      return c;
    }),
    (c) =>
      Effect.sync(() => {
        if (!c.signal.aborted) c.abort();
      }),
  );

/**
 * Run provider HTTP with finalizer that aborts in-flight work on interrupt.
 */
export const providerHttpScoped = (
  req: ProviderHttpRequest,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ProviderHttpResponse, ProviderHttpError, Scope.Scope> =>
  Effect.gen(function* () {
    const controller = yield* scopedAbortController(req.signal);
    return yield* providerHttpRequest(
      { ...req, signal: controller.signal },
      fetchImpl,
    );
  });

/** Map non-2xx response to classified provider error (safe message). */
export function failIfNotOk(
  res: ProviderHttpResponse,
  opts: {
    readonly label?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly operation?: string;
    readonly phase?: "request" | "headers" | "body";
  } = {},
): Effect.Effect<ProviderHttpResponse, ProviderHttpError> {
  if (res.status >= 200 && res.status < 300) {
    return Effect.succeed(res);
  }
  const pe = providerHttpError(
    res.status,
    res.diagnostic,
    opts.phase ?? "request",
    opts.label ?? "upstream",
  );
  return Effect.fail(
    classifyProviderError(pe, {
      streamCommitted: false,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
    }),
  );
}

/**
 * Effect program for a scoped provider HTTP request.
 * Run only via ManagedRuntime / effect-handler adapters — not Effect.run*.
 */
export function providerHttpExit(
  req: ProviderHttpRequest,
  fetchImpl?: typeof fetch,
): Effect.Effect<ProviderHttpResponse, ProviderHttpError> {
  return Effect.scoped(providerHttpScoped(req, fetchImpl ?? fetch));
}
