/**
 * Integration tests for withMongoSession (infrastructure/mongo/session.ts)
 * against the in-memory replica set.
 *
 * Covered contract (source of truth: session.ts):
 * - transactional commit: a two-doc write is invisible mid-transaction and both
 *   docs are durable after the effect resolves.
 * - body failure: abortTransaction runs, NEITHER doc persists, and the ORIGINAL
 *   (non-Mongo) error is rethrown — not a classified failure from the abort path.
 * - UnknownTransactionCommitResult-labeled commit failure: the commit-retry loop
 *   retries the commit ONLY and succeeds when the subsequent commit passes. The
 *   release mongod binary has test commands disabled (configureFailPoint →
 *   CommandNotFound), so the one-shot failing op is injected at the MongoDb
 *   client seam the module consumes: a Proxy around client.startSession() whose
 *   first commitTransaction throws a server-shaped labeled error while every
 *   later call delegates to the REAL session (real driver commit, real durability).
 *   session.ts internals run untouched — only the driver boundary is controlled.
 * - non-transactional passthrough: session bound, no txn semantics, writes are
 *   immediately visible and survive a body failure (no abort).
 * - session cleanup stability: 50 sequential mixed runs end every acquired session.
 *
 * Harness: @tokenpanel/db/test-support/memory-server (single-node MongoMemoryReplSet).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  MongoErrorLabel,
  MongoServerError,
  type ClientSession,
  type MongoClient,
} from "mongodb";
import {
  TEST_DB_START_TIMEOUT_MS,
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "@tokenpanel/db/test-support/memory-server";
import { withMongoSession } from "../mongo/session.ts";
import { MongoDb, type MongoDbService } from "../../runtime/services/mongo-db.ts";

const TEST_DB = "tokenpanel_session_test";
const COLL_A = "session_probe_a";
const COLL_B = "session_probe_b";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: TEST_DB });
}, TEST_DB_START_TIMEOUT_MS);
afterAll(stopTestDb);

beforeEach(async () => {
  await handle.rawDb.collection(COLL_A).deleteMany({});
  await handle.rawDb.collection(COLL_B).deleteMany({});
});

/** MongoDb service layer backed by the live harness handle (optionally a wrapped client). */
function mongoLayer(client?: MongoClient): Layer.Layer<MongoDb> {
  const svc: MongoDbService = {
    db: handle.db,
    client: client ?? handle.client,
    rawDb: handle.rawDb,
    close: async () => undefined,
  };
  return Layer.succeed(MongoDb, svc);
}

type SessionEffect<A, E> = Effect.Effect<A, E, MongoDb>;

async function runOk<A, E>(effect: SessionEffect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(Effect.provide(effect, mongoLayer()));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

function runExit<A, E>(effect: SessionEffect<A, E>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(Effect.provide(effect, mongoLayer()));
}

function insertDoc(
  coll: string,
  n: number,
  session: ClientSession,
): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const res = await handle.rawDb.collection(coll).insertOne({ n }, { session });
      return res.insertedId.toHexString();
    },
    catch: (err) => err as Error,
  });
}

function countDocs(coll: string): Effect.Effect<number, Error> {
  return Effect.tryPromise({
    try: () => handle.rawDb.collection(coll).countDocuments({}),
    catch: (err) => err as Error,
  });
}

