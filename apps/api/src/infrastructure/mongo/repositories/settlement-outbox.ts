/**
 * Settlement outbox repository (validated decode on every boundary).
 * Full claim / renew / fence lifecycle for workers (task 14.2).
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  SettlementOutboxDoc,
  SettlementOutboxUpdateInput,
  type SettlementOutboxDoc as SettlementOutboxDocT,
  type SettlementOutboxUpdateInput as SettlementOutboxUpdateInputT,
} from "@tokenpanel/db/schemas/effect";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import {
  decodeDocuments,
  decodeOptionalDocument,
  decodeWriteInput,
} from "../decode.ts";
import {
  tryMongo,
  toMongoDoc,
  toMongoUpdate,
  type MongoFailure,
} from "../try-mongo.ts";
import {
  classifyMongoError,
  type PersistenceDataError,
} from "../../../errors/index.ts";
import { isDuplicateKeyError } from "../../../lib/crypto.ts";

const COLL = collections.settlementOutbox;

export type OutboxClaimFence = {
  readonly attempts: number;
  readonly claimToken: string;
};

export type SettlementOutboxRepoService = {
  readonly findById: (
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    SettlementOutboxDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly findByGatewayRequestId: (
    gatewayRequestId: string,
    session?: ClientSession,
  ) => Effect.Effect<
    SettlementOutboxDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly insert: (
    doc: SettlementOutboxDocT,
    session?: ClientSession,
  ) => Effect.Effect<
    SettlementOutboxDocT,
    MongoFailure | PersistenceDataError
  >;

  /**
   * Idempotent enqueue: insert, or return existing id on gatewayRequestId race.
   */
  readonly insertOrGetByGatewayRequestId: (
    doc: SettlementOutboxDocT,
  ) => Effect.Effect<ObjectId, MongoFailure | PersistenceDataError>;

  readonly listDueCandidates: (
    limit: number,
    now: Date,
    session?: ClientSession,
  ) => Effect.Effect<
    readonly SettlementOutboxDocT[],
    MongoFailure | PersistenceDataError
  >;

  readonly updateById: (
    id: ObjectId,
    patch: SettlementOutboxUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<
    SettlementOutboxDocT | null,
    MongoFailure | PersistenceDataError
  >;

  /**
   * Atomic claim: match status + lease + attempts, set in_progress + claimToken.
   * Returns decoded row or null if lost race.
   */
  readonly claimOne: (
    id: ObjectId,
    expectedStatus:
      | "pending"
      | "in_progress"
      | "reconciled"
      | "failed"
      | "abandoned",
    expectedAttempts: number,
    set: {
      status: "in_progress";
      attempts: number;
      claimToken: string;
      nextAttemptAt: Date;
      claimedAt: Date;
      updatedAt: Date;
    },
    now: Date,
    session?: ClientSession,
  ) => Effect.Effect<
    SettlementOutboxDocT | null,
    MongoFailure | PersistenceDataError
  >;

  /**
   * Claim up to `limit` due rows with TOCTOU-safe lease re-check.
   */
  readonly claimDue: (
    limit: number,
    leaseMs: number,
    newClaimToken: () => string,
  ) => Effect.Effect<
    readonly SettlementOutboxDocT[],
    MongoFailure | PersistenceDataError
  >;

  readonly renewClaim: (
    id: ObjectId,
    claim: OutboxClaimFence,
    leaseUntil: Date,
  ) => Effect.Effect<boolean, MongoFailure>;

  readonly markReconciled: (
    id: ObjectId,
    claim: OutboxClaimFence,
  ) => Effect.Effect<boolean, MongoFailure>;

  readonly markFailed: (
    id: ObjectId,
    claim: OutboxClaimFence,
    error: string,
  ) => Effect.Effect<boolean, MongoFailure | PersistenceDataError>;

  readonly markAbandoned: (
    id: ObjectId,
    claim: OutboxClaimFence,
    reason: string,
  ) => Effect.Effect<boolean, MongoFailure | PersistenceDataError>;

  readonly releaseAfterFailure: (
    id: ObjectId,
    claim: OutboxClaimFence,
    error: string,
    nextAttemptAt: Date,
  ) => Effect.Effect<boolean, MongoFailure | PersistenceDataError>;
};

