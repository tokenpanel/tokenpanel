import { ObjectId } from "mongodb";
import {
  getDb,
  getClient,
  type ModelDoc,
  type ModelEntryDoc,
  type ProviderDoc,
  type UsageRecordDoc,
} from "@tokenpanel/db";
import { getAdapter, buildAdapterContext, type ChatRequest, type ChatResponse, type StreamChunk, type ChatMessage } from "../providers/index.ts";
import { decryptSecret } from "./crypto.ts";
import {
  getEffectiveRules,
  checkLimits,
  recordUsage,
  type ViolatedLimit,
} from "./rate-limits.ts";
import {
  isFallbackAllowed,
  publicProviderErrorMessage,
  ProviderError,
} from "../providers/provider-errors.ts";
import {
  compactGatewayRequestId,
  enqueueSettlementOutbox,
  resolveGatewayRequestId,
} from "../services/settlement-outbox.ts";
import type {
  CacheAccountingMode,
  ProviderUsage,
} from "../providers/provider-usage.ts";
import { normalizeProcessedTotalTokens } from "../providers/provider-usage.ts";
import { isDuplicateKeyError } from "./crypto.ts";
import { isReservationCanaryOrg } from "../services/canary.ts";
import {
  availableMinor,
  logRateShadowCompare,
  logReservationShadowCompare,
  releaseBalanceReservation,
  reserveBalance,
  settleBalanceWithReservation,
  wouldReserveSucceed,
} from "../services/reservation.ts";

export class BillingError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export type ResolvedModel = {
  model: ModelDoc;
};

export async function resolveModel(
  orgId: ObjectId,
  aliasId: string,
): Promise<ModelDoc> {
  const db = await getDb();
  const model = await db.models.findOne({
    organizationId: orgId,
    aliasId,
    active: true,
  });
  if (!model) {
    throw new BillingError(404, "model_not_found", `Model '${aliasId}' not found or inactive`);
  }
  return model;
}

export async function checkModelAccess(
  apiKeyModelWhitelist: string[],
  aliasId: string,
): Promise<void> {
  if (apiKeyModelWhitelist.length === 0) return;
  if (!apiKeyModelWhitelist.includes(aliasId)) {
    throw new BillingError(403, "model_not_allowed", `Your API key does not allow model '${aliasId}'`);
  }
}

export async function checkBalance(
  customerId: ObjectId,
  estimatedSpendMinor: number,
  currency: string,
): Promise<void> {
  if (estimatedSpendMinor <= 0) return;
  const db = await getDb();
  const customer = await db.customers.findOne({ _id: customerId });
  if (!customer) {
    throw new BillingError(403, "customer_not_found", "Customer not found");
  }
  if (customer.balance.currency !== currency) {
    // Enforce currency match: previously this returned silently, so a customer
    // whose balance currency differed from the model's could bypass the balance
    // check entirely and go negative (the debit $inc would also mix currencies).
    throw new BillingError(
      402,
      "currency_mismatch",
      "Customer balance currency does not match model currency",
      { balanceCurrency: customer.balance.currency, modelCurrency: currency },
    );
  }
  if (customer.balance.amountMinor < estimatedSpendMinor) {
    throw new BillingError(
      402,
      "insufficient_balance",
      "Insufficient balance to complete request",
      { balanceMinor: customer.balance.amountMinor, requiredMinor: estimatedSpendMinor, currency },
    );
  }
}

type EffectiveRules = Awaited<ReturnType<typeof getEffectiveRules>>;

/**
 * Conservative prompt-token estimate from the translated message array, used by
 * preFlight to enforce balance + token/spend limits BEFORE a paid upstream call.
 * Text content → ~4 chars/token; each non-text part (image/audio) → a fixed
 * overhead. Over-estimating is safe (may reject a marginal request); under-
 * estimating lets a customer exceed limits, which is what this guards against.
 */
const NON_TEXT_PART_TOKENS = 768;

export function estimatePromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let nonTextParts = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === "text") {
          chars += part.text?.length ?? 0;
        } else {
          nonTextParts += 1;
        }
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4) + nonTextParts * NON_TEXT_PART_TOKENS);
}

/**
 * Fallback completion cap (in tokens) when neither the request nor the model
 * config provides an output limit. OpenAI chat completions may omit
 * max_tokens/max_completion_tokens entirely; without a cap the pre-flight
 * spend estimate for completion tokens would be zero, bypassing balance and
 * spend-limit checks. 4096 is a conservative default that matches the common
 * upstream default; models with a known limits.output use that instead.
 */
export const DEFAULT_COMPLETION_CAP = 4096;

/**
 * Worst-case input + output price (minor units per million tokens) across the
 * model's ACTIVE entries. Settlement charges `entry.price ?? model.price`, so
 * a higher-priced fallback entry can spend more than model.price would suggest.
 * Pre-flight must reserve against the most expensive active entry so balance
 * and spend limits are not bypassed when failover lands on a pricier entry.
 * Entries without a price override fall back to model.price (the floor).
 */
export function worstCaseActiveEntryPrice(model: ModelDoc): {
  inputMinorPerMillion: number;
  outputMinorPerMillion: number;
} {
  const active = model.entries.filter((e) => e.active);
  let maxIn = model.price.inputMinorPerMillion;
  let maxOut = model.price.outputMinorPerMillion;
  for (const e of active) {
    const s = e.price ?? model.price;
    if (s.inputMinorPerMillion > maxIn) maxIn = s.inputMinorPerMillion;
    if (s.outputMinorPerMillion > maxOut) maxOut = s.outputMinorPerMillion;
  }
  return { inputMinorPerMillion: maxIn, outputMinorPerMillion: maxOut };
}