describe("withMongoSession (live replica set)", () => {
  test("commit: two-doc write invisible mid-transaction, both docs durable after", async () => {
    const observed = await runOk(
      withMongoSession((session) =>
        Effect.gen(function* () {
          yield* insertDoc(COLL_A, 1, session);
          yield* insertDoc(COLL_B, 2, session);
          // Mid-transaction snapshot from OUTSIDE the session: nothing visible yet.
          const outsideA = yield* countDocs(COLL_A);
          const outsideB = yield* countDocs(COLL_B);
          // In-transaction read sees the write.
          const inTxnA = yield* Effect.tryPromise({
            try: () => handle.rawDb.collection(COLL_A).countDocuments({}, { session }),
            catch: (err) => err as Error,
          });
          return { outsideA, outsideB, inTxnA };
        }),
      ),
    );
    expect(observed.outsideA).toBe(0);
    expect(observed.outsideB).toBe(0);
    expect(observed.inTxnA).toBe(1);
    expect(await handle.rawDb.collection(COLL_A).countDocuments({})).toBe(1);
    expect(await handle.rawDb.collection(COLL_B).countDocuments({})).toBe(1);
  });

  test("body failure: neither doc persisted and ORIGINAL error rethrown (not abort error)", async () => {
    const boom = new Error("boom-body");
    const exit = await runExit(
      withMongoSession((session) =>
        Effect.gen(function* () {
          yield* insertDoc(COLL_A, 1, session);
          yield* insertDoc(COLL_B, 2, session);
          return yield* Effect.fail(boom);
        }),
      ),
    );
    if (Exit.isSuccess(exit)) throw new Error("expected withMongoSession to fail");
    // Exact original instance: the abort path produced no replacement failure.
    expect(Cause.squash(exit.cause)).toBe(boom);
    // Neither doc survived the abort.
    expect(await handle.rawDb.collection(COLL_A).countDocuments({})).toBe(0);
    expect(await handle.rawDb.collection(COLL_B).countDocuments({})).toBe(0);
  });

  test("UnknownTransactionCommitResult-labeled commit failure: commit-only retry succeeds", async () => {
    let commitCalls = 0;
    let startSessionCalls = 0;

    // One-shot failing op: first commitTransaction throws a server-shaped error
    // labeled UnknownTransactionCommitResult (non-retryable code, so the driver
    // does not auto-retry); every later call delegates to the REAL session.
    const wrapSession = (session: ClientSession): ClientSession =>
      new Proxy(session, {
        get(target, prop) {
          if (prop === "commitTransaction") {
            return async (
              ...args: Parameters<ClientSession["commitTransaction"]>
            ): Promise<void> => {
              commitCalls++;
              if (commitCalls === 1) {
                throw new MongoServerError({
                  message: "Interrupted during commit (simulated ambiguous outcome)",
                  code: 112,
                  errorLabels: [MongoErrorLabel.UnknownTransactionCommitResult],
                });
              }
              await target.commitTransaction(...args);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });

    const wrappedClient: MongoClient = new Proxy(handle.client, {
      get(target, prop) {
        if (prop === "startSession") {
          return (...args: Parameters<MongoClient["startSession"]>) => {
            startSessionCalls++;
            return wrapSession(target.startSession(...args));
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        withMongoSession((session) =>
          Effect.gen(function* () {
            yield* insertDoc(COLL_A, 1, session);
            yield* insertDoc(COLL_B, 2, session);
            return "committed";
          }),
        ),
        mongoLayer(wrappedClient),
      ),
    );

    // The labeled failure was swallowed by the commit-retry loop and the
    // subsequent (real) commit passed.
    expect(Exit.isSuccess(exit)).toBe(true);
    // Exactly two commit attempts: first labeled failure, second real success.
    expect(commitCalls).toBe(2);
    // One session acquired; cleanup was exact-once (no re-acquire).
    expect(startSessionCalls).toBe(1);
    // The retried commit durably persisted both docs.
    expect(await handle.rawDb.collection(COLL_A).countDocuments({})).toBe(1);
    expect(await handle.rawDb.collection(COLL_B).countDocuments({})).toBe(1);
  });

  test("non-transactional passthrough: writes immediately visible and survive body failure", async () => {
    let inTransaction: boolean | undefined;
    let midBodyCount = -1;
    const exit = await runExit(
      withMongoSession(
        (session) =>
          Effect.gen(function* () {
            inTransaction = session.inTransaction();
            yield* insertDoc(COLL_A, 1, session);
            // No transaction: the write is immediately visible outside the session.
            midBodyCount = yield* countDocs(COLL_A);
            return yield* Effect.fail(new Error("passthrough-boom"));
          }),
        { transactional: false },
      ),
    );
    if (Exit.isSuccess(exit)) throw new Error("expected non-transactional run to fail");
    const squashed = Cause.squash(exit.cause);
    expect((squashed as Error).message).toBe("passthrough-boom");
    expect(inTransaction).toBe(false);
    expect(midBodyCount).toBe(1);
    // Failure ran no abort: the non-transactional write remains.
    expect(await handle.rawDb.collection(COLL_A).countDocuments({})).toBe(1);
    expect(await handle.rawDb.collection(COLL_B).countDocuments({})).toBe(0);
  });

  test("session cleanup stability across 50 sequential runs (mixed success/failure)", async () => {
    const seen: ClientSession[] = [];
    for (let i = 0; i < 50; i++) {
      const shouldFail = i % 5 === 0;
      const exit = await runExit(
        withMongoSession((session) =>
          Effect.gen(function* () {
            seen.push(session);
            yield* insertDoc(COLL_A, i, session);
            if (shouldFail) return yield* Effect.fail(new Error(`loop-${i}`));
            return "ok";
          }),
        ),
      );
      if (shouldFail) {
        expect(Exit.isFailure(exit)).toBe(true);
      } else {
        expect(Exit.isSuccess(exit)).toBe(true);
      }
    }
    expect(seen).toHaveLength(50);
    // Every acquired session was ended by the acquireRelease finalizer.
    expect(seen.every((s) => s.hasEnded)).toBe(true);
    // 10 failed loops rolled back; 40 committed loops persisted.
    expect(await handle.rawDb.collection(COLL_A).countDocuments({})).toBe(40);
  });
});
