/**
 * Unit tests for billing workflow: preFlightWorkflow, resolveModelOp,
 * release/debit reservation workflows (9.3).
 */
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { ModelDoc } from "@tokenpanel/db";
import type {
  CustomerDoc,
  ModelDoc as ModelDocT,
  RateLimitCounterDoc,
  RateLimitRule,
} from "@tokenpanel/db/schemas/effect";
import {
  debitWithReservationWorkflow,
  preFlightWorkflow,
  releaseAllPreflightHolds,
  releaseLimitReservationWorkflow,
  releaseReservationWorkflow,
  resolveModelOp,
  type BillingWorkflowServices,
  type LimitReservation,
} from "../workflow.ts";
import type { BalanceSnapshot } from "../reservation.ts";
import {
  AuthorizationError,
  InsufficientBalanceError,
  NotFoundError,
  PersistenceConflictError,
  RateLimitExceededError,
  SystemError,
} from "../../../errors/families.ts";
import { Clock } from "../../../runtime/services/clock.ts";
import {
  MongoDb,
  type MongoDbService,
} from "../../../runtime/services/mongo-db.ts";
import {
  CustomersRepo,
  type CustomersRepoService,
} from "../../../infrastructure/mongo/repositories/customers.ts";
import {
  ModelsRepo,
  type ModelsRepoService,
} from "../../../infrastructure/mongo/repositories/models.ts";
import {
  PlansRepo,
  type PlansRepoService,
} from "../../../infrastructure/mongo/repositories/plans.ts";
import {
  UsageRepo,
  type UsageRepoService,
} from "../../../infrastructure/mongo/repositories/usage.ts";

const ORG_ID = new ObjectId();
const CUSTOMER_ID = new ObjectId();
const ALIAS = "gpt-test";
/** Fixed epoch so bucket/retry math is deterministic. */
const NOW_MS = 1_800_000_000_000;

function makeModel(over: Partial<ModelDoc> = {}): ModelDoc {
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    aliasId: ALIAS,
    displayName: "GPT Test",
    description: null,
    entries: [
      {
        id: "e1",
        providerId: new ObjectId(),
        upstreamModelId: "gpt-4o",
        priority: 0,
        active: true,
      },
    ],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(NOW_MS),
    updatedAt: new Date(NOW_MS),
    ...over,
  };
}

function makeCustomer(balance: {
  amountMicros: number;
  reservedMicros: number;
  currency: string;
}): CustomerDoc {
  return {
    _id: CUSTOMER_ID,
    organizationId: ORG_ID,
    externalId: null,
    name: "Acme",
    email: null,
    balance,
    status: "active",
    metadata: {},
    createdAt: new Date(NOW_MS),
    updatedAt: new Date(NOW_MS),
  };
}

function rule(over: Partial<RateLimitRule> = {}): RateLimitRule {
  return {
    id: "r1",
    windowSeconds: 60,
    dimension: "requests",
    capValue: 5,
    scope: "customer",
    scopeTarget: null,
    active: true,
    ...over,
  };
}

function counterDoc(over: Partial<RateLimitCounterDoc> = {}): RateLimitCounterDoc {
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    dimension: "tokens",
    windowSeconds: 60,
    bucketStart: new Date(NOW_MS - 10_000),
    count: 5,
    scopeTarget: null,
    createdAt: new Date(NOW_MS - 10_000),
    updatedAt: new Date(NOW_MS - 10_000),
    ...over,
  };
}

type RecordedCounter = {
  dimension: string;
  windowSeconds: number;
  bucketStart: Date;
  scopeTarget: string | null;
  increment: number;
};

type CtxOpts = {
  /** findModelByAlias result; null = not found; omitted = a default model. */
  model?: ModelDoc | null;
  modelFails?: boolean;
  /** findByIdAnyOrg result. */
  customer?: CustomerDoc | null;
  reserveResult?:
    | { reserved: true; reservedMicros: number }
    | { reserved: false; reason: string };
  settleResult?: boolean;
  failRelease?: boolean;
  failSettle?: boolean;
  failBulk?: boolean;
  counters?: readonly RateLimitCounterDoc[];
};

