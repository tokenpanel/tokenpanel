/**
 * Integration tests for the settlement reconcile worker tick
 * (apps/api/src/workers/settlement-reconcile.ts) against the in-memory
 * replica set.
 *
 * reconcileTick is the production entrypoint the supervised loop drives:
 * - without an installed ManagedRuntime it must swallow the infrastructure
 *   miss and resolve to an empty tick (the schedule stays alive);
 * - with the runtime installed (MongoDb + ValidatedRepositoriesLive) it must
 *   drain seeded settlement_outbox rows: gateway-request idempotent reconcile
 *   and context-missing abandonment.
 *
 * withOverlapGuard is exercised with a controlled async gate and an
 * invocation counter (no fake timers).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Effect, Layer, Ref } from "effect";
import { ObjectId } from "mongodb";
import { getDb, getClient, getRawDb } from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  seedBasicDataset,
  startTestDb,
  stopTestDb,
} from "@tokenpanel/db/test-support/memory-server";
import {
  settlementOutboxFixture,
  usageRecordFixture,
} from "@tokenpanel/db/test-support/persistence-fixtures";
import type { AppServices } from "../../runtime/layers/live.ts";
import { MongoDb, type MongoDbService } from "../../runtime/services/mongo-db.ts";
import { ValidatedRepositoriesLive } from "../../infrastructure/mongo/repositories/index.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
  getAppRuntime,
  isAppRuntimeInstalled,
} from "../../runtime/app-runtime.ts";
import { reconcileTick, withOverlapGuard } from "../settlement-reconcile.ts";

const TEST_DB = "tokenpanel_worker_tick_test";
const TICK_BATCH_SIZE = 10;
const EMPTY_TICK = { claimed: 0, reconciled: 0, abandoned: 0 };

async function resetData(): Promise<void> {
  await resetTestCollections(
    "settlementOutbox",
    "usageRecords",
    "customers",
    "organizations",
    "providers",
    "models",
    "modelCatalog",
    "apiKeys",
  );
}

async function installRuntime(): Promise<void> {
  const mongo: MongoDbService = {
    db: await getDb(),
    client: getClient(),
    rawDb: getRawDb(),
    close: async () => undefined,
  };
  const base = Layer.succeed(MongoDb, mongo);
  const layer = Layer.provideMerge(ValidatedRepositoriesLive, base) as unknown as Layer.Layer<
    AppServices,
    never,
    never
  >;
  createAppRuntime(layer, { install: true });
}

describe("reconcileTick without an installed runtime", () => {
  beforeEach(async () => {
    // Defensive: never depend on leftover process state from other suites.
    if (isAppRuntimeInstalled()) {
      await disposeAppRuntime().catch(() => undefined);
      clearAppRuntimeSingleton();
    }
  });

  test("infrastructure miss is swallowed: empty tick, no throw", async () => {
    expect(isAppRuntimeInstalled()).toBe(false);
    const result = await Effect.runPromise(reconcileTick(TICK_BATCH_SIZE));
    expect(result).toEqual(EMPTY_TICK);
  });
});

describe("withOverlapGuard", () => {
  test("skips concurrent invocation while first is in flight; runs sequentially after completion", async () => {
    const busy = Effect.runSync(Ref.make(false));
    let invocations = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const work: Effect.Effect<string, Error> = Effect.tryPromise({
      try: async () => {
        invocations += 1;
        await gate;
        return "done";
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });

    const first = Effect.runPromise(withOverlapGuard(work, busy));
    // Let the first invocation acquire the guard and park on the gate.
    await Effect.runPromise(Effect.sleep(10));

    // Second invocation while the first still holds the guard → skipped,
    // the wrapped work is NOT re-entered.
    const second = await Effect.runPromise(withOverlapGuard(work, busy));
    expect(second).toBeNull();
    expect(invocations).toBe(1);

    release();
    expect(await first).toBe("done");

    // Effect.ensuring released the guard on completion → the sequential
    // invocation runs for real.
    const third = await Effect.runPromise(withOverlapGuard(work, busy));
    expect(third).toBe("done");
    expect(invocations).toBe(2);
  });
});

describe("reconcileTick (live replica set)", () => {
  beforeAll(() => startTestDb({ databaseName: TEST_DB }), TEST_DB_START_TIMEOUT_MS);
  afterAll(stopTestDb);

  beforeEach(async () => {
    await resetData();
    await installRuntime();
  });

  afterEach(async () => {
    await disposeAppRuntime().catch(() => undefined);
    clearAppRuntimeSingleton();
    await resetData();
  });

  test("empty database → no-op tick", async () => {
    const result = await getAppRuntime().runPromise(reconcileTick(TICK_BATCH_SIZE));
    expect(result).toEqual(EMPTY_TICK);
    expect(await getRawDb().collection("settlement_outbox").countDocuments({})).toBe(0);
  });

  test("tick drains seeded pending outbox: idempotent reconcile + abandoned row", async () => {
    // Customer + org + provider the fixture rows reference.
    await seedBasicDataset();

    // Row A is already settled upstream: a usage record carrying its
    // gatewayRequestId exists → the tick must mark it reconciled WITHOUT
    // settling again (no new usage row, no balance debit).
    await getDb().then((typed) =>
      typed.usageRecords.insertOne(
        usageRecordFixture({ gatewayRequestId: "gw_tick_settled" }),
      ),
    );
    const settledRow = settlementOutboxFixture({
      _id: new ObjectId(),
      gatewayRequestId: "gw_tick_settled",
      context: {
        actorKind: "customer_key",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });
    // Row B has no usable usage in its context → abandoned with the row reason.
    const brokenRow = settlementOutboxFixture({
      _id: new ObjectId(),
      gatewayRequestId: "gw_tick_broken",
    });
    await getDb().then((typed) =>
      typed.settlementOutbox.insertMany([settledRow, brokenRow]),
    );

    const first = await getAppRuntime().runPromise(reconcileTick(TICK_BATCH_SIZE));
    expect(first).toEqual({ claimed: 2, reconciled: 1, abandoned: 1 });

    const typed = await getDb();

    const settled = await typed.settlementOutbox.findOne({
      gatewayRequestId: "gw_tick_settled",
    });
    expect(settled?.status).toBe("reconciled");
    expect(settled?.claimToken).toBeUndefined();
    expect(settled?.claimedAt).toBeUndefined();
    expect(settled?.attempts).toBe(1); // atomic fenced claim incremented attempts

    const broken = await typed.settlementOutbox.findOne({
      gatewayRequestId: "gw_tick_broken",
    });
    expect(broken?.status).toBe("abandoned");
    expect(broken?.context.abandonReason).toBe("missing_usage");
    expect(broken?.attempts).toBe(1);

    // Idempotency: exactly the pre-existing usage record, none re-inserted.
    expect(
      await typed.usageRecords.countDocuments({ gatewayRequestId: "gw_tick_settled" }),
    ).toBe(1);
    // The gateway-request shortcut reconciled without debiting the customer.
    const brokenCustomerId = brokenRow.customerId;
    if (!(brokenCustomerId instanceof ObjectId)) {
      throw new Error("fixture row must carry a customerId");
    }
    const customer = await typed.customers.findOne({ _id: brokenCustomerId });
    expect(customer?.balance.amountMicros).toBe(100_000_000);

    // Both rows are terminal now → a follow-up tick finds nothing due.
    const second = await getAppRuntime().runPromise(reconcileTick(TICK_BATCH_SIZE));
    expect(second).toEqual(EMPTY_TICK);
  });
});
