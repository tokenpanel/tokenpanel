/**
 * Balance-adjustment idempotency + exact-email customer lookup against the
 * live replica set. Proves the money path, not mocks: replays (sequential
 * and concurrent) increment the balance exactly once, conflicting key reuse
 * leaves balances untouched, keys are organization-scoped, and unkeyed
 * requests stay independent operations.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { MongoClient, ObjectId } from "mongodb";
import { appErrorCode, appErrorTag } from "../../../errors/families.ts";
import {
  configureDb,
  getDb,
  getClient,
  getRawDb,
  closeDb,
  getMongoConnectionConfig,
} from "@tokenpanel/db";
import type { CustomerDoc } from "@tokenpanel/db";
import { MongoDb, type MongoDbService } from "../../../runtime/services/mongo-db.ts";
import { ClockLive } from "../../../runtime/layers/clock.ts";
import { CustomerRepositoryLive } from "../../../infrastructure/mongo/repositories/live.ts";
import { CustomerRepository } from "../../../domains/ports/customer-repository.ts";
import { adjustCustomerBalance, listCustomers } from "../operations.ts";

const TEST_DB = "tokenpanel_idempotency_test";

/**
 * Live-replica-set gating: final validation always supplies TEST_MONGODB_URI
 * (compose Mongo). With no URI the suite is skipped explicitly; with a
 * supplied URI a connection failure must FAIL setup — never silently pass.
 */
const EXPLICIT_URI = process.env.TEST_MONGODB_URI;
const RUN_LIVE = EXPLICIT_URI !== undefined && EXPLICIT_URI.length > 0;
const describeLive = RUN_LIVE ? describe : describe.skip;
let connected = false;

async function ensureConnected(): Promise<void> {
  if (connected) return;
  // Another suite in this bun process may already have opened the shared
  // client (single-process serial execution). Reuse it ONLY after proving
  // the active database is an isolated test DB — never a dev/prod database.
  try {
    getRawDb();
  } catch {
    // not connected yet: probe reachability, then configure our own name.
    const probe = new MongoClient(EXPLICIT_URI as string, {
      serverSelectionTimeoutMS: 5000,
    });
    try {
      await probe.db("admin").command({ ping: 1 });
    } finally {
      await probe.close();
    }
    configureDb({ uri: EXPLICIT_URI as string, databaseName: TEST_DB });
    connected = true;
    return;
  }
  const active = getMongoConnectionConfig().databaseName;
  if (active !== TEST_DB) {
    throw new Error(
      `refusing shared connection: active database "${active}" is not ${TEST_DB}`,
    );
  }
  connected = true;
}

async function resetData(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.customers.deleteMany({}),
    db.organizations.deleteMany({}),
    db.balanceAdjustments.deleteMany({}),
  ]);
  // Mirror of post/2026-09-05 balance-adjustment idempotency migration: the
  // unique partial index is the gate that makes replay detection atomic.
  await db.balanceAdjustments.createIndex(
    { organizationId: 1, idempotencyKey: 1 },
    {
      name: "ux_balance_adjustments_org_idempotency",
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: "string" } },
    },
  );
  // Mirror of post/2026-07-09 unique-customer-email migration: the partial
  // email index that exact-email lookups are meant to hit.
  await db.customers.createIndex(
    { organizationId: 1, email: 1 },
    {
      name: "organizationId_1_email_1_unique",
      unique: true,
      partialFilterExpression: { email: { $type: "string" } },
    },
  );
}

type RepoLayer = Layer.Layer<CustomerRepository, never, never>;

let repoLayer: RepoLayer | null = null;

async function installLayer(): Promise<void> {
  const mongo: MongoDbService = {
    db: await getDb(),
    client: getClient(),
    rawDb: getRawDb(),
    close: async () => undefined,
  };
  repoLayer = CustomerRepositoryLive.pipe(
    Layer.provide(Layer.merge(Layer.succeed(MongoDb, mongo), ClockLive)),
  ) as unknown as RepoLayer;
}

/** Run a domain program against the real repository layer (test seam). */
function run<T, E>(
  program: Effect.Effect<T, E, CustomerRepository>,
): Promise<T> {
  if (!repoLayer) throw new Error("layer not installed");
  return Effect.runPromise(program.pipe(Effect.provide(repoLayer)));
}

