import type { Db } from "mongodb";
import { MongoServerError } from "mongodb";
import { hostname } from "node:os";

const LOCK_COLLECTION = "_migration_lock";
const LOCK_DOC_ID = "lock";
const LOCK_TTL_SECONDS = 300;
const HEARTBEAT_INTERVAL_MS = 60_000;

interface LockDoc {
  _id: string;
  holder: string;
  expiresAt: Date;
  acquiredAt: Date;
}

async function ensureLockCollection(db: Db): Promise<void> {
  const existing = await db.listCollections({ name: LOCK_COLLECTION }).toArray();
  if (existing.length === 0) {
    await db.createCollection(LOCK_COLLECTION);
  }
  // The TTL index uses expireAfterSeconds: 0 for ABSOLUTE expiry: a lock
  // document is eligible for deletion the moment its `expiresAt` is in the
  // past. (Earlier versions used LOCK_TTL_SECONDS here, which stacked a 5-min
  // grace period on top of the already-future `expiresAt`, pushing real
  // cleanup to ~10 min. The acquire path's deleteMany is the primary cleaner;
  // this index is the crash-recovery backstop.)
  const indexes = await db.collection<LockDoc>(LOCK_COLLECTION).listIndexes().toArray();
  const ttlIndex = indexes.find((i) => i.name === "expiresAt_1");
  if (!ttlIndex) {
    await db.collection<LockDoc>(LOCK_COLLECTION).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
  } else if (ttlIndex.expireAfterSeconds !== 0) {
    // Converge older deployments that created the index with a 300s grace
    // period. The lock collection is transient (no domain data), so
    // dropping+recreating the index is safe. This runs before we insert our
    // own lock, so no lock is held by this process.
    await db.collection<LockDoc>(LOCK_COLLECTION).dropIndex("expiresAt_1");
    await db.collection<LockDoc>(LOCK_COLLECTION).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }
}

/**
 * Thrown when the migration lock is lost mid-run — the heartbeat renewal found
 * no matching lock document (expired via TTL or stolen by another process) or
 * could not reach MongoDB. The runner calls {@link LockHandle.assertAlive}
 * between migrations and aborts on this error so two runners never apply
 * migrations concurrently.
 */
export class LockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockLostError";
  }
}

export interface LockHandle {
  /** Unique identifier for this holder (`<hostname>-<pid>`). */
  readonly holder: string;
  /**
   * Throws {@link LockLostError} if the heartbeat detected the lock was lost.
   * Call between long-running migration steps so the runner aborts instead of
   * continuing without holding the lock.
   */
  assertAlive(): void;
  /**
   * Renew the lock's `expiresAt`. Called automatically by the heartbeat every
   * `heartbeatIntervalMs`; may also be called on demand. Throws
   * {@link LockLostError} if the lock was lost. No-op once released or lost.
   */
  renew(): Promise<void>;
  /**
   * Stop the heartbeat and release the lock (deletes the lock document,
   * best-effort). Safe to call multiple times.
   */
  release(): Promise<void>;
}

/**
 * Pure factory that wires a {@link LockHandle} around two DB operations:
 * `renewOp` returns the `matchedCount` of the conditional expiry update
 * (it must return `0` when the lock no longer belongs to this holder), and
 * `releaseOp` deletes the lock document.
 *
 * Extracted from {@link acquireLock} so the loss-detection / heartbeat state
 * machine is unit-testable without a live MongoDB.
 */
