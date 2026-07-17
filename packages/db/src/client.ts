import { MongoClient, type Db } from "mongodb";
import { collections, type TypedDb } from "./schemas/index.ts";
import {
  getMongoConnectionConfig,
  isDbConfigured,
  markDbConnected,
  markDbDisconnected,
  DB_CLIENT_SERVER_SELECTION_TIMEOUT_MS,
  configureDb,
} from "./config.ts";

export {
  configureDb,
  clearDbConfig,
  isDbConfigured,
  getMongoConnectionConfig,
} from "./config.ts";
export type { MongoConnectionConfig } from "./config.ts";

let client: MongoClient | null = null;
let typed: TypedDb | null = null;
let rawDb: Db | null = null;

/**
 * @deprecated Prefer configureDb + getMongoConnectionConfig.
 * Kept for transitional callers; reads only if configureDb was not used.
 * Does not invent a default URI — throws when unset.
 */
export function getMongoUri(): string {
  if (isDbConfigured()) return getMongoConnectionConfig().uri;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI not set. Call configureDb({ uri, databaseName }) or set MONGODB_URI for legacy tools.",
    );
  }
  return uri;
}

/**
 * @deprecated Prefer configureDb + getMongoConnectionConfig.
 * Default name `tokenpanel` only when using legacy env path.
 */
export function getDbName(): string {
  if (isDbConfigured()) return getMongoConnectionConfig().databaseName;
  return process.env.MONGODB_DB ?? "tokenpanel";
}

/** Connect once and cache. Returns a typed accessor for our collections. */
export async function getDb(): Promise<TypedDb> {
  if (typed) return typed;

  // Prefer explicit configureDb; fall back to env for migrator/tests mid-migration.
  if (!isDbConfigured()) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error(
        "MongoDB not configured. Call configureDb({ uri, databaseName }) before getDb().",
      );
    }
    configureDb({
      uri,
      databaseName: process.env.MONGODB_DB ?? "tokenpanel",
    });
  }

  const { uri, databaseName } = getMongoConnectionConfig();
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: DB_CLIENT_SERVER_SELECTION_TIMEOUT_MS,
  });
  await client.connect();
  markDbConnected();
  rawDb = client.db(databaseName);
  typed = {
    organizations: rawDb.collection(collections.organizations),
    users: rawDb.collection(collections.users),
    invites: rawDb.collection(collections.invites),
    adminSessions: rawDb.collection(collections.adminSessions),
    customers: rawDb.collection(collections.customers),
    balanceAdjustments: rawDb.collection(collections.balanceAdjustments),
    providers: rawDb.collection(collections.providers),
    modelCatalog: rawDb.collection(collections.modelCatalog),
    models: rawDb.collection(collections.models),
    subscriptionPlans: rawDb.collection(collections.subscriptionPlans),
    subscriptions: rawDb.collection(collections.subscriptions),
    customerLimits: rawDb.collection(collections.customerLimits),
    budgets: rawDb.collection(collections.budgets),
    usageRecords: rawDb.collection(collections.usageRecords),
    rateLimitCounters: rawDb.collection(collections.rateLimitCounters),
    apiKeys: rawDb.collection(collections.apiKeys),
    managementApiKeys: rawDb.collection(collections.managementApiKeys),
    settlementOutbox: rawDb.collection(collections.settlementOutbox),
  };
  return typed;
}

/** Close the client (tests / shutdown). Resets connection; keeps configureDb config. */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    typed = null;
    rawDb = null;
  }
  markDbDisconnected();
}

/** Get the raw MongoClient (for starting transactions / sessions). */
export function getClient(): MongoClient {
  if (!client) {
    throw new Error("MongoDB not connected. Call getDb() first.");
  }
  return client;
}

/** Get the raw Db instance (for migrations, _migrations, _migration_lock). */
export function getRawDb(): Db {
  if (!rawDb) {
    throw new Error("MongoDB not connected. Call getDb() first.");
  }
  return rawDb;
}
