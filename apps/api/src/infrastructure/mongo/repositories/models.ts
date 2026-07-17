/**
 * Providers, models, model catalog repository.
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  ProviderDoc,
  ProviderUpdateInput,
  ModelDoc,
  ModelUpdateInput,
  ModelCatalogDoc,
  type ProviderDoc as ProviderDocT,
  type ProviderUpdateInput as ProviderUpdateInputT,
  type ModelDoc as ModelDocT,
  type ModelUpdateInput as ModelUpdateInputT,
  type ModelCatalogDoc as ModelCatalogDocT,
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

const PROVIDERS = collections.providers;
const MODELS = collections.models;
const CATALOG = collections.modelCatalog;

export type ModelsRepoService = {
  readonly findProviderById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<ProviderDocT | null, MongoFailure | PersistenceDataError>;

  readonly listProviders: (
    organizationId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<PageResult<ProviderDocT>, MongoFailure | PersistenceDataError>;

  readonly insertProvider: (
    doc: ProviderDocT,
    session?: ClientSession,
  ) => Effect.Effect<ProviderDocT, MongoFailure | PersistenceDataError>;

  readonly updateProvider: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: ProviderUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<ProviderDocT | null, MongoFailure | PersistenceDataError>;

  readonly findModelById: (
    organizationId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<ModelDocT | null, MongoFailure | PersistenceDataError>;

  readonly findModelByAlias: (
    organizationId: ObjectId,
    aliasId: string,
    session?: ClientSession,
  ) => Effect.Effect<ModelDocT | null, MongoFailure | PersistenceDataError>;

  readonly listModels: (
    organizationId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<PageResult<ModelDocT>, MongoFailure | PersistenceDataError>;

  readonly insertModel: (
    doc: ModelDocT,
    session?: ClientSession,
  ) => Effect.Effect<ModelDocT, MongoFailure | PersistenceDataError>;

  readonly updateModel: (
    organizationId: ObjectId,
    id: ObjectId,
    patch: ModelUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<ModelDocT | null, MongoFailure | PersistenceDataError>;

  readonly replaceModel: (
    doc: ModelDocT,
    session?: ClientSession,
  ) => Effect.Effect<ModelDocT, MongoFailure | PersistenceDataError>;

  readonly listCatalog: (
    organizationId: ObjectId,
    providerId?: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<
    PageResult<ModelCatalogDocT>,
    MongoFailure | PersistenceDataError
  >;

  readonly insertCatalog: (
    doc: ModelCatalogDocT,
    session?: ClientSession,
  ) => Effect.Effect<ModelCatalogDocT, MongoFailure | PersistenceDataError>;
};

export class ModelsRepo extends Context.Tag("tokenpanel/ModelsRepo")<
  ModelsRepo,
  ModelsRepoService
>() {}

export const ModelsRepoLive: Layer.Layer<ModelsRepo, never, MongoDb> =
  Layer.effect(
    ModelsRepo,
    Effect.gen(function* () {
      const mongo = yield* MongoDb;
      const providers = () => mongo.db.providers;
      const models = () => mongo.db.models;
      const catalog = () => mongo.db.modelCatalog;

      const service: ModelsRepoService = {
        findProviderById: (organizationId, id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              providers().findOne(
                { _id: id, organizationId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(ProviderDoc, raw, PROVIDERS);
          }),

        listProviders: (organizationId, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter = { organizationId };
            const [raws, total] = yield* tryMongo(async () => {
              const items = await providers()
                .find(filter, session ? { session } : {})
                .sort({ createdAt: -1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await providers().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(ProviderDoc, raws, PROVIDERS);
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insertProvider: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              ProviderDoc,
              doc,
              PROVIDERS,
            );
            yield* tryMongo(() =>
              providers().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        updateProvider: (organizationId, id, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              ProviderUpdateInput,
              patch,
              PROVIDERS,
            );
            // apiKey is wire-only; strip if present (encrypted storage is domain job)
            const { apiKey: _apiKey, ...rest } = validated as ProviderUpdateInputT & {
              apiKey?: string;
            };
            const now = new Date();
            const raw = yield* tryMongo(() =>
              providers().findOneAndUpdate(
                { _id: id, organizationId },
                toMongoUpdate({ $set: { ...rest, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(ProviderDoc, raw, PROVIDERS);
          }),

        findModelById: (organizationId, id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              models().findOne(
                { _id: id, organizationId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(ModelDoc, raw, MODELS);
          }),

        findModelByAlias: (organizationId, aliasId, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              models().findOne(
                { organizationId, aliasId },
                session ? { session } : {},
              ),
            );
            return yield* decodeOptionalDocument(ModelDoc, raw, MODELS);
          }),

        listModels: (organizationId, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter = { organizationId };
            const [raws, total] = yield* tryMongo(async () => {
              const items = await models()
                .find(filter, session ? { session } : {})
                .sort({ aliasId: 1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await models().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(ModelDoc, raws, MODELS);
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insertModel: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(ModelDoc, doc, MODELS);
            yield* tryMongo(() =>
              models().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        updateModel: (organizationId, id, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              ModelUpdateInput,
              patch,
              MODELS,
            );
            const now = new Date();
            const raw = yield* tryMongo(() =>
              models().findOneAndUpdate(
                { _id: id, organizationId },
                toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(ModelDoc, raw, MODELS);
          }),

        replaceModel: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(ModelDoc, doc, MODELS);
            yield* tryMongo(() =>
              models().replaceOne(
                { _id: validated._id },
                toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        listCatalog: (organizationId, providerId, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter: Record<string, unknown> = { organizationId };
            if (providerId !== undefined) filter.providerId = providerId;
            const [raws, total] = yield* tryMongo(async () => {
              const items = await catalog()
                .find(filter, session ? { session } : {})
                .sort({ displayName: 1 })
                .skip(page.skip)
                .limit(page.limit)
                .toArray();
              const count = await catalog().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(
              ModelCatalogDoc,
              raws,
              CATALOG,
            );
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insertCatalog: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              ModelCatalogDoc,
              doc,
              CATALOG,
            );
            yield* tryMongo(() =>
              catalog().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),
      };

      return service;
    }),
  );