export class SettlementOutboxRepo extends Context.Tag(
  "tokenpanel/SettlementOutboxRepo",
)<SettlementOutboxRepo, SettlementOutboxRepoService>() {}

function claimFilter(id: ObjectId, claim: OutboxClaimFence) {
  return {
    _id: id,
    status: "in_progress" as const,
    attempts: claim.attempts,
    claimToken: claim.claimToken,
  };
}

export const SettlementOutboxRepoLive: Layer.Layer<
  SettlementOutboxRepo,
  never,
  MongoDb
> = Layer.effect(
  SettlementOutboxRepo,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const col = () => mongo.db.settlementOutbox;

    const service: SettlementOutboxRepoService = {
      findById: (id, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            col().findOne({ _id: id }, session ? { session } : {}),
          );
          return yield* decodeOptionalDocument(SettlementOutboxDoc, raw, COLL);
        }),

      findByGatewayRequestId: (gatewayRequestId, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            col().findOne({ gatewayRequestId }, session ? { session } : {}),
          );
          return yield* decodeOptionalDocument(SettlementOutboxDoc, raw, COLL);
        }),

      insert: (doc, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(
            SettlementOutboxDoc,
            doc,
            COLL,
          );
          yield* tryMongo(() =>
            col().insertOne(toMongoDoc(validated), session ? { session } : {}),
          );
          return validated;
        }),

      insertOrGetByGatewayRequestId: (doc) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(
            SettlementOutboxDoc,
            doc,
            COLL,
          );
          const inserted = yield* Effect.tryPromise({
            try: () => col().insertOne(toMongoDoc(validated)),
            catch: (err) => err,
          }).pipe(
            Effect.map(() => ({ kind: "ok" as const, id: validated._id })),
            Effect.catchAll((err) => {
              if (!isDuplicateKeyError(err)) {
                return Effect.fail(classifyMongoError(err));
              }
              return Effect.succeed({ kind: "dup" as const });
            }),
          );
          if (inserted.kind === "ok") return inserted.id;
          const existing = yield* tryMongo(() =>
            col().findOne({ gatewayRequestId: validated.gatewayRequestId }),
          );
          if (existing?._id) return existing._id as ObjectId;
          return validated._id;
        }),

      listDueCandidates: (limit, now, session) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            col()
              .find(
                {
                  status: { $in: ["pending", "in_progress"] },
                  $or: [
                    { nextAttemptAt: { $lte: now } },
                    { nextAttemptAt: { $exists: false } },
                  ],
                },
                session ? { session } : {},
              )
              .sort({ nextAttemptAt: 1, createdAt: 1 })
              .limit(limit)
              .toArray(),
          );
          return yield* decodeDocuments(SettlementOutboxDoc, raws, COLL);
        }),

      updateById: (id, patch, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(
            SettlementOutboxUpdateInput,
            patch,
            COLL,
          );
          const now = new Date();
          const raw = yield* tryMongo(() =>
            col().findOneAndUpdate(
              { _id: id },
              toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
              { returnDocument: "after", ...(session ? { session } : {}) },
            ),
          );
          return yield* decodeOptionalDocument(SettlementOutboxDoc, raw, COLL);
        }),

      claimOne: (id, expectedStatus, expectedAttempts, set, now, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            col().findOneAndUpdate(
              {
                _id: id,
                status: expectedStatus,
                attempts: expectedAttempts,
                $or: [
                  { nextAttemptAt: { $lte: now } },
                  { nextAttemptAt: { $exists: false } },
                ],
              },
              toMongoUpdate({ $set: set }),
              { returnDocument: "after", ...(session ? { session } : {}) },
            ),
          );
          return yield* decodeOptionalDocument(SettlementOutboxDoc, raw, COLL);
        }),

      claimDue: (limit, leaseMs, newClaimToken) =>
        Effect.gen(function* () {
          const now = new Date();
          const leaseUntil = new Date(now.getTime() + leaseMs);
          const claimed: SettlementOutboxDocT[] = [];

          const candidates = yield* tryMongo(() =>
            col()
              .find({
                status: { $in: ["pending", "in_progress"] },
                $or: [
                  { nextAttemptAt: { $lte: now } },
                  { nextAttemptAt: { $exists: false } },
                ],
              })
              .sort({ nextAttemptAt: 1, createdAt: 1 })
              .limit(limit * 3)
              .toArray(),
          );

          for (const row of candidates) {
            if (claimed.length >= limit) break;
            const nextAttempts = (row.attempts ?? 0) + 1;
            const claimToken = newClaimToken();
            const raw = yield* tryMongo(() =>
              col().findOneAndUpdate(
                {
                  _id: row._id,
                  status: row.status,
                  attempts: row.attempts ?? 0,
                  $or: [
                    { nextAttemptAt: { $lte: now } },
                    { nextAttemptAt: { $exists: false } },
                  ],
                },
                toMongoUpdate({
                  $set: {
                    status: "in_progress",
                    attempts: nextAttempts,
                    claimToken,
                    claimedAt: now,
                    nextAttemptAt: leaseUntil,
                    updatedAt: now,
                  },
                }),
                { returnDocument: "after" },
              ),
            );
            if (raw) {
              const decoded = yield* decodeOptionalDocument(
                SettlementOutboxDoc,
                raw,
                COLL,
              );
              if (decoded) claimed.push(decoded);
            }
          }
          return claimed;
        }),

      renewClaim: (id, claim, leaseUntil) =>
        Effect.gen(function* () {
          const now = new Date();
          const res = yield* tryMongo(() =>
            col().updateOne(claimFilter(id, claim), {
              $set: { nextAttemptAt: leaseUntil, updatedAt: now },
            }),
          );
          return res.matchedCount === 1;
        }),

      markReconciled: (id, claim) =>
        Effect.gen(function* () {
          const now = new Date();
          const res = yield* tryMongo(() =>
            col().updateOne(claimFilter(id, claim), {
              $set: { status: "reconciled", updatedAt: now },
              $unset: { claimedAt: "", claimToken: "" },
            }),
          );
          return res.matchedCount === 1;
        }),

      markFailed: (id, claim, error) =>
        Effect.gen(function* () {
          const now = new Date();
          const raw = yield* tryMongo(() =>
            col().findOne(claimFilter(id, claim)),
          );
          if (!raw) return false;
          const row = yield* decodeOptionalDocument(
            SettlementOutboxDoc,
            raw,
            COLL,
          );
          if (!row) return false;
          const res = yield* tryMongo(() =>
            col().updateOne(claimFilter(id, claim), {
              $set: {
                status: "failed",
                updatedAt: now,
                context: {
                  ...(row.context ?? {}),
                  lastError: error.slice(0, 500),
                },
              },
              $unset: { claimedAt: "", claimToken: "" },
            }),
          );
          return res.matchedCount === 1;
        }),

      markAbandoned: (id, claim, reason) =>
        Effect.gen(function* () {
          const now = new Date();
          const raw = yield* tryMongo(() =>
            col().findOne(claimFilter(id, claim)),
          );
          if (!raw) return false;
          const row = yield* decodeOptionalDocument(
            SettlementOutboxDoc,
            raw,
            COLL,
          );
          if (!row) return false;
          const res = yield* tryMongo(() =>
            col().updateOne(claimFilter(id, claim), {
              $set: {
                status: "abandoned",
                updatedAt: now,
                context: {
                  ...(row.context ?? {}),
                  abandonReason: reason.slice(0, 200),
                },
              },
              $unset: { claimedAt: "", claimToken: "" },
            }),
          );
          return res.matchedCount === 1;
        }),

      releaseAfterFailure: (id, claim, error, nextAttemptAt) =>
        Effect.gen(function* () {
          const now = new Date();
          const raw = yield* tryMongo(() =>
            col().findOne(claimFilter(id, claim)),
          );
          if (!raw) return false;
          const row = yield* decodeOptionalDocument(
            SettlementOutboxDoc,
            raw,
            COLL,
          );
          if (!row) return false;
          const res = yield* tryMongo(() =>
            col().updateOne(claimFilter(id, claim), {
              $set: {
                status: "pending",
                nextAttemptAt,
                updatedAt: now,
                context: {
                  ...(row.context ?? {}),
                  lastError: error.slice(0, 500),
                },
              },
              $unset: { claimedAt: "", claimToken: "" },
            }),
          );
          return res.matchedCount === 1;
        }),
    };

    return service;
  }),
);
