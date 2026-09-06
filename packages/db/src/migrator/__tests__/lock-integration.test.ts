import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { hostname } from "node:os";
import { acquireLock, LockLostError } from "../lock.ts";
import {
  startTestDb,
  stopTestDb,
  TEST_DB_START_TIMEOUT_MS,
  type TestDbHandle,
} from "../../test-support/memory-server.ts";

/**
 * acquireLock against the in-memory MongoDB harness: lock document shape,
 * conflict on concurrent acquisition (duplicate-key path), TTL index
 * convergence, release/re-acquire, stale-lock reclaim, and the heartbeat
 * renewal / loss-detection behavior.
 */

const LOCK_COLLECTION = "_migration_lock";
/** Heartbeat interval that never fires during a test (1e9 < 2^31). */
const NO_AUTO_HEARTBEAT_MS = 1_000_000_000;
const FAST_HEARTBEAT_MS = 20;

interface LockDoc {
  _id: string;
  holder: string;
  expiresAt: Date;
  acquiredAt: Date;
}

type IndexSpec = { name: string; expireAfterSeconds?: number };

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: "migrator_lock_test" });
}, TEST_DB_START_TIMEOUT_MS);

afterEach(async () => {
  await handle.rawDb.collection<LockDoc>(LOCK_COLLECTION).deleteMany({});
});

afterAll(() => stopTestDb());

const locks = () => handle.rawDb.collection<LockDoc>(LOCK_COLLECTION);
const EXPECTED_HOLDER = `${hostname()}-${process.pid}`;

test("acquireLock writes the lock document, exposes the handle, and creates the TTL index", async () => {
  const lock = await acquireLock(handle.rawDb, { heartbeatIntervalMs: NO_AUTO_HEARTBEAT_MS });
  try {
    expect(lock.holder).toBe(EXPECTED_HOLDER);
    expect(typeof lock.renew).toBe("function");
    expect(typeof lock.release).toBe("function");
    expect(() => lock.assertAlive()).not.toThrow();

    const doc = await locks().findOne({ _id: "lock" });
    expect(doc).not.toBeNull();
    expect(doc?.holder).toBe(EXPECTED_HOLDER);
    expect(doc?.acquiredAt).toBeInstanceOf(Date);
    expect(doc?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const indexes = (await locks().listIndexes().toArray()) as IndexSpec[];
    const ttl = indexes.find((i) => i.name === "expiresAt_1");
    expect(ttl).toBeDefined();
    // Absolute expiry: a doc is reclaimable the moment expiresAt is past.
    expect(ttl?.expireAfterSeconds).toBe(0);
  } finally {
    await lock.release();
  }
  expect(await locks().findOne({ _id: "lock" })).toBeNull();
});

test("second acquire is refused while the lock is held (duplicate-key path)", async () => {
  const lock = await acquireLock(handle.rawDb);
  try {
    await expect(acquireLock(handle.rawDb)).rejects.toThrow(
      /Migration lock is held by another process/,
    );
    // The first holder still owns the document.
    expect((await locks().findOne({ _id: "lock" }))?.holder).toBe(EXPECTED_HOLDER);
  } finally {
    await lock.release();
  }
});

test("release deletes the lock document and immediate re-acquire succeeds", async () => {
  const first = await acquireLock(handle.rawDb);
  await first.release();
  expect(await locks().findOne({ _id: "lock" })).toBeNull();

  const second = await acquireLock(handle.rawDb);
  try {
    expect(second.holder).toBe(EXPECTED_HOLDER);
  } finally {
    await second.release();
  }
});

test("a stale expired lock from a crashed runner does not block acquisition", async () => {
  // Drop the TTL index first so mongod's TTL monitor cannot race this test;
  // acquireLock's own deleteMany({ expiresAt: { $lt: now } }) must be what
  // clears the stale document.
  await locks().dropIndex("expiresAt_1").catch(() => undefined);
  await locks().insertOne({
    _id: "lock",
    holder: "crashed-host-999",
    expiresAt: new Date(Date.now() - 60_000),
    acquiredAt: new Date(Date.now() - 360_000),
  });

  const lock = await acquireLock(handle.rawDb);
  try {
    const docs = await locks().find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.holder).toBe(EXPECTED_HOLDER);
  } finally {
    await lock.release();
  }
});

test("ensureLockCollection converges a legacy grace-period TTL index to absolute expiry", async () => {
  await locks().dropIndex("expiresAt_1").catch(() => undefined);
  await locks().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 300 });

  const lock = await acquireLock(handle.rawDb);
  try {
    const indexes = (await locks().listIndexes().toArray()) as IndexSpec[];
    const ttl = indexes.find((i) => i.name === "expiresAt_1");
    expect(ttl).toBeDefined();
    expect(ttl?.expireAfterSeconds).toBe(0);
  } finally {
    await lock.release();
  }
});

test("heartbeat renews expiresAt while the lock is held", async () => {
  const lock = await acquireLock(handle.rawDb, { heartbeatIntervalMs: FAST_HEARTBEAT_MS });
  try {
    const before = (await locks().findOne({ _id: "lock" }))?.expiresAt.getTime() ?? -1;
    expect(before).toBeGreaterThan(0);
    // The heartbeat's renews are fire-and-forget DB writes driven by a real
    // OS timer against real mongod — there is no exposed completion signal,
    // so (like lock.test.ts) we wait a fixed, generous window and assert
    // robustly: 20 ms interval → ~12 ticks in 250 ms; expect well over 2.
    const { promise: waited, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await waited;
    const after = (await locks().findOne({ _id: "lock" }))?.expiresAt.getTime() ?? -1;
    // Renewals push expiresAt forward past the acquire-time value, and the
    // lock stays alive (expiresAt still in the future).
    expect(after - before).toBeGreaterThan(100);
    expect(after).toBeGreaterThan(Date.now());
  } finally {
    await lock.release();
  }
  expect(await locks().findOne({ _id: "lock" })).toBeNull();
});

test("renew flags the lock lost once its document disappears", async () => {
  const lock = await acquireLock(handle.rawDb, { heartbeatIntervalMs: NO_AUTO_HEARTBEAT_MS });
  await locks().deleteOne({ _id: "lock" });
  await expect(lock.renew()).rejects.toBeInstanceOf(LockLostError);
  expect(() => lock.assertAlive()).toThrow(LockLostError);
  await lock.release();
});

test("renew and assertAlive are no-ops after release; release is idempotent", async () => {
  const lock = await acquireLock(handle.rawDb, { heartbeatIntervalMs: NO_AUTO_HEARTBEAT_MS });
  await lock.release();
  expect(await locks().findOne({ _id: "lock" })).toBeNull();

  // After release, renew is a no-op (no LockLostError even though the doc is
  // gone) and assertAlive stays clean.
  await expect(lock.renew()).resolves.toBeUndefined();
  expect(() => lock.assertAlive()).not.toThrow();
  await expect(lock.release()).resolves.toBeUndefined();
});
