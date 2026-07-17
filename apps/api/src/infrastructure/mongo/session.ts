/**
 * Scoped Mongo session / transaction helper (task 7.6).
 *
 * - acquire session → optional startTransaction → body → commit/abort → endSession
 * - endSession always runs (success, expected error, defect, interrupt)
 * - Transient labels classified via classifyMongoError
 * - NO automatic unsafe retry of non-idempotent work
 */
import { Effect } from "effect";
import type { ClientSession, TransactionOptions } from "mongodb";
import { MongoDb } from "../../runtime/services/mongo-db.ts";
import { classifyMongoError } from "../../errors/index.ts";
import type { MongoFailure } from "./try-mongo.ts";

export type WithSessionOptions = {
  /**
   * When true (default), startTransaction + commit/abort around body.
   * When false, only session is bound (multi-op causal consistency).
   */
  readonly transactional?: boolean | undefined;
  readonly transactionOptions?: TransactionOptions | undefined;
};

/**
 * Run `body` with a ClientSession. Cleanup is exact-once via acquireRelease.
 *
 * Does not retry TransientTransactionError / WriteConflict — callers that
 * need safe retry must do so explicitly with idempotent operations only.
 */
export function withMongoSession<A, E, R>(
  body: (session: ClientSession) => Effect.Effect<A, E, R>,
  options: WithSessionOptions = {},
): Effect.Effect<A, E | MongoFailure, R | MongoDb> {
  const transactional = options.transactional !== false;

  // Effect.scoped ensures endSession finalizer always runs.
  return Effect.scoped(
    Effect.gen(function* () {
      const mongo = yield* MongoDb;

      const session = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Promise.resolve(mongo.client.startSession()),
          catch: (err) => classifyMongoError(err),
        }),
        (s) =>
          Effect.promise(async () => {
            try {
              await s.endSession();
            } catch {
              // Best-effort cleanup; never mask original failure.
            }
          }),
      );

      if (!transactional) {
        return yield* body(session);
      }

      yield* Effect.tryPromise({
        try: async () => {
          session.startTransaction(options.transactionOptions);
        },
        catch: (err) => classifyMongoError(err),
      });

      const result = yield* body(session).pipe(
        Effect.matchEffect({
          onFailure: (err) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: async () => {
                  if (session.inTransaction()) {
                    await session.abortTransaction();
                  }
                },
                catch: (abortErr) => classifyMongoError(abortErr),
              }).pipe(
                // Prefer original body error over abort classification.
                Effect.catchAll(() => Effect.void),
              );
              return yield* Effect.fail(err);
            }),
          onSuccess: (value) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: async () => {
                  if (session.inTransaction()) {
                    await session.commitTransaction();
                  }
                },
                catch: (err) => classifyMongoError(err),
              });
              return value;
            }),
        }),
      );

      return result;
    }),
  );
}

/**
 * Abort helper for explicit mid-body rollback before rethrowing domain errors.
 * Safe to call when not in a transaction (no-op).
 */
export function abortSession(
  session: ClientSession,
): Effect.Effect<void, MongoFailure> {
  return Effect.tryPromise({
    try: async () => {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
    },
    catch: (err) => classifyMongoError(err),
  });
}
