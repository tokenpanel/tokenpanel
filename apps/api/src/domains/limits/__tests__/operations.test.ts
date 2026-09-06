/**
 * Limits domain operations: evaluate/enforce/reserve/settle/record + retry-after.
 * Fake repos + Clock via Layer.succeed; MongoDb session stub — no DB.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { RateLimitRule } from "@tokenpanel/db";
import { RateLimitExceededError } from "../../../errors/families.ts";
import { UsageRepo } from "../../../infrastructure/mongo/repositories/usage.ts";
import { PlansRepo } from "../../../infrastructure/mongo/repositories/plans.ts";
import type { UsageRepoService } from "../../../infrastructure/mongo/repositories/usage.ts";
import type { PlansRepoService } from "../../../infrastructure/mongo/repositories/plans.ts";
import { Clock } from "../../../runtime/services/clock.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
  getAppRuntime,
} from "../../../runtime/app-runtime.ts";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import {
  computeRetryAfterSeconds,
  enforceRateLimits,
  evaluateRateLimits,
  recordRateLimitUsage,
  reserveRateLimits,
  settleRateLimitUsage,
} from "../operations.ts";
import {
  bucketStartFor,
  type LimitReservation,
} from "../../../lib/rate-limits.ts";

/** Run domain Effect on installed test ManagedRuntime. */
function runEffect<A, E>(
  effect: Effect.Effect<A, E, Clock | UsageRepo | PlansRepo | MongoDb>,
): Promise<A> {
  return getAppRuntime().runPromise(effect as never) as Promise<A>;
}

function rule(over: Partial<RateLimitRule> = {}): RateLimitRule {
  return {
    id: "r1",
    windowSeconds: 3600,
    dimension: "tokens",
    capValue: 1000,
    scope: "customer",
    scopeTarget: null,
    active: true,
    ...over,
  };
}

const FIXED_NOW_MS = 1_700_000_000_000;

function installRuntime(stubs: {
  plans?: Partial<PlansRepoService>;
  usage?: Partial<UsageRepoService>;
  /** Fixed clock epoch ms; defaults to FIXED_NOW_MS. */
  nowMs?: number;
}): void {
  const plans = (stubs.plans ?? {}) as PlansRepoService;
  const usage = (stubs.usage ?? {}) as UsageRepoService;
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
    Layer.succeed(Clock, {
      nowMs: () => stubs.nowMs ?? FIXED_NOW_MS,
      now: () => new Date(stubs.nowMs ?? FIXED_NOW_MS),
    }),
  ) as unknown as Layer.Layer<never, never, never>;
  createAppRuntime(layer as never, { install: true });
}

function counterDoc(over: {
  dimension: RateLimitRule["dimension"];
  windowSeconds: number;
  count: number;
  customerId?: ObjectId;
  orgId?: ObjectId;
  bucketStart?: Date;
}): Record<string, unknown> {
  return {
    _id: new ObjectId(),
    organizationId: over.orgId ?? new ObjectId(),
    customerId: over.customerId ?? new ObjectId(),
    dimension: over.dimension,
    windowSeconds: over.windowSeconds,
    bucketStart: over.bucketStart ?? new Date(FIXED_NOW_MS - 60_000),
    count: over.count,
    scopeTarget: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
});

