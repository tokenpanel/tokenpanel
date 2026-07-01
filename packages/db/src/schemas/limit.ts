import { z } from "zod";
import { objectId, objectIdFromString, money, timestampFields } from "./common.ts";

/**
 * Rate limit dimension + window. Windows are arbitrary seconds so we can
 * express "5-hour" (18000s), "weekly" (604800s), or any custom window.
 */
export const limitDimension = z.enum(["tokens", "requests", "spend_minor"]);
export type LimitDimension = z.infer<typeof limitDimension>;

export const limitScope = z.enum(["customer", "plan", "model", "endpoint"]);
export type LimitScope = z.infer<typeof limitScope>;

/** A single rate-limit rule. */
export const rateLimitRule = z.object({
  /** Stable id within the rules array (for reorder/patch). */
  id: z.string().min(1).max(40),
  /** Window length in seconds. 18000=5h, 604800=week, 2592000=30d, etc. */
  windowSeconds: z.number().int().positive().max(31536000),
  /** What is being capped. */
  dimension: limitDimension,
  /** Cap value in that dimension's unit. */
  capValue: z.number().positive(),
  /** Scope this limit applies to. */
  scope: limitScope.default("customer"),
  /** Optional narrower target (model aliasId / endpoint path). */
  scopeTarget: z.string().max(120).nullish(),
  /** Currency required when dimension = spend_minor. */
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).nullish(),
  active: z.boolean().default(true),
});

export const rateLimitRuleInput = z.object({
  id: z.string().min(1).max(40).optional(),
  windowSeconds: z.number().int().positive().max(31536000),
  dimension: limitDimension,
  capValue: z.number().positive(),
  scope: limitScope.optional(),
  scopeTarget: z.string().max(120).nullish().optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).nullish().optional(),
  active: z.boolean().optional(),
});

export type RateLimitRule = z.infer<typeof rateLimitRule>;
export type RateLimitRuleInput = z.infer<typeof rateLimitRuleInput>;

/**
 * SubscriptionPlan = recurring billing plan a Customer subscribes to.
 * Defines default rate limits + credit allowances applied to subscribers.
 */
export const subscriptionPlanDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  /** Recurring price charged each cycle. */
  price: money,
  /** Cycle length. */
  interval: z.enum(["day", "week", "month", "year"]),
  /** Number of intervals per cycle (for "month" this may be 30). */
  intervalCount: z.number().int().positive().default(1),
  /**
   * Credit allowance per cycle in minor units + currency. Customers on this
   * plan get this balance credited at period start (or 0 for prepaid-only).
   */
  includedCredit: money.default({ amountMinor: 0, currency: "USD" }),
  /** Token allowance per cycle (optional, complementary to credit). */
  includedTokens: z.number().int().nonnegative().default(0),
  /** Default rate limits applied to subscribers. */
  rateLimits: z.array(rateLimitRule).default(() => []),
  active: z.boolean().default(true),
  ...timestampFields,
});

export const subscriptionPlanCreateInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  price: money,
  interval: z.enum(["day", "week", "month", "year"]),
  intervalCount: z.number().int().positive().default(1),
  includedCredit: money.optional(),
  includedTokens: z.number().int().nonnegative().default(0),
  rateLimits: z.array(rateLimitRuleInput).default(() => []),
});

export const subscriptionPlanUpdateInput = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullish().optional(),
  price: money.optional(),
  interval: z.enum(["day", "week", "month", "year"]).optional(),
  intervalCount: z.number().int().positive().optional(),
  includedCredit: money.optional(),
  includedTokens: z.number().int().nonnegative().optional(),
  rateLimits: z.array(rateLimitRuleInput).optional(),
  active: z.boolean().optional(),
});

export type SubscriptionPlanDoc = z.infer<typeof subscriptionPlanDoc>;
export type SubscriptionPlanCreateInput = z.infer<
  typeof subscriptionPlanCreateInput
>;
export type SubscriptionPlanUpdateInput = z.infer<
  typeof subscriptionPlanUpdateInput
>;

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
  customerId: objectIdFromString,
  planId: objectIdFromString,
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
});

export type SubscriptionDoc = z.infer<typeof subscriptionDoc>;
export type SubscriptionCreateInput = z.infer<typeof subscriptionCreateInput>;

/**
 * CustomerLimit = a rate-limit override applied to a specific customer
 * (in addition to or instead of their plan's defaults). Stored as rules
 * for the enforcement engine.
 */
export const customerLimitDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId,
  rules: z.array(rateLimitRule).default(() => []),
  ...timestampFields,
});

export const customerLimitCreateInput = z.object({
  customerId: objectIdFromString,
  rules: z.array(rateLimitRuleInput).default(() => []),
});

export const customerLimitUpdateInput = z.object({
  rules: z.array(rateLimitRuleInput).optional(),
});

export type CustomerLimitDoc = z.infer<typeof customerLimitDoc>;
export type CustomerLimitCreateInput = z.infer<typeof customerLimitCreateInput>;
export type CustomerLimitUpdateInput = z.infer<typeof customerLimitUpdateInput>;

/**
 * Budget = a soft/planned spend allocation for a period (not enforcement).
 * Used for dashboards and alerting; rate limits do enforcement.
 */
export const budgetDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId,
  periodStart: z.instanceof(Date),
  periodEnd: z.instanceof(Date),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  /** Alert thresholds in percent (0–100). */
  alertThresholds: z.array(z.number().int().min(0).max(100)).default([50, 80, 100]),
  ...timestampFields,
});

export const budgetCreateInput = z.object({
  customerId: objectIdFromString,
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  alertThresholds: z.array(z.number().int().min(0).max(100)).optional(),
});

export type BudgetDoc = z.infer<typeof budgetDoc>;
export type BudgetCreateInput = z.infer<typeof budgetCreateInput>;