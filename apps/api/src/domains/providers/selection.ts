/**
 * Provider selection + fallback workflow (task 9.4).
 * Priority order, active filter, classification, maybe-accepted,
 * no post-commit fallback.
 */

import { Effect } from "effect";
import type { ObjectId } from "mongodb";
import type { ModelDoc, ModelEntryDoc, ProviderDoc } from "@tokenpanel/db";
import {
  ProviderUnavailableError,
  SystemError,
  type ProviderAppError,
} from "../../errors/families.ts";
import { classifyProviderError } from "../../errors/classify-provider.ts";
import {
  isFallbackAllowed,
  ProviderError,
} from "../../providers/provider-errors.ts";
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  StreamChunk,
} from "../../providers/types.ts";
import { decryptSecret } from "../../lib/crypto.ts";

/** Active entries sorted by priority ascending (lower = preferred). */
export function selectActiveEntries(
  model: ModelDoc,
): readonly ModelEntryDoc[] {
  return [...model.entries]
    .filter((e) => e.active)
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Pure fallback decision (stream-commit safety).
 * Never allows fallback after commit or when classifier forbids it.
 */
export function decideFallback(params: {
  readonly err: unknown;
  readonly streamCommitted: boolean;
}): { readonly allow: boolean; readonly reason: string } {
  if (params.streamCommitted) {
    return { allow: false, reason: "stream_committed" };
  }
  if (isFallbackAllowed(params.err, false)) {
    return { allow: true, reason: "fallback_eligible" };
  }
  return { allow: false, reason: "not_fallback_eligible" };
}

export type ProviderAttemptContext = {
  readonly entry: ModelEntryDoc;
  readonly provider: ProviderDoc;
  readonly adapter: ProviderAdapter;
  readonly ctx: AdapterContext;
  readonly upstreamReq: ChatRequest;
};

export type LoadProviderDeps = {
  /** Promise-based load — Effect programs wrap via Effect.tryPromise. */
  readonly loadProvider: (
    orgId: ObjectId,
    providerId: ObjectId,
  ) => Promise<ProviderDoc>;
  readonly getAdapter: (sdkType: string) => ProviderAdapter | undefined;
  readonly decryptApiKey: (encrypted: string) => string;
  readonly buildAdapterContext: (params: {
    baseUrl: string;
    apiKey: string;
    providerOrg?: string | null;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }) => AdapterContext;
};

export type CallOutcome = {
  readonly entry: ModelEntryDoc;
  readonly provider: ProviderDoc;
  readonly response: ChatResponse;
};

/**
 * Non-streaming call with ordered fallback.
 * Stops on non-fallback-eligible errors; never retries after success.
 */
export type CallWithFallbackError = ProviderAppError | SystemError;

export const callWithFallbackWorkflow = (params: {
  readonly orgId: ObjectId;
  readonly model: ModelDoc;
  readonly request: ChatRequest;
  readonly deps: LoadProviderDeps;
}): Effect.Effect<CallOutcome, CallWithFallbackError> =>
  Effect.gen(function* () {
    const entries = selectActiveEntries(params.model);
    if (entries.length === 0) {
      return yield* Effect.fail(
        new ProviderUnavailableError({
          code: "no_active_entries",
          message: "Model has no active provider entries",
          category: "unknown",
          phase: "request",
          retryClass: "never",
          fallbackClass: "ineligible",
          acceptanceClass: "not_accepted",
          streamCommitClass: "not_committed",
        }),
      );
    }

    let lastErr: unknown = null;
    for (const entry of entries) {
      const attempt = yield* prepareAttempt({
        orgId: params.orgId,
        entry,
        request: params.request,
        deps: params.deps,
      }).pipe(
        Effect.map((a) => ({ ok: true as const, attempt: a })),
        Effect.catchAll((e) =>
          Effect.succeed({ ok: false as const, err: e as unknown }),
        ),
      );

      if (!attempt.ok) {
        lastErr = attempt.err;
        const d = decideFallback({ err: attempt.err, streamCommitted: false });
        if (!d.allow) {
          return yield* Effect.fail(toProviderAppError(attempt.err, false));
        }
        continue;
      }

      const { attempt: a } = attempt;
      const result = yield* a.adapter.chatComplete(a.ctx, a.upstreamReq).pipe(
        Effect.map((response) => ({ ok: true as const, response })),
        Effect.catchAll((e) =>
          Effect.succeed({ ok: false as const, err: e as unknown }),
        ),
      );

      if (result.ok) {
        return {
          entry: a.entry,
          provider: a.provider,
          response: result.response,
        };
      }
      lastErr = result.err;
      const d = decideFallback({ err: result.err, streamCommitted: false });
      if (!d.allow) {
        return yield* Effect.fail(toProviderAppError(result.err, false));
      }
    }

    return yield* Effect.fail(
      new ProviderUnavailableError({
        code: "all_providers_failed",
        message:
          lastErr instanceof Error
            ? lastErr.message
            : "All providers failed",
        category: "unknown",
        phase: "request",
        retryClass: "never",
        fallbackClass: "ineligible",
        acceptanceClass: "not_accepted",
        streamCommitClass: "not_committed",
      }),
    );
  });

export type StreamAttemptEvent =
  | {
      readonly kind: "chunk";
      readonly entry: ModelEntryDoc;
      readonly provider: ProviderDoc;
      readonly chunk: StreamChunk;
      readonly streamCommitted: boolean;
    }
  | {
      readonly kind: "failover";
      readonly entry: ModelEntryDoc;
      readonly reason: string;
    }
  | {
      readonly kind: "terminal_fail";
      readonly entry: ModelEntryDoc;
      readonly provider: ProviderDoc | null;
      readonly err: unknown;
      readonly streamCommitted: boolean;
    };

/**
 * Streaming with ordered fallback. Yields structured events so callers
 * own SSE encoding. No fallback after first delta/done commit.
 */
export async function* streamWithFallbackWorkflow(params: {
  readonly orgId: ObjectId;
  readonly model: ModelDoc;
  readonly request: ChatRequest;
  readonly deps: LoadProviderDeps;
}): AsyncGenerator<StreamAttemptEvent, void, void> {
  const entries = selectActiveEntries(params.model);
  if (entries.length === 0) {
    yield {
      kind: "terminal_fail",
      entry: {
        id: "",
        providerId: params.orgId,
        upstreamModelId: "",
        priority: 0,
        active: false,
      },
      provider: null,
      err: new ProviderUnavailableError({
        code: "no_active_entries",
        message: "Model has no active provider entries",
        category: "unknown",
        phase: "request",
        retryClass: "never",
        fallbackClass: "ineligible",
        acceptanceClass: "not_accepted",
        streamCommitClass: "not_committed",
      }),
      streamCommitted: false,
    };
    return;
  }

  let lastError: unknown = null;
  for (const entry of entries) {
    let streamCommitted = false;
    let provider: ProviderDoc | null = null;
    try {
      // Async generator bridge: run prepare as interruptible Effect without
      // Effect.run* — use either path via Promise-based adapter deps.
      const attempt = await prepareAttemptAsPromise({
        orgId: params.orgId,
        entry,
        request: params.request,
        deps: params.deps,
      });
      provider = attempt.provider;
      let failoverToNext = false;
      for await (const chunk of attempt.adapter.streamChat(
        attempt.ctx,
        attempt.upstreamReq,
      )) {
        if (chunk.type === "delta" || chunk.type === "done") {
          streamCommitted = true;
        }
        if (chunk.type === "error" && !streamCommitted) {
          const soft = new Error(chunk.error?.message ?? "stream error");
          const d = decideFallback({ err: soft, streamCommitted: false });
          if (d.allow) {
            lastError = soft;
            failoverToNext = true;
            yield {
              kind: "failover",
              entry,
              reason: d.reason,
            };
            break;
          }
          yield {
            kind: "chunk",
            entry,
            provider: attempt.provider,
            chunk,
            streamCommitted: false,
          };
          yield {
            kind: "terminal_fail",
            entry,
            provider: attempt.provider,
            err: soft,
            streamCommitted: false,
          };
          return;
        }
        yield {
          kind: "chunk",
          entry,
          provider: attempt.provider,
          chunk,
          streamCommitted,
        };
      }
      if (failoverToNext) continue;
      return;
    } catch (err) {
      lastError = err;
      const d = decideFallback({ err, streamCommitted });
      if (!d.allow) {
        // Surface maybe-accepted pre-commit for outbox without committing stream.
        if (
          provider &&
          !streamCommitted &&
          isMaybeAccepted(err)
        ) {
          yield {
            kind: "chunk",
            entry,
            provider,
            chunk: {
              type: "error",
              error: {
                code: "accepted_upstream_failed",
                message: "provider failed after possible acceptance",
              },
            },
            streamCommitted: false,
          };
        }
        yield {
          kind: "terminal_fail",
          entry,
          provider,
          err,
          streamCommitted,
        };
        return;
      }
      yield {
        kind: "failover",
        entry,
        reason: d.reason,
      };
      continue;
    }
  }
  yield {
    kind: "terminal_fail",
    entry: entries[entries.length - 1]!,
    provider: null,
    err: lastError ?? new Error("All providers failed for stream"),
    streamCommitted: false,
  };
}

function isMaybeAccepted(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "maybeAcceptedUpstream" in err &&
    (err as ProviderError).maybeAcceptedUpstream === true
  );
}