export function createLockHandle(
  holder: string,
  renewOp: () => Promise<number>,
  releaseOp: () => Promise<void>,
  opts?: { heartbeatIntervalMs?: number },
): LockHandle {
  let lostError: LockLostError | null = null;
  let released = false;
  let renewing = false;

  const renew = async (): Promise<void> => {
    if (released || renewing || lostError) return;
    renewing = true;
    try {
      const matched = await renewOp();
      // The lock may have been released while we were awaiting renewOp; in
      // that case ignore the result so we don't set a spurious lost error.
      if (released) return;
      if (matched === 0) {
        lostError = new LockLostError(
          "Migration lock was lost (expired or stolen by another process). " +
            "Aborting to prevent concurrent migrations.",
        );
      }
    } catch (e: unknown) {
      if (released) return;
      lostError = new LockLostError(
        "Migration lock renewal failed: " +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      renewing = false;
    }
    if (lostError) throw lostError;
  };

  const intervalMs = opts?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    // lostError is captured inside renew(); swallow the rejection so the
    // async interval callback never raises an unhandled rejection.
    void renew().catch(() => {});
  }, intervalMs);
  // Don't let the heartbeat timer alone keep the process alive after the
  // runner finishes; release() clears it promptly in any case.
  timer.unref();

  const assertAlive = (): void => {
    if (lostError) throw lostError;
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      await releaseOp();
    } catch {
      // Best-effort: if deletion fails, the TTL index reclaims the doc.
    }
  };

  return { holder, assertAlive, renew, release };
}

/**
 * Acquire the migration lock and start a heartbeat that keeps it alive for the
 * full duration of the run.
 *
 * The lock is a single document (`_id: "lock"`) in `_migration_lock` with a TTL
 * index (`expireAfterSeconds: 0`) on `expiresAt`, so a document is deleted the
 * moment its `expiresAt` is in the past. While held, a heartbeat renews
 * `expiresAt` to `now + {@link LOCK_TTL_SECONDS}` (5 min ahead) every
 * {@link HEARTBEAT_INTERVAL_MS} (60 s) via a conditional
 * `updateOne({ _id, holder })` — so a long-running migration can no longer
 * outlive the TTL and lose the lock to a second runner. If a renewal finds no
 * matching document (lock expired / stolen) or cannot reach MongoDB, the
 * handle becomes "lost"; call `handle.assertAlive()` between migrations to
 * abort on loss.
 *
 * Dead holders are still reclaimed by the TTL index: if a runner crashes, no
 * renewals happen and the lock auto-expires 5 minutes after the last renewal
 * (absolute expiry on `expiresAt`).
 *
 * @returns a {@link LockHandle}; call `assertAlive()` between steps and
 *   `release()` in a `finally` block.
 */
export async function acquireLock(
  db: Db,
  opts?: { heartbeatIntervalMs?: number },
): Promise<LockHandle> {
  await ensureLockCollection(db);

  const holder = `${hostname()}-${process.pid}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_SECONDS * 1000);

  // Opportunistically clear any expired lock documents before inserting, so a
  // crashed runner's stale lock (past its TTL) doesn't block the next run.
  await db.collection<LockDoc>(LOCK_COLLECTION).deleteMany({ expiresAt: { $lt: now } });

  try {
    await db.collection<LockDoc>(LOCK_COLLECTION).insertOne({
      _id: LOCK_DOC_ID,
      holder,
      expiresAt,
      acquiredAt: now,
    });
  } catch (e: unknown) {
    if (e instanceof MongoServerError && e.code === 11000) {
      throw new Error(
        "Migration lock is held by another process. " +
          "If no migration is running, the lock auto-expires within 5 minutes " +
          "(TTL on _migration_lock.expiresAt).",
      );
    }
    throw e;
  }

  const renewOp = async (): Promise<number> => {
    const newExpiry = new Date(Date.now() + LOCK_TTL_SECONDS * 1000);
    const res = await db.collection<LockDoc>(LOCK_COLLECTION).updateOne(
      { _id: LOCK_DOC_ID, holder },
      { $set: { expiresAt: newExpiry } },
    );
    return res.matchedCount;
  };

  const releaseOp = async (): Promise<void> => {
    await db.collection<LockDoc>(LOCK_COLLECTION).deleteOne({
      _id: LOCK_DOC_ID,
      holder,
    });
  };

  return createLockHandle(holder, renewOp, releaseOp, opts);
}
