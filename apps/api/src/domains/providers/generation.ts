/**
 * Shared generation workflow (tasks 13.5 / 9.4–9.9).
 *
 * One path for OpenAI, Anthropic, and playground:
 * provider selection → fallback → usage → stream lifecycle → settle/outbox.
 * Protocol surfaces only translate requests and encode responses/SSE.
 *
 * Cancellation (13.6): AbortSignal flows into provider adapters; pre-commit
 * interrupt releases reservation without fabricated error bodies; post-commit
 * interrupt settles or enqueues outbox.
 */

import { Effect, Exit } from "effect";
import type { ObjectId } from "mongodb";
import type {
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  RateLimitRule,
} from "@tokenpanel/db";
import type { AppError } from "../../errors/families.ts";
import { SystemError } from "../../errors/families.ts";
import { classifyProviderError } from "../../errors/classify-provider.ts";
import { SAFE_MESSAGES } from "../../errors/safe-messages.ts";
import {
  getAdapter,
  buildAdapterContext,
  type ChatRequest,
  type ChatResponse,
  type StreamChunk,
} from "../../providers/index.ts";
import type { TokenUsage } from "../../providers/provider-usage.ts";
import { normalizeProcessedTotalTokens } from "../../providers/provider-usage.ts";
import { newGatewayRequestId } from "../../services/settlement-outbox.ts";
import type { SettlementActor } from "../settlement/settle.ts";
import type {
  BalanceReservation,
  LimitReservation,
} from "../billing/workflow.ts";
import {
  computeCharges,
  cacheAccountingForProtocol,
} from "../billing/charges.ts";
import { releaseAllPreflightHolds } from "../billing/workflow.ts";
import {
  settleOrOutboxWorkflow,
  type SettlementResult,
} from "../settlement/operations.ts";
import {
  callWithFallbackWorkflow,
  defaultLoadProviderDeps,
  streamWithFallbackWorkflow,
  type CallOutcome,
  type LoadProviderDeps,
  type StreamAttemptEvent,
} from "./selection.ts";
import {
  allowsFallback,
  initialStreamState,
  requiresSettlementConsideration,
  transitionStream,
  type StreamLifecycleState,
} from "./stream-lifecycle.ts";
import {
  usageFromChatResponse,
  type UsageOutcome,
} from "./usage.ts";
import { ProviderRepository } from "../ports/provider-repository.ts";

export type GenerationProtocol = "openai" | "anthropic";

export type GenerationError = AppError;

export type GenerationCharges = {
  readonly costMinor: number;
  readonly priceMinor: number;
  readonly currency: string;
};

export type GenerationCompleteResult = {
  readonly entry: ModelEntryDoc;
  readonly provider: ProviderDoc;
  readonly response: ChatResponse;
  readonly settlement: SettlementResult;
  readonly durationMs: number;
  readonly charges: GenerationCharges;
  readonly gatewayRequestId: string;
};

export type StreamUsageAccumulator = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedTotalTokens: number | undefined;
  cacheAccounting: "subset" | "additive";
  finishReason: string;
  streamComplete: boolean;
};

export type StreamFinalizeInput = {
  readonly orgId: ObjectId;
  readonly actor: SettlementActor;
  readonly model: ModelDoc;
  readonly protocol: GenerationProtocol;
  readonly gatewayRequestId: string;
  readonly reservedMinor: number;
  readonly reservation: BalanceReservation | null;
  readonly limitReservation?: LimitReservation | null | undefined;
  readonly rules: readonly RateLimitRule[];
  readonly startedAtMs: number;
  /** Force price (0 = free / unbilled). Omit to use computed charges. */
  readonly priceMinorOverride?: number | undefined;
  readonly lifecycle: StreamLifecycleState;
  readonly activeEntry: ModelEntryDoc | null;
  readonly activeProvider: ProviderDoc | null;
  readonly usage: StreamUsageAccumulator;
  /**
   * When true, settlement failures are swallowed (stream already committed
   * to client). When false, failures surface (JSON complete path).
   */
  readonly swallowSettleErrors?: boolean | undefined;
};

