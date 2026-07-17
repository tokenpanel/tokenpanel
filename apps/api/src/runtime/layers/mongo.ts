/**
 * MongoDB Layers (task 3.4).
 *
 * Wraps packages/db configureDb/getDb/getClient/closeDb for Effect layers.
 * Process-global connection remains usable by routes that still call getDb().
 */
import { Effect, Layer, Data } from "effect";
import {
  configureDb,
  getDb,
  getClient,
  getRawDb,
  closeDb,
  isDbConfigured,
} from "@tokenpanel/db";
import { AppConfig } from "../services/app-config.ts";
import { MongoDb, type MongoDbService } from "../services/mongo-db.ts";

export class MongoUnavailableError extends Data.TaggedError(
  "MongoUnavailableError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Scoped live Mongo: configure from AppConfig, connect, ping, close on release.
 * Requires AppConfig in the environment.
 */
export const MongoLive: Layer.Layer<MongoDb, MongoUnavailableError, AppConfig> =
  Layer.scoped(
    MongoDb,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const service = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async (): Promise<MongoDbService> => {
            if (!isDbConfigured()) {
              configureDb({
                uri: config.database.uri,
                databaseName: config.database.name,
              });
            }
            const db = await getDb();
            const client = getClient();
            const rawDb = getRawDb();
            await rawDb.command({ ping: 1 });
            return {
              db,
              client,
              rawDb,
              close: () => closeDb(),
            };
          },
          catch: (cause) =>
            new MongoUnavailableError({
              message: "MongoDB connect/ping failed",
              cause,
            }),
        }),
        (svc) =>
          Effect.promise(async () => {
            await svc.close();
          }),
      );
      return service;
    }),
  );

/**
 * Inject an already-connected Mongo service (dual-path boot where index
 * already called getDb / migrations).
 */
export function makeMongoLayer(
  service: MongoDbService,
): Layer.Layer<MongoDb> {
  return Layer.succeed(MongoDb, service);
}

/**
 * Test double: in-memory stub that does not open sockets.
 * Methods that need real DB will throw if used.
 */
export function makeMongoTestLayer(
  partial?: Partial<MongoDbService>,
): Layer.Layer<MongoDb> {
  const closed = { value: false };
  const service: MongoDbService = {
    get db() {
      if (partial?.db) return partial.db;
      throw new Error("MongoTest: db not provided");
    },
    get client() {
      if (partial?.client) return partial.client;
      throw new Error("MongoTest: client not provided");
    },
    get rawDb() {
      if (partial?.rawDb) return partial.rawDb;
      throw new Error("MongoTest: rawDb not provided");
    },
    close: async () => {
      closed.value = true;
      if (partial?.close) await partial.close();
    },
  };
  return Layer.succeed(MongoDb, service);
}

/** Layer that fails construction — for unavailable-Mongo boot tests. */
export const MongoFailLayer: Layer.Layer<MongoDb, MongoUnavailableError> =
  Layer.effect(
    MongoDb,
    Effect.fail(
      new MongoUnavailableError({ message: "MongoDB unavailable (test)" }),
    ),
  );
