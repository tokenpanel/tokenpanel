/**
 * Exactly-once settlement Effect (native path).
 *
 * Transactional usage insert + balance debit + ledger + rate counters via
 * withMongoSession. Idempotent on gatewayRequestId.
 */

import { Effect } from "effect";
import { ObjectId } from "mongodb";
import type {
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  RateLimitRule,
  UsageRecordDoc,
} from "@tokenpanel/db";
import {
  PersistenceDuplicateKeyError,
  SystemError,
} from "../../errors/families.ts";
import { CustomersRepo } from "../../infrastructure/mongo/repositories/customers.ts";
import { UsageRepo } from "../../infrastructure/mongo/repositories/usage.ts";
import type { MongoFailure } from "../../infrastructure/mongo/try-mongo.ts";
import { withMongoSession } from "../../infrastructure/mongo/session.ts";
import type { MongoDb } from "../../runtime/services/mongo-db.ts";
import type { ChatResponse } from "../../providers/index.ts";
import type {
  CacheAccountingMode,
  ProviderUsage,
} from "../../providers/provider-usage.ts";
import { normalizeProcessedTotalTokens } from "../../providers/provider-usage.ts";
import {
  recordUsage,
  settleLimits,
  serializeLimitReservation,
  type LimitReservation,
} from "../../lib/rate-limits.ts";
import {
  compactGatewayRequestId,
  enqueueSettlementOutbox,
  resolveGatewayRequestId,
} from "../../services/settlement-outbox.ts";
import { settleBalanceWithReservation } from "../../services/reservation.ts";
import { syncLog } from "../../infrastructure/telemetry/sync-log.ts";
import {
  applyTokenSchedule as applyTokenScheduleDomain,
  cacheAccountingForProtocol as cacheAccountingForProtocolDomain,
  computeCharges as computeChargesDomain,
  resolveCacheAccounting as resolveCacheAccountingDomain,
  type ChargeSchedule as ChargeScheduleDomain,
} from "../billing/charges.ts";

export type ChargeSchedule = ChargeScheduleDomain;

export function cacheAccountingForProtocol(
  protocol: "openai" | "anthropic",
): CacheAccountingMode {
  return cacheAccountingForProtocolDomain(protocol);
}

export function resolveCacheAccounting(
  usage: ChatResponse["usage"],
  fallback?: CacheAccountingMode,
): CacheAccountingMode {
  return resolveCacheAccountingDomain(usage, fallback);
}

export function applyTokenSchedule(
  schedule: ChargeSchedule,
  usage: ChatResponse["usage"],
  opts?: { cacheAccounting?: CacheAccountingMode | undefined } | undefined,
): number {
  return applyTokenScheduleDomain(schedule, usage, opts);
}

export function computeCharges(params: {
  entry: ModelEntryDoc;
  model: ModelDoc;
  usage: ChatResponse["usage"];
  cacheAccounting?: CacheAccountingMode | undefined;
}): { costMinor: number; priceMinor: number; currency: string } {
  return computeChargesDomain(params);
}

/**
 * Settlement guard failure: customer no longer matches expected org/currency,
 * or balance insufficient under concurrent debit. Typed error channel.
 */
export class SettlementGuardError extends Error {
  readonly _tag = "SettlementGuardError" as const;
  constructor(message = "settlement_guard_failed") {
    super(message);
    this.name = "SettlementGuardError";
  }
}

/**
 * Who is being settled for.
 *  - customerId set → billed path
 *  - customerId null → analytics-only (no debit / counters)
 */
export type SettlementActor = {
  actorKind: "customer_key" | "management_key" | "playground";
  customerId: ObjectId | null;
  apiKeyId?: ObjectId | null | undefined;
  managementKeyId?: ObjectId | null | undefined;
  customerEmail?: string | null | undefined;
};

