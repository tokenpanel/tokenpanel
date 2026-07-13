import { MongoClient, type Db } from "mongodb";
import { collections, type TypedDb } from "./schemas/index.ts";

let client: MongoClient | null = null;
let typed: TypedDb | null = null;
let rawDb: Db | null = null;

/** Test-only override so HTTP integration tests can inject an in-memory TypedDb. */
let getDbForTests: (() => Promise<TypedDb>) | null = null;

/**
 * Hard gate for test hooks. Production (NODE_ENV=production) always rejects.
 * Outside production, TOKENPANEL_TEST_HOOKS=1 must be set by the test process
 * so a stray import cannot silently swap the DB accessor.
 */
function assertTestHooksAllowed(action: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${action} is forbidden when NODE_ENV=production`);
  }
  if (process.env.TOKENPANEL_TEST_HOOKS !== "1") {
    throw new Error(
      `${action} requires TOKENPANEL_TEST_HOOKS=1 (test processes only)`,
    );
  }
}

function testHooksActive(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.TOKENPANEL_TEST_HOOKS === "1" &&
    getDbForTests !== null
  );
}

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

/**
 * Install/clear a test-only getDb override.
 * Requires TOKENPANEL_TEST_HOOKS=1 and is forbidden in production.
 * Pass `null` to restore the real Mongo-backed accessor.
 */
export function setGetDbForTests(fn: (() => Promise<TypedDb>) | null): void {
  assertTestHooksAllowed("setGetDbForTests");
  getDbForTests = fn;
}

/** Connect once and cache. Returns a typed accessor for our collections. */
export async function getDb(): Promise<TypedDb> {
  if (testHooksActive()) return getDbForTests!();
  // Drop a leaked override if env was cleared so production paths stay pure.
  getDbForTests = null;
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
    managementApiKeys: rawDb.collection(collections.managementApiKeys),
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