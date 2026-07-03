import { test, describe, expect, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { executeMigration } from "../runner.ts";
import type { MigrationFile } from "../types.ts";

/**
 * Walk up from this test file to find the nearest `.env` (the monorepo root in
 * dev) and populate `process.env` for keys not already set. Bun only auto-loads
 * `.env` from the CWD, so a test run from `packages/db` wouldn't otherwise see
 * the root `.env`'s MONGO_USER/MONGO_PASS. In CI (no `.env`, no MongoDB) the
 * connectivity probe below fails and the suite is skipped.
 */
function loadRootEnvIfPresent(): void {
  let dir = import.meta.dir;
  for (let i = 0; i < 8; i++) {
    const envPath = join(dir, ".env");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadRootEnvIfPresent();

/**
 * Integration test for the migration runner's transaction guarantee.
 *
 * Requires a live MongoDB replica set (transactions need a RS). It connects to
 * a *dedicated* test database (tokenpanel_migrator_it) using MONGO_USER /
 * MONGO_PASS from the environment, and drops it on cleanup — it never touches
 * the real `tokenpanel` database. If no reachable, authenticated replica-set
 * MongoDB is available, the whole suite is skipped (see `describe.skipIf`).
 */
const TEST_DB = "tokenpanel_migrator_it";
const MONGO_USER = process.env.MONGO_USER;
const MONGO_PASS = process.env.MONGO_PASS;
const MONGO_HOST = process.env.MONGO_HOST ?? "localhost";
const MONGO_PORT = process.env.MONGO_PORT ?? "27017";

const uri = MONGO_USER
  ? `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASS ?? "")}@${MONGO_HOST}:${MONGO_PORT}/${TEST_DB}?authSource=admin&directConnection=true`
  : `mongodb://${MONGO_HOST}:${MONGO_PORT}/${TEST_DB}?directConnection=true`;

// Resolve connectivity at module load so describe.skipIf sees the real result.
let client: MongoClient | null = null;
let connected = false;
{
  let c: MongoClient | null = null;
  try {
    c = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    await c.connect();
    const hello = await c.db("admin").command({ hello: 1 });
    if (!hello?.isWritablePrimary) throw new Error("not writable primary");
    // Auth probe: hello/ping are permitted pre-auth, so use a command that
    // requires authentication to confirm the credentials actually work.
    await c.db(TEST_DB).command({ dbStats: 1 });
    // Clean slate for an isolated run.
    await c.db(TEST_DB).dropDatabase().catch(() => {});
    client = c;
    connected = true;
    c = null; // ownership transferred to `client`
  } catch {
    connected = false;
  } finally {
    if (c) await c.close().catch(() => {});
  }
}

afterAll(async () => {
  if (client) {
    await client.db(TEST_DB).dropDatabase().catch(() => {});
    await client.close().catch(() => {});
    client = null;
  }
});

describe.skipIf(!connected)("executeMigration transactional rollback", () => {
  const MIGRATIONS = "_migrations";

  test("data write AND _migrations record both roll back when up() throws", async () => {
    const db = client!.db(TEST_DB);
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

    await expect(executeMigration(client!, db, m)).rejects.toThrow("intentional migration failure");

    // The session-bound insert must have rolled back with the transaction.
    const dataCount = await db.collection(coll).countDocuments();
    expect(dataCount).toBe(0);

    // The _migrations record must NOT exist (it was in the same transaction).
    const record = await db.collection<{ _id: string }>(MIGRATIONS).findOne({ _id: migId });
    expect(record).toBeNull();
  });

  test("data write AND _migrations record both commit when up() succeeds", async () => {
    const db = client!.db(TEST_DB);
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

    await executeMigration(client!, db, m);

    const dataCount = await db.collection(coll).countDocuments();
    expect(dataCount).toBe(1);

    const record = await db.collection<{ _id: string; checksum?: string }>(MIGRATIONS).findOne({ _id: migId });
    expect(record).not.toBeNull();
    expect(record?.checksum).toBe("checksum-success");
  });

  test("a write WITHOUT { session } escapes the transaction (documents the foot-gun the wrapper prevents)", async () => {
    const db = client!.db(TEST_DB);
    const coll = "footgun_demo";

    // This mimics what a migration COULD do before the MigrationDb wrapper:
    // a raw, un-sessioned write inside withTransaction. It autocommits outside
    // the txn, so even though the txn aborts, the write persists. The
    // MigrationDb wrapper removes this code path entirely.
    await client!.withSession(async (session) => {
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
