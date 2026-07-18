/**
 * Domain-port repository Layers with Effect Schema decode on every document
 * boundary (task 13.1). Uses typed collection properties only — never
 * collection("string"). Complements §7 ValidatedRepositoriesLive tags;
 * domain operations depend on these ports (HexId-oriented API).
 */
import { Effect, Layer } from "effect";
import type { Filter } from "mongodb";
import { ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import type {
  UserDoc,
  CustomerDoc,
  ApiKeyDoc,
  ManagementApiKeyDoc,
  InviteDoc,
  AdminSessionDoc,
  OrganizationDoc,
  ModelDoc,
  ProviderDoc,
  SubscriptionPlanDoc,
  SubscriptionDoc,
  BalanceAdjustmentDoc,
  CustomerLimitDoc,
  BudgetDoc,
  ModelCatalogDoc,
} from "@tokenpanel/db";
import {
  UserDoc as UserDocSchema,
  InviteDoc as InviteDocSchema,
  AdminSessionDoc as AdminSessionDocSchema,
  OrganizationDoc as OrganizationDocSchema,
  CustomerDoc as CustomerDocSchema,
  BalanceAdjustmentDoc as BalanceAdjustmentDocSchema,
  ProviderDoc as ProviderDocSchema,
  ModelDoc as ModelDocSchema,
  ModelCatalogDoc as ModelCatalogDocSchema,
  ApiKeyDoc as ApiKeyDocSchema,
  ManagementApiKeyDoc as ManagementApiKeyDocSchema,
  SubscriptionPlanDoc as SubscriptionPlanDocSchema,
  SubscriptionDoc as SubscriptionDocSchema,
  CustomerLimitDoc as CustomerLimitDocSchema,
  BudgetDoc as BudgetDocSchema,
} from "@tokenpanel/db/schemas/effect";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import { Clock } from "../../../runtime/services/clock.ts";
import { UserRepository } from "../../../domains/ports/user-repository.ts";
import { InviteRepository } from "../../../domains/ports/invite-repository.ts";
import { SessionRepository } from "../../../domains/ports/session-repository.ts";
import { OrganizationRepository } from "../../../domains/ports/organization-repository.ts";
import { CustomerRepository } from "../../../domains/ports/customer-repository.ts";
import { PlanRepository } from "../../../domains/ports/plan-repository.ts";
import { ModelRepository } from "../../../domains/ports/model-repository.ts";
import { ProviderRepository } from "../../../domains/ports/provider-repository.ts";
import { KeyRepository } from "../../../domains/ports/key-repository.ts";
import { UsageRepository } from "../../../domains/ports/usage-repository.ts";
import { tryMongo } from "./try-mongo.ts";
import { newObjectId, toObjectId } from "./object-id.ts";
import { readOne, readMany, writeOne } from "./decode-helpers.ts";
import { isDuplicateKeyError } from "../../../lib/crypto.ts";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cast decoded Schema.Type → domain MutableDeep doc types (shape-identical). */
function asDoc<T>(value: T): T {
  return value;
}

function decodeUser(raw: unknown | null) {
  return readOne(UserDocSchema, collections.users, raw).pipe(
    Effect.map((d) => asDoc(d as UserDoc | null)),
  );
}
function decodeUsers(raws: readonly unknown[]) {
  return readMany(UserDocSchema, collections.users, raws).pipe(
    Effect.map((d) => asDoc(d as readonly UserDoc[])),
  );
}
function decodeInvite(raw: unknown | null) {
  return readOne(InviteDocSchema, collections.invites, raw).pipe(
    Effect.map((d) => asDoc(d as InviteDoc | null)),
  );
}
function decodeInvites(raws: readonly unknown[]) {
  return readMany(InviteDocSchema, collections.invites, raws).pipe(
    Effect.map((d) => asDoc(d as readonly InviteDoc[])),
  );
}
function decodeAdminSession(raw: unknown | null) {
  return readOne(AdminSessionDocSchema, collections.adminSessions, raw).pipe(
    Effect.map((d) => asDoc(d as AdminSessionDoc | null)),
  );
}
function decodeOrg(raw: unknown | null) {
  return readOne(OrganizationDocSchema, collections.organizations, raw).pipe(
    Effect.map((d) => asDoc(d as OrganizationDoc | null)),
  );
}
function decodeOrgs(raws: readonly unknown[]) {
  return readMany(OrganizationDocSchema, collections.organizations, raws).pipe(
    Effect.map((d) => asDoc(d as readonly OrganizationDoc[])),
  );
}
function decodeCustomer(raw: unknown | null) {
  return readOne(CustomerDocSchema, collections.customers, raw).pipe(
    Effect.map((d) => asDoc(d as CustomerDoc | null)),
  );
}
function decodeCustomers(raws: readonly unknown[]) {
  return readMany(CustomerDocSchema, collections.customers, raws).pipe(
    Effect.map((d) => asDoc(d as readonly CustomerDoc[])),
  );
}
function decodeAdjustments(raws: readonly unknown[]) {
  return readMany(BalanceAdjustmentDocSchema, collections.balanceAdjustments, raws).pipe(
    Effect.map((d) => asDoc(d as readonly BalanceAdjustmentDoc[])),
  );
}
function decodeProvider(raw: unknown | null) {
  return readOne(ProviderDocSchema, collections.providers, raw).pipe(
    Effect.map((d) => asDoc(d as ProviderDoc | null)),
  );
}
function decodeProviders(raws: readonly unknown[]) {
  return readMany(ProviderDocSchema, collections.providers, raws).pipe(
    Effect.map((d) => asDoc(d as readonly ProviderDoc[])),
  );
}
function decodeModel(raw: unknown | null) {
  return readOne(ModelDocSchema, collections.models, raw).pipe(
    Effect.map((d) => asDoc(d as ModelDoc | null)),
  );
}
function decodeModels(raws: readonly unknown[]) {
  return readMany(ModelDocSchema, collections.models, raws).pipe(
    Effect.map((d) => asDoc(d as readonly ModelDoc[])),
  );
}
function decodeCatalog(raws: readonly unknown[]) {
  return readMany(ModelCatalogDocSchema, collections.modelCatalog, raws).pipe(
    Effect.map((d) => asDoc(d as unknown as readonly ModelCatalogDoc[])),
  );
}
function decodeApiKey(raw: unknown | null) {
  return readOne(ApiKeyDocSchema, collections.apiKeys, raw).pipe(
    Effect.map((d) => asDoc(d as ApiKeyDoc | null)),
  );
}
function decodeApiKeys(raws: readonly unknown[]) {
  return readMany(ApiKeyDocSchema, collections.apiKeys, raws).pipe(
    Effect.map((d) => asDoc(d as readonly ApiKeyDoc[])),
  );
}
function decodeMgmtKey(raw: unknown | null) {
  return readOne(ManagementApiKeyDocSchema, collections.managementApiKeys, raw).pipe(
    Effect.map((d) => asDoc(d as ManagementApiKeyDoc | null)),
  );
}
function decodeMgmtKeys(raws: readonly unknown[]) {
  return readMany(ManagementApiKeyDocSchema, collections.managementApiKeys, raws).pipe(
    Effect.map((d) => asDoc(d as readonly ManagementApiKeyDoc[])),
  );
}
function decodePlan(raw: unknown | null) {
  return readOne(SubscriptionPlanDocSchema, collections.subscriptionPlans, raw).pipe(
    Effect.map((d) => asDoc(d as SubscriptionPlanDoc | null)),
  );
}
function decodePlans(raws: readonly unknown[]) {
  return readMany(SubscriptionPlanDocSchema, collections.subscriptionPlans, raws).pipe(
    Effect.map((d) => asDoc(d as readonly SubscriptionPlanDoc[])),
  );
}
function decodeSub(raw: unknown | null) {
  return readOne(SubscriptionDocSchema, collections.subscriptions, raw).pipe(
    Effect.map((d) => asDoc(d as SubscriptionDoc | null)),
  );
}
function decodeLimits(raws: readonly unknown[]) {
  return readMany(CustomerLimitDocSchema, collections.customerLimits, raws).pipe(
    Effect.map((d) => asDoc(d as unknown as readonly CustomerLimitDoc[])),
  );
}
function decodeBudgets(raws: readonly unknown[]) {
  return readMany(BudgetDocSchema, collections.budgets, raws).pipe(
    Effect.map((d) => asDoc(d as unknown as readonly BudgetDoc[])),
  );
}


export const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db until a repository method runs (test Layers
    // may install Mongo without a full TypedDb).
    const db = (): typeof mongo.db => mongo.db;
    const locks = () =>
      mongo.rawDb.collection<{ _id: string; createdAt: Date }>("_locks");
    const BOOTSTRAP_LOCK_ID = "first_run_signup";
    /** If process dies mid-signup, reclaim after this age (no users exist). */
    const BOOTSTRAP_STALE_MS = 2 * 60 * 1000;

    return {
      countUsers: () => tryMongo(() => db().users.countDocuments({})),
      claimBootstrap: () =>
        tryMongo(async () => {
          const tryInsert = async (): Promise<boolean> => {
            try {
              await locks().insertOne({
                _id: BOOTSTRAP_LOCK_ID,
                createdAt: clock.now(),
              });
              return true;
            } catch (err) {
              if (isDuplicateKeyError(err)) return false;
              throw err;
            }
          };

          if (await tryInsert()) return true;

          // Another claim exists. If users already present → setup done.
          const userCount = await db().users.countDocuments({});
          if (userCount > 0) return false;

          // No users: either concurrent in-flight signup or crash left a stale lock.
          const existing = await locks().findOne({ _id: BOOTSTRAP_LOCK_ID });
          if (!existing) {
            // Lost the race delete/insert window — try once more.
            return tryInsert();
          }
          const ageMs = clock.now().getTime() - existing.createdAt.getTime();
          if (ageMs < BOOTSTRAP_STALE_MS) {
            // Fresh claim: another request is still setting up.
            return false;
          }
          // Stale empty claim: reclaim so first-run is not permanently stuck.
          await locks().deleteOne({ _id: BOOTSTRAP_LOCK_ID });
          return tryInsert();
        }),
      releaseBootstrapClaim: () =>
        tryMongo(async () => {
          await locks().deleteOne({ _id: BOOTSTRAP_LOCK_ID });
        }),
      findById: (id) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().users.findOne({ _id: toObjectId(id) }),
          );
          return yield* decodeUser(raw);
        }),
      findByUsername: (username) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() => db().users.findOne({ username }));
          return yield* decodeUser(raw);
        }),
      findByEmail: (email) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() => db().users.findOne({ email }));
          return yield* decodeUser(raw);
        }),
      findByUsernameOrEmail: (username, email) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().users.findOne({ $or: [{ username }, { email }] }),
          );
          return yield* decodeUser(raw);
        }),
      emailTaken: (email, excludeUserId) =>
        tryMongo(async () => {
          const filter: Filter<UserDoc> = { email };
          if (excludeUserId !== undefined) {
            filter._id = { $ne: toObjectId(excludeUserId) };
          }
          const found = await db().users.findOne(filter);
          return found !== null;
        }),
      insertUser: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const _id = newObjectId(record.id);
          const doc: UserDoc = {
            _id,
            memberships: [...record.memberships],
            activeOrganizationId: toObjectId(record.activeOrganizationId),
            username: record.username,
            email: record.email,
            passwordHash: record.passwordHash,
            status: record.status,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            UserDocSchema,
            collections.users,
            doc,
          );
          yield* tryMongo(() =>
            db().users.insertOne(validated as UserDoc),
          );
          return asDoc(validated as UserDoc);
        }),
      updateEmail: (userId, email) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().users.findOneAndUpdate(
              { _id: toObjectId(userId) },
              { $set: { email, updatedAt: clock.now() } },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeUser(raw);
        }),
      updatePasswordHash: (userId, passwordHash) =>
        tryMongo(async () => {
          await db().users.updateOne(
            { _id: toObjectId(userId) },
            { $set: { passwordHash, updatedAt: clock.now() } },
          );
        }),
      setActiveOrganization: (userId, organizationId) =>
        tryMongo(async () => {
          await db().users.updateOne(
            { _id: toObjectId(userId) },
            {
              $set: {
                activeOrganizationId: toObjectId(organizationId),
                updatedAt: clock.now(),
              },
            },
          );
        }),
      addMembership: (userId, organizationId, role, setActive, permissions) =>
        Effect.gen(function* () {
          const $set: Record<string, unknown> = { updatedAt: clock.now() };
          if (setActive) {
            $set.activeOrganizationId = toObjectId(organizationId);
          }
          const raw = yield* tryMongo(() =>
            db().users.findOneAndUpdate(
              { _id: toObjectId(userId) },
              {
                $push: {
                  memberships: {
                    organizationId: toObjectId(organizationId),
                    role,
                    permissions: [...(permissions ?? [])],
                  },
                },
                $set,
              },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeUser(raw);
        }),
      findMembersOfOrg: (organizationId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().users
              .find({ "memberships.organizationId": toObjectId(organizationId) })
              .toArray(),
          );
          return yield* decodeUsers(raws);
        }),
      pullMembershipAndRepoint: (userId, organizationId, nextActive) =>
        tryMongo(async () => {
          await db().users.updateOne(
            { _id: toObjectId(userId) },
            {
              $pull: {
                memberships: { organizationId: toObjectId(organizationId) },
              },
              $set: {
                activeOrganizationId: toObjectId(nextActive),
                updatedAt: clock.now(),
              },
            },
          );
        }),
    };
  }),
);

