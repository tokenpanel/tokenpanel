/**
 * Exactly-once settlement + reservation release + usage + outbox (task 9.9).
 * Native Effect path over domains/settlement/settle.ts.
 */

import { Effect } from "effect";
import type { ObjectId } from "mongodb";
import type {
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  RateLimitRule,
} from "@tokenpanel/db";
import { InvalidStateError, SystemError } from "../../errors/families.ts";
import type {
  CacheAccountingMode,
  ProviderUsage,
  TokenUsage,
} from "../../providers/provider-usage.ts";
import {
  computeCharges,
  cacheAccountingForProtocol,
  resolveCacheAccounting,
} from "../billing/charges.ts";
import { toProviderUsage, type UsageOutcome } from "../providers/usage.ts";
import {
  settleUsage,
  settleUsageOrOutbox,
  SettlementGuardError,
  type SettlementActor,
  type SettleOrOutboxServices,
  type SettleServices,
} from "./settle.ts";

export type { SettlementActor } from "./settle.ts";
export { SettlementGuardError } from "./settle.ts";

export type SettlementResult =
  | { readonly settled: true }
  | { readonly settled: false; readonly outboxId: ObjectId; readonly reason: string };

export type SettlementOpError = InvalidStateError | SystemError;

/**
 * Pure decision: given usage outcome, should we settle or outbox?
 * Never free-bill missing/malformed/overflow.
 */
export function decideSettlementPath(
  outcome: UsageOutcome,
):
  | { readonly path: "settle"; readonly usage: TokenUsage }
  | { readonly path: "outbox"; readonly reason: string } {
  if (outcome.status === "reported") {
    return { path: "settle", usage: outcome.usage };
  }
  return { path: "outbox", reason: outcome.reason };
}

/**
 * Compute charges for reported usage (pure).
 */
export function computeSettlementCharges(params: {
  readonly entry: ModelEntryDoc;
  readonly model: ModelDoc;
  readonly usage: TokenUsage;
  readonly protocol: "openai" | "anthropic";
  readonly priceMinorOverride?: number | undefined;
}): {
  readonly costMinor: number;
  readonly priceMinor: number;
  readonly currency: string;
  readonly cacheAccounting: CacheAccountingMode;
} {
  const protocolMode = cacheAccountingForProtocol(params.protocol);
  const cacheAccounting = resolveCacheAccounting(
    params.usage,
    protocolMode,
  );
  const charges = computeCharges({
    entry: params.entry,
    model: params.model,
    usage: params.usage,
    cacheAccounting,
  });
  return {
    costMinor: charges.costMinor,
    priceMinor:
      params.priceMinorOverride !== undefined
        ? params.priceMinorOverride
        : charges.priceMinor,
    currency: charges.currency,
    cacheAccounting,
  };
}

function mapSettleError(e: unknown): SettlementOpError {
  if (e instanceof SettlementGuardError) {
    return new InvalidStateError({
      code: "settlement_guard_failed",
      message: e.message,
      resource: "settlement",
    });
  }
  if (e instanceof SystemError) return e;
  return new SystemError({
    code: "system_error",
    message: "Settlement failed",
    diagnostic: e instanceof Error ? e.message : String(e),
  });
}

/**
 * Exactly-once settle or durable outbox fallback.
 */
export const settleOrOutboxWorkflow = (params: {
  readonly orgId: ObjectId;
  readonly actor: SettlementActor;
  readonly model: ModelDoc;
  readonly entry: ModelEntryDoc;
  readonly provider: ProviderDoc;
  readonly protocol: "openai" | "anthropic";
  readonly usageOutcome: UsageOutcome;
  readonly providerRequestId?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly reservedMinor?: number | undefined;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string | undefined;
  readonly rules: readonly RateLimitRule[];
  readonly priceMinorOverride?: number | undefined;
  readonly occurredAt?: Date | undefined;
}): Effect.Effect<
  SettlementResult,
  SettlementOpError,
  SettleOrOutboxServices
> =>
  Effect.gen(function* () {
    const providerUsage: ProviderUsage = toProviderUsage(params.usageOutcome);
    const decision = decideSettlementPath(params.usageOutcome);

    const result = yield* settleUsageOrOutbox({
      orgId: params.orgId,
      actor: params.actor,
      model: params.model,
      entry: params.entry,
      provider: params.provider,
      protocol: params.protocol,
      providerUsage,
      providerRequestId: params.providerRequestId,
      gatewayRequestId: params.gatewayRequestId,
      reservedMinor: params.reservedMinor,
      status: params.status,
      durationMs: params.durationMs,
      errorCode: params.errorCode,
      rules: params.rules,
      priceMinorOverride: params.priceMinorOverride,
      occurredAt: params.occurredAt,
    }).pipe(Effect.mapError(mapSettleError));

    if (result.settled) {
      return { settled: true as const };
    }
    return {
      settled: false as const,
      outboxId: result.outboxId,
      reason:
        decision.path === "outbox" ? decision.reason : "settlement_failed",
    };
  });

/** Direct settle when usage already reported (idempotent via gatewayRequestId). */
export const settleUsageWorkflow = (params: {
  readonly orgId: ObjectId;
  readonly actor: SettlementActor;
  readonly model: ModelDoc;
  readonly entry: ModelEntryDoc;
  readonly provider: ProviderDoc;
  readonly protocol: "openai" | "anthropic";
  readonly usage: TokenUsage;
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
}): Effect.Effect<void, SettlementOpError, SettleServices> =>
  settleUsage({
    ...params,
    rules: params.rules,
    rethrowGuardFailure: true,
  }).pipe(Effect.mapError(mapSettleError));
