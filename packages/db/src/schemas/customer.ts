import { z } from "zod";
import {
  objectId,
  objectIdFromString,
  money,
  moneyMinor,
  currencyCode,
  timestampFields,
} from "./common.ts";

/**
 * Customer = a client of an Organization.
 * Has a prepaid balance and may hold subscriptions.
 */
export const customerDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  externalId: z.string().max(128).nullish(),
  name: z.string().min(1).max(160),
  email: z.string().email().max(254).nullish(),
  /** Prepaid balance in minor units + currency. */
  balance: money.default({ amountMinor: 0, currency: "USD" }),
  status: z.enum(["active", "suspended", "closed"]).default("active"),
  metadata: z.record(z.string(), z.unknown()).default(() => ({})),
  ...timestampFields,
});

export const customerCreateInput = z.object({
  externalId: z.string().max(128).optional(),
  name: z.string().min(1).max(160),
  email: z.string().email().max(254).optional(),
  startingBalance: money.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const customerUpdateInput = z.object({
  externalId: z.string().max(128).nullish().optional(),
  name: z.string().min(1).max(160).optional(),
  email: z.string().email().max(254).nullish().optional(),
  status: z.enum(["active", "suspended", "closed"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Balance top-up / adjustment ledger entry. Append-only. */
export const balanceAdjustmentDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId,
  /** Positive for top-up, negative for debit. */
  amountMinor: z.number().int(),
  currency: currencyCode,
  reason: z.enum([
    "topup",
    "usage_debit",
    "refund",
    "adjustment",
    "overage",
  ]),
  /** Optional reference to the usage record that caused a debit. */
  usageRecordId: objectId.nullish(),
  note: z.string().max(280).nullish(),
  occurredAt: z.instanceof(Date),
  ...timestampFields,
});

export const balanceAdjustmentCreateInput = z.object({
  customerId: objectIdFromString,
  amountMinor: z.number().int(),
  currency: currencyCode,
  reason: z.enum([
    "topup",
    "usage_debit",
    "refund",
    "adjustment",
    "overage",
  ]),
  usageRecordId: objectIdFromString.optional(),
  note: z.string().max(280).optional(),
  occurredAt: z.coerce.date().optional(),
});

export type CustomerDoc = z.infer<typeof customerDoc>;
export type CustomerCreateInput = z.infer<typeof customerCreateInput>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateInput>;
export type BalanceAdjustmentDoc = z.infer<typeof balanceAdjustmentDoc>;
export type BalanceAdjustmentCreateInput = z.infer<
  typeof balanceAdjustmentCreateInput
>;

/** Re-export moneyMinor for convenience in consumers. */
export { moneyMinor as _balanceMoneyMinor };