export const SessionRepositoryLive = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    const db = (): typeof mongo.db => mongo.db;
    return {
      insert: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: AdminSessionDoc = {
            _id: newObjectId(record.id),
            userId: toObjectId(record.userId),
            organizationId: toObjectId(record.organizationId),
            expiresAt: record.expiresAt,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            AdminSessionDocSchema,
            collections.adminSessions,
            doc,
          );
          yield* tryMongo(() =>
            db().adminSessions.insertOne(validated as AdminSessionDoc),
          );
          return asDoc(validated as AdminSessionDoc);
        }),
      findById: (sessionId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().adminSessions.findOne({ _id: toObjectId(sessionId) }),
          );
          return yield* decodeAdminSession(raw);
        }),
      touchExpiry: (sessionId, userId, expiresAt, organizationId) =>
        Effect.gen(function* () {
          const $set: {
            expiresAt: Date;
            updatedAt: Date;
            organizationId?: ReturnType<typeof toObjectId>;
          } = {
            expiresAt,
            updatedAt: clock.now(),
          };
          if (organizationId !== undefined) {
            $set.organizationId = toObjectId(organizationId);
          }
          const raw = yield* tryMongo(() =>
            db().adminSessions.findOneAndUpdate(
              {
                _id: toObjectId(sessionId),
                userId: toObjectId(userId),
              },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeAdminSession(raw);
        }),
      deleteById: (sessionId) =>
        tryMongo(async () => {
          const res = await db().adminSessions.deleteOne({
            _id: toObjectId(sessionId),
          });
          return res.deletedCount === 1;
        }),
      deleteByIdForUser: (sessionId, userId) =>
        tryMongo(async () => {
          const res = await db().adminSessions.deleteOne({
            _id: toObjectId(sessionId),
            userId: toObjectId(userId),
          });
          return res.deletedCount === 1;
        }),
      deleteAllForUser: (userId) =>
        tryMongo(async () => {
          const res = await db().adminSessions.deleteMany({
            userId: toObjectId(userId),
          });
          return res.deletedCount;
        }),
    };
  }),
);

