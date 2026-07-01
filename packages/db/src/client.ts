import { MongoClient } from "mongodb";
import { collections, type TypedDb } from "./schemas/index.ts";

let client: MongoClient | null = null;
let typed: TypedDb | null = null;

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
  const db = client.db(getDbName());
  typed = {
    organizations: db.collection(collections.organizations),
    users: db.collection(collections.users),
    invites: db.collection(collections.invites),
    customers: db.collection(collections.customers),
    balanceAdjustments: db.collection(collections.balanceAdjustments),
    providers: db.collection(collections.providers),
    modelCatalog: db.collection(collections.modelCatalog),
    models: db.collection(collections.models),
    subscriptionPlans: db.collection(collections.subscriptionPlans),
    subscriptions: db.collection(collections.subscriptions),
    customerLimits: db.collection(collections.customerLimits),
    budgets: db.collection(collections.budgets),
    usageRecords: db.collection(collections.usageRecords),
    rateLimitCounters: db.collection(collections.rateLimitCounters),
    apiKeys: db.collection(collections.apiKeys),
  };
  return typed;
}

/** Ensure indexes exist. Idempotent; safe to call on startup. */
export async function ensureIndexes(db: TypedDb): Promise<void> {
  await Promise.all([
    // organizations
    db.organizations.createIndex({ slug: 1 }, { unique: true }),
    // users — username + email globally unique (one user across many orgs)
    db.users.createIndex({ username: 1 }, { unique: true }),
    db.users.createIndex({ email: 1 }, { unique: true }),
    db.users.createIndex({ "memberships.organizationId": 1 }),
    // invites
    db.invites.createIndex({ organizationId: 1, email: 1 }, { sparse: true }),
    db.invites.createIndex({ tokenHash: 1 }, { unique: true, sparse: true }),
    db.invites.createIndex({ status: 1, expiresAt: 1 }),
    // customers
    db.customers.createIndex(
      { organizationId: 1, externalId: 1 },
      { unique: true, sparse: true },
    ),
    db.customers.createIndex(
      { organizationId: 1, email: 1 },
      { sparse: true },
    ),
    // balance adjustments
    db.balanceAdjustments.createIndex(
      { organizationId: 1, customerId: 1, occurredAt: -1 },
    ),
    // providers
    db.providers.createIndex({ organizationId: 1, name: 1 }),
    // model catalog (cache of discovered upstream models per provider)
    db.modelCatalog.createIndex(
      { organizationId: 1, providerId: 1, upstreamModelId: 1 },
      { unique: true },
    ),
    // models
    db.models.createIndex(
      { organizationId: 1, aliasId: 1 },
      { unique: true },
    ),
    // subscription plans
    db.subscriptionPlans.createIndex({ organizationId: 1, name: 1 }),
    // subscriptions
    db.subscriptions.createIndex({ organizationId: 1, customerId: 1 }),
    db.subscriptions.createIndex({ status: 1, periodEnd: 1 }),
    // customer limits
    db.customerLimits.createIndex(
      { organizationId: 1, customerId: 1 },
      { unique: true },
    ),
    // budgets
    db.budgets.createIndex({
      organizationId: 1,
      customerId: 1,
      periodStart: 1,
    }),
    // usage records
    db.usageRecords.createIndex(
      { organizationId: 1, customerId: 1, occurredAt: -1 },
    ),
    db.usageRecords.createIndex({ organizationId: 1, modelAliasId: 1, occurredAt: -1 }),
    db.usageRecords.createIndex({ organizationId: 1, providerId: 1, occurredAt: -1 }),
    // rate limit counters
    db.rateLimitCounters.createIndex(
      {
        organizationId: 1,
        customerId: 1,
        dimension: 1,
        windowSeconds: 1,
        bucketStart: 1,
        scopeTarget: 1,
      },
      { unique: true, sparse: true },
    ),
    // TTL: expire buckets after the max allowed window (31536000s = 1 year)
    // so any valid window (schema caps windowSeconds at 31536000) has all its
    // buckets available for aggregation. Smaller windows naturally age out.
    db.rateLimitCounters.createIndex({ bucketStart: 1 }, { expireAfterSeconds: 31536000 }),
    // api keys
    db.apiKeys.createIndex({ prefix: 1 }, { unique: true, sparse: true }),
    db.apiKeys.createIndex({ organizationId: 1, customerId: 1 }),
    db.apiKeys.createIndex({ keyHash: 1 }, { unique: true, sparse: true }),
  ]);
}

/** Close the client (tests / shutdown). */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    typed = null;
  }
}