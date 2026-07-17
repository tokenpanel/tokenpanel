/**
 * Usage records + rate limit counters repository.
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  UsageRecordDoc,
  RateLimitCounterDoc,
  type UsageRecordDoc as UsageRecordDocT,
  type RateLimitCounterDoc as RateLimitCounterDocT,
} from "@tokenpanel/db/schemas/effect";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import {
  decodeDocuments,
  decodeOptionalDocument,
  decodeWriteInput,
} from "../decode.ts";
import { normalizePage, type PageResult } from "../helpers.ts";
import { tryMongo, toMongoDoc, type MongoFailure } from "../try-mongo.ts";
import type { PersistenceDataError } from "../../../errors/index.ts";

const USAGE = collections.usageRecords;
const COUNTERS = collections.rateLimitCounters;

export type UsageListFilter = {
  readonly organizationId: ObjectId;
  readonly customerId?: ObjectId | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
};

export type UsageRepoService = {
  readonly findById: (
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<UsageRecordDocT | null, MongoFailure | PersistenceDataError>;

  readonly findByGatewayRequestId: (
    gatewayRequestId: string,
    session?: ClientSession,
  ) => Effect.Effect<UsageRecordDocT | null, MongoFailure | PersistenceDataError>;

  readonly list: (
    filter: UsageListFilter,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<
    PageResult<UsageRecordDocT>,
    MongoFailure | PersistenceDataError
  >;

  readonly insert: (
    doc: UsageRecordDocT,
    session?: ClientSession,
  ) => Effect.Effect<UsageRecordDocT, MongoFailure | PersistenceDataError>;

  readonly findCounter: (
    organizationId: ObjectId,
    customerId: ObjectId,
    dimension: string,
    windowSeconds: number,
    bucketStart: Date,
    scopeTarget?: string | null,
    session?: ClientSession,
  ) => Effect.Effect<
    RateLimitCounterDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly insertCounter: (
    doc: RateLimitCounterDocT,
    session?: ClientSession,
  ) => Effect.Effect<
    RateLimitCounterDocT,
    MongoFailure | PersistenceDataError
  >;

  readonly replaceCounter: (
    doc: RateLimitCounterDocT,
    session?: ClientSession,
  ) => Effect.Effect<
    RateLimitCounterDocT,
    MongoFailure | PersistenceDataError
  >;

  /**
   * Find decoded counters in a rolling window for read-only rate-limit
   * evaluation (checkLimits). `scopeTarget` matches null for customer/plan
   * scoped rules. Full decode enforces the schema on every read.
   */
  readonly findWindowCounters: (
    filter: {
      readonly customerId: ObjectId;
      readonly dimension: string;
      readonly windowSeconds: number;
      readonly windowStart: Date;
      readonly scopeTarget: string | null;
    },
    session?: ClientSession,
  ) => Effect.Effect<
    readonly RateLimitCounterDocT[],
    MongoFailure | PersistenceDataError
  >;

  /**
   * Atomic upsert of one bucket per (dimension, window, scopeTarget).
   * Schema-decoded ownership of the rate-limit counter bulk write used by
   * settlement (recordUsage). No raw collection access leaks to callers.
   */
  readonly bulkUpsertCounters: (params: {
    readonly organizationId: ObjectId;
    readonly customerId: ObjectId;
    readonly session?: ClientSession;
    readonly entries: ReadonlyArray<{
      readonly dimension: string;
      readonly windowSeconds: number;
      readonly bucketStart: Date;
      readonly scopeTarget: string | null;
      readonly increment: number;
    }>;
  }) => Effect.Effect<void, MongoFailure>;
};

export class UsageRepo extends Context.Tag("tokenpanel/UsageRepo")<
  UsageRepo,
  UsageRepoService
>() {}

