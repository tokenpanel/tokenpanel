import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  windowSecondsToHuman,
  ruleIncrement,
  resolveScopeTarget,
  getEffectiveRules,
  checkLimits,
  recordUsage,
} from "../rate-limits.ts";
import type { RateLimitRule } from "@tokenpanel/db";

function rule(over: Partial<RateLimitRule> = {}): RateLimitRule {
  return {
    id: "r1",
    windowSeconds: 3600,
    dimension: "tokens",
    capValue: 1000,
    scope: "customer",
    scopeTarget: null,
    currency: null,
    active: true,
    ...over,
  };
}

test("windowSecondsToHuman known + fallback", () => {
  expect(windowSecondsToHuman(3600)).toBe("1h");
  expect(windowSecondsToHuman(18000)).toBe("5h");
  expect(windowSecondsToHuman(86400)).toBe("1d");
  expect(windowSecondsToHuman(604800)).toBe("1w");
  expect(windowSecondsToHuman(2592000)).toBe("30d");
  expect(windowSecondsToHuman(7200)).toBe("7200s");
  expect(windowSecondsToHuman(1)).toBe("1s");
});

test("ruleIncrement per dimension", () => {
  const usage = { tokens: 500, requests: 1, spendMinor: 200, currency: "USD" };
  expect(ruleIncrement(rule({ dimension: "tokens" }), usage)).toBe(500);
  expect(ruleIncrement(rule({ dimension: "requests" }), usage)).toBe(1);
  expect(ruleIncrement(rule({ dimension: "spend_minor" }), usage)).toBe(200);
});

test("resolveScopeTarget: customer/plan → null; model with alias → alias; model without → undefined", () => {
  expect(resolveScopeTarget(rule({ scope: "customer" }), "gpt", undefined)).toBeNull();
  expect(resolveScopeTarget(rule({ scope: "plan" }), "gpt", undefined)).toBeNull();
  expect(resolveScopeTarget(rule({ scope: "model" }), "gpt", undefined)).toBe("gpt");
  expect(resolveScopeTarget(rule({ scope: "model" }), undefined, undefined)).toBeUndefined();
  expect(resolveScopeTarget(rule({ scope: "model", scopeTarget: "fallback" }), undefined, undefined)).toBe("fallback");
  expect(resolveScopeTarget(rule({ scope: "endpoint" }), undefined, "/v1/chat")).toBe("/v1/chat");
  expect(resolveScopeTarget(rule({ scope: "endpoint" }), undefined, undefined)).toBeUndefined();
});

test("getEffectiveRules: no subscription + no customer limits → []", async () => {
  const db = mockDb({
    subscriptions: { findOne: async () => null },
    subscriptionPlans: { findOne: async () => null },
    customerLimits: { findOne: async () => null },
  });
  const rules = await getEffectiveRules(db as never, new ObjectId());
  expect(rules).toEqual([]);
});

test("getEffectiveRules: plan rules only, active only", async () => {
  const planRules = [rule({ id: "p1", active: true }), rule({ id: "p2", active: false })];
  const db = mockDb({
    subscriptions: { findOne: async () => ({ planId: new ObjectId(), status: "active", periodEnd: new Date() } as never) },
    subscriptionPlans: { findOne: async () => ({ rateLimits: planRules } as never) },
    customerLimits: { findOne: async () => null },
  });
  const rules = await getEffectiveRules(db as never, new ObjectId());
  expect(rules.map((r) => r.id)).toEqual(["p1"]);
});

test("getEffectiveRules: customer rules override plan rules by id", async () => {
  const planRules = [rule({ id: "shared", capValue: 100 }), rule({ id: "p1", capValue: 50 })];
  const customerRules = [rule({ id: "shared", capValue: 999 }), rule({ id: "c1", capValue: 10 })];
  const db = mockDb({
    subscriptions: { findOne: async () => ({ planId: new ObjectId(), status: "active", periodEnd: new Date() } as never) },
    subscriptionPlans: { findOne: async () => ({ rateLimits: planRules } as never) },
    customerLimits: { findOne: async () => ({ rules: customerRules } as never) },
  });
  const rules = await getEffectiveRules(db as never, new ObjectId());
  const byId = new Map(rules.map((r) => [r.id, r]));
  expect(byId.get("shared")?.capValue).toBe(999);
  expect(byId.get("p1")?.capValue).toBe(50);
  expect(byId.get("c1")?.capValue).toBe(10);
});