export type SettleUsageParams = {
  readonly orgId: ObjectId;
  readonly actor: SettlementActor;
  readonly model: ModelDoc;
  readonly entry: ModelEntryDoc;
  readonly provider: ProviderDoc;
  readonly protocol: "openai" | "anthropic";
  readonly usage: ChatResponse["usage"];
  readonly costMinor: number;
  readonly priceMinor: number;
  readonly currency: string;
  readonly providerRequestId?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string | undefined;
  readonly rules: readonly RateLimitRule[];
  readonly occurredAt?: Date | undefined;
  readonly reservedMinor?: number | undefined;
  /** Preflight rolling-limit holds; when set, counters adjust by actual − reserved. */
  readonly limitReservation?: LimitReservation | null | undefined;
  /**
   * When true (default), guard failure surfaces on the error channel so
   * settleUsageOrOutbox can enqueue durable work.
   */
  readonly rethrowGuardFailure?: boolean | undefined;
  /** @deprecated No-op. */
  readonly skipGuardAudit?: boolean | undefined;
};

export type SettleServices = UsageRepo | CustomersRepo | MongoDb;

export type SettleError =
  | SettlementGuardError
  | SystemError
  | MongoFailure
  | PersistenceDuplicateKeyError;

function isDuplicateKey(err: unknown): boolean {
  return (
    err instanceof PersistenceDuplicateKeyError ||
    (typeof err === "object" &&
      err !== null &&
      "_tag" in err &&
      (err as { _tag: string })._tag === "PersistenceDuplicateKeyError")
  );
}

function mapSystem(message: string) {
  return (e: unknown) =>
    e instanceof SettlementGuardError
      ? e
      : e instanceof SystemError
        ? e
        : e instanceof PersistenceDuplicateKeyError
          ? e
          : typeof e === "object" &&
              e !== null &&
              "_tag" in e &&
              typeof (e as { _tag: unknown })._tag === "string"
            ? (e as MongoFailure)
            : new SystemError({
                code: "system_error",
                message,
                diagnostic: e instanceof Error ? e.message : String(e),
              });
}

/**
 * Exactly-once settle: insert usage + optional debit/ledger/counters in one txn.
 */
