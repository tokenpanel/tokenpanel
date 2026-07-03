import { MongoClient, type Db } from "mongodb";
import { collections, type TypedDb } from "./schemas/index.ts";

let client: MongoClient | null = null;
let typed: TypedDb | null = null;
let rawDb: Db | null = null;

/**
 * Connection URI. Bun loads `.env` automatically; no dotenv import needed.
 * Default points to a local MongoDB for development.
 */
export function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI not set. Add it to .env (e.g. mongodb://localhost:27017)",
    );
  }
  return uri;
}

export function getDbName(): string {
  return process.env.MONGODB_DB ?? "tokenpanel";
}

/** Connect once and cache. Returns a typed accessor for our collections. */
export async function getDb(): Promise<TypedDb> {
  if (typed) return typed;

  client = new MongoClient(getMongoUri(), {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  rawDb = client.db(getDbName());
  typed = {
    organizations: rawDb.collection(collections.organizations),
    users: rawDb.collection(collections.users),
    invites: rawDb.collection(collections.invites),
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
  };
  return typed;
}

/** Close the client (tests / shutdown). */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    typed = null;
    rawDb = null;
  }
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