export const InviteRepositoryLive = Layer.effect(
  InviteRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db until a repository method runs (test Layers
    // may install Mongo without a full TypedDb).
    const db = (): typeof mongo.db => mongo.db;
    return {
      listByOrg: (organizationId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().invites
              .find({ organizationId: toObjectId(organizationId) })
              .sort({ createdAt: -1 })
              .toArray(),
          );
          return yield* decodeInvites(raws);
        }),
      insert: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: InviteDoc = {
            _id: new ObjectId(),
            organizationId: toObjectId(record.organizationId),
            invitedBy: toObjectId(record.invitedBy),
            email: record.email,
            role: record.role,
            permissions:
              record.role === "admin"
                ? []
                : [...(record.permissions ?? [])],
            tokenHash: record.tokenHash,
            status: "pending",
            acceptedAt: null,
            expiresAt: record.expiresAt,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            InviteDocSchema,
            collections.invites,
            doc,
          );
          yield* tryMongo(() =>
            db().invites.insertOne(validated as InviteDoc),
          );
          return asDoc(validated as InviteDoc);
        }),
      findPendingByTokenHash: (tokenHash) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().invites.findOne({ tokenHash, status: "pending" }),
          );
          return yield* decodeInvite(raw);
        }),
      revokePending: (inviteId, organizationId) =>
        tryMongo(async () => {
          const res = await db().invites.updateOne(
            {
              _id: toObjectId(inviteId),
              organizationId: toObjectId(organizationId),
              status: "pending",
            },
            { $set: { status: "revoked", updatedAt: clock.now() } },
          );
          return res.matchedCount > 0;
        }),
      markAccepted: (inviteId) =>
        tryMongo(async () => {
          const now = clock.now();
          await db().invites.updateOne(
            { _id: toObjectId(inviteId) },
            {
              $set: {
                status: "accepted",
                acceptedAt: now,
                updatedAt: now,
              },
            },
          );
        }),
      deleteByOrg: (organizationId) =>
        tryMongo(async () => {
          await db().invites.deleteMany({
            organizationId: toObjectId(organizationId),
          });
        }),
    };
  }),
);

export const OrganizationRepositoryLive = Layer.effect(
  OrganizationRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db until a repository method runs (test Layers
    // may install Mongo without a full TypedDb).
    const db = (): typeof mongo.db => mongo.db;
    return {
      findById: (id) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().organizations.findOne({ _id: toObjectId(id) }),
          );
          return yield* decodeOrg(raw);
        }),
      findByIds: (ids) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().organizations
              .find({ _id: { $in: ids.map(toObjectId) } })
              .sort({ createdAt: 1 })
              .toArray(),
          );
          return yield* decodeOrgs(raws);
        }),
      findBySlug: (slug) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() => db().organizations.findOne({ slug }));
          return yield* decodeOrg(raw);
        }),
      slugTaken: (slug, excludeId) =>
        tryMongo(async () => {
          const filter: Filter<OrganizationDoc> = { slug };
          if (excludeId !== undefined) {
            filter._id = { $ne: toObjectId(excludeId) };
          }
          return (await db().organizations.findOne(filter)) !== null;
        }),
      insert: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: OrganizationDoc = {
            _id: newObjectId(record.id),
            name: record.name,
            slug: record.slug,
            ownerId: toObjectId(record.ownerId),
            defaultCurrency: record.defaultCurrency,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            OrganizationDocSchema,
            collections.organizations,
            doc,
          );
          yield* tryMongo(() =>
            db().organizations.insertOne(validated as OrganizationDoc),
          );
          return asDoc(validated as OrganizationDoc);
        }),
      update: (id, patch) =>
        Effect.gen(function* () {
          const $set: Record<string, unknown> = { updatedAt: clock.now() };
          for (const [k, v] of Object.entries(patch)) {
            if (v !== undefined) $set[k] = v;
          }
          const raw = yield* tryMongo(() =>
            db().organizations.findOneAndUpdate(
              { _id: toObjectId(id) },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeOrg(raw);
        }),
      delete: (id) =>
        tryMongo(async () => {
          await db().organizations.deleteOne({ _id: toObjectId(id) });
        }),
      countBusinessData: (organizationId) =>
        tryMongo(async () => {
          const oid = toObjectId(organizationId);
          const [providers, customers, models, plans, apiKeys] =
            await Promise.all([
              db().providers.countDocuments({ organizationId: oid }),
              db().customers.countDocuments({ organizationId: oid }),
              db().models.countDocuments({ organizationId: oid }),
              db().subscriptionPlans.countDocuments({ organizationId: oid }),
              db().apiKeys.countDocuments({ organizationId: oid }),
            ]);
          return { providers, customers, models, plans, apiKeys };
        }),
    };
  }),
);

