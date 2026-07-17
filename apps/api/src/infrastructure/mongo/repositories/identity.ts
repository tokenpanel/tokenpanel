/**
 * Users + invites repository.
 */
import { Context, Effect, Layer } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { collections } from "@tokenpanel/db";
import {
  UserDoc,
  UserUpdateInput,
  InviteDoc,
  type UserDoc as UserDocT,
  type UserUpdateInput as UserUpdateInputT,
  type InviteDoc as InviteDocT,
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

const USERS = collections.users;
const INVITES = collections.invites;

export type IdentityRepoService = {
  readonly findUserById: (
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<UserDocT | null, MongoFailure | PersistenceDataError>;

  readonly findUserByEmail: (
    email: string,
    session?: ClientSession,
  ) => Effect.Effect<UserDocT | null, MongoFailure | PersistenceDataError>;

  readonly findUserByUsername: (
    username: string,
    session?: ClientSession,
  ) => Effect.Effect<UserDocT | null, MongoFailure | PersistenceDataError>;

  readonly countUsers: (
    session?: ClientSession,
  ) => Effect.Effect<number, MongoFailure>;

  readonly insertUser: (
    doc: UserDocT,
    session?: ClientSession,
  ) => Effect.Effect<UserDocT, MongoFailure | PersistenceDataError>;

  readonly updateUserById: (
    id: ObjectId,
    patch: UserUpdateInputT,
    session?: ClientSession,
  ) => Effect.Effect<UserDocT | null, MongoFailure | PersistenceDataError>;

  readonly replaceUser: (
    doc: UserDocT,
    session?: ClientSession,
  ) => Effect.Effect<UserDocT, MongoFailure | PersistenceDataError>;

  readonly findInviteById: (
    id: ObjectId,
    session?: ClientSession,
  ) => Effect.Effect<InviteDocT | null, MongoFailure | PersistenceDataError>;

  readonly findInviteByTokenHash: (
    tokenHash: string,
    session?: ClientSession,
  ) => Effect.Effect<InviteDocT | null, MongoFailure | PersistenceDataError>;

  readonly listInvitesByOrg: (
    organizationId: ObjectId,
    pageParams?: { limit?: number; skip?: number },
    session?: ClientSession,
  ) => Effect.Effect<PageResult<InviteDocT>, MongoFailure | PersistenceDataError>;

  readonly insertInvite: (
    doc: InviteDocT,
    session?: ClientSession,
  ) => Effect.Effect<InviteDocT, MongoFailure | PersistenceDataError>;

  readonly replaceInvite: (
    doc: InviteDocT,
    session?: ClientSession,
  ) => Effect.Effect<InviteDocT, MongoFailure | PersistenceDataError>;
};

export class IdentityRepo extends Context.Tag("tokenpanel/IdentityRepo")<
  IdentityRepo,
  IdentityRepoService
>() {}

export const IdentityRepoLive: Layer.Layer<IdentityRepo, never, MongoDb> =
  Layer.effect(
    IdentityRepo,
    Effect.gen(function* () {
      const mongo = yield* MongoDb;
      const users = () => mongo.db.users;
      const invites = () => mongo.db.invites;

      const service: IdentityRepoService = {
        findUserById: (id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              users().findOne({ _id: id }, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(UserDoc, raw, USERS);
          }),

        findUserByEmail: (email, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              users().findOne({ email }, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(UserDoc, raw, USERS);
          }),

        findUserByUsername: (username, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              users().findOne({ username }, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(UserDoc, raw, USERS);
          }),

        countUsers: (session) =>
          tryMongo(() =>
            users().countDocuments({}, session ? { session } : {}),
          ),

        insertUser: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(UserDoc, doc, USERS);
            yield* tryMongo(() =>
              users().insertOne(toMongoDoc(validated), session ? { session } : {}),
            );
            return validated;
          }),

        updateUserById: (id, patch, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(
              UserUpdateInput,
              patch,
              USERS,
            );
            const now = new Date();
            const raw = yield* tryMongo(() =>
              users().findOneAndUpdate(
                { _id: id },
                toMongoUpdate({ $set: { ...validated, updatedAt: now } }),
                { returnDocument: "after", ...(session ? { session } : {}) },
              ),
            );
            return yield* decodeOptionalDocument(UserDoc, raw, USERS);
          }),

        replaceUser: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(UserDoc, doc, USERS);
            yield* tryMongo(() =>
              users().replaceOne(
                { _id: validated._id },
                toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        findInviteById: (id, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              invites().findOne({ _id: id }, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(InviteDoc, raw, INVITES);
          }),

        findInviteByTokenHash: (tokenHash, session) =>
          Effect.gen(function* () {
            const raw = yield* tryMongo(() =>
              invites().findOne({ tokenHash }, session ? { session } : {}),
            );
            return yield* decodeOptionalDocument(InviteDoc, raw, INVITES);
          }),

        listInvitesByOrg: (organizationId, pageParams, session) =>
          Effect.gen(function* () {
            const page = normalizePage(pageParams);
            const filter = { organizationId };
            const [raws, total] = yield* tryMongo(async () => {
              const cursor = invites()
                .find(filter, session ? { session } : {})
                .sort({ createdAt: -1 })
                .skip(page.skip)
                .limit(page.limit);
              const items = await cursor.toArray();
              const count = await invites().countDocuments(
                filter,
                session ? { session } : {},
              );
              return [items, count] as const;
            });
            const items = yield* decodeDocuments(InviteDoc, raws, INVITES);
            return {
              items,
              total,
              limit: page.limit,
              skip: page.skip,
            };
          }),

        insertInvite: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(InviteDoc, doc, INVITES);
            yield* tryMongo(() =>
              invites().insertOne(toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),

        replaceInvite: (doc, session) =>
          Effect.gen(function* () {
            const validated = yield* decodeWriteInput(InviteDoc, doc, INVITES);
            yield* tryMongo(() =>
              invites().replaceOne(
                { _id: validated._id },
                toMongoDoc(validated),
                session ? { session } : {},
              ),
            );
            return validated;
          }),
      };

      return service;
    }),
  );
