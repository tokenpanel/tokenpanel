/**
 * Atomic balance reservation (ADR 001 dual-write / org canary).
 *
 * Available = amountMinor - reservedMinor.
 * Canary orgs: preFlight holds estimated spend in reservedMinor; settle releases
 * the hold and debits actual price. Non-canary: shadow-compare only, legacy
 * checkBalance remains the enforcement reader.
 */

import { ObjectId, type ClientSession } from "mongodb";
import { getDb } from "@tokenpanel/db";

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
): { ok: true } | { ok: false; reason: "currency_mismatch" | "insufficient_available" } {
  if (needMinor <= 0) return { ok: true };
  if (balance.currency !== currency) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (availableMinor(balance) < needMinor) {
    return { ok: false, reason: "insufficient_available" };
  }
  return { ok: true };
}

/**
 * Atomic hold: available >= need → $inc reservedMinor.
 * Missing reservedMinor treated as 0 via $ifNull in $expr.
 */
export async function reserveBalance(params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  needMinor: number;
  currency: string;
  session?: ClientSession;
}): Promise<{ reserved: true; reservedMinor: number } | { reserved: false; reason: string }> {
  if (params.needMinor <= 0) {
    return { reserved: true, reservedMinor: 0 };
  }
  const db = await getDb();
  const now = new Date();
  const result = await db.customers.updateOne(
    {
      _id: params.customerId,
      organizationId: params.organizationId,
      "balance.currency": params.currency,
      status: { $ne: "closed" },
      $expr: {
        $gte: [
          {
            $subtract: [
              "$balance.amountMinor",
              { $ifNull: ["$balance.reservedMinor", 0] },
            ],
          },
          params.needMinor,
        ],
      },
    },
    {
      $inc: { "balance.reservedMinor": params.needMinor },
      $set: { updatedAt: now },
    },
    { session: params.session },
  );
  if (result.matchedCount === 0) {
    return { reserved: false, reason: "insufficient_available" };
  }
  return { reserved: true, reservedMinor: params.needMinor };
}

/** Release a prior hold without debiting (upstream failure / cancel). */
export async function releaseBalanceReservation(params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  reservedMinor: number;
  session?: ClientSession;
}): Promise<boolean> {
  if (params.reservedMinor <= 0) return true;
  const db = await getDb();
  const now = new Date();
  const result = await db.customers.updateOne(
    {
      _id: params.customerId,
      organizationId: params.organizationId,
      $expr: {
        $gte: [{ $ifNull: ["$balance.reservedMinor", 0] }, params.reservedMinor],
      },
    },
    {
      $inc: { "balance.reservedMinor": -params.reservedMinor },
      $set: { updatedAt: now },
    },
    { session: params.session },
  );
  return result.matchedCount > 0;
}

/**
 * Settle after a hold: debit actual priceMinor and release the full reserved hold.
 * Filter requires reservedMinor >= reserved and amountMinor >= priceMinor.
 */
export async function settleBalanceWithReservation(params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  priceMinor: number;
  reservedMinor: number;
  currency: string;
  session?: ClientSession;
}): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const reserved = Math.max(0, params.reservedMinor);
  const price = Math.max(0, params.priceMinor);

  if (price === 0 && reserved === 0) return true;

  const filter: Record<string, unknown> = {
    _id: params.customerId,
    organizationId: params.organizationId,
    "balance.currency": params.currency,
    status: { $ne: "closed" },
  };
  if (price > 0) {
    filter["balance.amountMinor"] = { $gte: price };
  }
  if (reserved > 0) {
    filter.$expr = {
      $gte: [{ $ifNull: ["$balance.reservedMinor", 0] }, reserved],
    };
  }

  const inc: Record<string, number> = {};
  if (price > 0) inc["balance.amountMinor"] = -price;
  if (reserved > 0) inc["balance.reservedMinor"] = -reserved;

  const result = await db.customers.updateOne(
    filter,
    { $inc: inc, $set: { updatedAt: now } },
    { session: params.session },
  );
  return result.matchedCount > 0;
}

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
  console.info(
    JSON.stringify({
      event: "reservation_shadow_mismatch",
      orgIdTail: params.orgIdTail,
      legacyOk: params.legacyOk,
      reservationOk: params.reservationOk,
      needMinor: params.needMinor,
      availableMinor: params.availableMinor,
      amountMinor: params.amountMinor,
      reservedMinor: params.reservedMinor,
      enforced: params.enforced,
    }),
  );
}

export function logRateShadowCompare(params: {
  orgIdTail: string;
  legacyOk: boolean;
  dualOk: boolean;
  enforced: boolean;
}): void {
  if (params.legacyOk === params.dualOk) return;
  console.info(
    JSON.stringify({
      event: "rate_shadow_mismatch",
      orgIdTail: params.orgIdTail,
      legacyOk: params.legacyOk,
      dualOk: params.dualOk,
      enforced: params.enforced,
    }),
  );
}