export const CustomerRepositoryLive = Layer.effect(
  CustomerRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db/client until a repository method runs.
    const db = (): typeof mongo.db => mongo.db;
    const client = (): typeof mongo.client => mongo.client;
    return {
      list: (filter, page) =>
        Effect.gen(function* () {
          const q: Filter<CustomerDoc> = {
            organizationId: toObjectId(filter.organizationId),
          };
          if (filter.status !== undefined) q.status = filter.status;
          if (filter.q !== undefined && filter.q.length > 0) {
            const esc = escapeRegExp(filter.q);
            q.$or = [
              { name: { $regex: esc, $options: "i" } },
              { email: { $regex: esc, $options: "i" } },
            ];
          }
          const [rawItems, total] = yield* tryMongo(() =>
            Promise.all([
              db().customers
                .find(q)
                .sort({ createdAt: -1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray(),
              db().customers.countDocuments(q),
            ]),
          );
          const items = yield* decodeCustomers(rawItems);
          return { items, total };
        }),
      findById: (organizationId, customerId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().customers.findOne({
              _id: toObjectId(customerId),
              organizationId: toObjectId(organizationId),
            }),
          );
          return yield* decodeCustomer(raw);
        }),
      findByCustomerId: (customerId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().customers.findOne({ _id: toObjectId(customerId) }),
          );
          return yield* decodeCustomer(raw);
        }),
      findConflict: (organizationId, fields, excludeCustomerId) =>
        Effect.gen(function* () {
          const or: Filter<CustomerDoc>[] = [];
          if (fields.externalId !== undefined)
            or.push({ externalId: fields.externalId });
          if (fields.email !== undefined) or.push({ email: fields.email });
          if (or.length === 0) return null;
          const filter: Filter<CustomerDoc> = {
            organizationId: toObjectId(organizationId),
            $or: or,
          };
          if (excludeCustomerId !== undefined) {
            filter._id = { $ne: toObjectId(excludeCustomerId) };
          }
          const raw = yield* tryMongo(() => db().customers.findOne(filter));
          return yield* decodeCustomer(raw);
        }),
      insertWithOpeningBalance: (customer, openingNote) =>
        Effect.gen(function* () {
          const now = clock.now();
          const customerId = new ObjectId();
          const doc: CustomerDoc = {
            _id: customerId,
            organizationId: toObjectId(customer.organizationId),
            externalId: customer.externalId,
            name: customer.name,
            email: customer.email,
            balance: { ...customer.balance },
            status: customer.status,
            metadata: { ...customer.metadata },
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            CustomerDocSchema,
            collections.customers,
            doc,
          );
          let adjustmentDoc: BalanceAdjustmentDoc | null = null;
          if (customer.balance.amountUnits !== 0) {
            adjustmentDoc = {
              _id: new ObjectId(),
              organizationId: toObjectId(customer.organizationId),
              customerId,
              amountUnits: customer.balance.amountUnits,
              currency: customer.balance.currency,
              reason: "topup",
              usageRecordId: null,
              note: openingNote,
              occurredAt: now,
              createdAt: now,
              updatedAt: now,
            };
            yield* writeOne(
              BalanceAdjustmentDocSchema,
              collections.balanceAdjustments,
              adjustmentDoc,
            );
          }
          yield* tryMongo(async () => {
            const session = client().startSession();
            try {
              await session.withTransaction(async () => {
                await db().customers.insertOne(validated as CustomerDoc, {
                  session,
                });
                if (adjustmentDoc) {
                  await db().balanceAdjustments.insertOne(adjustmentDoc, {
                    session,
                  });
                }
              });
            } finally {
              await session.endSession();
            }
          });
          return asDoc(validated as CustomerDoc);
        }),
      update: (organizationId, customerId, patch) =>
        Effect.gen(function* () {
          const $set: Record<string, unknown> = { updatedAt: clock.now() };
          for (const [k, v] of Object.entries(patch)) {
            if (v !== undefined) $set[k] = v;
          }
          const raw = yield* tryMongo(() =>
            db().customers.findOneAndUpdate(
              {
                _id: toObjectId(customerId),
                organizationId: toObjectId(organizationId),
              },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeCustomer(raw);
        }),
      close: (organizationId, customerId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().customers.findOneAndUpdate(
              {
                _id: toObjectId(customerId),
                organizationId: toObjectId(organizationId),
              },
              { $set: { status: "closed", updatedAt: clock.now() } },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeCustomer(raw);
        }),
      adjustBalance: (input) =>
        Effect.gen(function* () {
          const now = clock.now();
          const oid = toObjectId(input.customerId);
          const orgId = toObjectId(input.organizationId);
          const adjustment: BalanceAdjustmentDoc = {
            _id: new ObjectId(),
            organizationId: orgId,
            customerId: oid,
            amountUnits: input.amountUnits,
            currency: input.currency,
            reason: input.reason,
            usageRecordId: null,
            note: input.note,
            occurredAt: now,
            createdAt: now,
            updatedAt: now,
          };
          const validatedAdj = yield* writeOne(
            BalanceAdjustmentDocSchema,
            collections.balanceAdjustments,
            adjustment,
          );
          const result = yield* tryMongo(async () => {
            const session = client().startSession();
            let updated: CustomerDoc | null = null;
            try {
              await session.withTransaction(async () => {
                await db().balanceAdjustments.insertOne(
                  validatedAdj as BalanceAdjustmentDoc,
                  { session },
                );
                const setFields: Record<string, unknown> = { updatedAt: now };
                if (input.setCurrency) {
                  setFields["balance.currency"] = input.currency;
                }
                const res = await db().customers.findOneAndUpdate(
                  {
                    _id: oid,
                    organizationId: orgId,
                    "balance.currency": input.expectedBalanceCurrency,
                  },
                  // Dual-write Units + legacy Minor until post/ drops Minor.
                  [
                    {
                      $set: {
                        ...Object.fromEntries(
                          Object.entries(setFields).map(([k, v]) => [k, v]),
                        ),
                        "balance.amountUnits": {
                          $add: [
                            {
                              $ifNull: [
                                "$balance.amountMinor",
                                { $ifNull: ["$balance.amountUnits", 0] },
                              ],
                            },
                            input.amountUnits,
                          ],
                        },
                        "balance.amountMinor": {
                          $add: [
                            {
                              $ifNull: [
                                "$balance.amountMinor",
                                { $ifNull: ["$balance.amountUnits", 0] },
                              ],
                            },
                            input.amountUnits,
                          ],
                        },
                      },
                    },
                  ],
                  { returnDocument: "after", session },
                );
                if (!res) throw new Error("BalanceCustomerGone");
                updated = res;
              });
            } catch (err) {
              if (
                err instanceof Error &&
                err.message === "BalanceCustomerGone"
              ) {
                return null;
              }
              throw err;
            } finally {
              await session.endSession();
            }
            if (!updated) return null;
            return { customer: updated, adjustment: validatedAdj as BalanceAdjustmentDoc };
          });
          if (!result) return null;
          const customer = yield* decodeCustomer(result.customer);
          if (!customer) return null;
          return {
            customer,
            adjustment: asDoc(result.adjustment),
          };
        }),
      listBalanceHistory: (organizationId, customerId, page) =>
        Effect.gen(function* () {
          const filter = {
            organizationId: toObjectId(organizationId),
            customerId: toObjectId(customerId),
          };
          const [rawItems, total] = yield* tryMongo(() =>
            Promise.all([
              db().balanceAdjustments
                .find(filter)
                .sort({ occurredAt: -1, _id: -1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray(),
              db().balanceAdjustments.countDocuments(filter),
            ]),
          );
          const items = yield* decodeAdjustments(rawItems);
          return { items, total };
        }),
    };
  }),
);

