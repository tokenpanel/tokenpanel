/**
 * Sole process-level TypedDb / MongoClient resolver outside Layer construction.
 *
 * Fail-closed (task 16.1): requires the process ManagedRuntime. There is no
 * `@tokenpanel/db` process-cache fallback — if no runtime is installed the call
 * rejects, which proves no production path can execute without the single
 * managed runtime. Test harnesses must install a runtime via `bootApi` or
 * `createAppRuntime(..., { install: true })`.
 */
import { Effect } from "effect";
import type { MongoClient, Db } from "mongodb";
import type { TypedDb } from "@tokenpanel/db";
import { MongoDb, type MongoDbService } from "../../runtime/services/mongo-db.ts";

export type ResolvedMongo = {
  readonly db: TypedDb;
  readonly client: MongoClient;
  readonly rawDb: Db;
};

async function resolveMongoService(): Promise<MongoDbService> {
  const { getAppRuntime } = await import("../../runtime/app-runtime.ts");
  // getAppRuntime() throws synchronously when no runtime is installed; the
  // surrounding async function turns that into a rejected promise.
  const runtime = getAppRuntime();
  return runtime.runPromise(
    Effect.gen(function* () {
      return yield* MongoDb;
    }),
  );
}

/** Client handle (transactions / sessions). */
export async function resolveMongoClient(): Promise<MongoClient> {
  const live = await resolveMongoService();
  return live.client;
}

/** Full Mongo handles (settle path needs client for sessions). */
export async function resolveMongo(): Promise<ResolvedMongo> {
  const live = await resolveMongoService();
  return { db: live.db, client: live.client, rawDb: live.rawDb };
}
