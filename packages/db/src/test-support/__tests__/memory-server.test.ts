import { test, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import {
  TEST_DB_START_TIMEOUT_MS,
  startTestDb,
  stopTestDb,
  resetTestCollections,
  seedBasicDataset,
  type TestDbHandle,
  type SeededIds,
} from "../memory-server.ts";
import { FIXTURE_IDS } from "../persistence-fixtures.ts";

let handle: TestDbHandle;
let seeded: SeededIds;

beforeAll(async () => {
  handle = await startTestDb();
  seeded = await seedBasicDataset();
}, TEST_DB_START_TIMEOUT_MS);

test("startTestDb returns connected typed db, raw db and client", async () => {
  expect(handle.databaseName).toBe("tokenpanel_test");
  expect(handle.uri).toContain("mongodb://");

  // The client reaches the server: ping through the raw client, and read the
  // seeded organization through the typed accessor.
  const ping = await handle.client.db("admin").command({ ping: 1 });
  expect(ping.ok).toBe(1);

  const org = await handle.db.organizations.findOne({
    _id: new ObjectId(FIXTURE_IDS.org),
  });
  expect(org).not.toBeNull();
  expect(org?.name).toBe("Acme AI");
  expect(seeded.organizationId).toBe(FIXTURE_IDS.org);
});

test("seedBasicDataset seeds the canonical dataset in every collection", async () => {
  const counts = {
    organizations: await handle.db.organizations.countDocuments(),
    users: await handle.db.users.countDocuments(),
    customers: await handle.db.customers.countDocuments(),
    providers: await handle.db.providers.countDocuments(),
    modelCatalog: await handle.db.modelCatalog.countDocuments(),
    models: await handle.db.models.countDocuments(),
    apiKeys: await handle.db.apiKeys.countDocuments(),
  };
  expect(counts).toEqual({
    organizations: 1,
    users: 1,
    customers: 1,
    providers: 1,
    modelCatalog: 1,
    models: 1,
    apiKeys: 1,
  });

  const customer = await handle.db.customers.findOne({
    _id: new ObjectId(seeded.customerId),
  });
  // Seeded customer has a nonzero balance.
  expect(customer?.balance.amountMicros).toBe(100_000_000);
});

test("second startTestDb call returns the same memoized handle", async () => {
  const again = await startTestDb();
  expect(again).toBe(handle);
});

test("resetTestCollections empties named collections", async () => {
  await resetTestCollections("organizations", "customers");
  expect(await handle.db.organizations.countDocuments()).toBe(0);
  expect(await handle.db.customers.countDocuments()).toBe(0);
  // Untouched collections keep their documents.
  expect(await handle.db.users.countDocuments()).toBe(1);
});

afterAll(async () => {
  await resetTestCollections(
    "users",
    "providers",
    "modelCatalog",
    "models",
    "apiKeys",
  );
  await stopTestDb();
});