export const PlanRepositoryLive = Layer.effect(
  PlanRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db until a repository method runs (test Layers
    // may install Mongo without a full TypedDb).
    const db = (): typeof mongo.db => mongo.db;
    return {
      listPlans: (organizationId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().subscriptionPlans
              .find({ organizationId: toObjectId(organizationId) })
              .sort({ createdAt: -1 })
              .toArray(),
          );
          return yield* decodePlans(raws);
        }),
      findPlan: (organizationId, planId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().subscriptionPlans.findOne({
              _id: toObjectId(planId),
              organizationId: toObjectId(organizationId),
            }),
          );
          return yield* decodePlan(raw);
        }),
      insertPlan: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: SubscriptionPlanDoc = {
            _id: new ObjectId(),
            organizationId: toObjectId(record.organizationId),
            name: record.name,
            description: record.description,
            price: { ...record.price },
            interval: record.interval as SubscriptionPlanDoc["interval"],
            intervalCount: record.intervalCount,
            includedCredit: { ...record.includedCredit },
            includedTokens: record.includedTokens,
            rateLimits: [...record.rateLimits],
            active: record.active,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            SubscriptionPlanDocSchema,
            collections.subscriptionPlans,
            doc,
          );
          yield* tryMongo(() =>
            db().subscriptionPlans.insertOne(validated as SubscriptionPlanDoc),
          );
          return asDoc(validated as SubscriptionPlanDoc);
        }),
      updatePlan: (organizationId, planId, patch) =>
        Effect.gen(function* () {
          const $set = { ...patch, updatedAt: clock.now() };
          const raw = yield* tryMongo(() =>
            db().subscriptionPlans.findOneAndUpdate(
              {
                _id: toObjectId(planId),
                organizationId: toObjectId(organizationId),
              },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodePlan(raw);
        }),
      deactivatePlan: (organizationId, planId) =>
        tryMongo(async () => {
          const res = await db().subscriptionPlans.updateOne(
            {
              _id: toObjectId(planId),
              organizationId: toObjectId(organizationId),
            },
            { $set: { active: false, updatedAt: clock.now() } },
          );
          return res.matchedCount > 0;
        }),
      findActiveSubscription: (organizationId, customerId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().subscriptions.findOne(
              {
                organizationId: toObjectId(organizationId),
                customerId: toObjectId(customerId),
                status: "active",
              },
              { sort: { createdAt: -1 } },
            ),
          );
          return yield* decodeSub(raw);
        }),
      insertSubscription: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: SubscriptionDoc = {
            _id: new ObjectId(),
            organizationId: toObjectId(record.organizationId),
            customerId: toObjectId(record.customerId),
            planId: toObjectId(record.planId),
            status: record.status,
            periodStart: record.periodStart,
            periodEnd: record.periodEnd,
            canceledAt: null,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            SubscriptionDocSchema,
            collections.subscriptions,
            doc,
          );
          yield* tryMongo(() =>
            db().subscriptions.insertOne(validated as SubscriptionDoc),
          );
          return asDoc(validated as SubscriptionDoc);
        }),
      listCustomerLimits: (organizationId, customerId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().customerLimits
              .find({
                organizationId: toObjectId(organizationId),
                customerId: toObjectId(customerId),
              })
              .toArray(),
          );
          return yield* decodeLimits(raws);
        }),
      listBudgets: (organizationId, customerId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().budgets
              .find({
                organizationId: toObjectId(organizationId),
                customerId: toObjectId(customerId),
              })
              .toArray(),
          );
          return yield* decodeBudgets(raws);
        }),
    };
  }),
);

