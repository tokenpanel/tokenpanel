/**
 * Pure balance reservation decisions (task 9.1 / 9.3).
 * I/O lives in workflow.ts; these are deterministic guards.
 */

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

/** Legacy checkBalance reader decision (amount only, not available). */
export function wouldLegacyBalanceSucceed(
  balance: BalanceSnapshot,
  needMinor: number,
  currency: string,
):
  | { ok: true }
  | { ok: false; reason: "currency_mismatch" | "insufficient_balance" } {
  if (needMinor <= 0) return { ok: true };
  if (balance.currency !== currency) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (balance.amountMinor < needMinor) {
    return { ok: false, reason: "insufficient_balance" };
  }
  return { ok: true };
}

/** Org is in reservation canary set (enforcement path). */
export function isCanaryOrg(
  orgIdHex: string,
  canaryOrgIds: ReadonlySet<string>,
): boolean {
  return canaryOrgIds.has(orgIdHex);
}
