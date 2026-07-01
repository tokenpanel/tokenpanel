import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  limitDimension,
  limitScope,
  rateLimitRule,
  rateLimitRuleInput,
  subscriptionPlanDoc,
  subscriptionPlanCreateInput,
  subscriptionPlanUpdateInput,
  subscriptionDoc,
  subscriptionCreateInput,
  customerLimitDoc,
  budgetDoc,
  budgetCreateInput,
} from "../limit.ts";

const orgId = () => new ObjectId().toHexString();

test("limitDimension + limitScope enums", () => {
  expect(limitDimension.safeParse("tokens").success).toBe(true);
  expect(limitDimension.safeParse("requests").success).toBe(true);
  expect(limitDimension.safeParse("spend_minor").success).toBe(true);
  expect(limitDimension.safeParse("spend").success).toBe(false);
  expect(limitScope.safeParse("customer").success).toBe(true);
  expect(limitScope.safeParse("plan").success).toBe(true);
  expect(limitScope.safeParse("model").success).toBe(true);
  expect(limitScope.safeParse("endpoint").success).toBe(true);
  expect(limitScope.safeParse("org").success).toBe(false);
});

test("rateLimitRule applies defaults (scope, active) + bounds", () => {
  const r = rateLimitRule.parse({
    id: "r1",
    windowSeconds: 3600,
    dimension: "tokens",
    capValue: 1000,
  });
  expect(r.scope).toBe("customer");
  expect(r.scopeTarget).toBeUndefined();
  expect(r.currency).toBeUndefined();
  expect(r.active).toBe(true);
});

test("rateLimitRule windowSeconds max 31536000, cap positive", () => {
  const b = { id: "r1", dimension: "tokens", capValue: 10 } as const;
  expect(rateLimitRule.safeParse({ ...b, windowSeconds: 31536000 }).success).toBe(true);
  expect(rateLimitRule.safeParse({ ...b, windowSeconds: 31536001 }).success).toBe(false);
  expect(rateLimitRule.safeParse({ ...b, windowSeconds: 0 }).success).toBe(false);
  expect(rateLimitRule.safeParse({ ...b, windowSeconds: 1.5 }).success).toBe(false);
  expect(rateLimitRule.safeParse({ ...b, windowSeconds: 3600, capValue: 0 }).success).toBe(false);
  expect(rateLimitRule.safeParse({ ...b, windowSeconds: 3600, capValue: -1 }).success).toBe(false);
});

test("rateLimitRuleInput allows optional fields (no defaults)", () => {
  const r = rateLimitRuleInput.safeParse({
    windowSeconds: 3600,
    dimension: "tokens",
    capValue: 10,
  });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.scope).toBeUndefined();
    expect(r.data.active).toBeUndefined();
  }
});

test("subscriptionPlanDoc defaults: intervalCount 1, includedCredit 0 USD, includedTokens 0, rateLimits []", () => {
  const r = subscriptionPlanDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    name: "Pro",
    price: { amountMinor: 1000, currency: "USD" },
    interval: "month",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.intervalCount).toBe(1);
  expect(r.includedCredit).toEqual({ amountMinor: 0, currency: "USD" });
  expect(r.includedTokens).toBe(0);
  expect(r.rateLimits).toEqual([]);
  expect(r.active).toBe(true);
});

test("subscriptionPlanCreateInput validates interval enum + price money", () => {
  const b = {
    name: "Pro",
    price: { amountMinor: 1000, currency: "USD" },
    interval: "month",
  };
  expect(subscriptionPlanCreateInput.safeParse(b).success).toBe(true);
  expect(subscriptionPlanCreateInput.safeParse({ ...b, interval: "decade" }).success).toBe(false);
  expect(subscriptionPlanCreateInput.safeParse({ ...b, price: { amountMinor: -1, currency: "USD" } }).success).toBe(false);
  expect(subscriptionPlanCreateInput.safeParse({ ...b, intervalCount: 0 }).success).toBe(false);
});

test("subscriptionPlanUpdateInput all optional", () => {
  expect(subscriptionPlanUpdateInput.safeParse({}).success).toBe(true);
  expect(subscriptionPlanUpdateInput.safeParse({ name: "X" }).success).toBe(true);
  expect(subscriptionPlanUpdateInput.safeParse({ interval: "bad" }).success).toBe(false);
});

test("subscriptionDoc status enum", () => {
  const b = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    planId: new ObjectId(),
    periodStart: new Date(),
    periodEnd: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  for (const s of ["trialing", "active", "past_due", "canceled", "ended"]) {
    expect(subscriptionDoc.safeParse({ ...b, status: s }).success).toBe(true);
  }
  expect(subscriptionDoc.safeParse({ ...b, status: "paused" }).success).toBe(false);
});

test("subscriptionCreateInput coerces period dates from strings", () => {
  const r = subscriptionCreateInput.parse({
    customerId: orgId(),
    planId: orgId(),
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
  });
  expect(r.periodStart).toBeInstanceOf(Date);
  expect(r.periodEnd).toBeInstanceOf(Date);
});

test("customerLimitDoc defaults rules []", () => {
  const r = customerLimitDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.rules).toEqual([]);
});

test("budgetDoc defaults alertThresholds [50,80,100], amountMinor nonneg", () => {
  const r = budgetDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    periodStart: new Date(),
    periodEnd: new Date(),
    amountMinor: 1000,
    currency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.alertThresholds).toEqual([50, 80, 100]);
  expect(budgetDoc.safeParse({ ...r, amountMinor: -1 }).success).toBe(false);
});

test("budgetCreateInput threshold bounds 0-100", () => {
  const b = {
    customerId: orgId(),
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
    amountMinor: 1000,
    currency: "USD",
  };
  expect(budgetCreateInput.safeParse({ ...b, alertThresholds: [50, 80, 100] }).success).toBe(true);
  expect(budgetCreateInput.safeParse({ ...b, alertThresholds: [101] }).success).toBe(false);
  expect(budgetCreateInput.safeParse({ ...b, alertThresholds: [-1] }).success).toBe(false);
});