async function seedOrg(): Promise<ObjectId> {
  const orgId = new ObjectId();
  const db = await getDb();
  await db.organizations.insertOne({
    _id: orgId,
    name: `org-${orgId.toHexString()}`,
    slug: `org-${orgId.toHexString().slice(-8)}`,
    ownerId: new ObjectId(),
    defaultCurrency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  return orgId;
}

async function seedCustomer(
  orgId: ObjectId,
  over: { email?: string | null; name?: string } = {},
): Promise<ObjectId> {
  const customerId = new ObjectId();
  const db = await getDb();
  await db.customers.insertOne({
    _id: customerId,
    organizationId: orgId,
    externalId: null,
    name: over.name ?? "Seed Customer",
    email: over.email ?? null,
    balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" },
    status: "active",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  return customerId;
}

async function balanceMicrosOf(customerId: ObjectId): Promise<number> {
  const db = await getDb();
  const c = await db.customers.findOne({ _id: customerId });
  return (c?.balance as { amountMicros?: number } | null)?.amountMicros ?? 0;
}

async function adjustmentCount(): Promise<number> {
  const db = await getDb();
  return db.balanceAdjustments.countDocuments({});
}

type AdjustResult = { customer: CustomerDoc; adjustment: { _id: ObjectId } };

const isAdjustResult = (r: unknown): r is AdjustResult =>
  typeof r === "object" && r !== null && "adjustment" in r;

beforeEach(async () => {
  await ensureConnected();
  await resetData();
  await installLayer();
});

afterEach(async () => {
  if (connected) await resetData();
});

process.on("exit", () => {
  void (async () => {
    await closeDb().catch(() => undefined);
  })();
});

describeLive("balance adjustment idempotency (live replica set)", () => {

  test("sequential replay increments exactly once and returns the original adjustment", async () => {
    const orgId = await seedOrg();
    const customerId = await seedCustomer(orgId);

    const first = await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 500,
        reason: "topup",
        note: "original request",
        idempotencyKey: "grant-1",
      }),
    );
    expect(await balanceMicrosOf(customerId)).toBe(500);

    // Same key + same monetary operation, different (retry diagnostic) note.
    const replay = await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 500,
        reason: "topup",
        note: "retry diagnostic",
        idempotencyKey: "grant-1",
      }),
    );

    expect(replay.adjustment._id.toHexString()).toBe(
      first.adjustment._id.toHexString(),
    );
    expect(replay.adjustment.note).toBe("original request");
    expect(await balanceMicrosOf(customerId)).toBe(500);
    expect(await adjustmentCount()).toBe(1);
  });

  test("concurrent replays increment exactly once", async () => {
    const orgId = await seedOrg();
    const customerId = await seedCustomer(orgId);
    const input = {
      organizationId: orgId.toHexString(),
      customerId: customerId.toHexString(),
      amountMicros: 250,
      reason: "topup" as const,
      note: "concurrent",
      idempotencyKey: "grant-concurrent",
    };

    const results: unknown[] = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(adjustCustomerBalance(input)).catch((e: unknown) => e),
      ),
    );

    const successes = results.filter(isAdjustResult);
    // Every replay resolves to the committed adjustment; none conflict.
    expect(successes.length).toBe(8);
    expect(
      new Set(successes.map((r) => r.adjustment._id.toHexString())).size,
    ).toBe(1);
    expect(await balanceMicrosOf(customerId)).toBe(250);
    expect(await adjustmentCount()).toBe(1);
  });

  test("conflicting key reuse rejects and leaves balances unchanged", async () => {
    const orgId = await seedOrg();
    const customerId = await seedCustomer(orgId);

    await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 500,
        reason: "topup",
        note: "first",
        idempotencyKey: "grant-conflict",
      }),
    );

    // Same key, different amount → typed conflict, no second increment.
    const outcome = await run(
      Effect.either(
        adjustCustomerBalance({
          organizationId: orgId.toHexString(),
          customerId: customerId.toHexString(),
          amountMicros: 700,
          reason: "topup",
          note: "first",
          idempotencyKey: "grant-conflict",
        }),
      ),
    );
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(appErrorTag(outcome.left)).toBe("ConflictError");
      expect(appErrorCode(outcome.left)).toBe("idempotency_key_reused");
    }
    expect(await balanceMicrosOf(customerId)).toBe(500);
    expect(await adjustmentCount()).toBe(1);
  });

  test("same key is independent across organizations", async () => {
    const orgA = await seedOrg();
    const custA = await seedCustomer(orgA);
    const orgB = await seedOrg();
    const custB = await seedCustomer(orgB);

    await run(
      adjustCustomerBalance({
        organizationId: orgA.toHexString(),
        customerId: custA.toHexString(),
        amountMicros: 100,
        idempotencyKey: "shared-key",
      }),
    );
    await run(
      adjustCustomerBalance({
        organizationId: orgB.toHexString(),
        customerId: custB.toHexString(),
        amountMicros: 100,
        idempotencyKey: "shared-key",
      }),
    );

    expect(await balanceMicrosOf(custA)).toBe(100);
    expect(await balanceMicrosOf(custB)).toBe(100);
    expect(await adjustmentCount()).toBe(2);
  });

  test("requests without a key remain independent operations", async () => {
    const orgId = await seedOrg();
    const customerId = await seedCustomer(orgId);

    await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 300,
      }),
    );
    await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 300,
      }),
    );

    expect(await balanceMicrosOf(customerId)).toBe(600);
    expect(await adjustmentCount()).toBe(2);
  });

  test("uppercase ObjectId retry of a committed lowercase request replays, not 409s", async () => {
    const orgId = await seedOrg();
    const customerId = await seedCustomer(orgId);

    const first = await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 100,
        reason: "topup",
        note: "original",
        idempotencyKey: "grant-case",
      }),
    );

    // Valid ObjectId hex is case-insensitive: an uppercase retry from the
    // same client is the SAME monetary request and must return the original
    // adjustment instead of a false idempotency_key_reused conflict.
    const replay = await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString().toUpperCase(),
        amountMicros: 100,
        reason: "topup",
        note: "retry",
        idempotencyKey: "grant-case",
      }),
    );

    expect(replay.adjustment._id.toHexString()).toBe(
      first.adjustment._id.toHexString(),
    );
    expect(await balanceMicrosOf(customerId)).toBe(100);
    expect(await adjustmentCount()).toBe(1);
  });

  test("uppercase-first request commits, then lowercase replay returns it", async () => {
    const orgId = await seedOrg();
    const customerId = await seedCustomer(orgId);

    // The first call must fully commit with an uppercase customerId input.
    const first = await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString().toUpperCase(),
        amountMicros: 700,
        reason: "topup",
        note: "upper first",
        idempotencyKey: "grant-upper-first",
      }),
    );
    expect(await balanceMicrosOf(customerId)).toBe(700);

    const replay = await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 700,
        reason: "topup",
        note: "lower replay",
        idempotencyKey: "grant-upper-first",
      }),
    );

    expect(replay.adjustment._id.toHexString()).toBe(
      first.adjustment._id.toHexString(),
    );
    expect(await balanceMicrosOf(customerId)).toBe(700);
    expect(await adjustmentCount()).toBe(1);
  });
});

