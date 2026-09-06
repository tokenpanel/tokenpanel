import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { createMigrationDb } from "../migration-db.ts";
import { up as preUp } from "../../../migrations/pre/2026-07-29T18-54-05Z__money-micros-dual-fields.ts";
import { up as postUp } from "../../../migrations/post/2026-07-29T19-00-00Z__money-units-to-micros.ts";
import {
  startTestDb,
  stopTestDb,
  TEST_DB_START_TIMEOUT_MS,
  type TestDbHandle,
} from "../../test-support/memory-server.ts";

/**
 * Integration coverage for the units → micros money migration (pre + post).
 * Verifies currency-aware conversion (USD ×10⁴, JPY ×10⁶, KWD ×10³), spend-cap
 * scaling that leaves tokens/requests caps untouched, and idempotent re-runs.
 *
 * Runs against the shared in-memory MongoDB replica set, in a dedicated test
 * database that is dropped on cleanup.
 */
const TEST_DB = "tokenpanel_micros_it";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: TEST_DB });
  await handle.client.db(TEST_DB).dropDatabase().catch(() => {});
}, TEST_DB_START_TIMEOUT_MS);

afterAll(async () => {
  if (handle) {
    await handle.client.db(TEST_DB).dropDatabase().catch(() => {});
  }
  await stopTestDb();
});

async function runPre(): Promise<void> {
  const db = handle.rawDb;
  await handle.client.withSession(async (session) => {
    const mdb = createMigrationDb(db, session);
    await preUp(mdb);
  });
}

async function runPost(): Promise<void> {
  const db = handle.rawDb;
  await handle.client.withSession(async (session) => {
    const mdb = createMigrationDb(db, session);
    await postUp(mdb);
  });
}

describe("money units → micros migration", () => {
  test("pre: currency-aware dual-field copy (USD/JPY/KWD)", async () => {
    const db = handle.rawDb;
    const customers = db.collection("customers");
    await customers.deleteMany({});
    await customers.insertMany([
      { _id: new ObjectId(), balance: { amountUnits: 1, reservedUnits: 2, currency: "USD" } },
      { _id: new ObjectId(), balance: { amountUnits: 1, reservedUnits: 2, currency: "JPY" } },
      { _id: new ObjectId(), balance: { amountUnits: 1, reservedUnits: 2, currency: "KWD" } },
    ]);

    await runPre();

    const docs = await customers.find({}).toArray();
    const byCur = new Map(docs.map((d) => [d.balance.currency, d.balance]));
    expect(byCur.get("USD")?.amountMicros).toBe(10_000); // ×10,000
    expect(byCur.get("USD")?.reservedMicros).toBe(20_000);
    expect(byCur.get("JPY")?.amountMicros).toBe(1_000_000); // ×1,000,000
    expect(byCur.get("KWD")?.amountMicros).toBe(1_000); // ×1,000
    // Units preserved for old readers during the window.
    expect(byCur.get("USD")?.amountUnits).toBe(1);
  });

  test("pre: spend cap scaled + marker, tokens/requests caps untouched", async () => {
    const db = handle.rawDb;
    const plans = db.collection("subscription_plans");
    await plans.deleteMany({});
    await plans.insertOne({
      _id: new ObjectId(),
      price: { amountUnits: 5, currency: "USD" },
      rateLimits: [
        { id: "spend", dimension: "spend_units", capValue: 100, windowSeconds: 3600 },
        { id: "tok", dimension: "tokens", capValue: 1000, windowSeconds: 3600 },
        { id: "req", dimension: "requests", capValue: 50, windowSeconds: 3600 },
      ],
    });

    await runPre();

    const plan = await plans.findOne({});
    const rules = new Map<string, Record<string, unknown>>(
      plan!.rateLimits.map((r: Record<string, unknown>) => [r.id as string, r] as [string, Record<string, unknown>]),
    );
    expect(rules.get("spend")?.capValue).toBe(1_000_000); // 100 × 10,000
    expect(rules.get("spend")?._microsScaled).toBe(true);
    expect(rules.get("spend")?.dimension).toBe("spend_units"); // not renamed in pre
    expect(rules.get("tok")?.capValue).toBe(1000); // untouched
    expect(rules.get("req")?.capValue).toBe(50); // untouched
    expect(rules.get("tok")?._microsScaled).toBeUndefined();
  });

  test("pre: idempotent re-run does not double-scale caps or duplicate micros", async () => {
    const db = handle.rawDb;
    const plans = db.collection("subscription_plans");
    await plans.deleteMany({});
    await plans.insertOne({
      _id: new ObjectId(),
      price: { amountUnits: 5, currency: "USD" },
      rateLimits: [{ id: "spend", dimension: "spend_units", capValue: 100, windowSeconds: 3600 }],
    });

    await runPre();
    await runPre(); // second run must be a no-op

    const plan = await plans.findOne({});
    expect(plan!.rateLimits[0].capValue).toBe(1_000_000); // not 10^10
  });

  test("post: promotes units→micros, drops units, renames spend dim", async () => {
    const db = handle.rawDb;
    const customers = db.collection("customers");
    const plans = db.collection("subscription_plans");
    const counters = db.collection("rate_limit_counters");
    const orgs = db.collection("organizations");
    await customers.deleteMany({});
    await plans.deleteMany({});
    await counters.deleteMany({});
    await orgs.deleteMany({});

    const orgId = new ObjectId();
    await orgs.insertOne({ _id: orgId, defaultCurrency: "USD" });
    await customers.insertOne({
      _id: new ObjectId(),
      balance: { amountUnits: 3, currency: "USD" },
    });
    await plans.insertOne({
      _id: new ObjectId(),
      price: { amountUnits: 5, currency: "USD" },
      rateLimits: [{ id: "spend", dimension: "spend_units", capValue: 100, windowSeconds: 3600 }],
    });
    await counters.insertOne({
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: new ObjectId(),
      dimension: "spend_units",
      windowSeconds: 3600,
      bucketStart: new Date(),
      count: 7,
    });

    await runPre();
    await runPost();

    const cust = await customers.findOne({});
    expect(cust!.balance.amountMicros).toBe(30_000);
    expect(cust!.balance.amountUnits).toBeUndefined();

    const plan = await plans.findOne({});
    expect(plan!.price.amountMicros).toBe(50_000);
    expect(plan!.price.amountUnits).toBeUndefined();
    expect(plan!.rateLimits[0].dimension).toBe("spend_micros");
    expect(plan!.rateLimits[0].capValue).toBe(1_000_000);
    expect(plan!.rateLimits[0]._microsScaled).toBeUndefined();

    const counter = await counters.findOne({});
    expect(counter!.dimension).toBe("spend_micros");
    expect(counter!.count).toBe(70_000); // 7 × 10,000
  });

  test("post: idempotent re-run does not re-scale counters", async () => {
    const db = handle.rawDb;
    const counters = db.collection("rate_limit_counters");
    const orgs = db.collection("organizations");
    await counters.deleteMany({});
    await orgs.deleteMany({});

    const orgId = new ObjectId();
    await orgs.insertOne({ _id: orgId, defaultCurrency: "USD" });
    await counters.insertOne({
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: new ObjectId(),
      dimension: "spend_units",
      windowSeconds: 3600,
      bucketStart: new Date(),
      count: 7,
    });

    await runPre();
    await runPost();
    await runPost(); // second run: dimension already spend_micros → no match

    const counter = await counters.findOne({});
    expect(counter!.dimension).toBe("spend_micros");
    expect(counter!.count).toBe(70_000); // not 7×10^8
  });
});
