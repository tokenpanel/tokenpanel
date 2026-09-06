import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { createMigrationDb } from "../migration-db.ts";
import { up } from "../../../migrations/pre/2026-07-29T20-44-40Z__backfill-entry-cost-price.ts";
import {
  startTestDb,
  stopTestDb,
  TEST_DB_START_TIMEOUT_MS,
  type TestDbHandle,
} from "../../test-support/memory-server.ts";

/**
 * Integration coverage for the entry cost/price/margin backfill migration.
 * Runs against the shared in-memory MongoDB replica set, in a dedicated test
 * database that is dropped on cleanup.
 */
const TEST_DB = "tokenpanel_backfill_it";

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

async function runMigration(): Promise<void> {
  const db = handle.rawDb;
  await handle.client.withSession(async (session) => {
    const mdb = createMigrationDb(db, session);
    await up(mdb);
  });
}

const orgId = new ObjectId();
const providerId = new ObjectId();
const modelId = new ObjectId();
const catalogId = new ObjectId();

const CATALOG_COST = {
  inputMicrosPerMillion: 1_000_000,   // $1/M
  outputMicrosPerMillion: 2_000_000,  // $2/M
  cacheReadMicrosPerMillion: 100_000, // $0.10/M
};

const MODEL_PRICE = {
  inputMicrosPerMillion: 1_500_000,   // $1.50/M
  outputMicrosPerMillion: 3_000_000,  // $3/M
};

async function seed(): Promise<void> {
  const db = handle.rawDb;
  await db.collection("model_catalog").insertOne({
    _id: catalogId,
    organizationId: orgId,
    providerId,
    upstreamModelId: "gpt-4o",
    displayName: "GPT-4o",
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: {},
    modalities: { input: ["text"], output: ["text"] },
    cost: CATALOG_COST,
    raw: {},
    discoveredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.collection("models").insertOne({
    _id: modelId,
    organizationId: orgId,
    aliasId: "gpt-4o",
    displayName: "GPT-4o",
    entries: [
      {
        id: "e1",
        providerId,
        upstreamModelId: "gpt-4o",
        priority: 0,
        active: true,
        // no cost, no price — the state left by the old UI
      },
    ],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: {},
    modalities: { input: ["text"], output: ["text"] },
    price: MODEL_PRICE,
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function getModel(): Promise<Record<string, any>> {
  return (await handle.rawDb.collection("models").findOne({ _id: modelId }))!;
}

describe("backfill-entry-cost-price", () => {
  test("backfills entry.cost from catalog, materializes price, derives margin", async () => {
    await seed();
    await runMigration();

    const model = await getModel();
    const entry = model.entries[0]!;

    // Cost copied from catalog.
    expect(entry.cost).toEqual(CATALOG_COST);
    // Price materialized from model.price.
    expect(entry.price).toEqual(MODEL_PRICE);
    // Margin derived: (1.5 − 1) / 1 × 10000 = 5000 bps.
    expect(model.marginBps).toBe(5000);
  });

  test("idempotent: re-run is a no-op", async () => {
    await runMigration();
    const model = await getModel();
    expect(model.entries[0]!.cost).toEqual(CATALOG_COST);
    expect(model.marginBps).toBe(5000);
  });

  test("skips entries that already have a cost", async () => {
    const db = handle.rawDb;
    const manualCost = { inputMicrosPerMillion: 999, outputMicrosPerMillion: 888 };
    await db.collection("models").updateOne(
      { _id: modelId },
      { $set: { "entries.0.cost": manualCost } },
    );
    await runMigration();
    const model = await getModel();
    // Manual cost preserved, not overwritten by catalog.
    expect(model.entries[0]!.cost).toEqual(manualCost);
  });

  test("does not overwrite a non-zero marginBps", async () => {
    const db = handle.rawDb;
    await db.collection("models").updateOne(
      { _id: modelId },
      { $set: { marginBps: 2000, "entries.0.cost": undefined } },
    );
    await runMigration();
    const model = await getModel();
    // Cost backfilled again (was cleared).
    expect(model.entries[0]!.cost).toEqual(CATALOG_COST);
    // Margin untouched — admin set it explicitly.
    expect(model.marginBps).toBe(2000);
  });

  test("no catalog match → entry left untouched", async () => {
    const db = handle.rawDb;
    const noMatchId = new ObjectId();
    await db.collection("models").insertOne({
      _id: noMatchId,
      organizationId: orgId,
      aliasId: "unknown-model",
      displayName: "Unknown",
      entries: [{ id: "e1", providerId, upstreamModelId: "no-such-model", priority: 0, active: true }],
      reasoning: false,
      toolCall: false,
      attachment: false,
      limits: {},
      modalities: { input: ["text"], output: ["text"] },
      price: MODEL_PRICE,
      marginBps: 0,
      currency: "USD",
      active: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await runMigration();
    const model = await db.collection("models").findOne({ _id: noMatchId });
    expect(model!.entries[0]!.cost).toBeUndefined();
    expect(model!.marginBps).toBe(0);
  });
});