describeLive("exact-email customer lookup (live replica set)", () => {
  test("email lookup is exact, organization-scoped, and returns zero or one", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const adaA = await seedCustomer(orgA, { email: "ada@example.com" });
    // Same email legitimately exists in another organization.
    await seedCustomer(orgB, { email: "ada@example.com" });
    // Substring neighbors must not match an exact filter.
    await seedCustomer(orgA, { email: "ada@example.commerce" });
    await seedCustomer(orgA, { email: "not-ada@example.com" });

    const hit = await run(
      listCustomers({
        organizationId: orgA.toHexString(),
        email: "ada@example.com",
      }),
    );
    expect(hit.total).toBe(1);
    expect(hit.items.map((c) => c._id.toHexString())).toEqual([
      adaA.toHexString(),
    ]);

    const miss = await run(
      listCustomers({
        organizationId: orgA.toHexString(),
        email: "missing@example.com",
      }),
    );
    expect(miss.total).toBe(0);
    expect(miss.items).toHaveLength(0);
  });

  test("email lookup is planned on the partial index (1 key / 1 doc)", async () => {
    const orgId = await seedOrg();
    const customerId = await seedCustomer(orgId);
    for (let i = 0; i < 200; i++) {
      await seedCustomer(orgId, {
        email: i === 7 ? "target@example.com" : `user-${i}@example.com`,
      });
    }

    const db = getRawDb();
    type ProfileEntry = {
      command?: { find?: string; filter?: Record<string, unknown> };
    };
    // Profiler records the REAL predicates issued by the repository — both
    // the customers list (email filter) and the balanceAdjustments replay
    // findOne (idempotencyKey). Each is then explained with executionStats
    // against the same fixtures.
    await db.setProfilingLevel("all");
    const hit = await run(
      listCustomers({
        organizationId: orgId.toHexString(),
        email: "target@example.com",
      }),
    );
    expect(hit.total).toBe(1);
    await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 100,
        idempotencyKey: "grant-planner",
      }),
    );
    // Replay path: same key → findOne by idempotencyKey predicate.
    await run(
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: customerId.toHexString(),
        amountMicros: 100,
        idempotencyKey: "grant-planner",
      }),
    );
    expect(await balanceMicrosOf(customerId)).toBe(100);
    expect(await adjustmentCount()).toBe(1);

    const entries = (await db
      .collection("system.profile")
      .find({ op: "query" })
      .toArray()) as ProfileEntry[];
    await db.setProfilingLevel("off");
    await db.dropCollection("system.profile").catch(() => undefined);

    type PlanNode = { stage?: string; indexName?: string; inputStage?: PlanNode };
    const explainStats = async (
      collection: string,
      filter: Record<string, unknown>,
    ): Promise<{ indexNames: string[]; keys: number; docs: number }> => {
      const plan = await db.command({
        explain: { find: collection, filter },
        verbosity: "executionStats",
      });
      const qp = (plan as { queryPlanner?: { winningPlan?: PlanNode } })
        .queryPlanner;
      const stages: PlanNode[] = [];
      for (let n = qp?.winningPlan; n; n = n.inputStage) stages.push(n);
      const stats = (
        plan as {
          executionStats?: {
            totalKeysExamined?: number;
            totalDocsExamined?: number;
          };
        }
      ).executionStats;
      return {
        indexNames: stages
          .map((s) => s.indexName)
          .filter((n): n is string => n !== undefined),
        keys: stats?.totalKeysExamined ?? Infinity,
        docs: stats?.totalDocsExamined ?? Infinity,
      };
    };

    // 1. Customers list predicate: production code must emit {$eq, $type}.
    const listPredicates = entries
      .filter(
        (e) =>
          e.command?.find === "customers" &&
          e.command.filter?.email !== undefined,
      )
      .map((e) => e.command!.filter!);
    expect(listPredicates.length).toBeGreaterThan(0);
    const listFilter = listPredicates[listPredicates.length - 1]!;
    expect(listFilter.email).toEqual({
      $eq: "target@example.com",
      $type: "string",
    });
    const listPlan = await explainStats("customers", listFilter);
    expect(listPlan.indexNames).toContain("organizationId_1_email_1_unique");
    expect(listPlan.keys).toBeLessThanOrEqual(2);
    expect(listPlan.docs).toBeLessThanOrEqual(2);

    // 2. Replay findOne predicate: same partial-index eligibility on
    // balanceAdjustments (ux_balance_adjustments_org_idempotency).
    const replayPredicates = entries
      .filter(
        (e) =>
          e.command?.find === "balance_adjustments" &&
          e.command.filter?.idempotencyKey !== undefined,
      )
      .map((e) => e.command!.filter!);
    expect(replayPredicates.length).toBeGreaterThan(0);
    const replayFilter = replayPredicates[replayPredicates.length - 1]!;
    expect(replayFilter.idempotencyKey).toEqual({
      $eq: "grant-planner",
      $type: "string",
    });
    const replayPlan = await explainStats(
      "balance_adjustments",
      replayFilter,
    );
    expect(replayPlan.indexNames).toContain(
      "ux_balance_adjustments_org_idempotency",
    );
    expect(replayPlan.keys).toBeLessThanOrEqual(2);
    expect(replayPlan.docs).toBeLessThanOrEqual(2);
  });

  test("254-character emails are lookupable (q's 160-char cap does not apply)", async () => {
    const orgId = await seedOrg();
    const longEmail = `${"a".repeat(242)}@example.com`;
    expect(longEmail.length).toBe(254);
    const longId = await seedCustomer(orgId, { email: longEmail });

    const page = await run(
      listCustomers({ organizationId: orgId.toHexString(), email: longEmail }),
    );
    expect(page.total).toBe(1);
    expect(page.items[0]?._id.toHexString()).toBe(longId.toHexString());
  });
});
