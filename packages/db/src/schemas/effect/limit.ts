/**
 * Subscription, plan, limit, budget, rate-rule Effect schemas.
 */
import { Schema } from "effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  DateFromUnknown,
  TimestampFields,
  Money,
  CurrencyCode,
  PositiveSafeInt,
  NonNegativeSafeInt,
  SafeInt,
  exactOptional,
  exactNullish,
  boundedString,
  maxString,
} from "./primitives.ts";

export const LimitDimension = Schema.Literal(
  "tokens",
  "requests",
  "spend_minor",
);
export type LimitDimension = Schema.Schema.Type<typeof LimitDimension>;

export const LimitScope = Schema.Literal(
  "customer",
  "plan",
  "model",
  "endpoint",
);
export type LimitScope = Schema.Schema.Type<typeof LimitScope>;

export const RateLimitRule = Schema.Struct({
  id: boundedString(1, 40),
  windowSeconds: SafeInt.pipe(
    Schema.positive(),
    Schema.lessThanOrEqualTo(31536000),
  ),
  dimension: LimitDimension,
  capValue: Schema.Number.pipe(Schema.positive()),
  scope: Schema.optionalWith(LimitScope, {
    default: () => "customer" as const,
  }),
  scopeTarget: exactNullish(maxString(120)),
  currency: exactNullish(CurrencyCode),
  active: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

export const RateLimitRuleInput = Schema.Struct({
  id: exactOptional(boundedString(1, 40)),
  windowSeconds: SafeInt.pipe(
    Schema.positive(),
    Schema.lessThanOrEqualTo(31536000),
  ),
  dimension: LimitDimension,
  capValue: Schema.Number.pipe(Schema.positive()),
  scope: exactOptional(LimitScope),
  scopeTarget: exactNullish(maxString(120)),
  currency: exactNullish(CurrencyCode),
  active: exactOptional(Schema.Boolean),
});

export type RateLimitRule = Schema.Schema.Type<typeof RateLimitRule>;
export type RateLimitRuleInput = Schema.Schema.Type<typeof RateLimitRuleInput>;

export const PlanInterval = Schema.Literal("day", "week", "month", "year");

export const SubscriptionPlanDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  name: boundedString(1, 120),
  description: exactNullish(maxString(2000)),
  price: Money,
  interval: PlanInterval,
  intervalCount: Schema.optionalWith(PositiveSafeInt, { default: () => 1 }),
  includedCredit: Schema.optionalWith(Money, {
    default: () => ({ amountMinor: 0, currency: "USD" }),
  }),
  includedTokens: Schema.optionalWith(NonNegativeSafeInt, {
    default: () => 0,
  }),
  rateLimits: Schema.optionalWith(Schema.Array(RateLimitRule), {
    default: () => [] as Schema.Schema.Type<typeof RateLimitRule>[],
  }),
  active: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  ...TimestampFields,
});

export const SubscriptionPlanCreateInput = Schema.Struct({
  name: boundedString(1, 120),
  description: exactOptional(maxString(2000)),
  price: Money,
  interval: PlanInterval,
  intervalCount: Schema.optionalWith(PositiveSafeInt, { default: () => 1 }),
  includedCredit: exactOptional(Money),
  includedTokens: Schema.optionalWith(NonNegativeSafeInt, {
    default: () => 0,
  }),
  rateLimits: Schema.optionalWith(Schema.Array(RateLimitRuleInput), {
    default: () => [] as Schema.Schema.Type<typeof RateLimitRuleInput>[],
  }),
});

export const SubscriptionPlanUpdateInput = Schema.Struct({
  name: exactOptional(boundedString(1, 120)),
  description: exactNullish(maxString(2000)),
  price: exactOptional(Money),
  interval: exactOptional(PlanInterval),
  intervalCount: exactOptional(PositiveSafeInt),
  includedCredit: exactOptional(Money),
  includedTokens: exactOptional(NonNegativeSafeInt),
  rateLimits: exactOptional(Schema.Array(RateLimitRuleInput)),
  active: exactOptional(Schema.Boolean),
});

export type SubscriptionPlanDoc = Schema.Schema.Type<
  typeof SubscriptionPlanDoc
