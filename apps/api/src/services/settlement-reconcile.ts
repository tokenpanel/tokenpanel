/**
 * Reconciliation worker: drains settlement_outbox pending/expired-lease rows.
 * Retries settleUsage when context holds a full usage + pricing snapshot.
 * Missing-usage rows without recoverable usage abandon immediately.
 *
 * Primary API is Effect (worker runs via getAppRuntime().runPromise).
 */

import { Effect } from "effect";
import { ObjectId } from "mongodb";
import type {
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  RateLimitRule,
  SettlementOutboxDoc,
} from "@tokenpanel/db";
import { ModelsRepo } from "../infrastructure/mongo/repositories/models.ts";
import { UsageRepo } from "../infrastructure/mongo/repositories/usage.ts";
import type { SettlementOutboxRepo } from "../infrastructure/mongo/repositories/settlement-outbox.ts";
import type { PlansRepo } from "../infrastructure/mongo/repositories/plans.ts";
import type { CustomersRepo } from "../infrastructure/mongo/repositories/customers.ts";
import type { MongoDb } from "../runtime/services/mongo-db.ts";
import {
  claimDueOutboxRows,
  claimFromRow,
  compactGatewayRequestId,
  markOutboxReconciled,
  markOutboxAbandoned,
  releaseOutboxAfterFailure,
  renewOutboxClaim,
  type OutboxClaim,
} from "./settlement-outbox.ts";
import {
  applyTokenSchedule,
  cacheAccountingForProtocol,
  settleUsage,
  type ChargeSchedule,
  type SettlementActor,
} from "../domains/settlement/settle.ts";
import {
  getEffectiveRules,
  parseLimitReservation,
} from "../lib/rate-limits.ts";
import { syncLog } from "../infrastructure/telemetry/sync-log.ts";
import type {
  CacheAccountingMode,
  TokenUsage,
} from "../providers/provider-usage.ts";

function isTokenUsage(v: unknown): v is TokenUsage {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.promptTokens === "number" &&
    Number.isSafeInteger(o.promptTokens) &&
    typeof o.completionTokens === "number" &&
    Number.isSafeInteger(o.completionTokens) &&
    typeof o.totalTokens === "number" &&
    Number.isSafeInteger(o.totalTokens) &&
    o.promptTokens >= 0 &&
    o.completionTokens >= 0 &&
    o.totalTokens >= 0
  );
}

function actorFromContext(
  row: SettlementOutboxDoc,
  ctx: Record<string, unknown>,
): SettlementActor {
  const kind = ctx.actorKind;
  const actorKind =
    kind === "management_key" || kind === "playground" || kind === "customer_key"
      ? kind
      : "customer_key";
  return {
    actorKind,
    customerId: row.customerId ?? null,
    apiKeyId:
      typeof ctx.apiKeyId === "string" && ObjectId.isValid(ctx.apiKeyId)
        ? new ObjectId(ctx.apiKeyId)
        : null,
    managementKeyId:
      typeof ctx.managementKeyId === "string" &&
      ObjectId.isValid(ctx.managementKeyId)
        ? new ObjectId(ctx.managementKeyId)
        : null,
    customerEmail:
      typeof ctx.customerEmail === "string" ? ctx.customerEmail : null,
  };
}

function resolveEntry(params: {
  modelEntries: ModelEntryDoc[];
  providerId: ObjectId;
  upstreamModelId: string | undefined;
  ctx: Record<string, unknown>;
}):
  | { ok: true; entry: ModelEntryDoc }
  | { ok: false; reason: string } {
  const { modelEntries, providerId, upstreamModelId, ctx } = params;
  if (upstreamModelId) {
    const exact = modelEntries.find(
      (e) =>
        e.providerId.equals(providerId) && e.upstreamModelId === upstreamModelId,
    );
    if (exact) return { ok: true, entry: exact };
  } else {
    const matches = modelEntries.filter((e) => e.providerId.equals(providerId));
    if (matches.length === 1 && matches[0]) {
      return { ok: true, entry: matches[0] };
    }
    if (matches.length > 1) {
      return { ok: false, reason: "entry_ambiguous_no_upstream_id" };
    }
  }

  const frozenPrice =
    typeof ctx.priceUnits === "number" && Number.isFinite(ctx.priceUnits);
  const frozenUpstream =
    upstreamModelId ??
    (typeof ctx.upstreamModelId === "string" ? ctx.upstreamModelId : undefined);
  if (frozenPrice && frozenUpstream) {
    const stub: ModelEntryDoc = {
      id: "recon-stub",
      providerId,
      upstreamModelId: frozenUpstream,
      priority: 0,
      active: false,
    };
    return { ok: true, entry: stub };
  }
  return { ok: false, reason: "entry_not_found" };
}

