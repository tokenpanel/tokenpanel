/**
 * Settlement domain operations: decideSettlementPath, computeSettlementCharges,
 * settleOrOutboxWorkflow (reported → settle, missing → outbox, guard fail → outbox).
 * Fake repos via Layer.succeed + MongoDb session stub — no DB.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type {
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  RateLimitRule,
} from "@tokenpanel/db";
import { SettlementGuardError } from "../settle.ts";
import {
  computeSettlementCharges,
  decideSettlementPath,
  settleOrOutboxWorkflow,
} from "../operations.ts";
import { UsageRepo } from "../../../infrastructure/mongo/repositories/usage.ts";
import { CustomersRepo } from "../../../infrastructure/mongo/repositories/customers.ts";
import { SettlementOutboxRepo } from "../../../infrastructure/mongo/repositories/settlement-outbox.ts";
import type { UsageRepoService } from "../../../infrastructure/mongo/repositories/usage.ts";
import type { CustomersRepoService } from "../../../infrastructure/mongo/repositories/customers.ts";
import type { SettlementOutboxRepoService } from "../../../infrastructure/mongo/repositories/settlement-outbox.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
  getAppRuntime,
} from "../../../runtime/app-runtime.ts";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";

const ORG_ID = new ObjectId();
const CUSTOMER_ID = new ObjectId();
const PROVIDER_ID = new ObjectId();

function modelFixture(over: Partial<ModelDoc> = {}): ModelDoc {
  const now = new Date("2026-01-15T12:00:00.000Z");
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    providerId: PROVIDER_ID,
    aliasId: "gpt-test",
    upstreamModelId: "gpt-test-upstream",
    protocol: "openai",
    currency: "USD",
    price: {
      inputMicrosPerMillion: 1_000,
      outputMicrosPerMillion: 2_000,
    },
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as unknown as ModelDoc;
}

function entryFixture(over: Partial<ModelEntryDoc> = {}): ModelEntryDoc {
  return {
    upstreamModelId: "gpt-test-upstream",
    price: {
      inputMicrosPerMillion: 1_000,
      outputMicrosPerMillion: 2_000,
      cacheReadMicrosPerMillion: 100,
    },
    cost: {
      inputMicrosPerMillion: 500,
      outputMicrosPerMillion: 1_000,
    },
    ...over,
  } as unknown as ModelEntryDoc;
}

function providerFixture(): ProviderDoc {
  const now = new Date("2026-01-15T12:00:00.000Z");
  return {
    _id: PROVIDER_ID,
    organizationId: ORG_ID,
    name: "Test Provider",
    slug: "test-provider",
    protocol: "openai",
    baseUrl: "https://api.test",
    apiKeyCiphertext: "cipher",
    active: true,
    createdAt: now,
    updatedAt: now,
  } as unknown as ProviderDoc;
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

const reportedUsage = {
  promptTokens: 1_000_000,
  completionTokens: 1_000_000,
  totalTokens: 2_000_000,
};

function installRuntime(stubs: {
  usage?: Partial<UsageRepoService>;
  customers?: Partial<CustomersRepoService>;
  outbox?: Partial<SettlementOutboxRepoService>;
}): void {
  const usage = {
    bulkUpsertCounters: () => Effect.void,
    ...(stubs.usage ?? {}),
  } as UsageRepoService;
  const customers = (stubs.customers ?? {}) as CustomersRepoService;
  const outbox = (stubs.outbox ?? {}) as SettlementOutboxRepoService;
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
    Layer.succeed(UsageRepo, usage),
    Layer.succeed(CustomersRepo, customers),
    Layer.succeed(SettlementOutboxRepo, outbox),
    Layer.succeed(MongoDb, mongoStub as never),
  ) as unknown as Layer.Layer<never, never, never>;
  createAppRuntime(layer as never, { install: true });
}

function runEffect<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return getAppRuntime().runPromise(effect as never) as Promise<A>;
}

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
});

describe("decideSettlementPath", () => {
  test("reported → settle with usage", () => {
    const decision = decideSettlementPath({
      status: "reported",
      usage: reportedUsage,
    });
    expect(decision).toEqual({ path: "settle", usage: reportedUsage });
  });

  test("missing/malformed/overflow → outbox with reason (never free-bill)", () => {
    expect(decideSettlementPath({ status: "missing", reason: "usage_missing" })).toEqual({
      path: "outbox",
      reason: "usage_missing",
    });
    expect(
      decideSettlementPath({ status: "malformed", reason: "usage_malformed" }),
    ).toEqual({ path: "outbox", reason: "usage_malformed" });
    expect(decideSettlementPath({ status: "overflow", reason: "usage_overflow" })).toEqual({
      path: "outbox",
      reason: "usage_overflow",
    });
  });
});

describe("computeSettlementCharges", () => {
  test("openai subset: cache read peeled from prompt", () => {
    const charges = computeSettlementCharges({
      entry: entryFixture(),
      model: modelFixture(),
      protocol: "openai",
      usage: {
        promptTokens: 2_000_000,
        completionTokens: 1_000_000,
        cacheReadTokens: 500_000,
        totalTokens: 3_000_000,
      },
    });
    // Rates are micros per million tokens; ceil per bucket.
    // subset: 1.5M uncached @1_000 + 0.5M cache @100 + 1M output @2_000
    expect(charges.priceMicros).toBe(1_500 + 50 + 2_000);
    // cost schedule has NO cacheRead rate → subset peel skipped →
    // full 2M prompt @500 + 1M output @1_000
    expect(charges.costMicros).toBe(1_000 + 1_000);
    expect(charges.currency).toBe("USD");
    expect(charges.cacheAccounting).toBe("subset");
  });
  test("anthropic additive: cache charged in addition to input", () => {
    const charges = computeSettlementCharges({
      entry: entryFixture(),
      model: modelFixture(),
      protocol: "anthropic",
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cacheReadTokens: 500_000,
        totalTokens: 2_500_000,
      },
    });
    // additive: 1M @1_000 + 0.5M cacheRead @100 + 1M output @2_000
    expect(charges.priceMicros).toBe(1_000 + 50 + 2_000);
    expect(charges.cacheAccounting).toBe("additive");
  });

  test("priceMicrosOverride wins over schedule", () => {
    const charges = computeSettlementCharges({
      entry: entryFixture(),
      model: modelFixture(),
      protocol: "openai",
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
      priceMicrosOverride: 42,
    });
    expect(charges.priceMicros).toBe(42);
    // cost still computed from schedule: 1M @500 + 1M @1_000
    expect(charges.costMicros).toBe(500 + 1_000);
  });

  test("entry.price missing falls back to model.price", () => {
    const entry = entryFixture();
    const { price: _p, ...entryNoPrice } = entry as Record<string, unknown>;
    const charges = computeSettlementCharges({
      entry: entryNoPrice as unknown as ModelEntryDoc,
      model: modelFixture(),
      protocol: "openai",
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
    });
    // model.price: 1M @1_000 + 1M output @2_000
    expect(charges.priceMicros).toBe(1_000 + 2_000);
  });
});

describe("settleOrOutboxWorkflow", () => {
  function baseParams() {
    return {
      orgId: ORG_ID,
      actor: {
        actorKind: "customer_key" as const,
        customerId: CUSTOMER_ID,
        apiKeyId: new ObjectId(),
      },
      model: modelFixture(),
      entry: entryFixture(),
      provider: providerFixture(),
      protocol: "openai" as const,
      status: 200,
      durationMs: 42,
      rules: [rule()] as const,
      gatewayRequestId: "gw_test_case",
    };
  }

  test("reported usage → settled true, usage inserted + balance debited + adjustment", async () => {
    let insertedUsage: Record<string, unknown> | undefined;
    let debited: { priceMicros?: number } | undefined;
    let adjustment: Record<string, unknown> | undefined;
    let outboxInserts = 0;
    installRuntime({
      usage: {
        findByGatewayRequestId: () => Effect.succeed(null as never),
        insert: (doc) => {
          insertedUsage = doc as Record<string, unknown>;
          return Effect.succeed(doc as never);
        },
      },
      customers: {
        debitBalance: (params) => {
          debited = params as { priceMicros?: number };
          return Effect.succeed(true as never);
        },
        insertAdjustment: (doc) => {
          adjustment = doc as Record<string, unknown>;
          return Effect.succeed(doc as never);
        },
      },
      outbox: {
        insertOrGetByGatewayRequestId: () => {
          outboxInserts += 1;
          return Effect.succeed(new ObjectId() as never);
        },
      },
    });
    const result = await runEffect(
      settleOrOutboxWorkflow({
        ...baseParams(),
        usageOutcome: {
          status: "reported",
          usage: {
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
            totalTokens: 2_000_000,
          },
        },
      }),
    );
    expect(result).toEqual({ settled: true });
    expect(outboxInserts).toBe(0);
    // 1M @1_000 + 1M output @2_000 (cost: @500 + @1_000), micros scale
    expect(insertedUsage?.priceMicros).toBe(3_000);
    expect(insertedUsage?.costMicros).toBe(1_500);
    expect(insertedUsage?.gatewayRequestId).toBe("gw_test_case");
    expect(debited?.priceMicros).toBe(3_000);
    expect(adjustment?.amountMicros).toBe(-3_000);
    expect(adjustment?.reason).toBe("usage_debit");
  });

  test("idempotency: existing usage for gatewayRequestId → settled true, no writes", async () => {
    let inserts = 0;
    let debits = 0;
    installRuntime({
      usage: {
        findByGatewayRequestId: () => Effect.succeed({ _id: new ObjectId() } as never),
        insert: () => {
          inserts += 1;
          return Effect.succeed({} as never);
        },
      },
      customers: {
        debitBalance: () => {
          debits += 1;
          return Effect.succeed(true as never);
        },
      },
    });
    const result = await runEffect(
      settleOrOutboxWorkflow({
        ...baseParams(),
        usageOutcome: {
          status: "reported",
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          },
        },
      }),
    );
    expect(result).toEqual({ settled: true });
    expect(inserts).toBe(0);
    expect(debits).toBe(0);
  });

  test("missing usage → settled false with outbox row (reason from outcome)", async () => {
    let capturedDoc: Record<string, unknown> | undefined;
    const outboxId = new ObjectId();
    installRuntime({
      usage: { findByGatewayRequestId: () => Effect.succeed(null as never) },
      customers: {
        debitBalance: () => Effect.succeed(true as never),
        insertAdjustment: () => Effect.succeed({} as never),
      },
      outbox: {
        insertOrGetByGatewayRequestId: (doc) => {
          capturedDoc = doc as Record<string, unknown>;
          return Effect.succeed(outboxId as never);
        },
      },
    });
    const result = await runEffect(
      settleOrOutboxWorkflow({
        ...baseParams(),
        usageOutcome: { status: "missing", reason: "usage_missing" },
      }),
    );
    expect(result).toEqual({ settled: false, outboxId, reason: "usage_missing" });
    expect(capturedDoc?.reason).toBe("usage_missing");
    expect(capturedDoc?.status).toBe("pending");
    expect(capturedDoc?.attempts).toBe(0);
    expect(capturedDoc?.gatewayRequestId).toBe("gw_test_case");
    const context = capturedDoc?.context as Record<string, unknown>;
    expect(context?.reason).toBe("usage_missing");
    expect(context?.actorKind).toBe("customer_key");
    expect(context?.priceSchedule).toBeDefined();
  });

  test("guard failure (insufficient balance) → outbox with settlement_guard_failed", async () => {
    let capturedDoc: Record<string, unknown> | undefined;
    const outboxId = new ObjectId();
    installRuntime({
      usage: {
        findByGatewayRequestId: () => Effect.succeed(null as never),
        insert: () => Effect.succeed({} as never),
      },
      customers: {
        debitBalance: () => Effect.succeed(false as never),
        insertAdjustment: () => Effect.succeed({} as never),
      },
      outbox: {
        insertOrGetByGatewayRequestId: (doc) => {
          capturedDoc = doc as Record<string, unknown>;
          return Effect.succeed(outboxId as never);
        },
      },
    });
    const result = await runEffect(
      settleOrOutboxWorkflow({
        ...baseParams(),
        usageOutcome: {
          status: "reported",
          usage: {
            promptTokens: 100,
            completionTokens: 100,
            totalTokens: 200,
          },
        },
      }),
    );
    expect(result).toEqual({
      settled: false,
      outboxId,
      reason: "settlement_failed",
    });
    expect(capturedDoc?.reason).toBe("settlement_guard_failed");
    const context = capturedDoc?.context as Record<string, unknown>;
    expect(context?.usage).toBeDefined();
    expect(context?.error).toBeDefined();
  });

  test("playground actor (customerId null) settles without debit or counters", async () => {
    let debits = 0;
    let adjustments = 0;
    let counterWrites = 0;
    installRuntime({
      usage: {
        findByGatewayRequestId: () => Effect.succeed(null as never),
        insert: () => Effect.succeed({} as never),
        bulkUpsertCounters: () => {
          counterWrites += 1;
          return Effect.void;
        },
      },
      customers: {
        debitBalance: () => {
          debits += 1;
          return Effect.succeed(true as never);
        },
        insertAdjustment: () => {
          adjustments += 1;
          return Effect.succeed({} as never);
        },
      },
    });
    const result = await runEffect(
      settleOrOutboxWorkflow({
        ...baseParams(),
        actor: { actorKind: "playground", customerId: null },
        usageOutcome: {
          status: "reported",
          usage: {
            promptTokens: 100,
            completionTokens: 100,
            totalTokens: 200,
          },
        },
      }),
    );
    expect(result).toEqual({ settled: true });
    expect(debits).toBe(0);
    expect(adjustments).toBe(0);
    expect(counterWrites).toBe(0);
  });

  test("reported with prior reservation → settleLimits path adjusts counters", async () => {
    let counterDelta: number | undefined;
    const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    installRuntime({
      usage: {
        findByGatewayRequestId: () => Effect.succeed(null as never),
        insert: () => Effect.succeed({} as never),
        findWindowCounters: () => Effect.succeed([] as never),
        bulkUpsertCounters: (params) => {
          counterDelta = params.entries[0]?.increment;
          return Effect.void;
        },
      },
      customers: {
        debitBalance: () => Effect.succeed(true as never),
        insertAdjustment: () => Effect.succeed({} as never),
      },
    });
    const result = await runEffect(
      settleOrOutboxWorkflow({
        ...baseParams(),
        usageOutcome: {
          status: "reported",
          usage: {
            promptTokens: 100,
            completionTokens: 100,
            totalTokens: 200,
          },
        },
        limitReservation: {
          organizationId: ORG_ID,
          customerId: CUSTOMER_ID,
          holds: [
            {
              ruleId: "r1",
              dimension: "tokens",
              windowSeconds: 3600,
              bucketStart,
              scopeTarget: null,
              reserved: 50,
              capValue: 1000,
            },
          ],
        },
      }),
    );
    expect(result).toEqual({ settled: true });
    expect(counterDelta).toBe(150); // actual tokens 200 − reserved 50
  });
});

describe("SettlementGuardError identity", () => {
  test("guard error is the settle.ts class (re-exported through operations)", () => {
    expect(new SettlementGuardError()).toBeInstanceOf(SettlementGuardError);
  });
});
