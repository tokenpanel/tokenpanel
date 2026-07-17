/**
 * MongoDB service port (task 3.3).
 * Typed collections + client handle; close owned by Layer finalizer.
 */
import { Context } from "effect";
import type { MongoClient, Db } from "mongodb";
import type { TypedDb } from "@tokenpanel/db";

export type MongoDbService = {
  readonly db: TypedDb;
  readonly client: MongoClient;
  readonly rawDb: Db;
  /** Explicit close (Layer finalizer also calls this). Idempotent preferred. */
  readonly close: () => Promise<void>;
};

export class MongoDb extends Context.Tag("tokenpanel/MongoDb")<
  MongoDb,
  MongoDbService
>() {}