function reconstructFrozenAttribution(params: {
  row: SettlementOutboxDoc;
  ctx: Record<string, unknown>;
  providerId: ObjectId;
  upstreamModelId: string;
  currency: string;
  priceSchedule: ChargeSchedule;
}): { model: ModelDoc; provider: ProviderDoc; entry: ModelEntryDoc } {
  const { row, ctx, providerId, upstreamModelId, currency, priceSchedule } =
    params;
  const now = row.createdAt;
  const price = {
    inputUnitsPerMillion: priceSchedule.inputUnitsPerMillion ?? 0,
    outputUnitsPerMillion: priceSchedule.outputUnitsPerMillion ?? 0,
    ...(priceSchedule.reasoningUnitsPerMillion !== undefined
      ? { reasoningUnitsPerMillion: priceSchedule.reasoningUnitsPerMillion }
      : {}),
    ...(priceSchedule.cacheReadUnitsPerMillion !== undefined
      ? { cacheReadUnitsPerMillion: priceSchedule.cacheReadUnitsPerMillion }
      : {}),
    ...(priceSchedule.cacheWriteUnitsPerMillion !== undefined
      ? { cacheWriteUnitsPerMillion: priceSchedule.cacheWriteUnitsPerMillion }
      : {}),
  };
  const entry: ModelEntryDoc = {
    id: "recon-stub",
    providerId,
    upstreamModelId,
    priority: 0,
    active: false,
    price,
  };
  const model: ModelDoc = {
    _id: new ObjectId(),
    organizationId: row.organizationId,
    aliasId: row.modelAliasId,
    displayName: row.modelAliasId,
    description: null,
    entries: [entry],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 0 },
    modalities: { input: ["text"], output: ["text"] },
    price,
    marginBps: 0,
    currency,
    active: false,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
  const provider: ProviderDoc = {
    _id: providerId,
    organizationId: row.organizationId,
    name: "recon-stub",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "recon-stub",
    baseUrl: "https://invalid.invalid",
    providerOrg: null,
    headers: {},
    active: false,
    metadata: {
      reconstructed: true,
      ...(typeof ctx.providerId === "string"
        ? { frozenProviderId: ctx.providerId }
        : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
  return { model, provider, entry };
}

export type ReconcileResult =
  | "reconciled"
  | "retry"
  | "abandoned"
  | "stale_claim";

export type ReconcileServices =
  | SettlementOutboxRepo
  | UsageRepo
  | ModelsRepo
  | PlansRepo
  | CustomersRepo
  | MongoDb;

/**
 * Attempt to settle one outbox row (Effect).
 * settleUsage is idempotent on gatewayRequestId.
 */
export const reconcileOutboxRow = (
  row: SettlementOutboxDoc,
  claim: OutboxClaim,
): Effect.Effect<ReconcileResult, never, ReconcileServices> =>
  Effect.gen(function* () {
    const ctx = (row.context ?? {}) as Record<string, unknown>;
    const usage = ctx.usage;
    const hasUsage = isTokenUsage(usage);

    if (!hasUsage) {
      const ok = yield* markOutboxAbandoned(
        row._id,
        claim,
        row.reason || "missing_usage_no_provider_lookup",
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
      return ok ? ("abandoned" as const) : ("stale_claim" as const);
    }

    if (row.gatewayRequestId) {
      const gwId = compactGatewayRequestId(row.gatewayRequestId);
      const usageRepo = yield* UsageRepo;
      const existing = yield* usageRepo
        .findByGatewayRequestId(gwId)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (existing) {
        const ok = yield* markOutboxReconciled(row._id, claim).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        );
        return ok ? ("reconciled" as const) : ("stale_claim" as const);
      }
    }

    const renewed = yield* renewOutboxClaim(row._id, claim).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (!renewed) return "stale_claim" as const;

    const providerId =
      row.providerId ??
      (typeof ctx.providerId === "string" && ObjectId.isValid(ctx.providerId)
        ? new ObjectId(ctx.providerId)
        : undefined);
    if (!providerId) {
      const ok = yield* releaseOutboxAfterFailure(
        row._id,
        claim,
        "provider_id_missing",
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
      return ok ? ("retry" as const) : ("stale_claim" as const);
    }

    const upstreamModelId =
      row.upstreamModelId ??
      (typeof ctx.upstreamModelId === "string" ? ctx.upstreamModelId : undefined);

    const priceUnits =
      typeof ctx.priceUnits === "number" && Number.isFinite(ctx.priceUnits)
        ? Math.floor(ctx.priceUnits)
        : undefined;
    const costUnitsFrozen =
      typeof ctx.costUnits === "number" && Number.isFinite(ctx.costUnits)
        ? Math.floor(ctx.costUnits)
        : undefined;
    const frozenSchedule = ctx.priceSchedule as ChargeSchedule | undefined;

    const models = yield* ModelsRepo;
    let model = (yield* models
      .findModelByAlias(row.organizationId, row.modelAliasId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))) as ModelDoc | null;
    let provider = (yield* models
      .findProviderById(row.organizationId, providerId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))) as ProviderDoc | null;

    let entry: ModelEntryDoc | undefined;
    if (model) {
      const entryResult = resolveEntry({
        modelEntries: [...model.entries],
        providerId,
        upstreamModelId,
        ctx,
      });
      if (entryResult.ok) entry = entryResult.entry;
    }

    const canReconstruct =
      (priceUnits !== undefined || frozenSchedule !== undefined) &&
      !!upstreamModelId;

    if ((!model || !provider || !entry) && canReconstruct && upstreamModelId) {
      const currency =
        typeof ctx.currency === "string" && ctx.currency.length > 0
          ? ctx.currency
          : (model?.currency ?? "USD");
      const priceSchedule: ChargeSchedule =
        frozenSchedule ??
        entry?.price ??
        model?.price ??
        { inputUnitsPerMillion: 0, outputUnitsPerMillion: 0 };
      const stubs = reconstructFrozenAttribution({
        row,
        ctx,
        providerId,
        upstreamModelId,
        currency,
        priceSchedule,
      });
      if (!model) model = stubs.model;
      if (!provider) provider = stubs.provider;
      if (!entry) entry = stubs.entry;
    }

    if (!model) {
      const ok = yield* releaseOutboxAfterFailure(
        row._id,
        claim,
        "model_not_found",
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
      return ok ? ("retry" as const) : ("stale_claim" as const);
    }
    if (!provider) {
      const ok = yield* releaseOutboxAfterFailure(
        row._id,
        claim,
        "provider_not_found",
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
      return ok ? ("retry" as const) : ("stale_claim" as const);
    }
    if (!entry) {
      const ok = yield* releaseOutboxAfterFailure(
        row._id,
        claim,
        "entry_not_found",
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
      return ok ? ("retry" as const) : ("stale_claim" as const);
    }

    const currency =
      typeof ctx.currency === "string" && ctx.currency.length > 0
        ? ctx.currency
        : model.currency;

    const protocol =
      row.protocol === "anthropic" || row.protocol === "openai"
        ? row.protocol
        : "openai";

    const frozenMode: CacheAccountingMode | undefined =
      ctx.cacheAccounting === "subset" || ctx.cacheAccounting === "additive"
        ? ctx.cacheAccounting
        : usage.cacheAccounting === "subset" ||
            usage.cacheAccounting === "additive"
          ? usage.cacheAccounting
          : cacheAccountingForProtocol(protocol);
    const usageWithMode: TokenUsage = {
      ...usage,
      cacheAccounting: frozenMode,
    };

    let finalPrice = priceUnits;
    let finalCost = costUnitsFrozen ?? 0;
    if (finalPrice === undefined) {
      const priceSchedule = frozenSchedule ?? entry.price ?? model.price;
      finalPrice = applyTokenSchedule(priceSchedule, usageWithMode, {
        cacheAccounting: frozenMode,
      });
      if (ctx.priceUnitsOverride === 0) finalPrice = 0;
    }
    if (
      costUnitsFrozen === undefined &&
      ctx.costSchedule &&
      typeof ctx.costSchedule === "object"
    ) {
      finalCost = applyTokenSchedule(
        ctx.costSchedule as ChargeSchedule,
        usageWithMode,
        { cacheAccounting: frozenMode },
      );
    }

    const actor = actorFromContext(row, ctx);
    let rules: readonly RateLimitRule[];
    if (Array.isArray(ctx.rules)) {
      rules = ctx.rules as RateLimitRule[];
    } else if (actor.customerId !== null) {
      rules = yield* getEffectiveRules(actor.customerId).pipe(
        Effect.catchAll(() => Effect.succeed([] as RateLimitRule[])),
      );
    } else {
      rules = [];
    }

    let occurredAt: Date;
    if (typeof ctx.occurredAt === "string" || ctx.occurredAt instanceof Date) {
      const parsed = new Date(ctx.occurredAt as string | Date);
      occurredAt = Number.isNaN(parsed.getTime()) ? row.createdAt : parsed;
    } else {
      occurredAt = row.createdAt;
    }

    const reservedUnits =
      typeof ctx.reservedUnits === "number" &&
      Number.isSafeInteger(ctx.reservedUnits) &&
      ctx.reservedUnits > 0
        ? ctx.reservedUnits
        : 0;

    const limitReservation =
      actor.customerId !== null
        ? parseLimitReservation({
            organizationId: row.organizationId,
            customerId: actor.customerId,
            wire: ctx.limitHolds,
          })
        : null;

    const settleOutcome = yield* settleUsage({
      orgId: row.organizationId,
      actor,
      model,
      entry,
      provider,
      protocol,
      usage: usageWithMode,
      costUnits: finalCost,
      priceUnits: finalPrice,
      currency,
      providerRequestId: row.providerRequestId,
      gatewayRequestId: row.gatewayRequestId,
      status: typeof ctx.status === "number" ? ctx.status : 200,
      durationMs: typeof ctx.durationMs === "number" ? ctx.durationMs : 0,
      errorCode: typeof ctx.errorCode === "string" ? ctx.errorCode : undefined,
      rules,
      occurredAt,
      reservedUnits,
      limitReservation,
      rethrowGuardFailure: true,
      skipGuardAudit: true,
    }).pipe(Effect.either);

    if (settleOutcome._tag === "Left") {
      const msg =
        settleOutcome.left instanceof Error
          ? settleOutcome.left.message
          : String(settleOutcome.left);
      const ok = yield* releaseOutboxAfterFailure(row._id, claim, msg).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      );
      return ok ? ("retry" as const) : ("stale_claim" as const);
    }

    const ok = yield* markOutboxReconciled(row._id, claim).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    );
    return ok ? ("reconciled" as const) : ("stale_claim" as const);
  });

export const processSettlementOutboxBatch = (
  limit = 20,
): Effect.Effect<
  { claimed: number; reconciled: number; abandoned: number },
  never,
  ReconcileServices
> =>
  Effect.gen(function* () {
    const claimed = yield* claimDueOutboxRows(limit).pipe(
      Effect.catchAll(() => Effect.succeed([] as SettlementOutboxDoc[])),
    );
    let reconciled = 0;
    let abandoned = 0;
    for (const row of claimed) {
      const claim = claimFromRow(row);
      if (!claim) {
        yield* Effect.sync(() =>
          syncLog("error", "reconcile_missing_claim_token", {
            id: row._id.toHexString(),
          }),
        );
        continue;
      }
      const result = yield* reconcileOutboxRow(row, claim).pipe(
        Effect.catchAllDefect((err) =>
          Effect.gen(function* () {
            const msg = err instanceof Error ? err.message : String(err);
            yield* Effect.sync(() =>
              syncLog("error", "reconcile_row_failed", {
                id: row._id.toHexString(),
                error: msg,
              }),
            );
            yield* releaseOutboxAfterFailure(row._id, claim, msg).pipe(
              Effect.catchAll(() => Effect.succeed(false)),
            );
            return "retry" as const;
          }),
        ),
      );
      if (result === "reconciled") reconciled += 1;
      if (result === "abandoned") abandoned += 1;
    }
    return { claimed: claimed.length, reconciled, abandoned };
  });

/**
 * Legacy entrypoints — WorkerControl owns the supervised fiber.
 */
export function startSettlementReconcileWorker(_opts?: {
  intervalMs?: number;
  batchSize?: number;
  initialDelayMs?: number;
}): void {
  // Intentionally empty.
}

export function stopSettlementReconcileWorker(): void {
  // Intentionally empty.
}