/**
 * Resolve the completion token cap for pre-flight estimation. Preference:
 * request max_tokens > model.limits.output > DEFAULT_COMPLETION_CAP. Returns 0
 * only when explicitly passed 0 (caller intent: no completion expected).
 */
export function resolveCompletionCap(
  maxCompletionTokens: number | undefined,
  model: ModelDoc,
): number {
  if (maxCompletionTokens !== undefined) return Math.max(0, maxCompletionTokens);
  return Math.max(0, model.limits.output ?? DEFAULT_COMPLETION_CAP);
}

/** Hold placed during preFlight for canary orgs (release on fail / settle). */
export type BalanceReservation = {
  reservedMinor: number;
  customerId: ObjectId;
  organizationId: ObjectId;
};

export async function preFlight(params: {
  orgId: ObjectId;
  customerId: ObjectId;
  apiKeyModelWhitelist: string[];
  aliasId: string;
  /** Conservative prompt-token estimate (from estimatePromptTokens). */
  estimatedPromptTokens?: number;
  /** Completion cap (max_tokens) — upper bound on output tokens. */
  maxCompletionTokens?: number;
  scopeTarget?: string;
}): Promise<{
  model: ModelDoc;
  rules: EffectiveRules;
  /** Non-null when canary path held balance (caller must settle or release). */
  reservation: BalanceReservation | null;
}> {
  await checkModelAccess(params.apiKeyModelWhitelist, params.aliasId);
  const model = await resolveModel(params.orgId, params.aliasId);
  const db = await getDb();
  const rules = await getEffectiveRules(db, params.customerId);
  const canary = isReservationCanaryOrg(params.orgId);
  const orgIdTail = params.orgId.toHexString().slice(-8);

  // Conservative pre-call estimate. Completion is bounded by max_tokens (an
  // upper bound on actual output); prompt by estimatePromptTokens. Spend is
  // derived from the worst-case ACTIVE entry price (entry.price ?? model.price)
  // so higher-priced fallback entries cannot bypass balance/spend limits, and
  // the completion cap falls back to model.limits.output or a default when the
  // request omits max_tokens (OpenAI allows this) — previously completion was
  // estimated as zero, so balance + spend/token limits were never enforced and
  // customers could go negative / exceed limits until settlement.
  const prompt = Math.max(0, params.estimatedPromptTokens ?? 0);
  const completion = resolveCompletionCap(params.maxCompletionTokens, model);
  const estimatedTokens = prompt + completion;
  const price = worstCaseActiveEntryPrice(model);
  const estimatedSpendMinor =
    Math.ceil((prompt * price.inputMinorPerMillion) / 1_000_000) +
    Math.ceil((completion * price.outputMinorPerMillion) / 1_000_000);

  if (rules.length > 0 && estimatedTokens > 0) {
    // Dual-read rate decision (legacy tumbling window). Shadow compare re-runs
    // the same check for observability until a second algorithm lands; canary
    // still enforces via checkLimits (fixed-window ADR 001).
    const result = await checkLimits({
      db,
      customerId: params.customerId,
      rules,
      estimatedTokens,
      estimatedSpendMinor,
      modelAliasId: params.aliasId,
      scopeTarget: params.scopeTarget,
    });
    const dual = await checkLimits({
      db,
      customerId: params.customerId,
      rules,
      estimatedTokens,
      estimatedSpendMinor,
      modelAliasId: params.aliasId,
      scopeTarget: params.scopeTarget,
    });
    logRateShadowCompare({
      orgIdTail,
      legacyOk: result.ok,
      dualOk: dual.ok,
      enforced: canary,
    });
    if (!result.ok) {
      const v = result.violated[0] as ViolatedLimit | undefined;
      if (v) {
        throw new BillingError(429, "rate_limited", `Rate limit exceeded: ${v.rule.dimension} cap ${v.cap} in ${v.rule.windowSeconds}s window`, {
          retryAfterSeconds: v.retryAfterSeconds,
          dimension: v.rule.dimension,
          cap: v.cap,
          current: v.current,
          windowSeconds: v.rule.windowSeconds,
        });
      }
      throw new BillingError(429, "rate_limited", "Rate limit exceeded");
    }
  }

  let reservation: BalanceReservation | null = null;
  if (estimatedSpendMinor > 0) {
    const customer = await db.customers.findOne({ _id: params.customerId });
    if (!customer) {
      throw new BillingError(403, "customer_not_found", "Customer not found");
    }
    const snap = {
      amountMinor: customer.balance.amountMinor,
      reservedMinor: customer.balance.reservedMinor ?? 0,
      currency: customer.balance.currency,
    };
    const legacyOk =
      snap.currency === model.currency &&
      snap.amountMinor >= estimatedSpendMinor;
    const reservationDecision = wouldReserveSucceed(
      snap,
      estimatedSpendMinor,
      model.currency,
    );
    logReservationShadowCompare({
      orgIdTail,
      legacyOk,
      reservationOk: reservationDecision.ok,
      needMinor: estimatedSpendMinor,
      availableMinor: availableMinor(snap),
      amountMinor: snap.amountMinor,
      reservedMinor: snap.reservedMinor,
      enforced: canary,
    });

    if (canary) {
      // Enforcement: atomic available-balance hold.
      const held = await reserveBalance({
        customerId: params.customerId,
        organizationId: params.orgId,
        needMinor: estimatedSpendMinor,
        currency: model.currency,
      });
      if (!held.reserved) {
        throw new BillingError(
          402,
          "insufficient_balance",
          "Insufficient available balance to complete request",
          {
            availableMinor: availableMinor(snap),
            requiredMinor: estimatedSpendMinor,
            currency: model.currency,
          },
        );
      }
      if (held.reservedMinor > 0) {
        reservation = {
          reservedMinor: held.reservedMinor,
          customerId: params.customerId,
          organizationId: params.orgId,
        };
      }
    } else {
      // Legacy enforcement reader (ADR 001 until canary cutover).
      await checkBalance(params.customerId, estimatedSpendMinor, model.currency);
    }
  }
  return { model, rules, reservation };
}

