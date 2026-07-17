/**
 * Dual-path balance field helpers for the Minor → Units rename window.
 *
 * Effective value prefers legacy Minor, then Units. During pre→swap the old
 * container only updates Minor; dual-copy Units can be stale. New code
 * dual-writes both keys so they stay equal after swap. After post/ drops
 * Minor, $ifNull falls through to Units.
 */

/** Aggregation expr: effective available balance amount. */
export function effectiveAmountExpr(
  amountPath = "$balance.amountUnits",
  amountLegacyPath = "$balance.amountMinor",
): Record<string, unknown> {
  return { $ifNull: [amountLegacyPath, { $ifNull: [amountPath, 0] }] };
}

/** Aggregation expr: effective reserved hold. */
export function effectiveReservedExpr(
  reservedPath = "$balance.reservedUnits",
  reservedLegacyPath = "$balance.reservedMinor",
): Record<string, unknown> {
  return { $ifNull: [reservedLegacyPath, { $ifNull: [reservedPath, 0] }] };
}

/**
 * Pipeline stages: add `amountDelta` / `reservedDelta` to effective balances
 * and write the result to both Units and legacy Minor keys.
 */
export function balanceDualIncPipeline(opts: {
  amountDelta?: number;
  reservedDelta?: number;
  set?: Record<string, unknown>;
}): Record<string, unknown>[] {
  const amountDelta = opts.amountDelta ?? 0;
  const reservedDelta = opts.reservedDelta ?? 0;
  const setDoc: Record<string, unknown> = { ...(opts.set ?? {}) };

  if (amountDelta !== 0) {
    const base = effectiveAmountExpr();
    const next = { $add: [base, amountDelta] };
    setDoc["balance.amountUnits"] = next;
    setDoc["balance.amountMinor"] = next;
  }
  if (reservedDelta !== 0) {
    const base = effectiveReservedExpr();
    const next = { $add: [base, reservedDelta] };
    setDoc["balance.reservedUnits"] = next;
    setDoc["balance.reservedMinor"] = next;
  }

  return [{ $set: setDoc }];
}

/** $expr: effective available (amount - reserved) >= need. */
export function availableGteExpr(need: number): Record<string, unknown> {
  return {
    $gte: [
      {
        $subtract: [effectiveAmountExpr(), effectiveReservedExpr()],
      },
      need,
    ],
  };
}

/** $expr: effective amount >= price. */
export function amountGteExpr(price: number): Record<string, unknown> {
  return {
    $gte: [effectiveAmountExpr(), price],
  };
}

/** $expr: effective reserved >= hold. */
export function reservedGteExpr(reserved: number): Record<string, unknown> {
  return {
    $gte: [effectiveReservedExpr(), reserved],
  };
}