export const settleUsage = (
  params: SettleUsageParams,
): Effect.Effect<void, SettleError, SettleServices> =>
  Effect.gen(function* () {
    const now = new Date();
    const occurredAt = params.occurredAt ?? now;
    const actor = params.actor;
    const gatewayRequestId = params.gatewayRequestId
      ? compactGatewayRequestId(params.gatewayRequestId)
      : undefined;

    const usageRepo = yield* UsageRepo;

    if (gatewayRequestId) {
      const existing = yield* usageRepo
        .findByGatewayRequestId(gatewayRequestId)
        .pipe(Effect.mapError(mapSystem("Idempotency lookup failed")));
      if (existing) return;
    }

    const customerId = actor.customerId;
    const billed = customerId !== null;

    const total = normalizeProcessedTotalTokens({
      ...params.usage,
      cacheAccounting: resolveCacheAccounting(
        params.usage,
        cacheAccountingForProtocol(params.protocol),
      ),
    });
    if (total === null) {
      return yield* Effect.fail(new SettlementGuardError("usage_overflow"));
    }

    const usageRecord: Omit<UsageRecordDoc, "_id" | "createdAt" | "updatedAt"> =
      {
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
        totalTokens: total,
        costMinor: params.costMinor,
        priceMinor: params.priceMinor,
        currency: params.currency,
        providerRequestId: params.providerRequestId ?? null,
        gatewayRequestId: gatewayRequestId ?? null,
        billed,
        errorCode: params.errorCode ?? null,
        status: params.status,
        durationMs: params.durationMs,
        occurredAt,
      };

    const body = withMongoSession((session) =>
      Effect.gen(function* () {
        if (gatewayRequestId) {
          const raced = yield* usageRepo.findByGatewayRequestId(
            gatewayRequestId,
            session,
          );
          if (raced) return;
        }

        const insertResult = yield* usageRepo
          .insert(
            {
              _id: new ObjectId(),
              ...usageRecord,
              createdAt: now,
              updatedAt: now,
            } as never,
            session,
          )
          .pipe(
            Effect.map(() => "inserted" as const),
            Effect.catchAll((insertErr) => {
              if (gatewayRequestId && isDuplicateKey(insertErr)) {
                return usageRepo.findByGatewayRequestId(
                  gatewayRequestId,
                  session,
                ).pipe(
                  Effect.flatMap((existing) =>
                    existing
                      ? Effect.succeed("duplicate_done" as const)
                      : Effect.fail(insertErr),
                  ),
                );
              }
              return Effect.fail(insertErr);
            }),
          );

        if (insertResult === "duplicate_done") return;

        if (billed && customerId !== null) {
          const reserved = Math.max(0, params.reservedMinor ?? 0);
          if (params.priceMinor > 0 || reserved > 0) {
            let ok: boolean;
            if (reserved > 0) {
              ok = yield* settleBalanceWithReservation({
                customerId,
                organizationId: params.orgId,
                priceMinor: params.priceMinor,
                reservedMinor: reserved,
                currency: params.currency,
                session,
              });
            } else if (params.priceMinor > 0) {
              const customers = yield* CustomersRepo;
              ok = yield* customers.debitBalance({
                customerId,
                organizationId: params.orgId,
                priceMinor: params.priceMinor,
                currency: params.currency,
                session,
              });
            } else {
              ok = true;
            }
            if (!ok) {
              return yield* Effect.fail(new SettlementGuardError());
            }
          }
          if (params.priceMinor > 0) {
            const customers = yield* CustomersRepo;
            yield* customers.insertAdjustment(
              {
                _id: new ObjectId(),
                organizationId: params.orgId,
                customerId,
                amountMinor: -params.priceMinor,
                currency: params.currency,
                reason: "usage_debit",
                usageRecordId: null,
                note: null,
                occurredAt,
                createdAt: now,
                updatedAt: now,
              } as never,
              session,
            );
          }
        }

        if (billed && customerId !== null) {
          const usagePayload = {
            tokens: usageRecord.totalTokens,
            requests: 1,
            spendMinor: params.priceMinor,
            currency: params.currency,
            modelAliasId: params.model.aliasId,
          };
          if (
            params.limitReservation &&
            params.limitReservation.holds.length > 0
          ) {
            // Adjust preflight holds by (actual − reserved) on held buckets.
            yield* settleLimits({
              reservation: params.limitReservation,
              organizationId: params.orgId,
              customerId,
              rules: [...params.rules],
              usage: usagePayload,
              occurredAt,
              session,
            });
          } else {
            // No prior hold (playground / legacy): full counter write.
            yield* recordUsage({
              organizationId: params.orgId,
              customerId,
              rules: [...params.rules],
              usage: usagePayload,
              occurredAt,
              session,
            });
          }
        }
      }),
    );

    yield* body.pipe(
      Effect.catchAll((err) => {
        if (err instanceof SettlementGuardError) {
          return Effect.gen(function* () {
            yield* Effect.sync(() =>
              syncLog("error", "settle_balance_guard_failed", {
                customerId: customerId?.toHexString() ?? null,
                orgId: params.orgId.toHexString(),
                currency: params.currency,
                priceMinor: params.priceMinor,
                gatewayRequestId: gatewayRequestId ?? null,
              }),
            );
            if (params.rethrowGuardFailure !== false) {
              return yield* Effect.fail(err);
            }
          });
        }
        return Effect.fail(err as SettleError);
      }),
    );
  });