function providerUnavailable(
  code:
    | "provider_unavailable"
    | "all_providers_failed"
    | "no_active_entries"
    | "adapter_missing"
    | "upstream_error",
  message: string,
  diagnostic?: string,
): ProviderUnavailableError {
  return new ProviderUnavailableError({
    code,
    message,
    category: "unknown",
    phase: "request",
    retryClass: "never",
    fallbackClass: "ineligible",
    acceptanceClass: "not_accepted",
    streamCommitClass: "not_committed",
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  });
}

/** Promise path for async generators (no Effect.run*). */
async function prepareAttemptAsPromise(params: {
  orgId: ObjectId;
  entry: ModelEntryDoc;
  request: ChatRequest;
  deps: LoadProviderDeps;
}): Promise<ProviderAttemptContext> {
  let provider: ProviderDoc;
  try {
    provider = await params.deps.loadProvider(
      params.orgId,
      params.entry.providerId,
    );
  } catch (e) {
    throw providerUnavailable(
      "provider_unavailable",
      e instanceof Error
        ? e.message
        : "Configured provider is inactive or missing",
    );
  }
  const adapter = params.deps.getAdapter(provider.sdkType);
  if (!adapter) {
    throw providerUnavailable(
      "adapter_missing",
      `No adapter for sdkType '${provider.sdkType}'`,
    );
  }
  let apiKey: string;
  try {
    apiKey = params.deps.decryptApiKey(provider.apiKeyEncrypted);
  } catch (e) {
    throw providerUnavailable(
      "provider_unavailable",
      "Failed to decrypt provider credentials",
      e instanceof Error ? e.message : String(e),
    );
  }
  const ctx = params.deps.buildAdapterContext({
    baseUrl: provider.baseUrl,
    apiKey,
    ...(provider.providerOrg !== undefined
      ? { providerOrg: provider.providerOrg }
      : {}),
    ...(provider.headers !== undefined
      ? { headers: provider.headers as Record<string, string> }
      : {}),
    ...(params.request.signal !== undefined
      ? { signal: params.request.signal }
      : {}),
  });
  return {
    entry: params.entry,
    provider,
    adapter,
    ctx,
    upstreamReq: {
      ...params.request,
      model: params.entry.upstreamModelId,
    },
  };
}

