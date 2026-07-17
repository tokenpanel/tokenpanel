/**
 * Customer domain policy (server-only re-exports of browser-safe contracts).
 *
 * Policy version: 2026-07-15
 * Enum authority: @tokenpanel/contracts. Server-only field length bounds live
 * here so routes/schemas can share without inventing a second enum source.
 */

import {
  BALANCE_ADJUSTMENT_REASONS,
  CUSTOMER_STATUSES,
  OPERATOR_BALANCE_REASONS,
  type BalanceAdjustmentReason,
  type CustomerStatus,
  type OperatorBalanceReason,
} from "@tokenpanel/contracts";

export const CUSTOMERS_POLICY_VERSION = "2026-07-15" as const;

export {
  BALANCE_ADJUSTMENT_REASONS,
  CUSTOMER_STATUSES,
  OPERATOR_BALANCE_REASONS,
};
export type { BalanceAdjustmentReason, CustomerStatus, OperatorBalanceReason };

/** Customer name max length. Unit: count (chars). */
export const CUSTOMER_NAME_MAX_CHARS = 160;

/** Customer externalId max length. Unit: count (chars). */
export const CUSTOMER_EXTERNAL_ID_MAX_CHARS = 128;

/** Balance adjustment note max length. Unit: count (chars). */
export const BALANCE_NOTE_MAX_CHARS = 280;

/** Customer email max length. Unit: count (chars). */
export const CUSTOMER_EMAIL_MAX_CHARS = 254;