describe("evaluateRateLimits", () => {
  test("ok when current + increment <= cap (no writes)", async () => {
    let upserts = 0;
    installRuntime({
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            counterDoc({ dimension: "tokens", windowSeconds: 3600, count: 500 }),
          ] as never),
        bulkUpsertCounters: () => {
          upserts += 1;
          return Effect.void;
        },
      },
    });
    const res = await runEffect(
      evaluateRateLimits({
        customerId: new ObjectId(),
        rules: [rule({ dimension: "tokens", capValue: 1000 })],
        estimatedTokens: 400,
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(upserts).toBe(0);
  });

  test("violated with cap/current/retryAfterSeconds when over cap", async () => {
    installRuntime({
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            counterDoc({
              dimension: "tokens",
              windowSeconds: 3600,
              count: 900,
            }),
          ] as never),
      },
    });
    const res = await runEffect(
      evaluateRateLimits({
        customerId: new ObjectId(),
        rules: [rule({ dimension: "tokens", capValue: 1000 })],
        estimatedTokens: 200,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const v = res.violated[0];
      expect(v?.cap).toBe(1000);
      expect(v?.current).toBe(900);
      expect(v?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(v?.rule.dimension).toBe("tokens");
    }
  });

  test("model-scoped rule skipped when no modelAliasId supplied", async () => {
    let queried = false;
    installRuntime({
      usage: {
        findWindowCounters: () => {
          queried = true;
          return Effect.succeed([] as never);
        },
      },
    });
    const res = await runEffect(
      evaluateRateLimits({
        customerId: new ObjectId(),
        rules: [rule({ scope: "model", scopeTarget: "gpt-x" })],
        estimatedTokens: 999_999,
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(queried).toBe(false);
  });
});

describe("enforceRateLimits", () => {
  test("no effective rules → ok true with empty rules (no evaluation)", async () => {
    let queried = false;
    installRuntime({
      plans: {
        findActiveSubscriptionByCustomer: () => Effect.succeed(null as never),
        findCustomerLimitByCustomer: () => Effect.succeed(null as never),
      },
      usage: {
        findWindowCounters: () => {
          queried = true;
          return Effect.succeed([] as never);
        },
      },
    });
    const res = await runEffect(
      enforceRateLimits({ customerId: new ObjectId(), estimatedTokens: 50 }),
    );
    expect(res).toEqual({ ok: true, rules: [] });
    expect(queried).toBe(false);
  });

  test("under cap → ok true with effective rules", async () => {
    installRuntime({
      plans: {
        findActiveSubscriptionByCustomer: () => Effect.succeed(null as never),
        findCustomerLimitByCustomer: () =>
          Effect.succeed({
            _id: new ObjectId(),
            organizationId: new ObjectId(),
            customerId: new ObjectId(),
            rules: [rule({ id: "c1", capValue: 1000 })],
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
      },
      usage: { findWindowCounters: () => Effect.succeed([] as never) },
    });
    const res = await runEffect(
      enforceRateLimits({ customerId: new ObjectId(), estimatedTokens: 100 }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rules.map((r) => r.id)).toEqual(["c1"]);
  });

  test("over cap → fails RateLimitExceededError with retryAfterSeconds", async () => {
    installRuntime({
      plans: {
        findActiveSubscriptionByCustomer: () => Effect.succeed(null as never),
        findCustomerLimitByCustomer: () =>
          Effect.succeed({
            _id: new ObjectId(),
            organizationId: new ObjectId(),
            customerId: new ObjectId(),
            rules: [rule({ id: "c1", dimension: "tokens", capValue: 100 })],
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as never,
      },
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            counterDoc({
              dimension: "tokens",
              windowSeconds: 3600,
              count: 100,
            }),
          ] as never),
      },
    });
    const exit = await Effect.runPromiseExit(
      enforceRateLimits({
        customerId: new ObjectId(),
        estimatedTokens: 1,
      }) as Effect.Effect<unknown, RateLimitExceededError, never>,
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      const rl: RateLimitExceededError = exit.cause.error;
      expect(rl).toBeInstanceOf(RateLimitExceededError);
      expect(rl.code).toBe("rate_limited");
      expect(rl.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(rl.dimension).toBe("tokens");
      expect(rl.cap).toBe(100);
      expect(rl.current).toBe(100);
    }
  });
});

describe("computeRetryAfterSeconds", () => {
  test("matches checkLimits: window − elapsed seconds, min 1", () => {
    // Bucket started 10s ago in a 60s window → 50s remain.
    expect(
      computeRetryAfterSeconds({
        nowMs: FIXED_NOW_MS,
        windowSeconds: 60,
        oldestBucketMs: FIXED_NOW_MS - 10_000,
      }),
    ).toBe(50);
    // Fully elapsed window still reports ≥1.
    expect(
      computeRetryAfterSeconds({
        nowMs: FIXED_NOW_MS,
        windowSeconds: 60,
        oldestBucketMs: FIXED_NOW_MS - 120_000,
      }),
    ).toBe(1);
    // Sub-second elapsed floors to remaining full second.
    expect(
      computeRetryAfterSeconds({
        nowMs: FIXED_NOW_MS,
        windowSeconds: 60,
        oldestBucketMs: FIXED_NOW_MS - 500,
      }),
    ).toBe(60);
  });
});

describe("reserveRateLimits", () => {
  test("dryRun succeeds with holds and no counter writes", async () => {
    let writes = 0;
    installRuntime({
      usage: {
        findWindowCounters: () => Effect.succeed([] as never),
        bulkUpsertCounters: () => {
          writes += 1;
          return Effect.void;
        },
      },
    });
    const res = await runEffect(
      reserveRateLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [rule({ dimension: "tokens", capValue: 1000 })],
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

  test("live reserve writes estimated increment and returns holds", async () => {
    let capturedInc: number | undefined;
    installRuntime({
      usage: {
        findWindowCounters: () => Effect.succeed([] as never),
        bulkUpsertCounters: (params) => {
          capturedInc = params.entries[0]?.increment;
          return Effect.void;
        },
      },
    });
    const res = await runEffect(
      reserveRateLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [rule({ id: "tok", dimension: "tokens", capValue: 1000 })],
        estimatedTokens: 600,
      }),
    );
    expect(res.ok).toBe(true);
    expect(capturedInc).toBe(600);
    if (res.ok) {
      expect(res.reservation.holds[0]?.reserved).toBe(600);
      expect(res.reservation.holds[0]?.ruleId).toBe("tok");
    }
  });

  test("rejects when current count already at cap", async () => {
    installRuntime({
      usage: {
        findWindowCounters: () =>
          Effect.succeed([
            counterDoc({
              dimension: "requests",
              windowSeconds: 3600,
              count: 2,
            }),
          ] as never),
        bulkUpsertCounters: () => Effect.void,
      },
    });
    const res = await runEffect(
      reserveRateLimits({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [rule({ dimension: "requests", capValue: 2 })],
        estimatedTokens: 0,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violated.length).toBeGreaterThan(0);
  });
});

describe("settleRateLimitUsage", () => {
  test("adjusts held bucket by actual − reserved (negative delta releases)", async () => {
    const orgId = new ObjectId();
    const customerId = new ObjectId();
    const bucketStart = bucketStartFor(FIXED_NOW_MS, 3600);
    let delta: number | undefined;
    installRuntime({
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
      settleRateLimitUsage({
        reservation,
        organizationId: orgId,
        customerId,
        rules: [rule({ id: "tok", dimension: "tokens", capValue: 10_000 })],
        usage: { tokens: 350, requests: 1, spendMicros: 0, currency: "USD" },
      }),
    );
    expect(delta).toBe(-650);
  });

  test("actual === reserved → no counter write", async () => {
    let calls = 0;
    installRuntime({
      usage: {
        bulkUpsertCounters: () => {
          calls += 1;
          return Effect.void;
        },
      },
    });
    await runEffect(
      settleRateLimitUsage({
        reservation: {
          organizationId: new ObjectId(),
          customerId: new ObjectId(),
          holds: [
            {
              ruleId: "req",
              dimension: "requests",
              windowSeconds: 3600,
              bucketStart: bucketStartFor(FIXED_NOW_MS, 3600),
              scopeTarget: null,
              reserved: 1,
              capValue: 100,
            },
          ],
        },
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [rule({ id: "req", dimension: "requests", capValue: 100 })],
        usage: { tokens: 0, requests: 1, spendMicros: 0, currency: "USD" },
      }),
    );
    expect(calls).toBe(0);
  });

  test("no reservation → full counter write (record path)", async () => {
    let captured: number[] = [];
    installRuntime({
      usage: {
        findWindowCounters: () => Effect.succeed([] as never),
        bulkUpsertCounters: (params) => {
          captured = params.entries.map((e) => e.increment);
          return Effect.void;
        },
      },
    });
    await runEffect(
      settleRateLimitUsage({
        reservation: null,
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [
          rule({ id: "a", dimension: "tokens", capValue: 100 }),
          rule({ id: "b", dimension: "tokens", capValue: 5000 }),
        ],
        usage: { tokens: 100, requests: 0, spendMicros: 0, currency: "USD" },
      }),
    );
    // Overlapping same-dimension rules coalesce to one counter increment.
    expect(captured).toEqual([100]);
  });
});

describe("recordRateLimitUsage", () => {
  test("writes one entry per active rule, bucket floored to sub-bucket", async () => {
    let captured: { windowSeconds: number; bucketStart: Date }[] = [];
    installRuntime({
      usage: {
        bulkUpsertCounters: (params) => {
          captured = params.entries.map((e) => ({
            windowSeconds: e.windowSeconds,
            bucketStart: e.bucketStart,
          }));
          return Effect.void;
        },
      },
    });
    await runEffect(
      recordRateLimitUsage({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [
          rule({ id: "r1", dimension: "tokens", windowSeconds: 3600 }),
          rule({ id: "r2", dimension: "requests", windowSeconds: 18_000 }),
        ],
        usage: { tokens: 100, requests: 1, spendMicros: 0, currency: "USD" },
        occurredAt: new Date(FIXED_NOW_MS),
      }),
    );
    expect(captured).toHaveLength(2);
    const hour = captured.find((e) => e.windowSeconds === 3600);
    const fiveHours = captured.find((e) => e.windowSeconds === 18_000);
    expect((hour?.bucketStart.getTime() ?? Number.NaN) % 60_000).toBe(0);
    expect((fiveHours?.bucketStart.getTime() ?? Number.NaN) % 300_000).toBe(0);
  });

  test("zero-increment rule writes nothing", async () => {
    let calls = 0;
    installRuntime({
      usage: {
        bulkUpsertCounters: () => {
          calls += 1;
          return Effect.void;
        },
      },
    });
    await runEffect(
      recordRateLimitUsage({
        organizationId: new ObjectId(),
        customerId: new ObjectId(),
        rules: [rule({ dimension: "tokens" })],
        usage: { tokens: 0, requests: 0, spendMicros: 0, currency: "USD" },
      }),
    );
    expect(calls).toBe(0);
  });
});