function prepareAttempt(params: {
  orgId: ObjectId;
  entry: ModelEntryDoc;
  request: ChatRequest;
  deps: LoadProviderDeps;
}): Effect.Effect<ProviderAttemptContext, ProviderUnavailableError> {
  return Effect.tryPromise({
    try: () => prepareAttemptAsPromise(params),
    catch: (e) =>
      e instanceof ProviderUnavailableError
        ? e
        : providerUnavailable(
            "provider_unavailable",
            e instanceof Error ? e.message : "provider prepare failed",
          ),
  });
}

function toProviderAppError(
  err: unknown,
  streamCommitted: boolean,
): CallWithFallbackError {
  return classifyProviderError(err, { streamCommitted });
}

/** Default deps wiring for dual-path (uses process registry + crypto). */
export function defaultLoadProviderDeps(params: {
  readonly loadProvider: (
    orgId: ObjectId,
    providerId: ObjectId,
  ) => Promise<ProviderDoc>;
  readonly getAdapter: (sdkType: string) => ProviderAdapter | undefined;
  readonly buildAdapterContext: (p: {
    baseUrl: string;
    apiKey: string;
    providerOrg?: string | null;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }) => AdapterContext;
}): LoadProviderDeps {
  return {
    loadProvider: params.loadProvider,
    getAdapter: params.getAdapter,
    decryptApiKey: decryptSecret,
    buildAdapterContext: params.buildAdapterContext,
  };
}