export const ModelRepositoryLive = Layer.effect(
  ModelRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db until a repository method runs (test Layers
    // may install Mongo without a full TypedDb).
    const db = (): typeof mongo.db => mongo.db;
    return {
      list: (organizationId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().models
              .find({ organizationId: toObjectId(organizationId) })
              .sort({ createdAt: -1 })
              .toArray(),
          );
          return yield* decodeModels(raws);
        }),
      listActive: (organizationId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().models
              .find({ organizationId: toObjectId(organizationId), active: true })
              .sort({ aliasId: 1 })
              .toArray(),
          );
          return yield* decodeModels(raws);
        }),
      findById: (organizationId, modelId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().models.findOne({
              _id: toObjectId(modelId),
              organizationId: toObjectId(organizationId),
            }),
          );
          return yield* decodeModel(raw);
        }),
      insert: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc = {
            _id: new ObjectId(),
            organizationId: toObjectId(record.organizationId),
            aliasId: record.aliasId,
            displayName: record.displayName,
            description: record.description,
            entries: [...record.entries],
            reasoning: record.reasoning,
            toolCall: record.toolCall,
            ...(record.structuredOutput !== undefined
              ? { structuredOutput: record.structuredOutput }
              : {}),
            ...(record.temperature !== undefined
              ? { temperature: record.temperature }
              : {}),
            attachment: record.attachment,
            limits: record.limits,
            modalities: record.modalities,
            status: record.status,
            price: record.price,
            marginBps: record.marginBps,
            currency: record.currency,
            active: record.active,
            metadata: { ...record.metadata },
            createdAt: now,
            updatedAt: now,
          } as ModelDoc;
          const validated = yield* writeOne(
            ModelDocSchema,
            collections.models,
            doc,
          );
          yield* tryMongo(() =>
            db().models.insertOne(validated as ModelDoc),
          );
          return asDoc(validated as ModelDoc);
        }),
      update: (organizationId, modelId, patch) =>
        Effect.gen(function* () {
          const $set = { ...patch, updatedAt: clock.now() };
          const raw = yield* tryMongo(() =>
            db().models.findOneAndUpdate(
              {
                _id: toObjectId(modelId),
                organizationId: toObjectId(organizationId),
              },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeModel(raw);
        }),
      delete: (organizationId, modelId) =>
        tryMongo(async () => {
          const res = await db().models.deleteOne({
            _id: toObjectId(modelId),
            organizationId: toObjectId(organizationId),
          });
          return res.deletedCount > 0;
        }),
      setEntries: (organizationId, modelId, entries) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().models.findOneAndUpdate(
              {
                _id: toObjectId(modelId),
                organizationId: toObjectId(organizationId),
              },
              {
                $set: {
                  entries: [...entries],
                  updatedAt: clock.now(),
                },
              },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeModel(raw);
        }),
      countProviders: (organizationId, providerIds) =>
        tryMongo(() =>
          db().providers.countDocuments({
            _id: { $in: providerIds.map(toObjectId) },
            organizationId: toObjectId(organizationId),
          }),
        ),
      listCatalog: (organizationId, providerId) =>
        Effect.gen(function* () {
          const filter: Record<string, unknown> = {
            organizationId: toObjectId(organizationId),
          };
          if (providerId !== undefined) {
            filter.providerId = toObjectId(providerId);
          }
          const raws = yield* tryMongo(() =>
            db()
              .modelCatalog.find(filter)
              .sort({ upstreamModelId: 1 })
              .toArray(),
          );
          return yield* decodeCatalog(raws);
        }),
      upsertCatalog: (organizationId, providerId, entries) =>
        Effect.gen(function* () {
          if (entries.length === 0) return;
          const now = clock.now();
          const org = toObjectId(organizationId);
          const pid = toObjectId(providerId);
          const ops = entries.map((m) => {
            const setFields: Record<string, unknown> = {
              displayName: m.displayName,
              reasoning: m.reasoning ?? false,
              toolCall: m.toolCall ?? false,
              attachment: m.attachment ?? false,
              limits: m.limits,
              modalities: m.modalities,
              raw: m.raw ?? {},
              discoveredAt: now,
              updatedAt: now,
            };
            if (m.structuredOutput !== undefined) {
              setFields.structuredOutput = m.structuredOutput;
            }
            if (m.temperature !== undefined) {
              setFields.temperature = m.temperature;
            }
            if (m.status !== undefined) setFields.status = m.status;
            if (m.cost !== undefined) setFields.cost = m.cost;
            return {
              updateOne: {
                filter: {
                  organizationId: org,
                  providerId: pid,
                  upstreamModelId: m.upstreamModelId,
                },
                update: {
                  $set: setFields,
                  $setOnInsert: { createdAt: now },
                },
                upsert: true,
              },
            };
          });
          yield* tryMongo(() => db().modelCatalog.bulkWrite(ops));
        }),
    };
  }),
);

export const ProviderRepositoryLive = Layer.effect(
  ProviderRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db until a repository method runs (test Layers
    // may install Mongo without a full TypedDb).
    const db = (): typeof mongo.db => mongo.db;
    return {
      list: (organizationId) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            db().providers
              .find({ organizationId: toObjectId(organizationId) })
              .sort({ createdAt: -1 })
              .toArray(),
          );
          return yield* decodeProviders(raws);
        }),
      findById: (organizationId, providerId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().providers.findOne({
              _id: toObjectId(providerId),
              organizationId: toObjectId(organizationId),
            }),
          );
          return yield* decodeProvider(raw);
        }),
      insert: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: ProviderDoc = {
            _id: new ObjectId(),
            organizationId: toObjectId(record.organizationId),
            name: record.name,
            sdkType: record.sdkType,
            apiKeyEncrypted: record.apiKeyEncrypted,
            baseUrl: record.baseUrl,
            providerOrg: record.providerOrg,
            headers: { ...record.headers },
            active: record.active,
            ...(record.httpTimeoutMs !== undefined
              ? { httpTimeoutMs: record.httpTimeoutMs }
              : { httpTimeoutMs: null }),
            metadata: { ...record.metadata },
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            ProviderDocSchema,
            collections.providers,
            doc,
          );
          yield* tryMongo(() =>
            db().providers.insertOne(validated as ProviderDoc),
          );
          return asDoc(validated as ProviderDoc);
        }),
      update: (organizationId, providerId, patch) =>
        Effect.gen(function* () {
          const $set = { ...patch, updatedAt: clock.now() };
          const raw = yield* tryMongo(() =>
            db().providers.findOneAndUpdate(
              {
                _id: toObjectId(providerId),
                organizationId: toObjectId(organizationId),
              },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeProvider(raw);
        }),
      countModelRefs: (organizationId, providerId) =>
        tryMongo(() =>
          db().models.countDocuments({
            organizationId: toObjectId(organizationId),
            "entries.providerId": toObjectId(providerId),
          }),
        ),
      deleteWithCatalog: (organizationId, providerId) =>
        tryMongo(async () => {
          const oid = toObjectId(providerId);
          const org = toObjectId(organizationId);
          await db().modelCatalog.deleteMany({
            organizationId: org,
            providerId: oid,
          });
          const res = await db().providers.deleteOne({
            _id: oid,
            organizationId: org,
          });
          return res.deletedCount > 0;
        }),
    };
  }),
);