>;
export type SubscriptionPlanCreateInput = Schema.Schema.Type<
  typeof SubscriptionPlanCreateInput
>;
export type SubscriptionPlanUpdateInput = Schema.Schema.Type<
  typeof SubscriptionPlanUpdateInput
>;

export const SubscriptionStatus = Schema.Literal(
  "active",
  "past_due",
  "canceled",
  "ended",
);

export const SubscriptionDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: ObjectIdFromSelf,
  planId: ObjectIdFromSelf,
  status: SubscriptionStatus,
  periodStart: DateFromSelf,
  periodEnd: DateFromSelf,
  canceledAt: exactNullish(DateFromSelf),
  ...TimestampFields,
});

export const SubscriptionCreateInput = Schema.Struct({
  customerId: ObjectIdFromString,
  planId: ObjectIdFromString,
  periodStart: exactOptional(DateFromUnknown),
  periodEnd: exactOptional(DateFromUnknown),
});

export const SubscriptionUpdateInput = Schema.Struct({
  status: exactOptional(SubscriptionStatus),
  periodStart: exactOptional(DateFromSelf),
  periodEnd: exactOptional(DateFromSelf),
  canceledAt: exactNullish(DateFromSelf),
  planId: exactOptional(ObjectIdFromSelf),
});

export type SubscriptionDoc = Schema.Schema.Type<typeof SubscriptionDoc>;
export type SubscriptionCreateInput = Schema.Schema.Type<
  typeof SubscriptionCreateInput
>;
export type SubscriptionUpdateInput = Schema.Schema.Type<
  typeof SubscriptionUpdateInput
>;

export const CustomerLimitDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: ObjectIdFromSelf,
  rules: Schema.optionalWith(Schema.Array(RateLimitRule), {
    default: () => [] as Schema.Schema.Type<typeof RateLimitRule>[],
  }),
  ...TimestampFields,
});

export const CustomerLimitCreateInput = Schema.Struct({
  customerId: ObjectIdFromString,
  rules: Schema.optionalWith(Schema.Array(RateLimitRuleInput), {
    default: () => [] as Schema.Schema.Type<typeof RateLimitRuleInput>[],
  }),
});

export const CustomerLimitUpdateInput = Schema.Struct({
  rules: exactOptional(Schema.Array(RateLimitRuleInput)),
});

export type CustomerLimitDoc = Schema.Schema.Type<typeof CustomerLimitDoc>;
export type CustomerLimitCreateInput = Schema.Schema.Type<
  typeof CustomerLimitCreateInput
>;
export type CustomerLimitUpdateInput = Schema.Schema.Type<
  typeof CustomerLimitUpdateInput
>;

export const BudgetDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: ObjectIdFromSelf,
  periodStart: DateFromSelf,
  periodEnd: DateFromSelf,
  amountMinor: NonNegativeSafeInt,
  currency: CurrencyCode,
  alertThresholds: Schema.optionalWith(
    Schema.Array(SafeInt.pipe(Schema.between(0, 100))),
    { default: () => [50, 80, 100] },
  ),
  ...TimestampFields,
});

export const BudgetCreateInput = Schema.Struct({
  customerId: ObjectIdFromString,
  periodStart: DateFromUnknown,
  periodEnd: DateFromUnknown,
  amountMinor: NonNegativeSafeInt,
  currency: CurrencyCode,
  alertThresholds: exactOptional(
    Schema.Array(SafeInt.pipe(Schema.between(0, 100))),
  ),
});

export const BudgetUpdateInput = Schema.Struct({
  periodStart: exactOptional(DateFromSelf),
  periodEnd: exactOptional(DateFromSelf),
  amountMinor: exactOptional(NonNegativeSafeInt),
  currency: exactOptional(CurrencyCode),
  alertThresholds: exactOptional(
    Schema.Array(SafeInt.pipe(Schema.between(0, 100))),
  ),
});

export type BudgetDoc = Schema.Schema.Type<typeof BudgetDoc>;
export type BudgetCreateInput = Schema.Schema.Type<typeof BudgetCreateInput>;
export type BudgetUpdateInput = Schema.Schema.Type<typeof BudgetUpdateInput>;