export type StreamFinalizeResult =
  | {
      readonly action: "released";
      readonly reason: "no_provider_attempt" | "pre_commit_interrupt";
    }
  | {
      readonly action: "settled" | "outbox" | "settle_failed";
      readonly settlement?: SettlementResult;
      readonly charges?: GenerationCharges;
      readonly hasAuthoritativeUsage: boolean;
      readonly durationMs: number;
    };

export type GenerationSessionParams = {
  readonly orgId: ObjectId;
  readonly model: ModelDoc;
  readonly request: ChatRequest;
  readonly actor: SettlementActor;
  readonly rules: readonly RateLimitRule[];
  readonly protocol: GenerationProtocol;
  readonly reservation: BalanceReservation | null;
  readonly limitReservation?: LimitReservation | null | undefined;
  readonly reservedMinor?: number | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly startedAtMs?: number | undefined;
  /** Force price (0 for management_internal / unbilled playground). */
  readonly priceMinorOverride?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly deps?: LoadProviderDeps | undefined;
};

/**
 * Live provider load deps via ProviderRepository on ManagedRuntime.
 * Requires App runtime installed (production boot / tests that install layers).
 * Unit tests should pass explicit `deps` instead.
 */
export function liveLoadProviderDeps(): LoadProviderDeps {
  let globalTimeoutMs: number | undefined;

  async function loadGlobalTimeoutMs(): Promise<number> {
    if (globalTimeoutMs !== undefined) return globalTimeoutMs;
    const { getAppRuntime } = await import("../../runtime/app-runtime.ts");
    const { AppConfig } = await import("../../runtime/services/app-config.ts");
    globalTimeoutMs = await getAppRuntime().runPromise(
      Effect.gen(function* () {
        const config = yield* AppConfig;
        return config.operational.providerHttpTimeoutMs;
      }),
    );
    return globalTimeoutMs;
  }

  return defaultLoadProviderDeps({
    loadProvider: async (orgId, providerId) => {
      // Warm global timeout on first provider load (same process lifetime).
      await loadGlobalTimeoutMs();
      // Lazy import avoids circular init with runtime boot.
      const { getAppRuntime } = await import("../../runtime/app-runtime.ts");
      const provider = await getAppRuntime().runPromise(
        Effect.gen(function* () {
          const repo = yield* ProviderRepository;
          return yield* repo.findById(
            orgId.toHexString(),
            providerId.toHexString(),
          );
        }),
      );
      if (!provider || !provider.active) {
        throw new Error("Configured provider is inactive or missing");
      }
      return provider;
    },
    getAdapter,
    buildAdapterContext: (p) => {
      // Prefer explicit timeoutMs from prepareAttempt (per-provider override
      // already resolved). When omitted, fall back to process global default.
      const timeoutMs =
        p.timeoutMs !== undefined
          ? p.timeoutMs
          : (globalTimeoutMs ?? 0);
      return buildAdapterContext({
        ...p,
        ...(timeoutMs > 0 ? { timeoutMs } : {}),
      });
    },
  });
}