/** Best-effort release of a preFlight hold (upstream failure / cancel). */
export async function releasePreFlightReservation(
  reservation: BalanceReservation | null | undefined,
): Promise<void> {
  if (!reservation || reservation.reservedMinor <= 0) return;
  try {
    await releaseBalanceReservation({
      customerId: reservation.customerId,
      organizationId: reservation.organizationId,
      reservedMinor: reservation.reservedMinor,
    });
  } catch (err) {
    console.error("[reservation] release failed", {
      customerId: reservation.customerId.toHexString(),
      reservedMinor: reservation.reservedMinor,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function loadProvider(orgId: ObjectId, providerId: ObjectId): Promise<ProviderDoc> {
  const db = await getDb();
  const provider = await db.providers.findOne({
    _id: providerId,
    organizationId: orgId,
    active: true,
  });
  if (!provider) {
    throw new BillingError(502, "provider_unavailable", "Configured provider is inactive or missing");
  }
  return provider;
}

export type CallOutcome = {
  entry: ModelEntryDoc;
  provider: ProviderDoc;
  response: ChatResponse;
};

export async function callWithFallback(params: {
  orgId: ObjectId;
  model: ModelDoc;
  request: ChatRequest;
}): Promise<CallOutcome> {
  const { orgId, model, request } = params;
  const entries = [...model.entries]
    .filter((e) => e.active)
    .sort((a, b) => a.priority - b.priority);

  if (entries.length === 0) {
    throw new BillingError(503, "no_active_entries", "Model has no active provider entries");
  }

  let lastError: Error | null = null;
  for (const entry of entries) {
    try {
      const provider = await loadProvider(orgId, entry.providerId);
      const adapter = getAdapter(provider.sdkType);
      if (!adapter) {
        throw new BillingError(502, "adapter_missing", `No adapter for sdkType '${provider.sdkType}'`);
      }
      const apiKey = decryptSecret(provider.apiKeyEncrypted);
      const ctx = buildAdapterContext({
        baseUrl: provider.baseUrl,
        apiKey,
        providerOrg: provider.providerOrg,
        headers: provider.headers,
      });
      const upstreamReq: ChatRequest = {
        ...request,
        model: entry.upstreamModelId,
      };
      const response = await adapter.chatComplete(ctx, upstreamReq);
      return { entry, provider, response };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof BillingError && err.status !== 502) {
        throw err;
      }
      if (err instanceof ProviderError && !isFallbackAllowed(err, false)) {
        throw new BillingError(
          502,
          "provider_error",
          publicProviderErrorMessage("provider", err.httpStatus),
          { category: err.category },
        );
      }
      if (!isFallbackAllowed(err, false)) {
        throw lastError instanceof BillingError
          ? lastError
          : new BillingError(
              502,
              "provider_error",
              lastError instanceof ProviderError
                ? publicProviderErrorMessage("provider", lastError.httpStatus)
                : "provider request failed",
            );
      }
      continue;
    }
  }
  throw new BillingError(502, "all_providers_failed", lastError?.message ?? "All providers failed");
}

export async function* streamWithFallback(params: {
  orgId: ObjectId;
  model: ModelDoc;
  request: ChatRequest;
}): AsyncGenerator<{ entry: ModelEntryDoc; provider: ProviderDoc; chunk: StreamChunk }, void, void> {
  const { orgId, model, request } = params;
  const entries = [...model.entries]
    .filter((e) => e.active)
    .sort((a, b) => a.priority - b.priority);

  if (entries.length === 0) {
    throw new BillingError(503, "no_active_entries", "Model has no active provider entries");
  }

  let lastError: Error | null = null;
  for (const entry of entries) {
    let streamCommitted = false;
    let provider: ProviderDoc | null = null;
    try {
      provider = await loadProvider(orgId, entry.providerId);
      const adapter = getAdapter(provider.sdkType);
      if (!adapter) {
        throw new BillingError(502, "adapter_missing", `No adapter for sdkType '${provider.sdkType}'`);
      }
      const apiKey = decryptSecret(provider.apiKeyEncrypted);
      const ctx = buildAdapterContext({
        baseUrl: provider.baseUrl,
        apiKey,
        providerOrg: provider.providerOrg,
        headers: provider.headers,
      });
      const upstreamReq: ChatRequest = {
        ...request,
        model: entry.upstreamModelId,
      };
      let failoverToNext = false;
      for await (const chunk of adapter.streamChat(ctx, upstreamReq)) {
        // First client-visible protocol delta/byte commits the stream.
        if (chunk.type === "delta" || chunk.type === "done") {
          streamCommitted = true;
        }
        if (chunk.type === "error" && !streamCommitted) {
          // Pre-delta error chunks: only soft connection-style messages may
          // failover. Otherwise headers may already have been accepted
          // (malformed SSE, parse failure). Yield entry/provider so the route
          // can enqueue settlement outbox, then terminal-fail (do not failover).
          const soft = new Error(chunk.error?.message ?? "stream error");
          if (isFallbackAllowed(soft, false)) {
            lastError = soft;
            failoverToNext = true;
            break;
          }
          yield { entry, provider, chunk };
          throw new BillingError(
            502,
            "provider_error",
            chunk.error?.message ?? "stream error",
          );
        }
        yield { entry, provider, chunk };
      }
      if (failoverToNext) {
        continue; // next provider entry
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof BillingError && err.status !== 502) {
        throw err;
      }
      if (!isFallbackAllowed(err, streamCommitted)) {
        // Pre-delta accepted-upstream failure: surface provider attempt so the
        // route can create a settlement outbox (no chunk was ever yielded).
        if (
          provider &&
          !streamCommitted &&
          err instanceof ProviderError &&
          err.maybeAcceptedUpstream
        ) {
          yield {
            entry,
            provider,
            chunk: {
              type: "error",
              error: {
                code: "accepted_upstream_failed",
                message: publicProviderErrorMessage(
                  "provider",
                  err.httpStatus,
                ),
              },
            },
          };
        }
        throw err instanceof BillingError
          ? err
          : new BillingError(
              502,
              "provider_error",
              err instanceof ProviderError
                ? publicProviderErrorMessage("provider", err.httpStatus)
                : "stream failed",
            );
      }
      continue;
    }
  }
  throw new BillingError(
    502,
    "all_providers_failed",
    lastError?.message ?? "All providers failed for stream",
  );
}

/**
 * Snapshot for durable outbox / recon — pricing + actor ids, never secrets or prompts.
 * Freezes request-time rules and occurredAt so delayed recon does not apply
 * current rate-limit windows or a late wall-clock timestamp.
 */
/** Protocol default when adapters did not stamp usage.cacheAccounting. */
export function cacheAccountingForProtocol(
  protocol: "openai" | "anthropic",
): CacheAccountingMode {
  return protocol === "anthropic" ? "additive" : "subset";
}

function outboxReconContext(params: {
  actor: SettlementActor;
  model: ModelDoc;
  entry: ModelEntryDoc;
  provider: ProviderDoc;
  status: number;
  durationMs: number;
  errorCode?: string;
  usage?: ChatResponse["usage"];
  priceMinor?: number;
  costMinor?: number;
  currency?: string;
  priceMinorOverride?: number;
  /** Request-time rate-limit rules (frozen snapshot). */
  rules?: EffectiveRules;
  /** Request-time timestamp for analytics + rate-limit buckets. */
  occurredAt?: Date;
  /** Explicit cache mode (adapter stamp or protocol default). */
  cacheAccounting?: CacheAccountingMode;
  /** Canary balance hold to release on recon settle. */
  reservedMinor?: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const priceSchedule = params.entry.price ?? params.model.price;
  const costSchedule = params.entry.cost;
  const occurredAt = params.occurredAt ?? new Date();
  const cacheAccounting =
    params.cacheAccounting ??
    (params.usage
      ? resolveCacheAccounting(params.usage)
      : undefined);
  const usageFrozen =
    params.usage && cacheAccounting
      ? { ...params.usage, cacheAccounting }
      : params.usage;
  return {
    actorKind: params.actor.actorKind,
    apiKeyId: params.actor.apiKeyId?.toHexString() ?? null,
    managementKeyId: params.actor.managementKeyId?.toHexString() ?? null,
    customerEmail: params.actor.customerEmail ?? null,
    status: params.status,
    durationMs: params.durationMs,
    errorCode: params.errorCode,
    currency: params.currency ?? params.model.currency,
    providerId: params.provider._id.toHexString(),
    upstreamModelId: params.entry.upstreamModelId,
    // ISO string so JSON-friendly outbox context survives Mongo storage.
    occurredAt: occurredAt.toISOString(),
    priceSchedule: {
      inputMinorPerMillion: priceSchedule.inputMinorPerMillion,
      outputMinorPerMillion: priceSchedule.outputMinorPerMillion,
      reasoningMinorPerMillion: priceSchedule.reasoningMinorPerMillion,
      cacheReadMinorPerMillion: priceSchedule.cacheReadMinorPerMillion,
      cacheWriteMinorPerMillion: priceSchedule.cacheWriteMinorPerMillion,
    },
    ...(costSchedule
      ? {
          costSchedule: {
            inputMinorPerMillion: costSchedule.inputMinorPerMillion,
            outputMinorPerMillion: costSchedule.outputMinorPerMillion,
            reasoningMinorPerMillion: costSchedule.reasoningMinorPerMillion,
            cacheReadMinorPerMillion: costSchedule.cacheReadMinorPerMillion,
            cacheWriteMinorPerMillion: costSchedule.cacheWriteMinorPerMillion,
          },
        }
      : {}),
    ...(params.rules ? { rules: params.rules } : {}),
    ...(usageFrozen ? { usage: usageFrozen } : {}),
    // Top-level freeze so recon can reprice without re-deriving from amounts.
    ...(cacheAccounting ? { cacheAccounting } : {}),
    ...(params.priceMinor !== undefined ? { priceMinor: params.priceMinor } : {}),
    ...(params.costMinor !== undefined ? { costMinor: params.costMinor } : {}),
    ...(params.priceMinorOverride !== undefined
      ? { priceMinorOverride: params.priceMinorOverride }
      : {}),
    ...(params.reservedMinor !== undefined && params.reservedMinor > 0
      ? { reservedMinor: params.reservedMinor }
      : {}),
    ...(params.extra ?? {}),
  };
}

/**
 * Settle reported usage, or enqueue durable outbox when usage is missing.
 * Never silently bills zero for a completed upstream call with missing usage.
 *
 * Outbox enqueue failures propagate (do not log-only swallow) so callers can
 * fail the request rather than treat unpaid work as complete.
 */
export async function settleUsageOrOutbox(params: {
  orgId: ObjectId;
  actor: SettlementActor;
  model: ModelDoc;
  entry: ModelEntryDoc;
  provider: ProviderDoc;
  protocol: "openai" | "anthropic";
  /** Prefer structured ProviderUsage; falls back to response.usageStatus. */
  providerUsage?: ProviderUsage;
  response?: ChatResponse;
  providerRequestId?: string;
  /**
   * Stable idempotency key for this gateway request. Generate once per HTTP
   * request and pass on every settle attempt so the unique index dedupes.
   */
  gatewayRequestId?: string;
  /**
   * Canary balance hold from preFlight. Released (and actual debited) on settle;
   * frozen into outbox when immediate settle cannot complete.
   */
  reservedMinor?: number;
  status: number;
  durationMs: number;
  errorCode?: string;
  rules: EffectiveRules;
  /** Override computed customer price (e.g. management_internal → 0). */
  priceMinorOverride?: number;
  /**
   * Request-time timestamp frozen into usage analytics and rate-limit buckets.
   * Defaults to now; pass the request start so delayed recon stays correct.
   */
  occurredAt?: Date;
}): Promise<{ settled: boolean; outboxId?: ObjectId }> {
  // Freeze once for both immediate settle and outbox snapshot.
  const occurredAt = params.occurredAt ?? new Date();
  let providerUsage = params.providerUsage;
  if (!providerUsage && params.response) {
    // Only explicit "reported" may settle. Unspecified/missing → outbox
    // (never assume free zero for a completed upstream call).
    if (params.response.usageStatus === "reported") {
      providerUsage = { status: "reported", usage: params.response.usage };
    } else {
      providerUsage = {
        status: "missing",
        reason:
          params.response.usageMissingReason ??
          (params.response.usageStatus === "missing"
            ? "usage_missing"
            : "usage_status_unspecified"),
        providerRequestId: params.response.providerRequestId,
      };
    }
  }
  if (!providerUsage) {
    providerUsage = { status: "missing", reason: "usage_not_provided" };
  }

  const providerRequestId =
    params.providerRequestId ??
    (providerUsage.status === "missing"
      ? providerUsage.providerRequestId
      : params.response?.providerRequestId);

  const gatewayRequestId = resolveGatewayRequestId({
    gatewayRequestId: params.gatewayRequestId,
    providerRequestId,
    organizationId: params.orgId,
  });

  const outboxBase = {
    organizationId: params.orgId,
    customerId: params.actor.customerId,
    gatewayRequestId,
    modelAliasId: params.model.aliasId,
    providerId: params.provider._id,
    upstreamModelId: params.entry.upstreamModelId,
    protocol: params.protocol,
    providerRequestId,
  };

  const protocolCacheAccounting = cacheAccountingForProtocol(params.protocol);

  const reservedMinor = Math.max(0, params.reservedMinor ?? 0);

  if (providerUsage.status === "missing") {
    const outboxId = await enqueueSettlementOutbox({
      ...outboxBase,
      reason: providerUsage.reason,
      context: outboxReconContext({
        actor: params.actor,
        model: params.model,
        entry: params.entry,
        provider: params.provider,
        status: params.status,
        durationMs: params.durationMs,
        errorCode: params.errorCode,
        priceMinorOverride: params.priceMinorOverride,
        rules: params.rules,
        occurredAt,
        cacheAccounting: protocolCacheAccounting,
        reservedMinor,
        extra: { reason: providerUsage.reason },
      }),
    });
    console.error("[settleUsage] missing provider usage — outbox enqueued", {
      gatewayRequestId,
      outboxId: outboxId.toHexString(),
      reason: providerUsage.reason,
      model: params.model.aliasId,
    });
    return { settled: false, outboxId };
  }
  // Stamp cache mode on usage so charges + outbox freeze stay consistent.
  const usage = {
    ...providerUsage.usage,
    cacheAccounting: resolveCacheAccounting(
      providerUsage.usage,
      protocolCacheAccounting,
    ),
  };
  const charges = computeCharges({
    entry: params.entry,
    model: params.model,
    usage,
    cacheAccounting: usage.cacheAccounting,
  });
  const priceMinor =
    params.priceMinorOverride !== undefined
      ? params.priceMinorOverride
      : charges.priceMinor;
  try {
    await settleUsage({
      orgId: params.orgId,
      actor: params.actor,
      model: params.model,
      entry: params.entry,
      provider: params.provider,
      protocol: params.protocol,
      usage,
      costMinor: charges.costMinor,
      priceMinor,
      currency: charges.currency,
      providerRequestId,
      gatewayRequestId,
      status: params.status,
      durationMs: params.durationMs,
      errorCode: params.errorCode,
      rules: params.rules,
      occurredAt,
      reservedMinor,
      rethrowGuardFailure: true,
    });
    return { settled: true };
  } catch (err) {
    // Upstream already succeeded — never drop the charge into logs alone.
    // enqueueSettlementOutbox throws on failure (not log-only).
    const outboxId = await enqueueSettlementOutbox({
      ...outboxBase,
      reason:
        err instanceof SettlementGuardError
          ? "settlement_guard_failed"
          : "settlement_failed",
      context: outboxReconContext({
        actor: params.actor,
        model: params.model,
        entry: params.entry,
        provider: params.provider,
        status: params.status,
        durationMs: params.durationMs,
        errorCode: params.errorCode,
        usage,
        priceMinor,
        costMinor: charges.costMinor,
        currency: charges.currency,
        priceMinorOverride: params.priceMinorOverride,
        rules: params.rules,
        occurredAt,
        cacheAccounting: usage.cacheAccounting,
        reservedMinor,
        extra: {
          error: err instanceof Error ? err.message : String(err),
        },
      }),
    });
    console.error("[settleUsage] settlement failed — outbox enqueued", {
      gatewayRequestId,
      outboxId: outboxId.toHexString(),
      model: params.model.aliasId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { settled: false, outboxId };
  }
}

/** Per-million minor-unit price/cost schedule fields used for charging. */
export type ChargeSchedule = {
  inputMinorPerMillion?: number;
  outputMinorPerMillion?: number;
  reasoningMinorPerMillion?: number;
  cacheReadMinorPerMillion?: number;
  cacheWriteMinorPerMillion?: number;
};

/**
 * Resolve cache accounting mode. Prefer adapter-stamped usage field, then an
 * explicit override (protocol / frozen outbox), never token-amount heuristics.
 */
export function resolveCacheAccounting(
  usage: ChatResponse["usage"],
  fallback?: CacheAccountingMode,
): CacheAccountingMode {
  if (usage.cacheAccounting === "subset" || usage.cacheAccounting === "additive") {
    return usage.cacheAccounting;
  }
  return fallback ?? "subset";
}

/**
 * Apply a token price schedule.
 *
 * - **Reasoning** is included inside completion/output. When a reasoning tier
 *   is configured, charge non-reasoning output + reasoning tier — never full
 *   completion plus reasoning again.
 * - **Cache** billing uses explicit `cacheAccounting` from the adapter:
 *   - `subset` (OpenAI): prompt includes cached tokens → uncached@input + cache tiers
 *   - `additive` (Anthropic): prompt is base input only → input + cache fields
 */
export function applyTokenSchedule(
  schedule: ChargeSchedule,
  usage: ChatResponse["usage"],
  opts?: { cacheAccounting?: CacheAccountingMode },
): number {
  const reasoningRaw = Math.max(0, usage.reasoningTokens ?? 0);
  // Clamp: reasoning is a subset of completion/output, never a separate addend.
  const reasoning = Math.min(reasoningRaw, usage.completionTokens);
  const outputRate = schedule.outputMinorPerMillion ?? 0;
  const reasoningRate = schedule.reasoningMinorPerMillion;

  let outputCharge: number;
  if (reasoningRate === undefined || reasoning === 0) {
    // No distinct reasoning tier (or no reasoning tokens): one completion bucket.
    outputCharge = Math.ceil((usage.completionTokens * outputRate) / 1_000_000);
  } else {
    const nonReasoningOutput = usage.completionTokens - reasoning;
    outputCharge =
      Math.ceil((nonReasoningOutput * outputRate) / 1_000_000) +
      Math.ceil((reasoning * reasoningRate) / 1_000_000);
  }

  const inputRate = schedule.inputMinorPerMillion ?? 0;
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const readRate = schedule.cacheReadMinorPerMillion;
  const writeRate = schedule.cacheWriteMinorPerMillion;
  const prompt = usage.promptTokens;
  const cacheAccounting = resolveCacheAccounting(usage, opts?.cacheAccounting);

  let inputCharge: number;
  if (cacheAccounting === "additive") {
    // Anthropic: input_tokens is base/uncached; cache fields are extra.
    // Total input cost = input + cache_read + cache_write (each at its rate).
    inputCharge =
      Math.ceil((prompt * inputRate) / 1_000_000) +
      Math.ceil((cacheRead * (readRate ?? 0)) / 1_000_000) +
      Math.ceil((cacheWrite * (writeRate ?? 0)) / 1_000_000);
  } else {
    // OpenAI subset: peel configured cache tiers from prompt; remainder = uncached.
    let remaining = prompt;
    let cacheCharge = 0;
    if (readRate !== undefined && cacheRead > 0) {
      const peeled = Math.min(cacheRead, remaining);
      remaining -= peeled;
      cacheCharge += Math.ceil((peeled * readRate) / 1_000_000);
    }
    if (writeRate !== undefined && cacheWrite > 0) {
      const peeled = Math.min(cacheWrite, remaining);
      remaining -= peeled;
      cacheCharge += Math.ceil((peeled * writeRate) / 1_000_000);
    }
    // Cache without a configured tier stays in `remaining` at the input rate.
    inputCharge =
      Math.ceil((remaining * inputRate) / 1_000_000) + cacheCharge;
  }

  return inputCharge + outputCharge;
}

/**
 * Compute cost (what org pays) and price (what we charge customer) in minor
 * units from token counts + the model's price schedule. Cost uses the entry's
 * cost override if present, else 0 (cost tracking optional without catalog).
 * Price uses entry price override, else model.price.
 */
export function computeCharges(params: {
  entry: ModelEntryDoc;
  model: ModelDoc;
  usage: ChatResponse["usage"];
  /** Override when usage lacks adapter-stamped cacheAccounting (e.g. assembled stream). */
  cacheAccounting?: CacheAccountingMode;
}): { costMinor: number; priceMinor: number; currency: string } {
  const { entry, model, usage } = params;
  const priceSchedule = entry.price ?? model.price;
  const costSchedule = entry.cost;
  const opts = { cacheAccounting: params.cacheAccounting };

  const priceMinor = applyTokenSchedule(priceSchedule, usage, opts);
  const costMinor = costSchedule
    ? applyTokenSchedule(costSchedule, usage, opts)
    : 0;

  return { costMinor, priceMinor, currency: model.currency };
}

/**
 * Settlement guard failure: the customer no longer matches the expected
 * org/currency/state, or balance is insufficient under concurrent debit.
 * Thrown inside the transaction to abort it atomically. With
 * `rethrowGuardFailure` (default true from settleUsageOrOutbox), propagates so
 * the outbox path can enqueue durable work — never report settlement success.
 */
export class SettlementGuardError extends Error {
  constructor(message = "settlement_guard_failed") {
    super(message);
    this.name = "SettlementGuardError";
  }
}

/**
 * Who is being settled for. `customerId` decides whether the customer balance
 * is debited and counters are written:
 *  - customerId set → billed path: insert usage record, debit balance, write
 *    ledger + rate-limit counters (the standard customer-key path, plus the
 *    management-attributed-to-customer path).
 *  - customerId null → internal path: insert usage record for audit/analytics
 *    only. No debit, no counters. Used for org-internal management calls and
 *    playground-without-customer.
 *
 * `actorKind` is recorded verbatim on the usage record so analytics can split
 * customer vs management vs playground traffic.
 */
export type SettlementActor = {
  actorKind: "customer_key" | "management_key" | "playground";
  /** Customer to bill. null for org-internal calls. */
  customerId: ObjectId | null;
  /** Customer API key (`tp_live_`) when actorKind is customer_key. */
  apiKeyId?: ObjectId | null;
  /** Management API key (`tp_mgmt_`) when actorKind is management_key. */
  managementKeyId?: ObjectId | null;
  /** Snapshot of the customerEmail used for management attribution, if any. */
  customerEmail?: string | null;
};

export async function settleUsage(params: {
  orgId: ObjectId;
  actor: SettlementActor;
  model: ModelDoc;
  entry: ModelEntryDoc;
  provider: ProviderDoc;
  protocol: "openai" | "anthropic";
  usage: ChatResponse["usage"];
  costMinor: number;
  priceMinor: number;
  currency: string;
  providerRequestId?: string;
  /**
   * Settlement idempotency key. Unique on usage_records when set — recon
   * retries after a committed charge (but before outbox mark) no-op safely.
   */
  gatewayRequestId?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  rules: EffectiveRules;
  /**
   * Request-time timestamp for usage analytics + rate-limit windows.
   * Must be the original request time on delayed recon, not recon wall clock.
   */
  occurredAt?: Date;
  /**
   * Canary preFlight hold. When > 0, debit uses settleBalanceWithReservation
   * (release hold + charge actual) instead of bare amountMinor $gte.
   */
  reservedMinor?: number;
  /**
   * When true (default), balance-guard failure rethrows so settleUsageOrOutbox
   * enqueues durable work. No billed:false audit insert (outbox is the durable
   * record; a later billed settle would otherwise double-count analytics).
   */
  rethrowGuardFailure?: boolean;
  /** @deprecated No-op; guard path never writes a billed:false usage row. */
  skipGuardAudit?: boolean;
}): Promise<void> {
  const db = await getDb();
  const client = getClient();
  const now = new Date();
  const occurredAt = params.occurredAt ?? now;
  const actor = params.actor;
  // Hash long keys — never truncate (truncation collides distinct IDs).
  const gatewayRequestId = params.gatewayRequestId
    ? compactGatewayRequestId(params.gatewayRequestId)
    : undefined;

  // Idempotent short-circuit: already settled this gateway request.
  if (gatewayRequestId) {
    const existing = await db.usageRecords.findOne({ gatewayRequestId });
    if (existing) {
      // Prior attempt completed the charge (or recorded free/internal settle).
      return;
    }
  }

  // Resolve billing intent from the actor. Internal calls (customerId null)
  // skip the debit + ledger + counter writes entirely.
  const customerId = actor.customerId;
  const billed = customerId !== null;

  const usageRecord: Omit<UsageRecordDoc, "_id" | "createdAt" | "updatedAt"> = {
    organizationId: params.orgId,
    customerId,
    apiKeyId: actor.apiKeyId ?? null,
    actorKind: actor.actorKind,
    managementKeyId: actor.managementKeyId ?? null,
    customerEmail: actor.customerEmail ?? null,
    modelAliasId: params.model.aliasId,
    providerId: params.provider._id,
    upstreamModelId: params.entry.upstreamModelId,
    protocol: params.protocol,
    promptTokens: params.usage.promptTokens,
    completionTokens: params.usage.completionTokens,
    reasoningTokens: params.usage.reasoningTokens ?? 0,
    cacheReadTokens: params.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: params.usage.cacheWriteTokens ?? 0,
    // Rate-limit + analytics total: mode-correct parts sum (additive cache
    // included for Anthropic). Never add reasoning (inside completion/output).
    // Overflow fail-closed — never persist Infinity / unsafe totals.
    totalTokens: (() => {
      const total = normalizeProcessedTotalTokens({
        ...params.usage,
        cacheAccounting: resolveCacheAccounting(
          params.usage,
          cacheAccountingForProtocol(params.protocol),
        ),
      });
      if (total === null) {
        throw new SettlementGuardError("usage_overflow");
      }
      return total;
    })(),
    costMinor: params.costMinor,
    priceMinor: params.priceMinor,
    currency: params.currency,
    providerRequestId: params.providerRequestId,
    gatewayRequestId: gatewayRequestId ?? null,
    billed,
    errorCode: params.errorCode,
    status: params.status,
    durationMs: params.durationMs,
    occurredAt,
  };

  // Wrap usage insert + (optional) balance debit + (optional) ledger entry +
  // (optional) rate counters in ONE transaction so a failure can never leave a
  // partial charge. For internal calls, only the usage record is inserted
  // (no debit, no counters) — analytics-only attribution. The balance update
  // carries org/currency/not-closed guards: if the customer was closed, moved
  // orgs, or changed currency mid-flight, the debit is refused and the whole
  // txn aborts atomically.
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      // Re-check inside txn for races between concurrent recon workers.
      if (gatewayRequestId) {
        const raced = await db.usageRecords.findOne(
          { gatewayRequestId },
          { session },
        );
        if (raced) return;
      }

      try {
        await db.usageRecords.insertOne(
          {
            _id: new ObjectId(),
            ...usageRecord,
            createdAt: now,
            updatedAt: now,
          } as UsageRecordDoc,
          { session },
        );
      } catch (insertErr) {
        // Unique gatewayRequestId: concurrent settle already won — treat as done
        // only when the winner's row is visible (avoid false-success if they abort).
        if (gatewayRequestId && isDuplicateKeyError(insertErr)) {
          const existing = await db.usageRecords.findOne(
            { gatewayRequestId },
            { session },
          );
          if (existing) return;
        }
        throw insertErr;
      }

      if (billed && customerId !== null) {
        const reserved = Math.max(0, params.reservedMinor ?? 0);
        // Canary path: release hold + debit actual. Legacy: $gte amountMinor only.
        // Either way concurrent debits cannot drive balance below zero.
        if (params.priceMinor > 0 || reserved > 0) {
          let ok: boolean;
          if (reserved > 0) {
            ok = await settleBalanceWithReservation({
              customerId,
              organizationId: params.orgId,
              priceMinor: params.priceMinor,
              reservedMinor: reserved,
              currency: params.currency,
              session,
            });
          } else if (params.priceMinor > 0) {
            const debit = await db.customers.updateOne(
              {
                _id: customerId,
                organizationId: params.orgId,
                "balance.currency": params.currency,
                "balance.amountMinor": { $gte: params.priceMinor },
                status: { $ne: "closed" },
              },
              {
                $inc: { "balance.amountMinor": -params.priceMinor },
                $set: { updatedAt: now },
              },
              { session },
            );
            ok = debit.matchedCount > 0;
          } else {
            ok = true;
          }
          if (!ok) {
            // Guard failed: refuse the debit and abort the transaction atomically.
            throw new SettlementGuardError();
          }
        }
        if (params.priceMinor > 0) {
          await db.balanceAdjustments.insertOne(
            {
              _id: new ObjectId(),
              organizationId: params.orgId,
              customerId,
              amountMinor: -params.priceMinor,
              currency: params.currency,
              reason: "usage_debit",
              occurredAt,
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
        }
      }

      if (billed && customerId !== null) {
        await recordUsage({
          db,
          organizationId: params.orgId,
          customerId,
          rules: params.rules,
          usage: {
            tokens: usageRecord.totalTokens,
            requests: 1,
            spendMinor: params.priceMinor,
            currency: params.currency,
            modelAliasId: params.model.aliasId,
          },
          occurredAt,
          session,
        });
      }
    });
  } catch (err) {
    if (err instanceof SettlementGuardError) {
      console.error("[settleUsage] balance guard failed — no charge applied", {
        customerId: customerId?.toHexString() ?? null,
        orgId: params.orgId.toHexString(),
        currency: params.currency,
        priceMinor: params.priceMinor,
        gatewayRequestId: gatewayRequestId ?? null,
      });
      // Do NOT insert a billed:false audit row: durable outbox holds the event,
      // and a later successful recon would otherwise create a second usage row
      // (double-counting analytics). Outbox reason=settlement_guard_failed.
      if (params.rethrowGuardFailure !== false) {
        throw err;
      }
      return;
    }
    throw err;
  } finally {
    await session.endSession();
  }
}