/**
 * Pure balance reservation decisions (task 9.1 / 9.3).
 * I/O lives in workflow.ts; these are deterministic guards.
 */

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
