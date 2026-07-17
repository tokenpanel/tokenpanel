import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
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
import { UsageRepo } from "../../infrastructure/mongo/repositories/usage.ts";
import { PlansRepo } from "../../infrastructure/mongo/repositories/plans.ts";
import type { UsageRepoService } from "../../infrastructure/mongo/repositories/usage.ts";
import type { PlansRepoService } from "../../infrastructure/mongo/repositories/plans.ts";
import type { AppServices } from "../../runtime/layers/live.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
  getAppRuntime,
} from "../../runtime/app-runtime.ts";

/** Run domain Effect on installed test ManagedRuntime. */
function runEffect<A, E>(
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> {
  return getAppRuntime().runPromise(effect);
}

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

/**
 * Install a runtime with stub repo services so the rate-limit functions
 * (which resolve repos via the managed runtime) can be exercised in isolation.
 */
function installRuntime(stubs: {
  plans: Partial<PlansRepoService>;
  usage: Partial<UsageRepoService>;
}): void {
  const plans = stubs.plans as PlansRepoService;
  const usage = stubs.usage as UsageRepoService;
  const layer = Layer.mergeAll(
    Layer.succeed(PlansRepo, plans),
    Layer.succeed(UsageRepo, usage),
  ) as unknown as Layer.Layer<AppServices, never, never>;
  createAppRuntime(layer, { install: true });
}

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
});

describe("pure rate-limit helpers", () => {
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
});

describe("getEffectiveRules (repo-backed)", () => {
  test("no subscription + no customer limits → []", async () => {
    installRuntime({
      plans: {
        findActiveSubscriptionByCustomer: () => Effect.succeed(null),
        findCustomerLimitByCustomer: () => Effect.succeed(null),
      },
      usage: {},
    });
    const rules = await runEffect(getEffectiveRules(new ObjectId()));
    expect(rules).toEqual([]);
  });

  test("plan rules only, active only", async () => {
    const planId = new ObjectId();
    const planRules = [
      rule({ id: "p1", active: true }),
      rule({ id: "p2", active: false }),
    ];
    installRuntime({
      plans: {
        findActiveSubscriptionByCustomer: () =>
          Effect.succeed({
            _id: new ObjectId(),
            organizationId: new ObjectId(),
            customerId: new ObjectId(),
            planId,
            status: "active",
            periodStart: new Date(),
            periodEnd: new Date(),
            canceledAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
        findPlanByIdNoOrg: () =>
          Effect.succeed({
            _id: planId,
            organizationId: new ObjectId(),
            name: "p",
            description: null,
            price: { amountMinor: 0, currency: "USD" },
            interval: "month",
            intervalCount: 1,
            includedCredit: { amountMinor: 0, currency: "USD" },
            includedTokens: 0,
            rateLimits: planRules,
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
        findCustomerLimitByCustomer: () => Effect.succeed(null),
      },
      usage: {},
    });
    const rules = await runEffect(getEffectiveRules(new ObjectId()));
    expect(rules.map((r) => r.id)).toEqual(["p1"]);
  });

  test("customer rules override plan rules by id", async () => {
    const planId = new ObjectId();
    const planRules = [
      rule({ id: "shared", capValue: 100 }),
      rule({ id: "p1", capValue: 50 }),
    ];
    const customerRules = [
      rule({ id: "shared", capValue: 999 }),
      rule({ id: "c1", capValue: 10 }),
    ];
    installRuntime({
      plans: {
        findActiveSubscriptionByCustomer: () =>
          Effect.succeed({
            _id: new ObjectId(),
            organizationId: new ObjectId(),
            customerId: new ObjectId(),
            planId,
            status: "active",
            periodStart: new Date(),
            periodEnd: new Date(),
            canceledAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
        findPlanByIdNoOrg: () =>
          Effect.succeed({
            _id: planId,
            organizationId: new ObjectId(),
            name: "p",
            description: null,
            price: { amountMinor: 0, currency: "USD" },
            interval: "month",
            intervalCount: 1,
            includedCredit: { amountMinor: 0, currency: "USD" },
            includedTokens: 0,
            rateLimits: planRules,
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
        findCustomerLimitByCustomer: () =>
          Effect.succeed({
            _id: new ObjectId(),
            organizationId: new ObjectId(),
            customerId: new ObjectId(),
            rules: customerRules,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
      },
      usage: {},
    });
    const rules = await runEffect(getEffectiveRules(new ObjectId()));
    const byId = new Map(rules.map((r) => [r.id, r]));
    expect(byId.get("shared")?.capValue).toBe(999);
    expect(byId.get("p1")?.capValue).toBe(50);
    expect(byId.get("c1")?.capValue).toBe(10);
  });
});

describe("checkLimits (repo-backed)", () => {
  test("ok when current + increment <= cap", async () => {
    const r = rule({ windowSeconds: 3600, dimension: "tokens", capValue: 1000 });
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            {
              _id: new ObjectId(),
              organizationId: new ObjectId(),
              customerId: new ObjectId(),
              dimension: "tokens",
              windowSeconds: 3600,
              bucketStart: new Date(Date.now() - 1000),
              count: 500,
              scopeTarget: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as never,
          ]),
      },
    });
    const res = await runEffect(
      checkLimits({
        customerId: new ObjectId(),
        rules: [r],
        estimatedTokens: 400,
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.violated).toHaveLength(0);
  });

  test("violated when current + increment > cap, retryAfter >= 1", async () => {
    const r = rule({ windowSeconds: 3600, dimension: "tokens", capValue: 1000 });
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            {
              _id: new ObjectId(),
              organizationId: new ObjectId(),
              customerId: new ObjectId(),
              dimension: "tokens",
              windowSeconds: 3600,
              bucketStart: new Date(Date.now() - 60000),
              count: 900,
              scopeTarget: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as never,
          ]),
      },
    });
    const res = await runEffect(
      checkLimits({
        customerId: new ObjectId(),
        rules: [r],
        estimatedTokens: 200,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.violated).toHaveLength(1);
    expect(res.violated[0]?.cap).toBe(1000);
    expect(res.violated[0]?.current).toBe(900);
    expect(res.violated[0]?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test("skips model-scoped rule when no modelAliasId (undefined target)", async () => {
    const r = rule({ scope: "model" });
    let called = false;
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () => {
          called = true;
          return Effect.succeed([]);
        },
      },
    });
    const res = await runEffect(
      checkLimits({
        customerId: new ObjectId(),
        rules: [r],
        estimatedTokens: 999999,
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.violated).toHaveLength(0);
    expect(called).toBe(false);
  });
});

describe("recordUsage (repo-backed)", () => {
  test("skips rules with 0 increment (no bulk upsert)", async () => {
    const r = rule({ dimension: "tokens" });
    let calls = 0;
    installRuntime({
      plans: {},
      usage: {
        bulkUpsertCounters: () => {
          calls += 1;
          return Effect.void;
        },
      },
    });
    await runEffect(
      recordUsage({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r],
        usage: { tokens: 0, requests: 0, spendMinor: 0, currency: "USD" },
      }),
    );
    expect(calls).toBe(0);
  });

  test("writes one upsert per active rule, bucketStart floored to window", async () => {
    const r1 = rule({ id: "r1", dimension: "tokens", windowSeconds: 3600 });
    const r2 = rule({ id: "r2", dimension: "requests", windowSeconds: 18000 });
    let captured: { bucketStart: Date; windowSeconds: number }[] = [];
    installRuntime({
      plans: {},
      usage: {
        bulkUpsertCounters: (params) => {
          captured = params.entries.map((e) => ({
            bucketStart: e.bucketStart,
            windowSeconds: e.windowSeconds,
          }));
          return Effect.void;
        },
      },
    });
    await runEffect(
      recordUsage({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r1, r2],
        usage: { tokens: 100, requests: 1, spendMinor: 0, currency: "USD" },
        occurredAt: new Date(1700000000000),
      }),
    );
    expect(captured).toHaveLength(2);
    const tokensEntry = captured.find((e) => e.windowSeconds === 3600)!;
    expect(tokensEntry.bucketStart).toBeInstanceOf(Date);
    expect(tokensEntry.bucketStart.getTime() % 3600000).toBe(0);
  });
});