export const KeyRepositoryLive = Layer.effect(
  KeyRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const clock = yield* Clock;
    // Lazy: do not touch mongo.db until a repository method runs (test Layers
    // may install Mongo without a full TypedDb).
    const db = (): typeof mongo.db => mongo.db;
    return {
      listCustomerKeys: (organizationId, customerId, page) =>
        Effect.gen(function* () {
          const filter: Filter<ApiKeyDoc> = {
            organizationId: toObjectId(organizationId),
          };
          if (customerId !== undefined) {
            filter.customerId = toObjectId(customerId);
          }
          const limit = page?.limit ?? 50;
          const skip = page?.skip ?? 0;
          const [raws, total] = yield* tryMongo(async () => {
            const items = await db()
              .apiKeys.find(filter)
              .sort({ createdAt: -1 })
              .skip(skip)
              .limit(limit)
              .toArray();
            const count = await db().apiKeys.countDocuments(filter);
            return [items, count] as const;
          });
          const items = yield* decodeApiKeys(raws);
          return { items, total };
        }),
      findCustomerKey: (organizationId, keyId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().apiKeys.findOne({
              _id: toObjectId(keyId),
              organizationId: toObjectId(organizationId),
            }),
          );
          return yield* decodeApiKey(raw);
        }),
      findCustomerKeyByPrefix: (prefix) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() => db().apiKeys.findOne({ prefix }));
          return yield* decodeApiKey(raw);
        }),
      touchCustomerKeyLastUsed: (prefix) =>
        tryMongo(async () => {
          await db().apiKeys.updateOne(
            { prefix },
            { $set: { lastUsedAt: clock.now() } },
          );
        }),
      insertCustomerKey: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: ApiKeyDoc = {
            _id: new ObjectId(),
            organizationId: toObjectId(record.organizationId),
            customerId: toObjectId(record.customerId),
            name: record.name,
            prefix: record.prefix,
            keyHash: record.keyHash,
            modelWhitelist: [...record.modelWhitelist],
            status: "active",
            lastUsedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            ApiKeyDocSchema,
            collections.apiKeys,
            doc,
          );
          yield* tryMongo(() =>
            db().apiKeys.insertOne(validated as ApiKeyDoc),
          );
          return asDoc(validated as ApiKeyDoc);
        }),
      updateCustomerKey: (organizationId, keyId, patch) =>
        Effect.gen(function* () {
          const $set = { ...patch, updatedAt: clock.now() };
          const raw = yield* tryMongo(() =>
            db().apiKeys.findOneAndUpdate(
              {
                _id: toObjectId(keyId),
                organizationId: toObjectId(organizationId),
              },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeApiKey(raw);
        }),
      revokeCustomerKey: (organizationId, keyId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().apiKeys.findOneAndUpdate(
              {
                _id: toObjectId(keyId),
                organizationId: toObjectId(organizationId),
              },
              { $set: { status: "revoked", updatedAt: clock.now() } },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeApiKey(raw);
        }),
      listManagementKeys: (organizationId, status) =>
        Effect.gen(function* () {
          const filter: Filter<ManagementApiKeyDoc> = {
            organizationId: toObjectId(organizationId),
          };
          if (status !== undefined) filter.status = status;
          const raws = yield* tryMongo(() =>
            db().managementApiKeys
              .find(filter)
              .sort({ createdAt: -1 })
              .toArray(),
          );
          return yield* decodeMgmtKeys(raws);
        }),
      findManagementKey: (organizationId, keyId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().managementApiKeys.findOne({
              _id: toObjectId(keyId),
              organizationId: toObjectId(organizationId),
            }),
          );
          return yield* decodeMgmtKey(raw);
        }),
      findManagementKeyByPrefix: (prefix) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().managementApiKeys.findOne({ prefix }),
          );
          return yield* decodeMgmtKey(raw);
        }),
      touchManagementKeyLastUsed: (prefix) =>
        tryMongo(async () => {
          await db().managementApiKeys.updateOne(
            { prefix },
            { $set: { lastUsedAt: clock.now() } },
          );
        }),
      insertManagementKey: (record) =>
        Effect.gen(function* () {
          const now = clock.now();
          const doc: ManagementApiKeyDoc = {
            _id: new ObjectId(),
            organizationId: toObjectId(record.organizationId),
            name: record.name,
            prefix: record.prefix,
            keyHash: record.keyHash,
            scopes: [...record.scopes],
            status: "active",
            lastUsedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          const validated = yield* writeOne(
            ManagementApiKeyDocSchema,
            collections.managementApiKeys,
            doc,
          );
          yield* tryMongo(() =>
            db().managementApiKeys.insertOne(validated as ManagementApiKeyDoc),
          );
          return asDoc(validated as ManagementApiKeyDoc);
        }),
      updateManagementKey: (organizationId, keyId, patch) =>
        Effect.gen(function* () {
          const $set = { ...patch, updatedAt: clock.now() };
          const raw = yield* tryMongo(() =>
            db().managementApiKeys.findOneAndUpdate(
              {
                _id: toObjectId(keyId),
                organizationId: toObjectId(organizationId),
              },
              { $set },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeMgmtKey(raw);
        }),
      revokeManagementKey: (organizationId, keyId) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            db().managementApiKeys.findOneAndUpdate(
              {
                _id: toObjectId(keyId),
                organizationId: toObjectId(organizationId),
              },
              { $set: { status: "revoked", updatedAt: clock.now() } },
              { returnDocument: "after" },
            ),
          );
          return yield* decodeMgmtKey(raw);
        }),
      deleteManagementKeysByOrg: (organizationId) =>
        tryMongo(async () => {
          await db().managementApiKeys.deleteMany({
            organizationId: toObjectId(organizationId),
          });
        }),
    };
  }),
);

