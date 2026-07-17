/**
 * Atomic balance reservation.
 *
 * Available = amountUnits - reservedUnits.
 * preFlight holds estimated spend in reservedUnits; settle releases the hold
 * and debits actual price. Release on upstream failure / cancel.
 *
 * Persistence: schema-decoding CustomersRepo only (task 14.2).
 * Primary API is Effect (run on ManagedRuntime / AppServices).
 */

import { Effect } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { CustomersRepo } from "../infrastructure/mongo/repositories/customers.ts";
import type { MongoFailure } from "../infrastructure/mongo/try-mongo.ts";

export type BalanceSnapshot = {
  amountUnits: number;
  reservedUnits: number;
  currency: string;
};

/** Available prepaid cash after holds. */
export function availableUnits(balance: {
  amountUnits: number;
  reservedUnits?: number | null;
}): number {
  const reserved = Math.max(0, balance.reservedUnits ?? 0);
  return Math.max(0, balance.amountUnits - reserved);
}

/** Pure decision: would a hold of `needUnits` succeed given this snapshot? */
export function wouldReserveSucceed(
  balance: BalanceSnapshot,
  needUnits: number,
  currency: string,
):
  | { ok: true }
  | { ok: false; reason: "currency_mismatch" | "insufficient_available" } {
  if (needUnits <= 0) return { ok: true };
  if (balance.currency !== currency) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (availableUnits(balance) < needUnits) {
    return { ok: false, reason: "insufficient_available" };
  }
  return { ok: true };
}

export type ReserveResult =
  | { reserved: true; reservedUnits: number }
  | { reserved: false; reason: string };

/**
 * Atomic hold: available >= need → $inc reservedUnits.
 * Missing reservedUnits treated as 0 via $ifNull in $expr.
 */
export const reserveBalance = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  needUnits: number;
  currency: string;
  session?: ClientSession;
}): Effect.Effect<ReserveResult, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.reserveBalance({
      customerId: params.customerId,
      organizationId: params.organizationId,
      needUnits: params.needUnits,
      currency: params.currency,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });

/** Release a prior hold without debiting (upstream failure / cancel). */
export const releaseBalanceReservation = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  reservedUnits: number;
  session?: ClientSession;
}): Effect.Effect<boolean, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.releaseReserved({
      customerId: params.customerId,
      organizationId: params.organizationId,
      reservedUnits: params.reservedUnits,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });

/**
 * Settle after a hold: debit actual priceUnits and release the full reserved hold.
 * Filter requires reservedUnits >= reserved and amountUnits >= priceUnits.
 */
export const settleBalanceWithReservation = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  priceUnits: number;
  reservedUnits: number;
  currency: string;
  session?: ClientSession;
}): Effect.Effect<boolean, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.settleWithReservation({
      customerId: params.customerId,
      organizationId: params.organizationId,
      priceUnits: params.priceUnits,
      reservedUnits: params.reservedUnits,
      currency: params.currency,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });
