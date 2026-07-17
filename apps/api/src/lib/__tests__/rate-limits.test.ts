import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import {
  windowSecondsToHuman,
  ruleIncrement,
  estimatedRuleIncrement,
  allowsCapOvershoot,
  hardCapRoom,
  clampSettleDelta,
  resolveScopeTarget,
  getEffectiveRules,
  checkLimits,
  recordUsage,
  reserveLimits,
  releaseLimits,
  settleLimits,
  serializeLimitReservation,
  parseLimitReservation,
  bucketStartFor,
  bucketDurationSeconds,
  coalesceCounterWrites,
  collapseRulesByStream,
  type LimitReservation,
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
import { MongoDb } from "../../runtime/services/mongo-db.ts";

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
  /** When true, reserveLimits dry-run only (no MongoDb session). */
  dryOnly?: boolean;
}): void {
  const plans = stubs.plans as PlansRepoService;
  const usage = stubs.usage as UsageRepoService;
  // withMongoSession needs MongoDb; for dry-run reserve tests we skip sessions.
  // Non-dry reserve tests use a fake session that just runs the body without txn.
  const mongoStub = {
    client: {
      startSession: async () => ({
        startTransaction: () => undefined,
        commitTransaction: async () => undefined,
        abortTransaction: async () => undefined,
        endSession: async () => undefined,
        inTransaction: () => true,
      }),
    },
    db: {},
  };
  const layer = Layer.mergeAll(
    Layer.succeed(PlansRepo, plans),
    Layer.succeed(UsageRepo, usage),
    Layer.succeed(MongoDb, mongoStub as never),
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

  test("ruleIncrement spend_minor skips currency mismatch", () => {
    const usage = { tokens: 0, requests: 1, spendMinor: 200, currency: "USD" };
    expect(
      ruleIncrement(
        rule({ dimension: "spend_minor", currency: "EUR" }),
        usage,
      ),
    ).toBe(0);
    expect(
      ruleIncrement(
        rule({ dimension: "spend_minor", currency: "USD" }),
        usage,
      ),
    ).toBe(200);
    expect(
      ruleIncrement(rule({ dimension: "spend_minor", currency: null }), usage),
    ).toBe(200);
  });

  test("estimatedRuleIncrement: tokens/spend from estimate; requests always 1", () => {
    expect(
      estimatedRuleIncrement(rule({ dimension: "tokens" }), {
        estimatedTokens: 100,
      }),
    ).toBe(100);
    expect(
      estimatedRuleIncrement(rule({ dimension: "tokens" }), {
        estimatedTokens: 0,
      }),
    ).toBe(0);
    expect(
      estimatedRuleIncrement(rule({ dimension: "requests" }), {
        estimatedTokens: 0,
      }),
    ).toBe(1);
    expect(
      estimatedRuleIncrement(rule({ dimension: "spend_minor" }), {
        estimatedSpendMinor: 50,
        currency: "USD",
      }),
    ).toBe(50);
    expect(
      estimatedRuleIncrement(rule({ dimension: "spend_minor", currency: "EUR" }), {
        estimatedSpendMinor: 50,
        currency: "USD",
      }),
    ).toBe(0);
  });

  test("bucketDurationSeconds uses sub-buckets smaller than window", () => {
    expect(bucketDurationSeconds(30)).toBe(1);
    expect(bucketDurationSeconds(3600)).toBe(60);
    expect(bucketDurationSeconds(18_000)).toBe(300);
  });

  test("bucketStartFor floors to sub-bucket", () => {
    const t = 1_700_000_123_456;
    const b = bucketStartFor(t, 3600);
    expect(b.getTime() % 60_000).toBe(0);
  });

  test("coalesceCounterWrites keeps one write per counter key", () => {
    const bucket = new Date("2024-01-01T00:00:00.000Z");
    const out = coalesceCounterWrites([
      {
        dimension: "tokens",
        windowSeconds: 3600,
        bucketStart: bucket,
        scopeTarget: null,
        increment: 100,
      },
      {
        dimension: "tokens",
        windowSeconds: 3600,
        bucketStart: bucket,
        scopeTarget: null,
        increment: 100,
      },
      {
        dimension: "requests",
        windowSeconds: 3600,
        bucketStart: bucket,
        scopeTarget: null,
        increment: 1,
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.dimension === "tokens")?.increment).toBe(100);
  });

  test("coalesceCounterWrites: positive same key keeps min (strictest claim)", () => {
    const bucket = new Date("2024-01-01T00:00:00.000Z");
    const out = coalesceCounterWrites([
      {
        dimension: "tokens",
        windowSeconds: 3600,
        bucketStart: bucket,
        scopeTarget: null,
        increment: 200,
      },
      {
        dimension: "tokens",
        windowSeconds: 3600,
        bucketStart: bucket,
        scopeTarget: null,
        increment: 100,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.increment).toBe(100);
  });

  test("collapseRulesByStream: keeps strictest cap per stream", () => {
    const out = collapseRulesByStream([
      rule({ id: "loose", capValue: 5000, windowSeconds: 3600 }),
      rule({ id: "strict", capValue: 1000, windowSeconds: 3600 }),
      rule({ id: "week", capValue: 50_000, windowSeconds: 604_800 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.windowSeconds === 3600)?.id).toBe("strict");
    expect(out.find((r) => r.windowSeconds === 604_800)?.id).toBe("week");
  });

  test("allowsCapOvershoot: only spend is soft", () => {
    expect(allowsCapOvershoot("spend_minor")).toBe(true);
    expect(allowsCapOvershoot("tokens")).toBe(false);
    expect(allowsCapOvershoot("requests")).toBe(false);
  });

  test("clampSettleDelta: hard dims clamp extra; soft full; release always", () => {
    // tokens hard: window full of reserved 900, cap 1000 → room 100
    expect(
      clampSettleDelta({
        dimension: "tokens",
        delta: 200,
        capValue: 1000,
        windowSum: 900,
      }),
    ).toBe(100);
    // release surplus never clamped
    expect(
      clampSettleDelta({
        dimension: "tokens",
        delta: -500,
        capValue: 1000,
        windowSum: 900,
      }),
    ).toBe(-500);
    // spend soft: full overage
    expect(
      clampSettleDelta({
        dimension: "spend_minor",
        delta: 500,
        capValue: 1000,
        windowSum: 900,
      }),
    ).toBe(500);
    expect(hardCapRoom(1000, 1200)).toBe(0);
  });

  test("serialize/parse LimitReservation round-trip", () => {
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    const res: LimitReservation = {
      organizationId: orgId,
      customerId,
      holds: [
        {
          ruleId: "r1",
          dimension: "tokens",
          windowSeconds: 3600,
          bucketStart: new Date("2024-01-01T00:00:00.000Z"),
          scopeTarget: null,
          reserved: 500,
          capValue: 1000,
        },
      ],
    };
    const wire = serializeLimitReservation(res);
    expect(wire).toHaveLength(1);
    const parsed = parseLimitReservation({
      organizationId: orgId,
      customerId,
      wire,
    });
    expect(parsed?.holds[0]?.reserved).toBe(500);
    expect(parsed?.holds[0]?.bucketStart.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
  });

  test("resolveScopeTarget: customer/plan → null; untargeted model per request", () => {
    expect(resolveScopeTarget(rule({ scope: "customer" }), "gpt")).toBeNull();
    expect(resolveScopeTarget(rule({ scope: "plan" }), "gpt")).toBeNull();
    expect(resolveScopeTarget(rule({ scope: "model" }), "gpt")).toBe("gpt");
    expect(resolveScopeTarget(rule({ scope: "model" }), undefined)).toBeUndefined();
  });

  test("resolveScopeTarget: targeted model only matches request model", () => {
    const modelRule = rule({ scope: "model", scopeTarget: "gpt-4" });
    expect(resolveScopeTarget(modelRule, "gpt-4")).toBe("gpt-4");
    expect(resolveScopeTarget(modelRule, "claude")).toBeUndefined();
    expect(resolveScopeTarget(modelRule, undefined)).toBeUndefined();
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
    // Distinct streams (hour / day / week) so collapse does not drop overrides.
    const planRules = [
      rule({ id: "shared", windowSeconds: 3600, capValue: 100 }),
      rule({ id: "p1", windowSeconds: 86_400, capValue: 50 }),
    ];
    const customerRules = [
      rule({ id: "shared", windowSeconds: 3600, capValue: 999 }),
      rule({ id: "c1", windowSeconds: 604_800, capValue: 10 }),
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

  test("legacy same-stream plan+customer rules collapse to strictest cap", async () => {
    const planId = new ObjectId();
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
            rateLimits: [
              rule({ id: "a", windowSeconds: 3600, capValue: 5000 }),
              rule({ id: "b", windowSeconds: 3600, capValue: 1000 }),
            ],
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
        findCustomerLimitByCustomer: () => Effect.succeed(null),
      },
      usage: {},
    });
    const rules = await runEffect(getEffectiveRules(new ObjectId()));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe("b");
    expect(rules[0]?.capValue).toBe(1000);
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

  test("writes one upsert per active rule, bucketStart floored to sub-bucket", async () => {
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
    expect(tokensEntry.bucketStart.getTime() % 60_000).toBe(0);
    const reqEntry = captured.find((e) => e.windowSeconds === 18_000)!;
    expect(reqEntry.bucketStart.getTime() % 300_000).toBe(0);
  });

  test("overlapping same-dimension rules write one counter increment", async () => {
    const r1 = rule({ id: "a", dimension: "tokens", capValue: 1000 });
    const r2 = rule({ id: "b", dimension: "tokens", capValue: 5000 });
    let captured: number[] = [];
    installRuntime({
      plans: {},
      usage: {
        bulkUpsertCounters: (params) => {
          captured = params.entries.map((e) => e.increment);
          return Effect.void;
        },
      },
    });
    await runEffect(
      recordUsage({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r1, r2],
        usage: { tokens: 100, requests: 0, spendMinor: 0, currency: "USD" },
      }),
    );
    expect(captured).toEqual([100]);
  });
});

describe("reserveLimits / settleLimits / releaseLimits", () => {
  test("dryRun reserve rejects when estimate exceeds remaining cap", async () => {
    const r = rule({ dimension: "tokens", capValue: 1000 });
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
              bucketStart: new Date(),
              count: 900,
              scopeTarget: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as never,
          ]),
      },
    });
    const res = await runEffect(
      reserveLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r],
        estimatedTokens: 200,
        dryRun: true,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violated[0]?.current).toBe(900);
    }
  });

  test("dryRun reserve succeeds and returns holds without writes", async () => {
    const r = rule({ dimension: "tokens", capValue: 1000 });
    let writes = 0;
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () => Effect.succeed([]),
        bulkUpsertCounters: () => {
          writes += 1;
          return Effect.void;
        },
      },
    });
    const res = await runEffect(
      reserveLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r],
        estimatedTokens: 400,
        dryRun: true,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reservation.holds).toHaveLength(1);
      expect(res.reservation.holds[0]?.reserved).toBe(400);
    }
    expect(writes).toBe(0);
  });

  test("live reserve writes estimated increment when under cap", async () => {
    const r = rule({ id: "tok", dimension: "tokens", capValue: 1000 });
    let capturedInc: number | undefined;
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () => Effect.succeed([]),
        bulkUpsertCounters: (params) => {
          capturedInc = params.entries[0]?.increment;
          return Effect.void;
        },
      },
    });
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    const res = await runEffect(
      reserveLimits({
        organizationId: orgId,
        customerId,
        rules: [r],
        estimatedTokens: 600,
      }),
    );
    expect(res.ok).toBe(true);
    expect(capturedInc).toBe(600);
    if (res.ok) {
      expect(res.reservation.holds[0]?.reserved).toBe(600);
    }
  });

  test("live reserve rejects concurrent over-cap (window already full)", async () => {
    const r = rule({ dimension: "requests", capValue: 2 });
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            {
              _id: new ObjectId(),
              organizationId: new ObjectId(),
              customerId: new ObjectId(),
              dimension: "requests",
              windowSeconds: 3600,
              bucketStart: new Date(),
              count: 2,
              scopeTarget: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as never,
          ]),
        bulkUpsertCounters: () => Effect.void,
      },
    });
    const res = await runEffect(
      reserveLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r],
      }),
    );
    expect(res.ok).toBe(false);
  });

  test("settleLimits: actual < reserved releases surplus (negative delta)", async () => {
    const r = rule({ id: "tok", dimension: "tokens", capValue: 10_000 });
    const bucketStart = bucketStartFor(Date.now(), 3600);
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    let delta: number | undefined;
    installRuntime({
      plans: {},
      usage: {
        bulkUpsertCounters: (params) => {
          delta = params.entries[0]?.increment;
          return Effect.void;
        },
      },
    });
    const reservation: LimitReservation = {
      organizationId: orgId,
      customerId,
      holds: [
        {
          ruleId: "tok",
          dimension: "tokens",
          windowSeconds: 3600,
          bucketStart,
          scopeTarget: null,
          reserved: 1000,
          capValue: 10_000,
        },
      ],
    };
    await runEffect(
      settleLimits({
        reservation,
        organizationId: orgId,
        customerId,
        rules: [r],
        usage: {
          tokens: 350,
          requests: 1,
          spendMinor: 0,
          currency: "USD",
        },
      }),
    );
    // 350 actual − 1000 reserved = −650
    expect(delta).toBe(-650);
  });

  test("settleLimits: tokens hard — overshoot clamped to remaining room", async () => {
    // Reserved 100; window sum now 950 (incl. hold); cap 1000 → room 50.
    // Actual 250 → raw delta +150 → clamped to +50.
    const r = rule({ id: "tok", dimension: "tokens", capValue: 1000 });
    const bucketStart = bucketStartFor(Date.now(), 3600);
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    let delta: number | undefined;
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            {
              _id: new ObjectId(),
              organizationId: orgId,
              customerId,
              dimension: "tokens",
              windowSeconds: 3600,
              bucketStart,
              count: 950,
              scopeTarget: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as never,
          ]),
        bulkUpsertCounters: (params) => {
          delta = params.entries[0]?.increment;
          return Effect.void;
        },
      },
    });
    const reservation: LimitReservation = {
      organizationId: orgId,
      customerId,
      holds: [
        {
          ruleId: "tok",
          dimension: "tokens",
          windowSeconds: 3600,
          bucketStart,
          scopeTarget: null,
          reserved: 100,
          capValue: 1000,
        },
      ],
    };
    await runEffect(
      settleLimits({
        reservation,
        organizationId: orgId,
        customerId,
        rules: [r],
        usage: {
          tokens: 250,
          requests: 1,
          spendMinor: 0,
          currency: "USD",
        },
      }),
    );
    expect(delta).toBe(50);
  });

  test("settleLimits: spend soft — actual overshoot fully applied past cap", async () => {
    const r = rule({
      id: "sp",
      dimension: "spend_minor",
      capValue: 1000,
    });
    const bucketStart = bucketStartFor(Date.now(), 3600);
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    let delta: number | undefined;
    installRuntime({
      plans: {},
      usage: {
        // No window read required for soft spend overage.
        bulkUpsertCounters: (params) => {
          delta = params.entries[0]?.increment;
          return Effect.void;
        },
      },
    });
    await runEffect(
      settleLimits({
        reservation: {
          organizationId: orgId,
          customerId,
          holds: [
            {
              ruleId: "sp",
              dimension: "spend_minor",
              windowSeconds: 3600,
              bucketStart,
              scopeTarget: null,
              reserved: 100,
              capValue: 1000,
            },
          ],
        },
        organizationId: orgId,
        customerId,
        rules: [r],
        usage: {
          tokens: 0,
          requests: 1,
          spendMinor: 400,
          currency: "USD",
        },
      }),
    );
    // Full +300 even if that pushes window past cap.
    expect(delta).toBe(300);
  });

  test("settleLimits: actual === reserved → no write", async () => {
    const r = rule({ id: "req", dimension: "requests", capValue: 100 });
    const bucketStart = bucketStartFor(Date.now(), 3600);
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
      settleLimits({
        reservation: {
          organizationId: new ObjectId(),
          customerId: new ObjectId(),
          holds: [
            {
              ruleId: "req",
              dimension: "requests",
              windowSeconds: 3600,
              bucketStart,
              scopeTarget: null,
              reserved: 1,
              capValue: 100,
            },
          ],
        },
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r],
        usage: { tokens: 0, requests: 1, spendMinor: 0, currency: "USD" },
      }),
    );
    expect(calls).toBe(0);
  });

  test("releaseLimits reverses full hold", async () => {
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    let inc: number | undefined;
    installRuntime({
      plans: {},
      usage: {
        bulkUpsertCounters: (params) => {
          inc = params.entries[0]?.increment;
          return Effect.void;
        },
      },
    });
    await runEffect(
      releaseLimits({
        organizationId: orgId,
        customerId,
        holds: [
          {
            ruleId: "tok",
            dimension: "tokens",
            windowSeconds: 3600,
            bucketStart: new Date(),
            scopeTarget: null,
            reserved: 800,
            capValue: 5000,
          },
        ],
      }),
    );
    expect(inc).toBe(-800);
  });

  test("request dimension reserves even when estimatedTokens is 0", async () => {
    const r = rule({ id: "req", dimension: "requests", capValue: 10 });
    let captured: number | undefined;
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () => Effect.succeed([]),
        bulkUpsertCounters: (params) => {
          captured = params.entries[0]?.increment;
          return Effect.void;
        },
      },
    });
    const res = await runEffect(
      reserveLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [r],
        estimatedTokens: 0,
        estimatedSpendMinor: 0,
      }),
    );
    expect(res.ok).toBe(true);
    expect(captured).toBe(1);
  });

  test("live reserve: overlapping rules produce one counter write", async () => {
    const rules = [
      rule({ id: "a", dimension: "tokens", capValue: 1000 }),
      rule({ id: "b", dimension: "tokens", capValue: 5000 }),
    ];
    let entryCount = 0;
    let holdCount = 0;
    installRuntime({
      plans: {},
      usage: {
        findWindowCounters: () => Effect.succeed([]),
        bulkUpsertCounters: (params) => {
          entryCount = params.entries.length;
          return Effect.void;
        },
      },
    });
    const res = await runEffect(
      reserveLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules,
        estimatedTokens: 100,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) holdCount = res.reservation.holds.length;
    expect(holdCount).toBe(2);
    expect(entryCount).toBe(1);
  });
});
