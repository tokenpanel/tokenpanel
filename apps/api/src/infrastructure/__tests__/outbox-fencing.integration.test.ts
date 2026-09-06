/**
 * Integration tests for the settlement-outbox fencing lifecycle against the
 * in-memory replica set (infrastructure/mongo/repositories/settlement-outbox.ts).
 *
 * Real Mongo semantics under test:
 *  - atomic findOneAndUpdate claims: each row claimed exactly once per lease,
 *    even under concurrent racers with different claim tokens;
 *  - lease (nextAttemptAt) exclusivity: a held lease blocks re-claim until it
 *    expires, expiry allows redelivery with a new token and attempts+1;
 *  - claim-token fencing on renew/settle/fail/abandon/release: a foreign or
 *    stale token is a rejected no-op, persisted state is untouched;
 *  - terminal states (reconciled/failed/abandoned) and not-yet-due rows are
 *    skipped by the claim sweep;
 *  - processed-at-most-once across claim -> settle -> reclaim.
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
import { Cause, Effect, Exit, Layer } from "effect";
import { ObjectId } from "mongodb";
import { getDb, getClient, getRawDb } from "@tokenpanel/db";
import type { SettlementOutboxDoc } from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  startTestDb,
  stopTestDb,
} from "@tokenpanel/db/test-support/memory-server";
import { settlementOutboxFixture } from "@tokenpanel/db/test-support/persistence-fixtures";
import type { AppServices } from "../../runtime/layers/live.ts";
import { MongoDb, type MongoDbService } from "../../runtime/services/mongo-db.ts";
import { ValidatedRepositoriesLive } from "../mongo/repositories/index.ts";
import {
  SettlementOutboxRepo,
  type OutboxClaimFence,
  type SettlementOutboxRepoService,
} from "../mongo/repositories/settlement-outbox.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
  getAppRuntime,
} from "../../runtime/app-runtime.ts";

const TEST_DB = "tokenpanel_outbox_fence_test";
const LEASE_MS = 300_000;

/**
 * Run a SettlementOutboxRepo effect on the ManagedRuntime and surface typed
 * failures (not FiberFailure) so persistence errors fail the test directly.
 */
async function run<A, E>(
  effect: Effect.Effect<A, E, SettlementOutboxRepo>,
): Promise<A> {
  const exit = await getAppRuntime().runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

async function resetData(): Promise<void> {
  await resetTestCollections("settlementOutbox");
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

let repo: SettlementOutboxRepoService;
let gatewaySeq = 0;

async function seedRow(
  over: Partial<SettlementOutboxDoc> = {},
): Promise<ObjectId> {
  gatewaySeq += 1;
  const doc = settlementOutboxFixture({
    _id: new ObjectId(),
    gatewayRequestId: `gw_fence_${gatewaySeq}`,
    ...over,
  });
  const db = await getDb();
  await db.settlementOutbox.insertOne(doc);
  return doc._id;
}

beforeAll(
  () => startTestDb({ databaseName: TEST_DB }),
  TEST_DB_START_TIMEOUT_MS,
);
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  await installRuntime();
  repo = await getAppRuntime().runPromise(SettlementOutboxRepo);
});

afterEach(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
  await resetData();
});

