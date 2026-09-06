import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { executeMigration } from "../runner.ts";
import type { MigrationFile } from "../types.ts";
import {
  startTestDb,
  stopTestDb,
  TEST_DB_START_TIMEOUT_MS,
  type TestDbHandle,
} from "../../test-support/memory-server.ts";

/**
 * Integration test for the migration runner's transaction guarantee.
 *
 * Runs against the shared in-memory MongoDB replica set (transactions need a
 * RS). It uses a *dedicated* test database (tokenpanel_migrator_it) and drops
 * it on cleanup — it never touches the real `tokenpanel` database.
 */
const TEST_DB = "tokenpanel_migrator_it";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: TEST_DB });
  // Clean slate for an isolated run.
  await handle.client.db(TEST_DB).dropDatabase().catch(() => {});
}, TEST_DB_START_TIMEOUT_MS);

afterAll(async () => {
  if (handle) {
    await handle.client.db(TEST_DB).dropDatabase().catch(() => {});
  }
  await stopTestDb();
});

describe("executeMigration transactional rollback", () => {
  const MIGRATIONS = "_migrations";

  test("data write AND _migrations record both roll back when up() throws", async () => {
    const db = handle.rawDb;
    const coll = "rollback_throw";
    const migId = `it-rollback-throw-${Date.now()}`;

    const m: MigrationFile = {
      id: migId,
      phase: "pre",
      checksum: "checksum-throw",
      transactional: true,
      up: async (mdb) => {
        await mdb.collection(coll).insertOne({ value: 1 });
        throw new Error("intentional migration failure");
      },
    };

    await expect(executeMigration(handle.client, db, m)).rejects.toThrow("intentional migration failure");

    // The session-bound insert must have rolled back with the transaction.
    const dataCount = await db.collection(coll).countDocuments();
    expect(dataCount).toBe(0);

    // The _migrations record must NOT exist (it was in the same transaction).
    const record = await db.collection<{ _id: string }>(MIGRATIONS).findOne({ _id: migId });
    expect(record).toBeNull();
  });

  test("data write AND _migrations record both commit when up() succeeds", async () => {
    const db = handle.rawDb;
    const coll = "rollback_success";
    const migId = `it-rollback-success-${Date.now()}`;

    const m: MigrationFile = {
      id: migId,
      phase: "pre",
      checksum: "checksum-success",
      transactional: true,
      up: async (mdb) => {
        await mdb.collection(coll).insertOne({ value: 42 });
      },
    };

    await executeMigration(handle.client, db, m);

    const dataCount = await db.collection(coll).countDocuments();
    expect(dataCount).toBe(1);

    const record = await db.collection<{ _id: string; checksum?: string }>(MIGRATIONS).findOne({ _id: migId });
    expect(record).not.toBeNull();
    expect(record?.checksum).toBe("checksum-success");
  });

  test("a write WITHOUT { session } escapes the transaction (documents the foot-gun the wrapper prevents)", async () => {
    const db = handle.rawDb;
    const coll = "footgun_demo";

    // This mimics what a migration COULD do before the MigrationDb wrapper:
    // a raw, un-sessioned write inside withTransaction. It autocommits outside
    // the txn, so even though the txn aborts, the write persists. The
    // MigrationDb wrapper removes this code path entirely.
    await handle.client.withSession(async (session) => {
      await expect(
        session.withTransaction(async () => {
          await db.collection(coll).insertOne({ value: 1 }); // no { session }
          throw new Error("abort txn");
        }),
      ).rejects.toThrow("abort txn");
    });

    // The un-sessioned write survived the aborted transaction.
    const dataCount = await db.collection(coll).countDocuments();
    expect(dataCount).toBe(1);

    // Clean up the leaked document.
    await db.collection(coll).deleteMany({});
  });
});