function testCtx(opts: CtxOpts = {}) {
  const calls = {
    findModelByAlias: 0,
    findByIdAnyOrg: 0,
    reserveBalance: [] as { needMicros: number; currency: string }[],
    releaseReserved: [] as { reservedMicros: number }[],
    settleWithReservation: [] as {
      customerId: ObjectId;
      organizationId: ObjectId;
      priceMicros: number;
      reservedMicros: number;
      currency: string;
    }[],
    bulkUpserts: [] as RecordedCounter[][],
  };

  const mongoFailure = () =>
    new PersistenceConflictError({
      code: "persistence_conflict",
      message: "db down",
      labels: [],
      retryClass: "transient",
    });

  const customers: CustomersRepoService = {
    findById: () => Effect.die("unused"),
    findByIdAnyOrg: () => {
      calls.findByIdAnyOrg += 1;
      return Effect.succeed(opts.customer ?? null);
    },
    findByOrgEmail: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    insert: () => Effect.die("unused"),
    updateById: () => Effect.die("unused"),
    replace: () => Effect.die("unused"),
    insertAdjustment: () => Effect.die("unused"),
    listAdjustments: () => Effect.die("unused"),
    reserveBalance: (p) => {
      calls.reserveBalance.push({ needMicros: p.needMicros, currency: p.currency });
      return Effect.succeed(
        opts.reserveResult ?? { reserved: true, reservedMicros: p.needMicros },
      );
    },
    releaseReserved: (p) => {
      calls.releaseReserved.push({ reservedMicros: p.reservedMicros });
      return opts.failRelease
        ? Effect.fail(mongoFailure())
        : Effect.succeed(true);
    },
    settleWithReservation: (p) => {
      calls.settleWithReservation.push({
        customerId: p.customerId,
        organizationId: p.organizationId,
        priceMicros: p.priceMicros,
        reservedMicros: p.reservedMicros,
        currency: p.currency,
      });
      return opts.failSettle
        ? Effect.fail(mongoFailure())
        : Effect.succeed(opts.settleResult ?? true);
    },
    debitBalance: () => Effect.die("unused"),
  };

  const models: ModelsRepoService = {
    findProviderById: () => Effect.die("unused"),
    listProviders: () => Effect.die("unused"),
    insertProvider: () => Effect.die("unused"),
    updateProvider: () => Effect.die("unused"),
    findModelById: () => Effect.die("unused"),
    findModelByAlias: (_orgId, aliasId) => {
      calls.findModelByAlias += 1;
      void aliasId;
      return opts.modelFails
        ? Effect.fail(mongoFailure())
        : Effect.succeed(
            (opts.model === undefined ? makeModel() : opts.model) as
              | ModelDocT
              | null,
          );
    },
    listModels: () => Effect.die("unused"),
    insertModel: () => Effect.die("unused"),
    updateModel: () => Effect.die("unused"),
    replaceModel: () => Effect.die("unused"),
    listCatalog: () => Effect.die("unused"),
    insertCatalog: () => Effect.die("unused"),
  };

  const usage: UsageRepoService = {
    findById: () => Effect.die("unused"),
    findByGatewayRequestId: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    insert: () => Effect.die("unused"),
    findCounter: () => Effect.die("unused"),
    insertCounter: () => Effect.die("unused"),
    replaceCounter: () => Effect.die("unused"),
    findWindowCounters: (f) =>
      Effect.succeed(
        (opts.counters ?? []).filter(
          (c) =>
            c.dimension === f.dimension &&
            c.windowSeconds === f.windowSeconds &&
            c.bucketStart.getTime() >= f.windowStart.getTime(),
        ),
      ),
    bulkUpsertCounters: (p) => {
      calls.bulkUpserts.push(
        p.entries.map((e) => ({
          dimension: e.dimension,
          windowSeconds: e.windowSeconds,
          bucketStart: e.bucketStart,
          scopeTarget: e.scopeTarget,
          increment: e.increment,
        })),
      );
      return opts.failBulk ? Effect.fail(mongoFailure()) : Effect.void;
    },
  };

  // PlansRepo is never resolved: every test injects rules.
  const plans = {} as PlansRepoService;

  // Fake session that runs the body without a real transaction.
  const mongo = {
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
    rawDb: {},
    close: async () => undefined,
  } as unknown as MongoDbService;

  const clock: Layer.Layer<Clock> = Layer.succeed(Clock, {
    nowMs: () => NOW_MS,
    now: () => new Date(NOW_MS),
  });
  const customersLayer: Layer.Layer<CustomersRepo> =
    Layer.succeed(CustomersRepo, customers);
  const modelsLayer: Layer.Layer<ModelsRepo> = Layer.succeed(ModelsRepo, models);
  const usageLayer: Layer.Layer<UsageRepo> = Layer.succeed(UsageRepo, usage);

  const layer: Layer.Layer<BillingWorkflowServices, never, never> =
    Layer.mergeAll(
      clock,
      customersLayer,
      modelsLayer,
      Layer.succeed(PlansRepo, plans),
      usageLayer,
      Layer.succeed(MongoDb, mongo),
    );

  return { layer, calls, modelsLayer, customersLayer, usageLayer };
}