function withSignal(
  request: ChatRequest,
  signal: AbortSignal | undefined,
): ChatRequest {
  if (!signal) return request;
  return { ...request, signal };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

/**
 * Non-streaming generation Effect: selection/fallback → settle/outbox.
 * On failure or interruption before settle: release reservation.
 */
export const completeGeneration = (
  params: GenerationSessionParams,
): Effect.Effect<
  GenerationCompleteResult,
  GenerationError,
  import("../settlement/settle.ts").SettleOrOutboxServices
> =>
  Effect.gen(function* () {
    const startedAtMs = params.startedAtMs ?? Date.now();
    const gatewayRequestId = params.gatewayRequestId ?? newGatewayRequestId();
    const reservedMinor =
      params.reservedMinor ?? params.reservation?.reservedMinor ?? 0;
    const deps = params.deps ?? liveLoadProviderDeps();
    const signal = params.signal;
    const request = withSignal(params.request, signal);

    const limitReservation = params.limitReservation ?? null;

    if (signal?.aborted) {
      yield* releaseAllPreflightHolds({
        reservation: params.reservation,
        limitReservation,
      });
      return yield* Effect.interrupt;
    }

    const outcome: CallOutcome = yield* callWithFallbackWorkflow({
      orgId: params.orgId,
      model: params.model,
      request,
      deps,
    }).pipe(
      Effect.catchAll((e) => {
        if (isAbortError(e) || signal?.aborted) {
          return Effect.interrupt as Effect.Effect<
            never,
            GenerationError,
            never
          >;
        }
        return Effect.fail(e as GenerationError);
      }),
    );

    // Provider finished: always settle (even if client later disconnects).
    const durationMs = Date.now() - startedAtMs;
    const usageOutcome = usageFromChatResponse({
      usageStatus: outcome.response.usageStatus,
      usage: outcome.response.usage,
      usageMissingReason: outcome.response.usageMissingReason,
      providerRequestId: outcome.response.providerRequestId,
    });

    const baseCharges = computeCharges({
      entry: outcome.entry,
      model: params.model,
      usage: outcome.response.usage,
    });
    const priceMinor =
      params.priceMinorOverride !== undefined
        ? params.priceMinorOverride
        : baseCharges.priceMinor;
    const charges: GenerationCharges = {
      costMinor: baseCharges.costMinor,
      priceMinor,
      currency: baseCharges.currency,
    };

    const settlement = yield* settleOrOutboxWorkflow({
      orgId: params.orgId,
      actor: params.actor,
      model: params.model,
      entry: outcome.entry,
      provider: outcome.provider,
      protocol: params.protocol,
      usageOutcome,
      providerRequestId: outcome.response.providerRequestId,
      gatewayRequestId,
      reservedMinor,
      limitReservation,
      status: 200,
      durationMs,
      rules: params.rules,
      priceMinorOverride: priceMinor,
      occurredAt: new Date(startedAtMs),
    });

    return {
      entry: outcome.entry,
      provider: outcome.provider,
      response: outcome.response,
      settlement,
      durationMs,
      charges,
      gatewayRequestId,
    };
  }).pipe(
    Effect.onExit((exit) => {
      // Release holds only when we never reached a successful settle path.
      if (Exit.isSuccess(exit)) return Effect.void;
      return releaseAllPreflightHolds({
        reservation: params.reservation,
        limitReservation: params.limitReservation ?? null,
      });
    }),
  );

export type StreamSession = {
  readonly gatewayRequestId: string;
  readonly startedAtMs: number;
  /** Mutable lifecycle; updated as chunks arrive. */
  getLifecycle: () => StreamLifecycleState;
  /** Iterate provider events (selection + fallback). */
  iterate: () => AsyncGenerator<StreamAttemptEvent, void, void>;
  /**
   * Apply a protocol-visible chunk to lifecycle (delta/done/error).
   * Callers still encode SSE; this only advances domain state.
   */
  noteChunk: (
    entryId: string,
    chunk: StreamChunk,
  ) => StreamLifecycleState;
  noteInterrupt: () => StreamLifecycleState;
  /**
   * Finalize: release reservation if never committed; else settle/outbox.
   * Safe to call once from ReadableStream finally / disconnect.
   */
  finalize: (
    input: Omit<
      StreamFinalizeInput,
      | "orgId"
      | "actor"
      | "model"
      | "protocol"
      | "gatewayRequestId"
      | "reservedMinor"
      | "reservation"
      | "limitReservation"
      | "rules"
      | "startedAtMs"
      | "priceMinorOverride"
      | "lifecycle"
    > & {
      readonly activeEntry: ModelEntryDoc | null;
      readonly activeProvider: ProviderDoc | null;
      readonly usage: StreamUsageAccumulator;
      readonly swallowSettleErrors?: boolean | undefined;
    },
  ) => Promise<StreamFinalizeResult>;
};

/**
 * Open a streaming generation session. Protocol routes drive SSE encoding;
 * domain owns fallback, lifecycle, and settlement finalization.
 */
export function openStreamGeneration(
  params: GenerationSessionParams,
): StreamSession {
  const startedAtMs = params.startedAtMs ?? Date.now();
  const gatewayRequestId = params.gatewayRequestId ?? newGatewayRequestId();
  const reservedMinor =
    params.reservedMinor ?? params.reservation?.reservedMinor ?? 0;
  const limitReservation = params.limitReservation ?? null;
  const deps = params.deps ?? liveLoadProviderDeps();
  const request = withSignal(params.request, params.signal);

  let lifecycle: StreamLifecycleState = initialStreamState();
  let finalized = false;

  const iterate = async function* (): AsyncGenerator<
    StreamAttemptEvent,
    void,
    void
  > {
    if (params.signal?.aborted) {
      lifecycle = transitionStream(lifecycle, { type: "interrupt" }).state;
      return;
    }
    for await (const event of streamWithFallbackWorkflow({
      orgId: params.orgId,
      model: params.model,
      request,
      deps,
    })) {
      if (params.signal?.aborted) {
        lifecycle = transitionStream(lifecycle, { type: "interrupt" }).state;
        return;
      }
      if (event.kind === "chunk") {
        lifecycle = noteChunkInternal(lifecycle, event.entry.id, event.chunk);
      } else if (event.kind === "terminal_fail") {
        lifecycle = transitionStream(lifecycle, {
          type: "provider_error",
          reason:
            event.err instanceof Error
              ? event.err.message
              : "provider_failed",
          maybeAccepted: false,
        }).state;
      }
      yield event;
    }
  };

  return {
    gatewayRequestId,
    startedAtMs,
    getLifecycle: () => lifecycle,
    iterate,
    noteChunk: (entryId, chunk) => {
      lifecycle = noteChunkInternal(lifecycle, entryId, chunk);
      return lifecycle;
    },
    noteInterrupt: () => {
      lifecycle = transitionStream(lifecycle, { type: "interrupt" }).state;
      return lifecycle;
    },
    finalize: async (input) => {
      if (finalized) {
        return {
          action: "released",
          reason: "no_provider_attempt",
        };
      }
      finalized = true;
      return finalizeStreamGeneration({
        orgId: params.orgId,
        actor: params.actor,
        model: params.model,
        protocol: params.protocol,
        gatewayRequestId,
        reservedMinor,
        reservation: params.reservation,
        limitReservation,
        rules: params.rules,
        startedAtMs,
        priceMinorOverride: params.priceMinorOverride,
        lifecycle,
        activeEntry: input.activeEntry,
        activeProvider: input.activeProvider,
        usage: input.usage,
        swallowSettleErrors: input.swallowSettleErrors ?? true,
      });
    },
  };
}

function noteChunkInternal(
  state: StreamLifecycleState,
  entryId: string,
  chunk: StreamChunk,
): StreamLifecycleState {
  if (chunk.type === "delta") {
    return transitionStream(state, { type: "delta", entryId }).state;
  }
  if (chunk.type === "done") {
    return transitionStream(state, {
      type: "done",
      entryId,
      streamComplete: chunk.streamComplete === true,
    }).state;
  }
  if (chunk.type === "error") {
    return transitionStream(state, {
      type: "provider_error",
      reason: chunk.error?.message ?? "stream error",
    }).state;
  }
  return state;
}

/**
 * Pure usage authority check for stream finalize (shared by all surfaces).
 */
export function streamUsageAuthority(usage: StreamUsageAccumulator): {
  readonly hasAuthoritativeUsage: boolean;
  readonly usageOutcome: UsageOutcome;
  readonly normalizedTotal: number | null;
} {
  const normalizedTotal = normalizeProcessedTotalTokens({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.reportedTotalTokens,
    cacheAccounting: usage.cacheAccounting,
  });
  const hasAuthoritativeUsage =
    usage.streamComplete &&
    normalizedTotal !== null &&
    (usage.promptTokens > 0 || usage.completionTokens > 0);

  if (hasAuthoritativeUsage && normalizedTotal !== null) {
    return {
      hasAuthoritativeUsage: true,
      normalizedTotal,
      usageOutcome: {
        status: "reported",
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          totalTokens: normalizedTotal,
          cacheAccounting: usage.cacheAccounting,
        },
      },
    };
  }

  const reason = !usage.streamComplete
    ? "stream_truncated"
    : normalizedTotal === null
      ? "usage_overflow"
      : "stream_usage_absent";
  return {
    hasAuthoritativeUsage: false,
    normalizedTotal,
    usageOutcome: { status: "missing", reason },
  };
}