export const UsageRepoLive: Layer.Layer<UsageRepo, never, MongoDb> =
  Layer.effect(
    UsageRepo,
    Effect.gen(function* () {
      const mongo = yield* MongoDb;
      const usage = () => mongo.db.usageRecords;
      const counters = () => mongo.db.rateLimitCounters;

      const service: UsageRepoService = {
        findById: (id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              usage().findOne({ _id: id }, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(UsageRecordDoc, raw, USAGE);
          }),

        findByGatewayRequestId: (gatewayRequestId, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              usage().findOne(
                { gatewayRequestId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(UsageRecordDoc, raw, USAGE);
          }),

        list: (filter, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const mongoFilter: Record<string, unknown> = {
              organizationId: filter.organizationId,
            };
            if (filter.customerId !== undefined) {
              mongoFilter.customerId = filter.customerId;
            }
            if (filter.from !== undefined || filter.to !== undefined) {
              const range: Record<string, Date> = {};
              if (filter.from !== undefined) range.$gte = filter.from;
              if (filter.to !== undefined) range.$lte = filter.to;
              mongoFilter.occurredAt = range;
            }
            const [raws, total] = yield* tryMongo(async () => {
              const items = await usage()
                .find(mongoFilter, session ? { session } : {})
                .sort({ occurredAt: -1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await usage().countDocuments(
                mongoFilter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(UsageRecordDoc, raws, USAGE);
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insert: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              UsageRecordDoc,
              doc,
              USAGE,
            );
            yield* tryMongo(() =>
              usage().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        findCounter: (
          organizationId,
          customerId,
          dimension,
          windowSeconds,
          bucketStart,
          scopeTarget,
          session,
        ) =>
          Effect.gen(function* () {
            const filter: Record<string, unknown> = {
              organizationId,
              customerId,
              dimension,
              windowSeconds,
              bucketStart,
            };
            if (scopeTarget !== undefined) {
              filter.scopeTarget = scopeTarget;
            }
            const raw = yield* tryMongo(() =>
              counters().findOne(filter, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(
              RateLimitCounterDoc,
              raw,
              COUNTERS,
            );
          }),

        insertCounter: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              RateLimitCounterDoc,
              doc,
              COUNTERS,
            );
            yield* tryMongo(() =>
              counters().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        replaceCounter: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              RateLimitCounterDoc,
              doc,
              COUNTERS,
            );
            yield* tryMongo(() =>
              counters().replaceOne(
                { _id: validated._id },
                toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        findWindowCounters: (filter, session) =>
          Effect.gen(function* () {
            const mongoFilter: Record<string, unknown> = {
              customerId: filter.customerId,
              dimension: filter.dimension,
              windowSeconds: filter.windowSeconds,
              bucketStart: { $gte: filter.windowStart },
              scopeTarget: filter.scopeTarget,
            };
            const raws = yield* tryMongo(() =>
              counters()
                .find(mongoFilter, session ? { session } : {})
                .toArray(),
            );
            return yield* decodeDocuments(RateLimitCounterDoc, raws, COUNTERS);
          }),

        bulkUpsertCounters: (params) =>
          Effect.gen(function* () {
            if (params.entries.length === 0) return;
            const ops = params.entries.map((e) => ({
              updateOne: {
                filter: {
                  organizationId: params.organizationId,
                  customerId: params.customerId,
                  dimension: e.dimension,
                  windowSeconds: e.windowSeconds,
                  bucketStart: e.bucketStart,
                  scopeTarget: e.scopeTarget,
                },
                update: {
                  $setOnInsert: {
                    organizationId: params.organizationId,
                    customerId: params.customerId,
                    dimension: e.dimension,
                    windowSeconds: e.windowSeconds,
                    bucketStart: e.bucketStart,
                    scopeTarget: e.scopeTarget,
                  },
                  $inc: { count: e.increment },
                },
                upsert: true,
              },
            }));
            yield* tryMongo(() =>
              counters().bulkWrite(
                ops as never,
                params.session ? { session: params.session } : {},
              ),
            );
          }),
      };

      return service;
    }),
  );
