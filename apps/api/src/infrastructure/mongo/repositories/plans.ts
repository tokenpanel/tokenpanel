/**
 * Plans, subscriptions, customer limits, budgets repository.
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  SubscriptionPlanDoc,
  SubscriptionPlanUpdateInput,
  SubscriptionDoc,
  SubscriptionUpdateInput,
  CustomerLimitDoc,
  CustomerLimitUpdateInput,
  BudgetDoc,
  BudgetUpdateInput,
  type SubscriptionPlanDoc as SubscriptionPlanDocT,
  type SubscriptionPlanUpdateInput as SubscriptionPlanUpdateInputT,
  type SubscriptionDoc as SubscriptionDocT,
  type SubscriptionUpdateInput as SubscriptionUpdateInputT,
  type CustomerLimitDoc as CustomerLimitDocT,
  type CustomerLimitUpdateInput as CustomerLimitUpdateInputT,
  type BudgetDoc as BudgetDocT,
  type BudgetUpdateInput as BudgetUpdateInputT,
} from "@tokenpanel/db/schemas/effect";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import {
  decodeDocuments,
  decodeOptionalDocument,
  decodeWriteInput,
} from "../decode.ts";
import { normalizePage, type PageResult } from "../helpers.ts";
import { tryMongo, toMongoDoc, toMongoUpdate, type MongoFailure } from "../try-mongo.ts";
import type { PersistenceDataError } from "../../../errors/index.ts";

const PLANS = collections.subscriptionPlans;
const SUBS = collections.subscriptions;
const LIMITS = collections.customerLimits;
const BUDGETS = collections.budgets;

export type PlansRepoService = {
  readonly findPlanById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    SubscriptionPlanDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly listPlans: (
    organizationId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<
    PageResult<SubscriptionPlanDocT>,
    MongoFailure | PersistenceDataError
  >;

  readonly insertPlan: (
    doc: SubscriptionPlanDocT,
    session?: ClientSession,
  ) => Effect.Effect<
    SubscriptionPlanDocT,
    MongoFailure | PersistenceDataError
  >;

  readonly updatePlan: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: SubscriptionPlanUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<
    SubscriptionPlanDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly findSubscriptionById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    SubscriptionDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly listSubscriptionsByCustomer: (
    organizationId: ObjectId,
    customerId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<
    PageResult<SubscriptionDocT>,
    MongoFailure | PersistenceDataError
  >;

  readonly insertSubscription: (
    doc: SubscriptionDocT,
    session?: ClientSession,
  ) => Effect.Effect<SubscriptionDocT, MongoFailure | PersistenceDataError>;

  readonly updateSubscription: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: SubscriptionUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<
    SubscriptionDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly findCustomerLimit: (
    organizationId: ObjectId,
    customerId: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    CustomerLimitDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly insertCustomerLimit: (
    doc: CustomerLimitDocT,
    session?: ClientSession,
  ) => Effect.Effect<CustomerLimitDocT, MongoFailure | PersistenceDataError>;

  readonly updateCustomerLimit: (
    organizationId: ObjectId,
    customerId: ObjectId,
    patch: CustomerLimitUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<
    CustomerLimitDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly findBudgetById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<BudgetDocT | null, MongoFailure | PersistenceDataError>;

  readonly listBudgetsByCustomer: (
    organizationId: ObjectId,
    customerId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<PageResult<BudgetDocT>, MongoFailure | PersistenceDataError>;

  readonly insertBudget: (
    doc: BudgetDocT,
    session?: ClientSession,
  ) => Effect.Effect<BudgetDocT, MongoFailure | PersistenceDataError>;

  readonly updateBudget: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: BudgetUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<BudgetDocT | null, MongoFailure | PersistenceDataError>;

  /**
   * Customer-scoped (non-org) reads used by effective-rule resolution.
   * customerId is a globally-unique ObjectId so scoping by customer alone is
   * safe; these mirror the historical getEffectiveRules lookups exactly.
   */
  readonly findActiveSubscriptionByCustomer: (
    customerId: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    SubscriptionDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly findPlanByIdNoOrg: (
    planId: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    SubscriptionPlanDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly findCustomerLimitByCustomer: (
    customerId: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    CustomerLimitDocT | null,
    MongoFailure | PersistenceDataError
  >;
};

export class PlansRepo extends Context.Tag("tokenpanel/PlansRepo")<
  PlansRepo,
  PlansRepoService
>() {}

export const PlansRepoLive: Layer.Layer<PlansRepo, never, MongoDb> =
  Layer.effect(
    PlansRepo,
    Effect.gen(function* () {
      const mongo = yield* MongoDb;
      const plans = () => mongo.db.subscriptionPlans;
      const subs = () => mongo.db.subscriptions;
      const limits = () => mongo.db.customerLimits;
      const budgets = () => mongo.db.budgets;

      const service: PlansRepoService = {
        findPlanById: (organizationId, id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              plans().findOne(
                { _id: id, organizationId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(
              SubscriptionPlanDoc,
              raw,
              PLANS,
            );
          }),

        listPlans: (organizationId, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter = { organizationId };
            const [raws, total] = yield* tryMongo(async () => {
              const items = await plans()
                .find(filter, session ? { session } : {})
                .sort({ name: 1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await plans().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(
              SubscriptionPlanDoc,
              raws,
              PLANS,
            );
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insertPlan: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              SubscriptionPlanDoc,
              doc,
              PLANS,
            );
            yield* tryMongo(() =>
              plans().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        updatePlan: (organizationId, id, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              SubscriptionPlanUpdateInput,
              patch,
              PLANS,
            );
            const now = new Date();
            const raw = yield* tryMongo(() =>
              plans().findOneAndUpdate(
                { _id: id, organizationId },
                toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(
              SubscriptionPlanDoc,
              raw,
              PLANS,
            );
          }),

        findSubscriptionById: (organizationId, id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              subs().findOne(
                { _id: id, organizationId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(SubscriptionDoc, raw, SUBS);
          }),

        listSubscriptionsByCustomer: (
          organizationId,
          customerId,
          pageParams,
          session,
        ) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter = { organizationId, customerId };
            const [raws, total] = yield* tryMongo(async () => {
              const items = await subs()
                .find(filter, session ? { session } : {})
                .sort({ periodStart: -1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await subs().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(SubscriptionDoc, raws, SUBS);
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insertSubscription: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              SubscriptionDoc,
              doc,
              SUBS,
            );
            yield* tryMongo(() =>
              subs().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        updateSubscription: (organizationId, id, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              SubscriptionUpdateInput,
              patch,
              SUBS,
            );
            const now = new Date();
            const raw = yield* tryMongo(() =>
              subs().findOneAndUpdate(
                { _id: id, organizationId },
                toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(SubscriptionDoc, raw, SUBS);
          }),

        findCustomerLimit: (organizationId, customerId, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              limits().findOne(
                { organizationId, customerId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(CustomerLimitDoc, raw, LIMITS);
          }),

        insertCustomerLimit: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              CustomerLimitDoc,
              doc,
              LIMITS,
            );
            yield* tryMongo(() =>
              limits().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        updateCustomerLimit: (organizationId, customerId, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              CustomerLimitUpdateInput,
              patch,
              LIMITS,
            );
            const now = new Date();
            const raw = yield* tryMongo(() =>
              limits().findOneAndUpdate(
                { organizationId, customerId },
                toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(CustomerLimitDoc, raw, LIMITS);
          }),

        findBudgetById: (organizationId, id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              budgets().findOne(
                { _id: id, organizationId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(BudgetDoc, raw, BUDGETS);
          }),

        listBudgetsByCustomer: (
          organizationId,
          customerId,
          pageParams,
          session,
        ) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter = { organizationId, customerId };
            const [raws, total] = yield* tryMongo(async () => {
              const items = await budgets()
                .find(filter, session ? { session } : {})
                .sort({ periodStart: -1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await budgets().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(BudgetDoc, raws, BUDGETS);
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insertBudget: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(BudgetDoc, doc, BUDGETS);
            yield* tryMongo(() =>
              budgets().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        updateBudget: (organizationId, id, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              BudgetUpdateInput,
              patch,
              BUDGETS,
            );
            const now = new Date();
            const raw = yield* tryMongo(() =>
              budgets().findOneAndUpdate(
                { _id: id, organizationId },
                toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(BudgetDoc, raw, BUDGETS);
          }),

        findActiveSubscriptionByCustomer: (customerId, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              subs().findOne(
                { customerId, status: "active" },
                { sort: { periodEnd: -1 }, ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(SubscriptionDoc, raw, SUBS);
          }),

        findPlanByIdNoOrg: (planId, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              plans().findOne(
                { _id: planId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(
              SubscriptionPlanDoc,
              raw,
              PLANS,
            );
          }),

        findCustomerLimitByCustomer: (customerId, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              limits().findOne(
                { customerId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(
              CustomerLimitDoc,
              raw,
              LIMITS,
            );
          }),
      };

      return service;
    }),
  );