test("checkLimits: ok when current + increment <= cap", async () => {
  const r = rule({ windowSeconds: 3600, dimension: "tokens", capValue: 1000 });
  const db = mockDb({
    rateLimitCounters: {
      find: () => ({ toArray: async () => [{ count: 500, bucketStart: new Date(Date.now() - 1000) } as never] }),
    },
  });
  const res = await checkLimits({ db: db as never, customerId: new ObjectId(), rules: [r], estimatedTokens: 400 });
  expect(res.ok).toBe(true);
  expect(res.violated).toHaveLength(0);
});

test("checkLimits: violated when current + increment > cap, retryAfter >= 1", async () => {
  const r = rule({ windowSeconds: 3600, dimension: "tokens", capValue: 1000 });
  const db = mockDb({
    rateLimitCounters: {
      find: () => ({ toArray: async () => [{ count: 900, bucketStart: new Date(Date.now() - 60000) } as never] }),
    },
  });
  const res = await checkLimits({ db: db as never, customerId: new ObjectId(), rules: [r], estimatedTokens: 200 });
  expect(res.ok).toBe(false);
  expect(res.violated).toHaveLength(1);
  expect(res.violated[0]?.cap).toBe(1000);
  expect(res.violated[0]?.current).toBe(900);
  expect(res.violated[0]?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
});

test("checkLimits: skips model-scoped rule when no modelAliasId (undefined target)", async () => {
  const r = rule({ scope: "model" });
  const db = mockDb({
    rateLimitCounters: {
      find: () => ({ toArray: async () => [] }),
    },
  });
  const res = await checkLimits({ db: db as never, customerId: new ObjectId(), rules: [r], estimatedTokens: 999999 });
  expect(res.ok).toBe(true);
  expect(res.violated).toHaveLength(0);
});

test("recordUsage: skips rules with 0 increment", async () => {
  const r = rule({ dimension: "tokens" });
  const calls: unknown[] = [];
  const db = mockDb({
    rateLimitCounters: {
      bulkWrite: async (ops: unknown[]) => { calls.push(ops); return { insertedCount: 0, modifiedCount: 0, upsertedCount: 0, deletedCount: 0, matchedCount: 0 } as never; },
    },
  });
  await recordUsage({
    db: db as never,
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    rules: [r],
    usage: { tokens: 0, requests: 0, spendMinor: 0, currency: "USD" },
  });
  expect(calls).toHaveLength(0);
});

test("recordUsage: writes one upsert per active rule, bucketStart floored to window", async () => {
  const r1 = rule({ id: "r1", dimension: "tokens", windowSeconds: 3600 });
  const r2 = rule({ id: "r2", dimension: "requests", windowSeconds: 18000 });
  let ops: unknown[] = [];
  const db = mockDb({
    rateLimitCounters: {
      bulkWrite: async (o: unknown[]) => { ops = o; return { insertedCount: 0, modifiedCount: 0, upsertedCount: 0, deletedCount: 0, matchedCount: 0 } as never; },
    },
  });
  await recordUsage({
    db: db as never,
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    rules: [r1, r2],
    usage: { tokens: 100, requests: 1, spendMinor: 0, currency: "USD" },
    occurredAt: new Date(1700000000000),
  });
  expect(ops).toHaveLength(2);
  const first = (ops[0] as { updateOne: { filter: Record<string, unknown> } }).updateOne.filter;
  expect(first.bucketStart).toBeInstanceOf(Date);
  const bucketMs = (first.bucketStart as Date).getTime();
  expect(bucketMs % 3600000).toBe(0);
});

function mockDb(over: Record<string, unknown>): Record<string, unknown> {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      throw new Error(`unexpected db access: ${String(prop)}`);
    },
  };
  return new Proxy({ ...over }, handler);
}