/**
 * Customers + balance adjustments repository.
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  CustomerDoc,
  CustomerUpdateInput,
  BalanceAdjustmentDoc,
  type CustomerDoc as CustomerDocT,
  type CustomerUpdateInput as CustomerUpdateInputT,
  type BalanceAdjustmentDoc as BalanceAdjustmentDocT,
} from "@tokenpanel/db/schemas/effect";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import {
  decodeDocuments,
  decodeOptionalDocument,
  decodeWriteInput,
} from "../decode.ts";
import {
  buildSort,
  escapeRegExp,
  normalizePage,
  type PageResult,
} from "../helpers.ts";
import { tryMongo, toMongoDoc, toMongoUpdate, type MongoFailure } from "../try-mongo.ts";
import type { PersistenceDataError } from "../../../errors/index.ts";
import {
  amountGteExpr,
  availableGteExpr,
  balanceDualIncPipeline,
  reservedGteExpr,
} from "../balance-paths.ts";

const CUSTOMERS = collections.customers;
const ADJUSTMENTS = collections.balanceAdjustments;
const SORT_ALLOWED = ["createdAt", "updatedAt", "name"] as const;

export type CustomerListFilter = {
  readonly organizationId: ObjectId;
  readonly status?: "active" | "suspended" | "closed" | undefined;
  readonly q?: string | undefined;
};

export type CustomersRepoService = {
  readonly findById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<CustomerDocT | null, MongoFailure | PersistenceDataError>;

  readonly findByIdAnyOrg: (
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<CustomerDocT | null, MongoFailure | PersistenceDataError>;

  /** Org-scoped email lookup (management chat attribution). */
  readonly findByOrgEmail: (
    organizationId: ObjectId,
    email: string,
    session?: ClientSession,
  ) => Effect.Effect<CustomerDocT | null, MongoFailure | PersistenceDataError>;

  readonly list: (
    filter: CustomerListFilter,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<PageResult<CustomerDocT>, MongoFailure | PersistenceDataError>;

  readonly insert: (
    doc: CustomerDocT,
    session?: ClientSession,
  ) => Effect.Effect<CustomerDocT, MongoFailure | PersistenceDataError>;

  readonly updateById: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: CustomerUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<CustomerDocT | null, MongoFailure | PersistenceDataError>;

  readonly replace: (
    doc: CustomerDocT,
    session?: ClientSession,
  ) => Effect.Effect<CustomerDocT, MongoFailure | PersistenceDataError>;

  readonly insertAdjustment: (
    doc: BalanceAdjustmentDocT,
    session?: ClientSession,
  ) => Effect.Effect<
    BalanceAdjustmentDocT,
    MongoFailure | PersistenceDataError
  >;

  readonly listAdjustments: (
    organizationId: ObjectId,
    customerId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<
    PageResult<BalanceAdjustmentDocT>,
    MongoFailure | PersistenceDataError
  >;

  /** Atomic hold: available >= need → $inc reservedUnits. */
  readonly reserveBalance: (params: {
    readonly customerId: ObjectId;
    readonly organizationId: ObjectId;
    readonly needUnits: number;
    readonly currency: string;
    readonly session?: ClientSession;
  }) => Effect.Effect<
    { reserved: true; reservedUnits: number } | { reserved: false; reason: string },
    MongoFailure
  >;

  /** Release a prior hold without debiting. */
  readonly releaseReserved: (params: {
    readonly customerId: ObjectId;
    readonly organizationId: ObjectId;
    readonly reservedUnits: number;
    readonly session?: ClientSession;
  }) => Effect.Effect<boolean, MongoFailure>;

  /** Debit price + release reserved hold in one update. */
  readonly settleWithReservation: (params: {
    readonly customerId: ObjectId;
    readonly organizationId: ObjectId;
    readonly priceUnits: number;
    readonly reservedUnits: number;
    readonly currency: string;
    readonly session?: ClientSession;
  }) => Effect.Effect<boolean, MongoFailure>;

  /** Bare debit when no reservation hold exists: amountUnits $gte price → $inc. */
  readonly debitBalance: (params: {
    readonly customerId: ObjectId;
    readonly organizationId: ObjectId;
    readonly priceUnits: number;
    readonly currency: string;
    readonly session?: ClientSession;
  }) => Effect.Effect<boolean, MongoFailure>;
};

export class CustomersRepo extends Context.Tag("tokenpanel/CustomersRepo")<
  CustomersRepo,
  CustomersRepoService
>() {}

export const CustomersRepoLive: Layer.Layer<CustomersRepo, never, MongoDb> =
  Layer.effect(
    CustomersRepo,
    Effect.gen(function* () {
      const mongo = yield* MongoDb;
      const customers = () => mongo.db.customers;
      const adjustments = () => mongo.db.balanceAdjustments;

      const service: CustomersRepoService = {
        findById: (organizationId, id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              customers().findOne(
                { _id: id, organizationId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(CustomerDoc, raw, CUSTOMERS);
          }),

        findByIdAnyOrg: (id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              customers().findOne({ _id: id }, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(CustomerDoc, raw, CUSTOMERS);
          }),

        findByOrgEmail: (organizationId, email, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              customers().findOne(
                { organizationId, email },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(CustomerDoc, raw, CUSTOMERS);
          }),

        list: (filter, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const mongoFilter: Record<string, unknown> = {
              organizationId: filter.organizationId,
            };
            if (filter.status !== undefined) {
              mongoFilter.status = filter.status;
            }
            if (filter.q !== undefined && filter.q.length > 0) {
              mongoFilter.name = {
                $regex: escapeRegExp(filter.q),
                $options: "i",
              };
            }
            const [raws, total] = yield* tryMongo(async () => {
              const items = await customers()
                .find(mongoFilter, session ? { session } : {})
                .sort(buildSort(SORT_ALLOWED, undefined, { createdAt: -1 }))
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await customers().countDocuments(
                mongoFilter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(CustomerDoc, raws, CUSTOMERS);
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
              CustomerDoc,
              doc,
              CUSTOMERS,
            );
            yield* tryMongo(() =>
              customers().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        updateById: (organizationId, id, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              CustomerUpdateInput,
              patch,
              CUSTOMERS,
            );
            const now = new Date();
            const raw = yield* tryMongo(() =>
              customers().findOneAndUpdate(
                { _id: id, organizationId },
                toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(CustomerDoc, raw, CUSTOMERS);
          }),

        replace: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              CustomerDoc,
              doc,
              CUSTOMERS,
            );
            yield* tryMongo(() =>
              customers().replaceOne(
                { _id: validated._id },
                toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        insertAdjustment: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              BalanceAdjustmentDoc,
              doc,
              ADJUSTMENTS,
            );
            yield* tryMongo(() =>
              adjustments().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        listAdjustments: (organizationId, customerId, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter = { organizationId, customerId };
            const [raws, total] = yield* tryMongo(async () => {
              const items = await adjustments()
                .find(filter, session ? { session } : {})
                .sort({ occurredAt: -1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await adjustments().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(
              BalanceAdjustmentDoc,
              raws,
              ADJUSTMENTS,
            );
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        reserveBalance: (params) =>
          Effect.gen(function* () {
            if (params.needUnits <= 0) {
              return { reserved: true as const, reservedUnits: 0 };
            }
            const now = new Date();
            const result = yield* tryMongo(() =>
              customers().updateOne(
                {
                  _id: params.customerId,
                  organizationId: params.organizationId,
                  "balance.currency": params.currency,
                  status: { $ne: "closed" },
                  $expr: availableGteExpr(params.needUnits),
                },
                balanceDualIncPipeline({
                  reservedDelta: params.needUnits,
                  set: { updatedAt: now },
                }),
                params.session ? { session: params.session } : {},
              ),
            );
            if (result.matchedCount === 0) {
              return {
                reserved: false as const,
                reason: "insufficient_available",
              };
            }
            return {
              reserved: true as const,
              reservedUnits: params.needUnits,
            };
          }),

        releaseReserved: (params) =>
          Effect.gen(function* () {
            if (params.reservedUnits <= 0) return true;
            const now = new Date();
            const result = yield* tryMongo(() =>
              customers().updateOne(
                {
                  _id: params.customerId,
                  organizationId: params.organizationId,
                  $expr: reservedGteExpr(params.reservedUnits),
                },
                balanceDualIncPipeline({
                  reservedDelta: -params.reservedUnits,
                  set: { updatedAt: now },
                }),
                params.session ? { session: params.session } : {},
              ),
            );
            return result.matchedCount > 0;
          }),

        settleWithReservation: (params) =>
          Effect.gen(function* () {
            const now = new Date();
            const reserved = Math.max(0, params.reservedUnits);
            const price = Math.max(0, params.priceUnits);
            if (price === 0 && reserved === 0) return true;

            const filter: Record<string, unknown> = {
              _id: params.customerId,
              organizationId: params.organizationId,
              "balance.currency": params.currency,
              status: { $ne: "closed" },
            };
            const exprs: Record<string, unknown>[] = [];
            if (price > 0) exprs.push(amountGteExpr(price));
            if (reserved > 0) exprs.push(reservedGteExpr(reserved));
            if (exprs.length === 1) {
              filter.$expr = exprs[0];
            } else if (exprs.length > 1) {
              filter.$expr = { $and: exprs };
            }

            const result = yield* tryMongo(() =>
              customers().updateOne(
                filter,
                balanceDualIncPipeline({
                  amountDelta: price > 0 ? -price : 0,
                  reservedDelta: reserved > 0 ? -reserved : 0,
                  set: { updatedAt: now },
                }),
                params.session ? { session: params.session } : {},
              ),
            );
            return result.matchedCount > 0;
          }),

        debitBalance: (params) =>
          Effect.gen(function* () {
            if (params.priceUnits <= 0) return true;
            const now = new Date();
            const result = yield* tryMongo(() =>
              customers().updateOne(
                {
                  _id: params.customerId,
                  organizationId: params.organizationId,
                  "balance.currency": params.currency,
                  status: { $ne: "closed" },
                  $expr: amountGteExpr(params.priceUnits),
                },
                balanceDualIncPipeline({
                  amountDelta: -params.priceUnits,
                  set: { updatedAt: now },
                }),
                params.session ? { session: params.session } : {},
              ),
            );
            return result.matchedCount > 0;
          }),
      };

      return service;
    }),
  );
