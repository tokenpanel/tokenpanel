/**
 * Atomic balance reservation (ADR 001 dual-write / org canary).
 *
 * Available = amountMinor - reservedMinor.
 * Canary orgs: preFlight holds estimated spend in reservedMinor; settle releases
 * the hold and debits actual price. Non-canary: shadow-compare only, legacy
 * checkBalance remains the enforcement reader.
 *
 * Persistence: schema-decoding CustomersRepo only (task 14.2).
 * Primary API is Effect (run on ManagedRuntime / AppServices).
 */

import { Effect } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { CustomersRepo } from "../infrastructure/mongo/repositories/customers.ts";
import type { MongoFailure } from "../infrastructure/mongo/try-mongo.ts";
import { syncLog } from "../infrastructure/telemetry/sync-log.ts";

export type BalanceSnapshot = {
  amountMinor: number;
  reservedMinor: number;
  currency: string;
};

/** Available prepaid cash after holds. */
export function availableMinor(balance: {
  amountMinor: number;
  reservedMinor?: number | null;
}): number {
  const reserved = Math.max(0, balance.reservedMinor ?? 0);
  return Math.max(0, balance.amountMinor - reserved);
}

/** Pure decision: would a hold of `needMinor` succeed given this snapshot? */
export function wouldReserveSucceed(
  balance: BalanceSnapshot,
  needMinor: number,
  currency: string,
):
  | { ok: true }
  | { ok: false; reason: "currency_mismatch" | "insufficient_available" } {
  if (needMinor <= 0) return { ok: true };
  if (balance.currency !== currency) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (availableMinor(balance) < needMinor) {
    return { ok: false, reason: "insufficient_available" };
  }
  return { ok: true };
}

export type ReserveResult =
  | { reserved: true; reservedMinor: number }
  | { reserved: false; reason: string };

/**
 * Atomic hold: available >= need → $inc reservedMinor.
 * Missing reservedMinor treated as 0 via $ifNull in $expr.
 */
export const reserveBalance = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  needMinor: number;
  currency: string;
  session?: ClientSession;
}): Effect.Effect<ReserveResult, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.reserveBalance({
      customerId: params.customerId,
      organizationId: params.organizationId,
      needMinor: params.needMinor,
      currency: params.currency,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });

/** Release a prior hold without debiting (upstream failure / cancel). */
export const releaseBalanceReservation = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  reservedMinor: number;
  session?: ClientSession;
}): Effect.Effect<boolean, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.releaseReserved({
      customerId: params.customerId,
      organizationId: params.organizationId,
      reservedMinor: params.reservedMinor,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });

/**
 * Settle after a hold: debit actual priceMinor and release the full reserved hold.
 * Filter requires reservedMinor >= reserved and amountMinor >= priceMinor.
 */
export const settleBalanceWithReservation = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  priceMinor: number;
  reservedMinor: number;
  currency: string;
  session?: ClientSession;
}): Effect.Effect<boolean, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.settleWithReservation({
      customerId: params.customerId,
      organizationId: params.organizationId,
      priceMinor: params.priceMinor,
      reservedMinor: params.reservedMinor,
      currency: params.currency,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });

/** Low-cardinality shadow compare log (no PII / full customer ids). */
export function logReservationShadowCompare(params: {
  orgIdTail: string;
  legacyOk: boolean;
  reservationOk: boolean;
  needMinor: number;
  availableMinor: number;
  amountMinor: number;
  reservedMinor: number;
  enforced: boolean;
}): void {
  if (params.legacyOk === params.reservationOk) return;
  syncLog("info", "reservation_shadow_mismatch", {
    event: "reservation_shadow_mismatch",
    orgIdTail: params.orgIdTail,
    legacyOk: params.legacyOk,
    reservationOk: params.reservationOk,
    needMinor: params.needMinor,
    availableMinor: params.availableMinor,
    amountMinor: params.amountMinor,
    reservedMinor: params.reservedMinor,
    enforced: params.enforced,
  });
}

export function logRateShadowCompare(params: {
  orgIdTail: string;
  legacyOk: boolean;
  dualOk: boolean;
  enforced: boolean;
}): void {
  if (params.legacyOk === params.dualOk) return;
  syncLog("info", "rate_shadow_mismatch", {
    event: "rate_shadow_mismatch",
    orgIdTail: params.orgIdTail,
    legacyOk: params.legacyOk,
    dualOk: params.dualOk,
    enforced: params.enforced,
  });
}
