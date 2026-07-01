import { z } from "zod";
import { objectId, objectIdFromString, money, timestampFields } from "./common.ts";

/**
 * Subscription = recurring billing plan a Customer subscribes to.
 * Entitles the customer to quota within each reset window.
 */
export const subscriptionPlanDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  name: z.string().min(1).max(120),
  /** Recurring price charged each cycle. */
  price: money,
  /** Cycle length. */
  interval: z.enum(["day", "week", "month", "year"]),
  /** Number of days per cycle (for "month" this may be 30). */
  intervalCount: z.number().int().positive().default(1),
  /** Tokens included free per cycle. */
  includedTokens: z.number().int().nonnegative().default(0),
  /** Overage price per 1k tokens beyond quota. */
  overagePerKTokens: money.nullish(),
  active: z.boolean().default(true),
  ...timestampFields,
});

export const subscriptionPlanCreateInput = z.object({
  organizationId: objectIdFromString,
  name: z.string().min(1).max(120),
  price: money,
  interval: z.enum(["day", "week", "month", "year"]),
  intervalCount: z.number().int().positive().default(1),
  includedTokens: z.number().int().nonnegative().default(0),
  overagePerKTokens: money.optional(),
});

export type SubscriptionPlanDoc = z.infer<typeof subscriptionPlanDoc>;
export type SubscriptionPlanCreateInput = z.infer<typeof subscriptionPlanCreateInput>;

/**
 * A Customer's active subscription instance.
 * `periodStart`/`periodEnd` bound the current usage window.
 */
export const subscriptionDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId,
  planId: objectId,
  status: z.enum(["trialing", "active", "past_due", "canceled", "ended"]),
  periodStart: z.instanceof(Date),
  periodEnd: z.instanceof(Date),
  canceledAt: z.instanceof(Date).nullish(),
  ...timestampFields,
});

export const subscriptionCreateInput = z.object({
  organizationId: objectIdFromString,
  customerId: objectIdFromString,
  planId: objectIdFromString,
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

export type SubscriptionDoc = z.infer<typeof subscriptionDoc>;
export type SubscriptionCreateInput = z.infer<typeof subscriptionCreateInput>;