function outboxReconContext(params: {
  actor: SettlementActor;
  model: ModelDoc;
  entry: ModelEntryDoc;
  provider: ProviderDoc;
  status: number;
  durationMs: number;
  errorCode?: string | undefined;
  usage?: ChatResponse["usage"] | undefined;
  priceMinor?: number | undefined;
  costMinor?: number | undefined;
  currency?: string | undefined;
  priceMinorOverride?: number | undefined;
  rules?: readonly RateLimitRule[] | undefined;
  occurredAt?: Date | undefined;
  cacheAccounting?: CacheAccountingMode | undefined;
  reservedMinor?: number | undefined;
  limitReservation?: LimitReservation | null | undefined;
  extra?: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const priceSchedule = params.entry.price ?? params.model.price;
  const costSchedule = params.entry.cost;
  const occurredAt = params.occurredAt ?? new Date();
  const cacheAccounting =
    params.cacheAccounting ??
    (params.usage ? resolveCacheAccounting(params.usage) : undefined);
  const usageFrozen =
    params.usage && cacheAccounting
      ? { ...params.usage, cacheAccounting }
      : params.usage;
  const limitHolds = serializeLimitReservation(params.limitReservation);
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
    ...(cacheAccounting ? { cacheAccounting } : {}),
    ...(params.priceMinor !== undefined ? { priceMinor: params.priceMinor } : {}),
    ...(params.costMinor !== undefined ? { costMinor: params.costMinor } : {}),
    ...(params.priceMinorOverride !== undefined
      ? { priceMinorOverride: params.priceMinorOverride }
      : {}),
    ...(params.reservedMinor !== undefined && params.reservedMinor > 0
      ? { reservedMinor: params.reservedMinor }
      : {}),
    ...(limitHolds !== undefined ? { limitHolds } : {}),
    ...(params.extra ?? {}),
  };
}

export type SettleUsageOrOutboxParams = {
  readonly orgId: ObjectId;
  readonly actor: SettlementActor;
  readonly model: ModelDoc;
  readonly entry: ModelEntryDoc;
  readonly provider: ProviderDoc;
  readonly protocol: "openai" | "anthropic";
  readonly providerUsage?: ProviderUsage | undefined;
  readonly response?: ChatResponse | undefined;
  readonly providerRequestId?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly reservedMinor?: number | undefined;
  readonly limitReservation?: LimitReservation | null | undefined;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string | undefined;
  readonly rules: readonly RateLimitRule[];
  readonly priceMinorOverride?: number | undefined;
  readonly occurredAt?: Date | undefined;
};

export type SettleOrOutboxResult =
  | { readonly settled: true }
  | { readonly settled: false; readonly outboxId: ObjectId };

export type SettleOrOutboxServices = SettleServices | import("../../infrastructure/mongo/repositories/settlement-outbox.ts").SettlementOutboxRepo;

/**
 * Settle reported usage, or enqueue durable outbox when usage is missing /
 * settle fails. Never free-bills missing usage.
 */
export const settleUsageOrOutbox = (
  params: SettleUsageOrOutboxParams,
): Effect.Effect<
  SettleOrOutboxResult,
  SettleError,
  SettleOrOutboxServices
> =>
  Effect.gen(function* () {
    const occurredAt = params.occurredAt ?? new Date();
    let providerUsage = params.providerUsage;
    if (!providerUsage && params.response) {
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
    const limitReservation = params.limitReservation ?? null;

    if (providerUsage.status === "missing") {
      const outboxId = yield* enqueueSettlementOutbox({
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
          limitReservation,
          extra: { reason: providerUsage.reason },
        }),
      }).pipe(
        Effect.mapError(
          mapSystem("Outbox enqueue failed after missing usage"),
        ),
      );
      yield* Effect.sync(() =>
        syncLog("error", "settle_missing_usage_outbox", {
          gatewayRequestId,
          outboxId: outboxId.toHexString(),
          reason: providerUsage.reason,
          model: params.model.aliasId,
        }),
      );
      return { settled: false as const, outboxId };
    }

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

    const settleResult = yield* settleUsage({
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
      limitReservation,
      rethrowGuardFailure: true,
    }).pipe(Effect.either);

    if (settleResult._tag === "Right") {
      return { settled: true as const };
    }

    const err = settleResult.left;
    const outboxId = yield* enqueueSettlementOutbox({
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
        limitReservation,
        extra: {
          error: err instanceof Error ? err.message : String(err),
        },
      }),
    }).pipe(
      Effect.mapError(mapSystem("Outbox enqueue failed after settle failure")),
    );
    yield* Effect.sync(() =>
      syncLog("error", "settle_failed_outbox", {
        gatewayRequestId,
        outboxId: outboxId.toHexString(),
        model: params.model.aliasId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { settled: false as const, outboxId };
  });
