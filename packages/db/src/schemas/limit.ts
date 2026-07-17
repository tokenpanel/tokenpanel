/**
 * Plan / subscription / rate-limit / budget schemas — Effect Schema (§11).
 */
import {
  PLAN_INTERVALS,
  SUBSCRIPTION_STATUSES,
} from "@tokenpanel/contracts";
import {
  LimitDimension as LimitDimensionSchema,
  LimitScope as LimitScopeSchema,
  RateLimitRule as RateLimitRuleSchema,
  RateLimitRuleInput as RateLimitRuleInputSchema,
  PlanInterval as PlanIntervalSchema,
  SubscriptionPlanDoc as SubscriptionPlanDocSchema,
  SubscriptionPlanCreateInput as SubscriptionPlanCreateInputSchema,
  SubscriptionPlanUpdateInput as SubscriptionPlanUpdateInputSchema,
  SubscriptionStatus as SubscriptionStatusSchema,
  SubscriptionDoc as SubscriptionDocSchema,
  SubscriptionCreateInput as SubscriptionCreateInputSchema,
  SubscriptionUpdateInput as SubscriptionUpdateInputSchema,
  CustomerLimitDoc as CustomerLimitDocSchema,
  CustomerLimitCreateInput as CustomerLimitCreateInputSchema,
  CustomerLimitUpdateInput as CustomerLimitUpdateInputSchema,
  BudgetDoc as BudgetDocSchema,
  BudgetCreateInput as BudgetCreateInputSchema,
  BudgetUpdateInput as BudgetUpdateInputSchema,
} from "./effect/limit.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export { PLAN_INTERVALS, SUBSCRIPTION_STATUSES };

export const limitDimension = withParseApi(LimitDimensionSchema);
export const limitScope = withParseApi(LimitScopeSchema);
export type LimitDimension = Schema.Schema.Type<typeof LimitDimensionSchema>;
export type LimitScope = Schema.Schema.Type<typeof LimitScopeSchema>;

export const rateLimitRule = withParseApi(RateLimitRuleSchema);
export const rateLimitRuleInput = withParseApi(RateLimitRuleInputSchema);
export type RateLimitRule = MutableDeep<Schema.Schema.Type<typeof RateLimitRuleSchema>>;
export type RateLimitRuleInput = MutableDeep<Schema.Schema.Type<typeof RateLimitRuleInputSchema>>;

export const planInterval = withParseApi(PlanIntervalSchema);
export const subscriptionPlanDoc = withParseApi(SubscriptionPlanDocSchema);
export const subscriptionPlanCreateInput = withParseApi(SubscriptionPlanCreateInputSchema);
export const subscriptionPlanUpdateInput = withParseApi(SubscriptionPlanUpdateInputSchema);
export type SubscriptionPlanDoc = MutableDeep<Schema.Schema.Type<typeof SubscriptionPlanDocSchema>>;
export type SubscriptionPlanCreateInput = MutableDeep<Schema.Schema.Type<typeof SubscriptionPlanCreateInputSchema>>;
export type SubscriptionPlanUpdateInput = MutableDeep<Schema.Schema.Type<typeof SubscriptionPlanUpdateInputSchema>>;

export const subscriptionStatus = withParseApi(SubscriptionStatusSchema);
export const subscriptionDoc = withParseApi(SubscriptionDocSchema);
export const subscriptionCreateInput = withParseApi(SubscriptionCreateInputSchema);
export const subscriptionUpdateInput = withParseApi(SubscriptionUpdateInputSchema);
export type SubscriptionDoc = MutableDeep<Schema.Schema.Type<typeof SubscriptionDocSchema>>;
export type SubscriptionCreateInput = MutableDeep<Schema.Schema.Type<typeof SubscriptionCreateInputSchema>>;
export type SubscriptionUpdateInput = MutableDeep<Schema.Schema.Type<typeof SubscriptionUpdateInputSchema>>;

export const customerLimitDoc = withParseApi(CustomerLimitDocSchema);
export const customerLimitCreateInput = withParseApi(CustomerLimitCreateInputSchema);
export const customerLimitUpdateInput = withParseApi(CustomerLimitUpdateInputSchema);
export type CustomerLimitDoc = MutableDeep<Schema.Schema.Type<typeof CustomerLimitDocSchema>>;
export type CustomerLimitCreateInput = MutableDeep<Schema.Schema.Type<typeof CustomerLimitCreateInputSchema>>;
export type CustomerLimitUpdateInput = MutableDeep<Schema.Schema.Type<typeof CustomerLimitUpdateInputSchema>>;

export const budgetDoc = withParseApi(BudgetDocSchema);
export const budgetCreateInput = withParseApi(BudgetCreateInputSchema);
export const budgetUpdateInput = withParseApi(BudgetUpdateInputSchema);
export type BudgetDoc = MutableDeep<Schema.Schema.Type<typeof BudgetDocSchema>>;
export type BudgetCreateInput = MutableDeep<Schema.Schema.Type<typeof BudgetCreateInputSchema>>;
export type BudgetUpdateInput = MutableDeep<Schema.Schema.Type<typeof BudgetUpdateInputSchema>>;
