/**
 * Organizations repository — Effect Schema decode on read/write.
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  OrganizationDoc,
  OrganizationUpdateInput,
  type OrganizationDoc as OrganizationDocT,
  type OrganizationUpdateInput as OrganizationUpdateInputT,
} from "@tokenpanel/db/schemas/effect";
import { MongoDb } from "../../../runtime/services/mongo-db.ts";
import {
  decodeDocuments,
  decodeOptionalDocument,
  decodeWriteInput,
} from "../decode.ts";
import { buildSort, normalizePage, type PageResult } from "../helpers.ts";
import { tryMongo, toMongoDoc, toMongoUpdate, type MongoFailure } from "../try-mongo.ts";
import type { PersistenceDataError } from "../../../errors/index.ts";

const COLL = collections.organizations;
const SORT_ALLOWED = ["createdAt", "updatedAt", "name", "slug"] as const;

export type OrganizationsRepoService = {
  readonly findById: (
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<OrganizationDocT | null, MongoFailure | PersistenceDataError>;

  readonly findBySlug: (
    slug: string,
    session?: ClientSession,
  ) => Effect.Effect<OrganizationDocT | null, MongoFailure | PersistenceDataError>;

  readonly findByIds: (
    ids: readonly ObjectId[],
    session?: ClientSession,
  ) => Effect.Effect<readonly OrganizationDocT[], MongoFailure | PersistenceDataError>;

  readonly insert: (
    doc: OrganizationDocT,
    session?: ClientSession,
  ) => Effect.Effect<OrganizationDocT, MongoFailure | PersistenceDataError>;

  readonly updateById: (
    id: ObjectId,
    patch: OrganizationUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<OrganizationDocT | null, MongoFailure | PersistenceDataError>;

  readonly deleteById: (
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<boolean, MongoFailure>;
};

export class OrganizationsRepo extends Context.Tag(
  "tokenpanel/OrganizationsRepo",
)<OrganizationsRepo, OrganizationsRepoService>() {}

export const OrganizationsRepoLive: Layer.Layer<
  OrganizationsRepo,
  never,
  MongoDb
> = Layer.effect(
  OrganizationsRepo,
  Effect.gen(function* () {
    const mongo = yield* MongoDb;
    const col = () => mongo.db.organizations;

    const service: OrganizationsRepoService = {
      findById: (id, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            col().findOne({ _id: id }, session ? { session } : {}),
          );
          return yield* decodeOptionalDocument(OrganizationDoc, raw, COLL);
        }),

      findBySlug: (slug, session) =>
        Effect.gen(function* () {
          const raw = yield* tryMongo(() =>
            col().findOne({ slug }, session ? { session } : {}),
          );
          return yield* decodeOptionalDocument(OrganizationDoc, raw, COLL);
        }),

      findByIds: (ids, session) =>
        Effect.gen(function* () {
          const raws = yield* tryMongo(() =>
            col()
              .find({ _id: { $in: [...ids] } }, session ? { session } : {})
              .sort(buildSort(SORT_ALLOWED, undefined, { createdAt: 1 }))
              .toArray(),
          );
          return yield* decodeDocuments(OrganizationDoc, raws, COLL);
        }),

      insert: (doc, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(OrganizationDoc, doc, COLL);
          yield* tryMongo(() =>
            col().insertOne(toMongoDoc(validated), session ? { session } : {}),
          );
          return validated;
        }),

      updateById: (id, patch, session) =>
        Effect.gen(function* () {
          const validated = yield* decodeWriteInput(
            OrganizationUpdateInput,
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
          return yield* decodeOptionalDocument(OrganizationDoc, raw, COLL);
        }),

      deleteById: (id, session) =>
        Effect.gen(function* () {
          const res = yield* tryMongo(() =>
            col().deleteOne({ _id: id }, session ? { session } : {}),
          );
          return res.deletedCount === 1;
        }),
    };

    return service;
  }),
);

/** Convenience list by ids with page (membership lists). */
export function pageOrganizationsByIds(
  repo: OrganizationsRepoService,
  ids: readonly ObjectId[],
  pageParams?: { limit?: number; skip?: number },
): Effect.Effect<PageResult<OrganizationDocT>, MongoFailure | PersistenceDataError> {
  const page = normalizePage(pageParams);
  return Effect.gen(function* () {
    const all = yield* repo.findByIds(ids);
    const total = all.length;
    const items = all.slice(page.skip, page.skip + page.limit);
    return { items, total, limit: page.limit, skip: page.skip };
  });
}