export function emptyStreamUsage(
  protocol: GenerationProtocol,
): StreamUsageAccumulator {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedTotalTokens: undefined,
    cacheAccounting: cacheAccountingForProtocol(protocol),
    finishReason: protocol === "anthropic" ? "end_turn" : "stop",
    streamComplete: false,
  };
}

/**
 * Apply done-chunk usage into accumulator (protocol-agnostic fields).
 * StreamChunk is a flat type (not a TS discriminated union).
 */
export function applyDoneUsage(
  acc: StreamUsageAccumulator,
  chunk: StreamChunk,
): void {
  if (chunk.type !== "done") return;
  if (chunk.streamComplete) acc.streamComplete = true;
  if (chunk.finishReason) acc.finishReason = chunk.finishReason;
  if (chunk.streamComplete && chunk.usage) {
    acc.promptTokens = chunk.usage.promptTokens;
    acc.completionTokens = chunk.usage.completionTokens;
    acc.reasoningTokens = chunk.usage.reasoningTokens ?? 0;
    acc.cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
    acc.cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
    acc.reportedTotalTokens =
      typeof chunk.usage.totalTokens === "number"
        ? chunk.usage.totalTokens
        : undefined;
    if (
      chunk.usage.cacheAccounting === "subset" ||
      chunk.usage.cacheAccounting === "additive"
    ) {
      acc.cacheAccounting = chunk.usage.cacheAccounting;
    }
  }
}