async function runOk<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(Effect.provide(effect, layer));
  if (exit._tag === "Failure") {
    throw new Error(`expected success: ${Cause.pretty(exit.cause)}`);
  }
  return exit.value;
}

async function runFail<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>,
): Promise<unknown> {
  const exit = await Effect.runPromiseExit(Effect.provide(effect, layer));
  if (exit._tag !== "Failure") {
    throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`);
  }
  return Cause.squash(exit.cause);
}

/** prompt 1.5M tokens @ 1_000_000 micros/M → 1_500_000 micros; no completion. */
function preFlightParams(model: ModelDoc, over: Record<string, unknown> = {}) {
  return {
    orgId: ORG_ID,
    customerId: CUSTOMER_ID,
    apiKeyModelWhitelist: [] as readonly string[],
    aliasId: ALIAS,
    model,
    estimatedPromptTokens: 1_500_000,
    maxCompletionTokens: 0,
    rules: [] as readonly RateLimitRule[],
    ...over,
  };
}

describe("preFlightWorkflow", () => {
  test("dry run: happy path yields decision-only reservation and estimates", async () => {
    const { layer } = testCtx();
    const model = makeModel();
    const snapshot: BalanceSnapshot = {
      amountMicros: 90_000_000,
      reservedMicros: 1_000_000,
      currency: "USD",
    };
    const result = await runOk(
      preFlightWorkflow(
        preFlightParams(model, {
          apiKeyModelWhitelist: [ALIAS], // alias present → gate passes
          balanceSnapshot: snapshot,
          dryRun: true,
        }),
      ),
      layer,
    );
    expect(result.model).toBe(model);
    expect(result.estimatedTokens).toBe(1_500_000);
    expect(result.estimatedSpendMicros).toBe(1_500_000);
    expect(result.rules).toEqual([]);
    expect(result.limitReservation).toBeNull();
    expect(result.reservation).not.toBeNull();
    expect(result.reservation?.reservedMicros).toBe(1_500_000);
    expect(result.reservation?.customerId.toHexString()).toBe(
      CUSTOMER_ID.toHexString(),
    );
  });

  test("whitelist gate: alias not allowed → AuthorizationError before model load", async () => {
    const { layer, calls } = testCtx();
    const err = (await runFail(
      preFlightWorkflow(
        preFlightParams(makeModel(), { apiKeyModelWhitelist: ["other-model"] }),
      ),
      layer,
    )) as AuthorizationError;
    expect(err._tag).toBe("AuthorizationError");
    expect(err.code).toBe("model_not_allowed");
    expect(err.message).toBe(`Your API key does not allow model '${ALIAS}'`);
    // Gate fires before any model lookup.
    expect(calls.findModelByAlias).toBe(0);
  });

  test("model missing: loads via ModelsRepo → NotFoundError model_not_found", async () => {
    const { layer, calls } = testCtx({ model: null });
    const err = (await runFail(
      preFlightWorkflow({
        orgId: ORG_ID,
        customerId: CUSTOMER_ID,
        apiKeyModelWhitelist: [],
        aliasId: ALIAS,
        estimatedPromptTokens: 1_000,
        maxCompletionTokens: 0,
        rules: [],
      }),
      layer,
    )) as NotFoundError;
    expect(err._tag).toBe("NotFoundError");
    expect(err.code).toBe("model_not_found");
    expect(err.resource).toBe("model");
    expect(err.message).toBe(`Model '${ALIAS}' not found or inactive`);
    expect(calls.findModelByAlias).toBe(1);
  });

  test("rate-limit violation: typed fields, no writes, balance never touched", async () => {
    const { layer, calls } = testCtx({
      counters: [counterDoc()], // tokens window 60s, count 5, bucket 10s old
    });
    const err = (await runFail(
      preFlightWorkflow(
        preFlightParams(makeModel(), {
          rules: [rule({ dimension: "tokens", capValue: 5 })],
        }),
      ),
      layer,
    )) as RateLimitExceededError;
    expect(err._tag).toBe("RateLimitExceededError");
    expect(err.code).toBe("rate_limited");
    expect(err.message).toBe("Rate limit exceeded: tokens cap 5 in 60s window");
    expect(err.dimension).toBe("tokens");
    expect(err.cap).toBe(5);
    expect(err.current).toBe(5);
    // 60s window − 10s-old oldest bucket.
    expect(err.retryAfterSeconds).toBe(50);
    expect(err.windowSeconds).toBe(60);
    // Limits fail first: no counter writes, no customer read.
    expect(calls.bulkUpserts).toEqual([]);
    expect(calls.findByIdAnyOrg).toBe(0);
    expect(calls.reserveBalance).toEqual([]);
  });

  test("dry run insufficient: insufficient_balance decision, no reserve write", async () => {
    const { layer, calls } = testCtx();
    const snapshot: BalanceSnapshot = {
      amountMicros: 500_000,
      reservedMicros: 100_000,
      currency: "USD",
    };
    const err = (await runFail(
      preFlightWorkflow(
        preFlightParams(makeModel(), {
          balanceSnapshot: snapshot,
          dryRun: true,
        }),
      ),
      layer,
    )) as InsufficientBalanceError;
    expect(err._tag).toBe("InsufficientBalanceError");
    expect(err.code).toBe("insufficient_balance");
    expect(err.requiredMicros).toBe(1_500_000);
    expect(err.balanceMicros).toBe(400_000);
    expect(err.currency).toBe("USD");
    expect(calls.reserveBalance).toEqual([]);
    expect(calls.findByIdAnyOrg).toBe(0);
  });

  test("dry run currency mismatch → currency_mismatch", async () => {
    const { layer } = testCtx();
    const snapshot: BalanceSnapshot = {
      amountMicros: 99_000_000,
      reservedMicros: 0,
      currency: "EUR",
    };
    const err = (await runFail(
      preFlightWorkflow(
        preFlightParams(makeModel(), {
          balanceSnapshot: snapshot,
          dryRun: true,
        }),
      ),
      layer,
    )) as InsufficientBalanceError;
    expect(err._tag).toBe("InsufficientBalanceError");
    expect(err.code).toBe("currency_mismatch");
    expect(err.balanceCurrency).toBe("EUR");
    expect(err.modelCurrency).toBe("USD");
  });

  test("live reserve ok: repo-held micros pass through as reservation", async () => {
    const { layer, calls } = testCtx({
      customer: makeCustomer({
        amountMicros: 5_000_000,
        reservedMicros: 1_000_000,
        currency: "USD",
      }),
      // Distinct from the 1_500_000 estimate to prove passthrough.
      reserveResult: { reserved: true, reservedMicros: 1_200_000 },
    });
    const result = await runOk(
      preFlightWorkflow(preFlightParams(makeModel())),
      layer,
    );
    expect(result.reservation).not.toBeNull();
    expect(result.reservation?.reservedMicros).toBe(1_200_000);
    expect(calls.findByIdAnyOrg).toBe(1);
    expect(calls.reserveBalance).toEqual([
      { needMicros: 1_500_000, currency: "USD" },
    ]);
    // No rules injected → no limit holds.
    expect(result.limitReservation).toBeNull();
    expect(calls.bulkUpserts).toEqual([]);
  });

  test("live reserve refusal: insufficient_balance and limit holds released", async () => {
    const { layer, calls } = testCtx({
      customer: makeCustomer({
        amountMicros: 5_000_000,
        reservedMicros: 1_000_000,
        currency: "USD",
      }),
      reserveResult: { reserved: false, reason: "insufficient_available" },
      counters: [],
    });
    const err = (await runFail(
      preFlightWorkflow(preFlightParams(makeModel(), { rules: [rule()] })),
      layer,
    )) as InsufficientBalanceError;
    expect(err._tag).toBe("InsufficientBalanceError");
    expect(err.code).toBe("insufficient_balance");
    expect(err.balanceMicros).toBe(4_000_000);
    expect(err.requiredMicros).toBe(1_500_000);
    // requests hold (+1) written, then released (−1) on refusal.
    expect(calls.bulkUpserts.length).toBe(2);
    expect(calls.bulkUpserts[0]?.[0]?.increment).toBe(1);
    expect(calls.bulkUpserts[1]?.[0]?.increment).toBe(-1);
    expect(calls.bulkUpserts[1]?.[0]?.dimension).toBe("requests");
  });

  test("zero estimated spend: balance path skipped entirely", async () => {
    const freeModel = makeModel({
      price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    });
    // Customer deliberately missing: any balance-path run would fail.
    const { layer, calls } = testCtx({ customer: null });
    const result = await runOk(
      preFlightWorkflow(
        preFlightParams(freeModel, { estimatedPromptTokens: 0 }),
      ),
      layer,
    );
    expect(result.estimatedSpendMicros).toBe(0);
    expect(result.reservation).toBeNull();
    expect(calls.findByIdAnyOrg).toBe(0);
    expect(calls.reserveBalance).toEqual([]);
  });

  test("customer missing: AuthorizationError customer_not_found, holds released", async () => {
    const { layer, calls } = testCtx({ customer: null, counters: [] });
    const err = (await runFail(
      preFlightWorkflow(preFlightParams(makeModel(), { rules: [rule()] })),
      layer,
    )) as AuthorizationError;
    expect(err._tag).toBe("AuthorizationError");
    expect(err.code).toBe("customer_not_found");
    expect(err.message).toBe("Customer not found");
    expect(calls.findByIdAnyOrg).toBe(1);
    // Limit hold written then released before failing.
    expect(calls.bulkUpserts.length).toBe(2);
    expect(calls.bulkUpserts[0]?.[0]?.increment).toBe(1);
    expect(calls.bulkUpserts[1]?.[0]?.increment).toBe(-1);
    expect(calls.reserveBalance).toEqual([]);
  });
});

describe("resolveModelOp", () => {
  test("inactive model → NotFoundError model_not_found", async () => {
    const { modelsLayer } = testCtx({ model: makeModel({ active: false }) });
    const err = (await runFail(
      resolveModelOp(ORG_ID, ALIAS),
      modelsLayer,
    )) as NotFoundError;
    expect(err._tag).toBe("NotFoundError");
    expect(err.code).toBe("model_not_found");
    expect(err.resource).toBe("model");
  });

  test("repo failure → SystemError 'Failed to load model' with diagnostic", async () => {
    const { modelsLayer } = testCtx({ modelFails: true });
    const err = (await runFail(
      resolveModelOp(ORG_ID, ALIAS),
      modelsLayer,
    )) as SystemError;
    expect(err._tag).toBe("SystemError");
    expect(err.code).toBe("system_error");
    expect(err.message).toBe("Failed to load model");
    expect(err.diagnostic).toBe("db down");
  });
});

describe("releaseReservationWorkflow", () => {
  test("no-ops on null, undefined, and non-positive holds", async () => {
    const { customersLayer, calls } = testCtx();
    await runOk(releaseReservationWorkflow(null), customersLayer);
    await runOk(releaseReservationWorkflow(undefined), customersLayer);
    await runOk(
      releaseReservationWorkflow({
        reservedMicros: 0,
        customerId: CUSTOMER_ID,
        organizationId: ORG_ID,
      }),
      customersLayer,
    );
    expect(calls.releaseReserved).toEqual([]);
  });

  test("forwards the hold to releaseReserved", async () => {
    const { customersLayer, calls } = testCtx();
    await runOk(
      releaseReservationWorkflow({
        reservedMicros: 1_500_000,
        customerId: CUSTOMER_ID,
        organizationId: ORG_ID,
      }),
      customersLayer,
    );
    expect(calls.releaseReserved).toEqual([{ reservedMicros: 1_500_000 }]);
  });

  test("swallows repo failure (best-effort, never fails)", async () => {
    const { customersLayer, calls } = testCtx({ failRelease: true });
    await runOk(
      releaseReservationWorkflow({
        reservedMicros: 500,
        customerId: CUSTOMER_ID,
        organizationId: ORG_ID,
      }),
      customersLayer,
    );
    expect(calls.releaseReserved.length).toBe(1);
  });
});

describe("releaseLimitReservationWorkflow", () => {
  test("no-ops on null and empty holds", async () => {
    const { usageLayer, calls } = testCtx();
    await runOk(releaseLimitReservationWorkflow(null), usageLayer);
    await runOk(releaseLimitReservationWorkflow(undefined), usageLayer);
    await runOk(
      releaseLimitReservationWorkflow({
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        holds: [],
      }),
      usageLayer,
    );
    expect(calls.bulkUpserts).toEqual([]);
  });

  test("releases holds as negative counter increments", async () => {
    const { usageLayer, calls } = testCtx();
    const bucketStart = new Date(NOW_MS);
    const limitReservation: LimitReservation = {
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      holds: [
        {
          ruleId: "r1",
          dimension: "requests",
          windowSeconds: 60,
          bucketStart,
          scopeTarget: null,
          reserved: 2,
          capValue: 5,
        },
      ],
    };
    await runOk(releaseLimitReservationWorkflow(limitReservation), usageLayer);
    expect(calls.bulkUpserts).toEqual([
      [
        {
          dimension: "requests",
          windowSeconds: 60,
          bucketStart,
          scopeTarget: null,
          increment: -2,
        },
      ],
    ]);
  });

  test("swallows counter-write failure", async () => {
    const { usageLayer, calls } = testCtx({ failBulk: true });
    await runOk(
      releaseLimitReservationWorkflow({
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        holds: [
          {
            ruleId: "r1",
            dimension: "tokens",
            windowSeconds: 60,
            bucketStart: new Date(NOW_MS),
            scopeTarget: null,
            reserved: 3,
            capValue: 10,
          },
        ],
      }),
      usageLayer,
    );
    expect(calls.bulkUpserts.length).toBe(1);
  });
});

describe("releaseAllPreflightHolds", () => {
  test("releases balance and limit holds together", async () => {
    const { layer, calls } = testCtx();
    const bucketStart = new Date(NOW_MS);
    await runOk(
      releaseAllPreflightHolds({
        reservation: {
          reservedMicros: 700,
          customerId: CUSTOMER_ID,
          organizationId: ORG_ID,
        },
        limitReservation: {
          organizationId: ORG_ID,
          customerId: CUSTOMER_ID,
          holds: [
            {
              ruleId: "r1",
              dimension: "requests",
              windowSeconds: 60,
              bucketStart,
              scopeTarget: null,
              reserved: 1,
              capValue: 5,
            },
          ],
        },
      }),
      layer,
    );
    expect(calls.releaseReserved).toEqual([{ reservedMicros: 700 }]);
    expect(calls.bulkUpserts).toEqual([
      [
        {
          dimension: "requests",
          windowSeconds: 60,
          bucketStart,
          scopeTarget: null,
          increment: -1,
        },
      ],
    ]);
  });

  test("does nothing when both holds are absent", async () => {
    const { layer, calls } = testCtx();
    await runOk(releaseAllPreflightHolds({}), layer);
    expect(calls.releaseReserved).toEqual([]);
    expect(calls.bulkUpserts).toEqual([]);
  });

  test("never fails even when both repos error", async () => {
    const { layer, calls } = testCtx({
      failRelease: true,
      failBulk: true,
    });
    await runOk(
      releaseAllPreflightHolds({
        reservation: {
          reservedMicros: 700,
          customerId: CUSTOMER_ID,
          organizationId: ORG_ID,
        },
        limitReservation: {
          organizationId: ORG_ID,
          customerId: CUSTOMER_ID,
          holds: [
            {
              ruleId: "r1",
              dimension: "requests",
              windowSeconds: 60,
              bucketStart: new Date(NOW_MS),
              scopeTarget: null,
              reserved: 1,
              capValue: 5,
            },
          ],
        },
      }),
      layer,
    );
    expect(calls.releaseReserved.length).toBe(1);
    expect(calls.bulkUpserts.length).toBe(1);
  });
});

describe("debitWithReservationWorkflow", () => {
  test("settles with reservation and forwards params (true)", async () => {
    const { customersLayer, calls } = testCtx({ settleResult: true });
    const ok = await runOk(
      debitWithReservationWorkflow({
        customerId: CUSTOMER_ID,
        organizationId: ORG_ID,
        priceMicros: 1_200_000,
        reservedMicros: 1_500_000,
        currency: "USD",
      }),
      customersLayer,
    );
    expect(ok).toBe(true);
    expect(calls.settleWithReservation).toEqual([
      {
        customerId: CUSTOMER_ID,
        organizationId: ORG_ID,
        priceMicros: 1_200_000,
        reservedMicros: 1_500_000,
        currency: "USD",
      },
    ]);
  });

  test("returns false when the settle guard rejects", async () => {
    const { customersLayer, calls } = testCtx({ settleResult: false });
    const ok = await runOk(
      debitWithReservationWorkflow({
        customerId: CUSTOMER_ID,
        organizationId: ORG_ID,
        priceMicros: 1_200_000,
        reservedMicros: 1_500_000,
        currency: "USD",
      }),
      customersLayer,
    );
    expect(ok).toBe(false);
    expect(calls.settleWithReservation.length).toBe(1);
  });

  test("maps repo failure to SystemError 'Balance settle with reservation failed'", async () => {
    const { customersLayer } = testCtx({ failSettle: true });
    const err = (await runFail(
      debitWithReservationWorkflow({
        customerId: CUSTOMER_ID,
        organizationId: ORG_ID,
        priceMicros: 1_200_000,
        reservedMicros: 1_500_000,
        currency: "USD",
      }),
      customersLayer,
    )) as SystemError;
    expect(err._tag).toBe("SystemError");
    expect(err.code).toBe("system_error");
    expect(err.message).toBe("Balance settle with reservation failed");
    expect(err.diagnostic).toBe("db down");
  });
});
