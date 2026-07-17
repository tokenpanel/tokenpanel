/**
 * Browser-safe customer lifecycle + balance ledger contracts.
 *
 * Policy version: 2026-07-15
 * Owned by @tokenpanel/contracts. DB storage schemas and admin UI derive from
 * these tuples. Migrations MUST NOT import this module — keep frozen snapshots.
 *
 * Effect Schema live under `@tokenpanel/contracts/effect`.
 */
import { Schema } from "effect";
import { withParseApi } from "./parse.ts";

// ---------------------------------------------------------------------------
// Customer status
// ---------------------------------------------------------------------------

export const CUSTOMER_STATUSES = ["active", "suspended", "closed"] as const;

export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

// ---------------------------------------------------------------------------
// Balance adjustment reasons (append-only ledger)
// ---------------------------------------------------------------------------

export const BALANCE_ADJUSTMENT_REASONS = [
  "topup",
  "usage_debit",
  "refund",
  "adjustment",
  "overage",
] as const;

export type BalanceAdjustmentReason =
  (typeof BALANCE_ADJUSTMENT_REASONS)[number];

/** Operator-facing reasons (excludes automatic usage_debit). */
export const OPERATOR_BALANCE_REASONS = [
  "topup",
  "adjustment",
  "refund",
] as const satisfies readonly BalanceAdjustmentReason[];

export type OperatorBalanceReason = (typeof OPERATOR_BALANCE_REASONS)[number];

export const customerStatusSchema = withParseApi(
  Schema.Literal(...CUSTOMER_STATUSES),
);
export const balanceAdjustmentReasonSchema = withParseApi(
  Schema.Literal(...BALANCE_ADJUSTMENT_REASONS),
);