/**
 * Finalize stream: pre-commit / no provider → release reservation.
 * Post-commit or provider attempt → settle or outbox (never free-bill).
 * Requires ManagedRuntime (task 14.1) — no Promise dual-path.
 */
export async function finalizeStreamGeneration(
  input: StreamFinalizeInput,
): Promise<StreamFinalizeResult> {
  const { getAppRuntime, isAppRuntimeInstalled } = await import(
    "../../runtime/app-runtime.ts"
  );

  const durationMs = Date.now() - input.startedAtMs;
  const lifecycle = input.lifecycle;

  // No provider attempt: pure release (pre-commit disconnect, early abort).
  if (!input.activeEntry || !input.activeProvider) {
    const needsBalanceRelease =
      input.reservation != null && input.reservation.reservedMinor > 0;
    const needsLimitRelease =
      input.limitReservation != null &&
      input.limitReservation.holds.length > 0;
    if (needsBalanceRelease || needsLimitRelease) {
      if (!isAppRuntimeInstalled()) {
        throw new SystemError({
          code: "system_error",
          message: SAFE_MESSAGES.server_misconfigured,
          diagnostic:
            "ManagedRuntime not installed for finalizeStreamGeneration release",
        });
      }
      await getAppRuntime().runPromise(
        releaseAllPreflightHolds({
          reservation: input.reservation,
          limitReservation: input.limitReservation,
        }),
      );
    }
    return {
      action: "released",
      reason:
        lifecycle.tag === "interrupted"
          ? "pre_commit_interrupt"
          : "no_provider_attempt",
    };
  }

  if (!isAppRuntimeInstalled()) {
    throw new SystemError({
      code: "system_error",
      message: SAFE_MESSAGES.server_misconfigured,
      diagnostic: "ManagedRuntime not installed for finalizeStreamGeneration",
    });
  }
  const runtime = getAppRuntime();

  // Provider attempted: settle/outbox. Reserved minor released inside settle.
  void requiresSettlementConsideration(lifecycle);
  const { hasAuthoritativeUsage, usageOutcome } = streamUsageAuthority(
    input.usage,
  );

  const tokenUsage: TokenUsage = {
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    reasoningTokens: input.usage.reasoningTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    totalTokens: streamUsageAuthority(input.usage).normalizedTotal ?? 0,
    cacheAccounting: input.usage.cacheAccounting,
  };

  const baseCharges = computeCharges({
    entry: input.activeEntry,
    model: input.model,
    usage: tokenUsage,
    cacheAccounting: input.usage.cacheAccounting,
  });
  const priceMinor =
    input.priceMinorOverride !== undefined
      ? input.priceMinorOverride
      : baseCharges.priceMinor;
  const charges: GenerationCharges = {
    costMinor: baseCharges.costMinor,
    priceMinor,
    currency: baseCharges.currency,
  };

  try {
    const settlement = await runtime.runPromise(
      settleOrOutboxWorkflow({
        orgId: input.orgId,
        actor: input.actor,
        model: input.model,
        entry: input.activeEntry,
        provider: input.activeProvider,
        protocol: input.protocol,
        usageOutcome,
        gatewayRequestId: input.gatewayRequestId,
        reservedMinor: input.reservedMinor,
        limitReservation: input.limitReservation,
        status: 200,
        durationMs,
        rules: [...input.rules],
        priceMinorOverride: priceMinor,
        occurredAt: new Date(input.startedAtMs),
      }),
    );
    return {
      action: settlement.settled ? "settled" : "outbox",
      settlement,
      charges,
      hasAuthoritativeUsage,
      durationMs,
    };
  } catch (err) {
    if (input.swallowSettleErrors !== false) {
      // Stream may already be committed — do not throw after client write.
      return {
        action: "settle_failed",
        charges,
        hasAuthoritativeUsage,
        durationMs,
      };
    }
    if (err instanceof SystemError) throw err;
    throw new SystemError({
      code: "system_error",
      message: SAFE_MESSAGES.system_error,
      diagnostic: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Map unknown provider failure to AppError for protocol renderers.
 * Never returns raw driver/JWT/crypto messages.
 */
export function classifyGenerationFailure(
  err: unknown,
  opts?: { streamCommitted?: boolean },
): AppError {
  if (
    typeof err === "object" &&
    err !== null &&
    "_tag" in err &&
    typeof (err as { _tag: unknown })._tag === "string"
  ) {
    // Already an AppError-like tagged error
    return err as AppError;
  }
  if (isAbortError(err)) {
    // Callers should treat as interruption, not render.
    return new SystemError({
      code: "system_error",
      message: SAFE_MESSAGES.system_error,
      diagnostic: "aborted",
    });
  }
  return classifyProviderError(err, {
    streamCommitted: opts?.streamCommitted === true,
  });
}

/** Whether fallback is still allowed for current lifecycle. */
export function generationAllowsFallback(
  lifecycle: StreamLifecycleState,
): boolean {
  return allowsFallback(lifecycle);
}

export type { CallOutcome, StreamAttemptEvent, StreamLifecycleState };
