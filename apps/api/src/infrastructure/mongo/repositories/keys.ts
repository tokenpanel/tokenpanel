/**
 * Customer API keys + management API keys repository.
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  ApiKeyDoc,
  ApiKeyUpdateInput,
  ManagementApiKeyDoc,
  ManagementApiKeyUpdateInput,
  type ApiKeyDoc as ApiKeyDocT,
  type ApiKeyUpdateInput as ApiKeyUpdateInputT,
  type ManagementApiKeyDoc as ManagementApiKeyDocT,
  type ManagementApiKeyUpdateInput as ManagementApiKeyUpdateInputT,
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

const API_KEYS = collections.apiKeys;
const MGMT_KEYS = collections.managementApiKeys;

export type KeysRepoService = {
  readonly findApiKeyById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<ApiKeyDocT | null, MongoFailure | PersistenceDataError>;

  readonly findApiKeyByPrefix: (
    prefix: string,
    session?: ClientSession,
  ) => Effect.Effect<ApiKeyDocT | null, MongoFailure | PersistenceDataError>;

  readonly listApiKeys: (
    organizationId: ObjectId,
    customerId?: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<PageResult<ApiKeyDocT>, MongoFailure | PersistenceDataError>;

  readonly insertApiKey: (
    doc: ApiKeyDocT,
    session?: ClientSession,
  ) => Effect.Effect<ApiKeyDocT, MongoFailure | PersistenceDataError>;

  readonly updateApiKey: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: ApiKeyUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<ApiKeyDocT | null, MongoFailure | PersistenceDataError>;

  readonly findManagementKeyById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<
    ManagementApiKeyDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly findManagementKeyByPrefix: (
    prefix: string,
    session?: ClientSession,
  ) => Effect.Effect<
    ManagementApiKeyDocT | null,
    MongoFailure | PersistenceDataError
  >;

  readonly listManagementKeys: (
    organizationId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<
    PageResult<ManagementApiKeyDocT>,
    MongoFailure | PersistenceDataError
  >;

  readonly insertManagementKey: (
    doc: ManagementApiKeyDocT,
    session?: ClientSession,
  ) => Effect.Effect<
    ManagementApiKeyDocT,
    MongoFailure | PersistenceDataError
  >;

  readonly updateManagementKey: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: ManagementApiKeyUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<
    ManagementApiKeyDocT | null,
    MongoFailure | PersistenceDataError
  >;
};

export class KeysRepo extends Context.Tag("tokenpanel/KeysRepo")<
  KeysRepo,
  KeysRepoService
>() {}

export const KeysRepoLive: Layer.Layer<KeysRepo, never, MongoDb> = Layer.effect(
  KeysRepo,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const apiKeys = () => mongo.db.apiKeys;
    const mgmtKeys = () => mongo.db.managementApiKeys;

    const service: KeysRepoService = {
      findApiKeyById: (organizationId, id, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            apiKeys().findOne(
              { _id: id, organizationId },
              session ? { session } : {},
            ),
          );
          return yield* decodeOptionalDocument(ApiKeyDoc, raw, API_KEYS);
        }),

      findApiKeyByPrefix: (prefix, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            apiKeys().findOne({ prefix }, session ? { session } : {}),
          );
          return yield* decodeOptionalDocument(ApiKeyDoc, raw, API_KEYS);
        }),

      listApiKeys: (organizationId, customerId, pageParams, session) =>
        Effect.gen(function* () {
          const page = normalizePage(pageParams);
          const filter: Record<string, unknown> = { organizationId };
          if (customerId !== undefined) filter.customerId = customerId;
          const [raws, total] = yield* tryMongo(async () => {
            const items = await apiKeys()
              .find(filter, session ? { session } : {})
              .sort({ createdAt: -1 })
              .skip(page.skip)
              .limit(page.limit)
              .toArray();
            const count = await apiKeys().countDocuments(
              filter,
              session ? { session } : {},
            );
            return [items, count] as const;
          });
          const items = yield* decodeDocuments(ApiKeyDoc, raws, API_KEYS);
          return {
            items,
            total,
            limit: page.limit,
            skip: page.skip,
          };
        }),

      insertApiKey: (doc, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(ApiKeyDoc, doc, API_KEYS);
          yield* tryMongo(() =>
            apiKeys().insertOne(toMongoDoc(validated),
              session ? { session } : {},
            ),
          );
          return validated;
        }),

      updateApiKey: (organizationId, id, patch, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(
            ApiKeyUpdateInput,
            patch,
            API_KEYS,
          );
          const now = new Date();
          const raw = yield* tryMongo(() =>
            apiKeys().findOneAndUpdate(
              { _id: id, organizationId },
              toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
              { returnDocument: "after", ...(session ? { session } : {}) },
            ),
          );
          return yield* decodeOptionalDocument(ApiKeyDoc, raw, API_KEYS);
        }),

      findManagementKeyById: (organizationId, id, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            mgmtKeys().findOne(
              { _id: id, organizationId },
              session ? { session } : {},
            ),
          );
          return yield* decodeOptionalDocument(
            ManagementApiKeyDoc,
            raw,
            MGMT_KEYS,
          );
        }),

      findManagementKeyByPrefix: (prefix, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            mgmtKeys().findOne({ prefix }, session ? { session } : {}),
          );
          return yield* decodeOptionalDocument(
            ManagementApiKeyDoc,
            raw,
            MGMT_KEYS,
          );
        }),

      listManagementKeys: (organizationId, pageParams, session) =>
        Effect.gen(function* () {
          const page = normalizePage(pageParams);
          const filter = { organizationId };
          const [raws, total] = yield* tryMongo(async () => {
            const items = await mgmtKeys()
              .find(filter, session ? { session } : {})
              .sort({ createdAt: -1 })
              .skip(page.skip)
              .limit(page.limit)
              .toArray();
            const count = await mgmtKeys().countDocuments(
              filter,
              session ? { session } : {},
            );
            return [items, count] as const;
          });
          const items = yield* decodeDocuments(
            ManagementApiKeyDoc,
            raws,
            MGMT_KEYS,
          );
          return {
            items,
            total,
            limit: page.limit,
            skip: page.skip,
          };
        }),

      insertManagementKey: (doc, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(
            ManagementApiKeyDoc,
            doc,
            MGMT_KEYS,
          );
          yield* tryMongo(() =>
            mgmtKeys().insertOne(toMongoDoc(validated),
              session ? { session } : {},
            ),
          );
          return validated;
        }),

      updateManagementKey: (organizationId, id, patch, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(
            ManagementApiKeyUpdateInput,
            patch,
            MGMT_KEYS,
          );
          const now = new Date();
          const raw = yield* tryMongo(() =>
            mgmtKeys().findOneAndUpdate(
              { _id: id, organizationId },
              toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
              { returnDocument: "after", ...(session ? { session } : {}) },
            ),
          );
          return yield* decodeOptionalDocument(
            ManagementApiKeyDoc,
            raw,
            MGMT_KEYS,
          );
        }),
    };

    return service;
  }),
);