export const UsageRepositoryLive = Layer.effect(
  UsageRepository,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    // Lazy: do not touch mongo.db until a repository method runs.
    const db = (): typeof mongo.db => mongo.db;
    return {
      customerUsageSummary: (organizationId, customerId, range) =>
        tryMongo(async () => {
          const match: Record<string, unknown> = {
            organizationId: toObjectId(organizationId),
            customerId: toObjectId(customerId),
          };
          const occurredAt: Record<string, unknown> = {};
          if (range.from) occurredAt.$gte = range.from;
          if (range.to) occurredAt.$lte = range.to;
          if (Object.keys(occurredAt).length > 0) match.occurredAt = occurredAt;
          const rows = await db().usageRecords
            .aggregate<{
              _id: string;
              requests: number;
              tokens: number;
              costUnits: number;
              priceUnits: number;
              currency: string;
            }>([
              { $match: match },
              {
                $group: {
                  _id: "$modelAliasId",
                  requests: { $sum: 1 },
                  tokens: { $sum: "$totalTokens" },
                  costUnits: {
                    $sum: {
                      $ifNull: ["$costUnits", { $ifNull: ["$costMinor", 0] }],
                    },
                  },
                  priceUnits: {
                    $sum: {
                      $ifNull: ["$priceUnits", { $ifNull: ["$priceMinor", 0] }],
                    },
                  },
                  currency: { $first: "$currency" },
                },
              },
              { $sort: { costUnits: -1 } },
            ])
            .toArray();
          let totalRequests = 0;
          let totalTokens = 0;
          let totalCostUnits = 0;
          let totalPriceUnits = 0;
          const currency = rows[0]?.currency ?? "USD";
          const byModel = rows.map((r) => {
            totalRequests += r.requests;
            totalTokens += r.tokens;
            totalCostUnits += r.costUnits;
            totalPriceUnits += r.priceUnits;
            return {
              modelAliasId: r._id,
              requests: r.requests,
              tokens: r.tokens,
              costUnits: r.costUnits,
              priceUnits: r.priceUnits,
            };
          });
          return {
            totalRequests,
            totalTokens,
            totalCostUnits,
            totalPriceUnits,
            currency,
            byModel,
          };
        }),
      analyticsSummary: (organizationId, range, top) =>
        tryMongo(async () => {
          const match = {
            organizationId: toObjectId(organizationId),
            occurredAt: { $gte: range.from, $lte: range.to },
          };
          const [totalsByCurrency, byCustomer] = await Promise.all([
            db().usageRecords
              .aggregate<{
                _id: string;
                requests: number;
                tokens: number;
                costUnits: number;
                priceUnits: number;
              }>([
                { $match: match },
                {
                  $group: {
                    _id: "$currency",
                    requests: { $sum: 1 },
                    tokens: { $sum: "$totalTokens" },
                    costUnits: {
                      $sum: {
                        $ifNull: ["$costUnits", { $ifNull: ["$costMinor", 0] }],
                      },
                    },
                    priceUnits: {
                      $sum: {
                        $ifNull: ["$priceUnits", { $ifNull: ["$priceMinor", 0] }],
                      },
                    },
                  },
                },
              ])
              .toArray(),
            db().usageRecords
              .aggregate<{
                _id: { customerId: ObjectId; currency: string };
                requests: number;
                tokens: number;
                costUnits: number;
                priceUnits: number;
              }>([
                { $match: { ...match, customerId: { $ne: null } } },
                {
                  $group: {
                    _id: {
                      customerId: "$customerId",
                      currency: "$currency",
                    },
                    requests: { $sum: 1 },
                    tokens: { $sum: "$totalTokens" },
                    costUnits: {
                      $sum: {
                        $ifNull: ["$costUnits", { $ifNull: ["$costMinor", 0] }],
                      },
                    },
                    priceUnits: {
                      $sum: {
                        $ifNull: ["$priceUnits", { $ifNull: ["$priceMinor", 0] }],
                      },
                    },
                  },
                },
                { $sort: { priceUnits: -1 } },
                {
                  $group: {
                    _id: "$_id.currency",
                    rows: { $push: "$$ROOT" },
                  },
                },
                { $project: { rows: { $slice: ["$rows", top] } } },
                { $unwind: "$rows" },
                { $replaceRoot: { newRoot: "$rows" } },
                { $sort: { priceUnits: -1 } },
              ])
              .toArray(),
          ]);
          return {
            totalsByCurrency: totalsByCurrency.map((r) => ({
              currency: r._id || "USD",
              requests: r.requests,
              tokens: r.tokens,
              costUnits: r.costUnits,
              priceUnits: r.priceUnits,
            })),
            topCustomers: byCustomer.map((r) => ({
              customerId: r._id.customerId.toHexString(),
              currency: r._id.currency || "USD",
              requests: r.requests,
              tokens: r.tokens,
              costUnits: r.costUnits,
              priceUnits: r.priceUnits,
            })),
          };
        }),
      findCustomersByIds: (organizationId, customerIds) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            customerIds.length === 0
              ? Promise.resolve([])
              : db().customers
                  .find({
                    _id: { $in: customerIds.map(toObjectId) },
                    organizationId: toObjectId(organizationId),
                  })
                  .toArray(),
          );
          return yield* decodeCustomers(raws);
        }),
      dashboardSummary: (organizationId, options) =>
        Effect.gen(function* () {
          const orgId = toObjectId(organizationId);
          const includeBalances = options?.includeBalances !== false;
          const [
            customerCount,
            modelCount,
            providerCount,
            activePlanCount,
            balanceAgg,
            recentCustomers,
          ] = yield* tryMongo(() =>
            Promise.all([
              db().customers.countDocuments({ organizationId: orgId }),
              db().models.countDocuments({ organizationId: orgId }),
              db().providers.countDocuments({ organizationId: orgId }),
              db().subscriptionPlans.countDocuments({
                organizationId: orgId,
                active: true,
              }),
              includeBalances
                ? db().customers
                    .aggregate<{ _id: string; totalUnits: number }>([
                      { $match: { organizationId: orgId } },
                      // Prefer amountMinor (legacy) over amountUnits (new) during dual-write migration window — do NOT simplify until post-migration confirmed applied everywhere.
                      {
                        $project: {
                          _id: 0,
                          currency: "$balance.currency",
                          amount: {
                            $ifNull: [
                              "$balance.amountMinor",
                              { $ifNull: ["$balance.amountUnits", 0] },
                            ],
                          },
                        },
                      },
                      {
                        $group: {
                          _id: "$currency",
                          totalUnits: { $sum: "$amount" },
                        },
                      },
                    ])
                    .toArray()
                : Promise.resolve(
                    [] as { _id: string; totalUnits: number }[],
                  ),
              db().customers
                .find({ organizationId: orgId })
                .sort({ createdAt: -1 })
                .limit(5)
                .toArray(),
            ]),
          );
          const balancesByCurrency: Record<string, number> = {};
          for (const row of balanceAgg) {
            if (row._id) balancesByCurrency[row._id] = row.totalUnits;
          }
          const decodedRecent = yield* decodeCustomers(recentCustomers);
          return {
            customers: customerCount,
            models: modelCount,
            providers: providerCount,
            activePlans: activePlanCount,
            balancesByCurrency,
            recentCustomers: [...decodedRecent] as CustomerDoc[],
          };
        }),
    };
  }),
);

/** Domain-port repository graph (schema-decoding; requires MongoDb + Clock). */
export const RepositoryLive = Layer.mergeAll(
  UserRepositoryLive,
  InviteRepositoryLive,
  SessionRepositoryLive,
  OrganizationRepositoryLive,
  CustomerRepositoryLive,
  PlanRepositoryLive,
  ModelRepositoryLive,
  ProviderRepositoryLive,
  KeyRepositoryLive,
  UsageRepositoryLive,
);