describe("settlement outbox fencing (live replica set)", () => {
  test("two sequential claims with different tokens claim each row exactly once", async () => {
    const idA = await seedRow();
    const idB = await seedRow();

    const first = await run(repo.claimDue(10, LEASE_MS, () => "tok-A"));
    expect(first.map((row) => row._id.toHexString()).sort()).toEqual(
      [idA.toHexString(), idB.toHexString()].sort(),
    );
    for (const row of first) {
      expect(row.status).toBe("in_progress");
      expect(row.attempts).toBe(1);
      expect(row.claimToken).toBe("tok-A");
      expect(row.claimedAt).toBeInstanceOf(Date);
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(
        Date.now() + LEASE_MS - 60_000,
      );
    }

    // Lease still held: the second token claims nothing (no double claim).
    const second = await run(repo.claimDue(10, LEASE_MS, () => "tok-B"));
    expect(second).toHaveLength(0);

    // Persisted rows still owned by tok-A with attempts unchanged.
    for (const id of [idA, idB]) {
      const row = await run(repo.findById(id));
      expect(row?.status).toBe("in_progress");
      expect(row?.attempts).toBe(1);
      expect(row?.claimToken).toBe("tok-A");
    }
  });

  test("concurrent claims with different tokens partition rows exactly once", async () => {
    const idA = await seedRow();
    const idB = await seedRow();

    const [racerA, racerB] = await Promise.all([
      run(repo.claimDue(10, LEASE_MS, () => "tok-A")),
      run(repo.claimDue(10, LEASE_MS, () => "tok-B")),
    ]);

    const idsA = racerA.map((row) => row._id.toHexString());
    const idsB = racerB.map((row) => row._id.toHexString());

    // Every seeded row claimed by exactly one racer; no duplicates, no losses.
    expect([...idsA, ...idsB].sort()).toEqual([idA.toHexString(), idB.toHexString()].sort());
    expect(idsA.filter((id) => idsB.includes(id))).toHaveLength(0);

    for (const row of racerA) {
      expect(row.claimToken).toBe("tok-A");
      expect(row.attempts).toBe(1);
      expect(row.status).toBe("in_progress");
    }
    for (const row of racerB) {
      expect(row.claimToken).toBe("tok-B");
      expect(row.attempts).toBe(1);
      expect(row.status).toBe("in_progress");
    }
  });

  test("expired lease allows reclaim with a new token and bumped attempts", async () => {
    const id = await seedRow();

    const first = await run(repo.claimDue(10, LEASE_MS, () => "tok-A"));
    expect(first).toHaveLength(1);
    expect(first[0]!.claimToken).toBe("tok-A");
    expect(first[0]!.attempts).toBe(1);

    // Deterministic lease expiry: the claim gate is nextAttemptAt <= now, so
    // rewind the held lease into the past instead of waiting the wall clock.
    await run(
      repo.updateById(id, { nextAttemptAt: new Date(Date.now() - 1_000) }),
    );

    const second = await run(repo.claimDue(10, LEASE_MS, () => "tok-B"));
    expect(second.map((row) => row._id.toHexString())).toEqual([
      id.toHexString(),
    ]);
    expect(second[0]!.attempts).toBe(2);
    expect(second[0]!.claimToken).toBe("tok-B");
    expect(second[0]!.status).toBe("in_progress");
  });

  test("renew extends leaseUntil only for the owning claim token", async () => {
    const id = await seedRow();
    const claimed = await run(repo.claimDue(1, LEASE_MS, () => "tok-A"));
    expect(claimed).toHaveLength(1);
    const owner: OutboxClaimFence = { attempts: 1, claimToken: "tok-A" };

    const extendedUntil = new Date(Date.now() + 600_000);
    expect(await run(repo.renewClaim(id, owner, extendedUntil))).toBe(true);
    let row = await run(repo.findById(id));
    expect(row?.nextAttemptAt?.getTime()).toBe(extendedUntil.getTime());

    // Foreign token: rejected no-op, lease untouched.
    expect(
      await run(
        repo.renewClaim(
          id,
          { attempts: 1, claimToken: "tok-B" },
          new Date(Date.now() + 900_000),
        ),
      ),
    ).toBe(false);
    // Stale attempts fence: rejected no-op even with the right token.
    expect(
      await run(
        repo.renewClaim(
          id,
          { attempts: 2, claimToken: "tok-A" },
          new Date(Date.now() + 900_000),
        ),
      ),
    ).toBe(false);

    row = await run(repo.findById(id));
    expect(row?.nextAttemptAt?.getTime()).toBe(extendedUntil.getTime());
  });

  test("markReconciled is fenced: foreign token no-op, owner token settles", async () => {
    const id = await seedRow();
    await run(repo.claimDue(1, LEASE_MS, () => "tok-A"));

    expect(
      await run(repo.markReconciled(id, { attempts: 1, claimToken: "tok-B" })),
    ).toBe(false);
    expect(
      await run(repo.markReconciled(id, { attempts: 2, claimToken: "tok-A" })),
    ).toBe(false);

    let row = await run(repo.findById(id));
    expect(row?.status).toBe("in_progress");
    expect(row?.claimToken).toBe("tok-A");

    expect(
      await run(repo.markReconciled(id, { attempts: 1, claimToken: "tok-A" })),
    ).toBe(true);

    row = await run(repo.findById(id));
    expect(row?.status).toBe("reconciled");
    expect(row?.claimToken).toBeUndefined();
    expect(row?.claimedAt).toBeUndefined();
    // The unset is real at the BSON layer, not just decode-defaulted.
    expect(
      await getRawDb()
        .collection("settlement_outbox")
        .countDocuments({ _id: id, claimToken: { $exists: true } }),
    ).toBe(0);
    expect(
      await getRawDb()
        .collection("settlement_outbox")
        .countDocuments({ _id: id, claimedAt: { $exists: true } }),
    ).toBe(0);
  });

  test("markFailed is fenced and records lastError while preserving context", async () => {
    const id = await seedRow(); // fixture context: { actorKind: 'customer_key', priceMicros: 100000 }
    await run(repo.claimDue(1, LEASE_MS, () => "tok-A"));

    expect(
      await run(repo.markFailed(id, { attempts: 1, claimToken: "tok-B" }, "upstream 500")),
    ).toBe(false);
    let row = await run(repo.findById(id));
    expect(row?.status).toBe("in_progress");
    expect(row?.context.lastError).toBeUndefined();
    expect(row?.claimToken).toBe("tok-A");

    expect(
      await run(repo.markFailed(id, { attempts: 1, claimToken: "tok-A" }, "upstream 500")),
    ).toBe(true);

    row = await run(repo.findById(id));
    expect(row?.status).toBe("failed");
    expect(row?.context.lastError).toBe("upstream 500");
    expect(row?.context.actorKind).toBe("customer_key");
    expect(row?.claimToken).toBeUndefined();
    expect(row?.claimedAt).toBeUndefined();
  });

  test("markFailed truncates oversized error messages to 500 characters", async () => {
    const id = await seedRow();
    await run(repo.claimDue(1, LEASE_MS, () => "tok-A"));

    expect(
      await run(repo.markFailed(id, { attempts: 1, claimToken: "tok-A" }, "x".repeat(600))),
    ).toBe(true);

    const row = await run(repo.findById(id));
    expect(row?.context.lastError).toBe("x".repeat(500));
  });

  test("markAbandoned is fenced and records the abandon reason", async () => {
    const id = await seedRow();
    await run(repo.claimDue(1, LEASE_MS, () => "tok-A"));

    expect(
      await run(repo.markAbandoned(id, { attempts: 1, claimToken: "tok-B" }, "why")),
    ).toBe(false);
    let row = await run(repo.findById(id));
    expect(row?.status).toBe("in_progress");

    expect(
      await run(repo.markAbandoned(id, { attempts: 1, claimToken: "tok-A" }, "why")),
    ).toBe(true);

    row = await run(repo.findById(id));
    expect(row?.status).toBe("abandoned");
    expect(row?.context.abandonReason).toBe("why");
    expect(row?.claimToken).toBeUndefined();
  });

  test("claim skips abandoned (max-attempts), reconciled, failed, and not-yet-due rows", async () => {
    // Abandoned via the real repo flow: a row at the attempts ceiling is
    // claimed once more (attempts 19 -> 20), then abandoned by its owner —
    // the state the worker leaves after exceeding max attempts.
    const maxedId = await seedRow({ attempts: 19 });
    const claimed = await run(repo.claimDue(10, LEASE_MS, () => "tok-A"));
    expect(claimed.map((row) => row._id.toHexString())).toEqual([maxedId.toHexString()]);
    expect(claimed[0]!.attempts).toBe(20);
    expect(
      await run(
        repo.markAbandoned(
          maxedId,
          { attempts: 20, claimToken: "tok-A" },
          "max_attempts: upstream 500",
        ),
      ),
    ).toBe(true);

    const reconciledId = await seedRow({ status: "reconciled" });
    const failedId = await seedRow({ status: "failed" });
    const futureId = await seedRow({
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    });

    const due = await run(repo.claimDue(10, LEASE_MS, () => "tok-B"));
    expect(due).toHaveLength(0);

    for (const id of [maxedId, reconciledId, failedId, futureId]) {
      const row = await run(repo.findById(id));
      expect(row?.claimToken).toBeUndefined();
      expect(row?.claimedAt).toBeUndefined();
    }
    const future = await run(repo.findById(futureId));
    expect(future?.status).toBe("pending");
    expect(future?.attempts).toBe(0);
    const maxed = await run(repo.findById(maxedId));
    expect(maxed?.status).toBe("abandoned");
    expect(maxed?.context.abandonReason).toBe("max_attempts: upstream 500");
  });

  test("claim returns due rows with earliest nextAttemptAt first", async () => {
    const now = Date.now();
    const laterId = await seedRow({
      nextAttemptAt: new Date(now - 1_000),
      createdAt: new Date(now - 5_000),
    });
    const earlierId = await seedRow({
      nextAttemptAt: new Date(now - 60_000),
      createdAt: new Date(now - 1_000),
    });
    const missingId = await seedRow({});

    const due = await run(repo.claimDue(10, LEASE_MS, () => "tok-A"));
    const ids = due.map((row) => row._id.toHexString());
    expect(ids).toHaveLength(3);
    expect(ids).toContain(missingId.toHexString());
    expect(ids.indexOf(earlierId.toHexString())).toBeLessThan(ids.indexOf(laterId.toHexString()));
    for (const row of due) {
      expect(row.attempts).toBe(1);
      expect(row.status).toBe("in_progress");
    }
  });

  test("releaseAfterFailure parks row until backoff elapses, then claimOne reclaims", async () => {
    const id = await seedRow();
    await run(repo.claimDue(1, LEASE_MS, () => "tok-A"));

    const backoffUntil = new Date(Date.now() + 60_000);
    expect(
      await run(
        repo.releaseAfterFailure(
          id,
          { attempts: 1, claimToken: "tok-A" },
          "boom",
          backoffUntil,
        ),
      ),
    ).toBe(true);

    let row = await run(repo.findById(id));
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt?.getTime()).toBe(backoffUntil.getTime());
    expect(row?.context.lastError).toBe("boom");
    expect(row?.claimToken).toBeUndefined();
    expect(row?.claimedAt).toBeUndefined();

    // Released row keeps its attempts fence: the OLD token can no longer act.
    expect(
      await run(repo.markReconciled(id, { attempts: 1, claimToken: "tok-A" })),
    ).toBe(false);

    // Backoff in the future: the claim sweep does not pick it up yet.
    expect(await run(repo.claimDue(10, LEASE_MS, () => "tok-B"))).toHaveLength(0);

    // Wrong expected attempts loses the race atomically (returns null).
    const dueNow = new Date(backoffUntil.getTime() + 1);
    const lostRace = await run(
      repo.claimOne(
        id,
        "pending",
        2,
        {
          status: "in_progress",
          attempts: 3,
          claimToken: "tok-B",
          nextAttemptAt: new Date(dueNow.getTime() + LEASE_MS),
          claimedAt: dueNow,
          updatedAt: dueNow,
        },
        dueNow,
      ),
    );
    expect(lostRace).toBeNull();

    // Once due, a fenced atomic claimOne reclaims with a new token.
    const reclaimed = await run(
      repo.claimOne(
        id,
        "pending",
        1,
        {
          status: "in_progress",
          attempts: 2,
          claimToken: "tok-B",
          nextAttemptAt: new Date(dueNow.getTime() + LEASE_MS),
          claimedAt: dueNow,
          updatedAt: dueNow,
        },
        dueNow,
      ),
    );
    expect(reclaimed?.status).toBe("in_progress");
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.claimToken).toBe("tok-B");
  });

  test("processed at most once across claim -> settle -> reclaim", async () => {
    const id = await seedRow();

    const first = await run(repo.claimDue(10, LEASE_MS, () => "tok-A"));
    expect(first).toHaveLength(1);
    expect(
      await run(repo.markReconciled(id, { attempts: 1, claimToken: "tok-A" })),
    ).toBe(true);

    // Make the settled row overdue as well: even with an expired lease, the
    // terminal reconciled status keeps it out of every later claim sweep.
    await run(
      repo.updateById(id, { nextAttemptAt: new Date(Date.now() - 5_000) }),
    );

    expect(await run(repo.claimDue(10, LEASE_MS, () => "tok-B"))).toHaveLength(0);

    const row = await run(repo.findById(id));
    expect(row?.status).toBe("reconciled");
    expect(row?.attempts).toBe(1);
    expect(row?.claimToken).toBeUndefined();
  });
});
