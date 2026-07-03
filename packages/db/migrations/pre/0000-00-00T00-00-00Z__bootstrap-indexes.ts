import type { MigrationDb } from "../../src/migrator/migration-db.ts";

export const id = "0000-00-00T00-00-00Z__bootstrap-indexes";
export const phase = "pre" as const;
export const transactional = false as const;

export async function up(mdb: MigrationDb): Promise<void> {
  // Create indexes SEQUENTIALLY, not via Promise.all. The runner binds every
  // operation to a single ClientSession (createMigrationDb). The MongoDB driver
  // does not support concurrent operations on the same session — running them
  // in parallel risks "operation in progress" errors or undefined behaviour.
  // Index creation is idempotent and one-time, so sequential is safe and fast.
  await mdb.collection("organizations").createIndex({ slug: 1 }, { unique: true });
  await mdb.collection("users").createIndex({ username: 1 }, { unique: true });
  await mdb.collection("users").createIndex({ email: 1 }, { unique: true });
  await mdb.collection("users").createIndex({ "memberships.organizationId": 1 });
  await mdb.collection("invites").createIndex(
    { organizationId: 1, email: 1 },
    { sparse: true },
  );
  await mdb.collection("invites").createIndex(
    { tokenHash: 1 },
    { unique: true, sparse: true },
  );
  await mdb.collection("invites").createIndex({ status: 1, expiresAt: 1 });
  // externalId is optional (nullish) — most customers omit it. A plain
  // unique+sparse compound index would still index every document (the
  // required organizationId field satisfies sparse), so two customers in
  // the same org without an externalId would collide on { orgId, null } and
  // the second insert would fail. A partial unique index only indexes
  // documents where externalId is an actual string, so uniqueness is enforced
  // solely for customers that actually carry an externalId.
  await mdb.collection("customers").createIndex(
    { organizationId: 1, externalId: 1 },
    { unique: true, partialFilterExpression: { externalId: { $type: "string" } } },
  );
  await mdb.collection("customers").createIndex(
    { organizationId: 1, email: 1 },
    { sparse: true },
  );
  await mdb.collection("balance_adjustments").createIndex(
    { organizationId: 1, customerId: 1, occurredAt: -1 },
  );
  await mdb.collection("providers").createIndex({ organizationId: 1, name: 1 });
  await mdb.collection("model_catalog").createIndex(
    { organizationId: 1, providerId: 1, upstreamModelId: 1 },
    { unique: true },
  );
  await mdb.collection("models").createIndex(
    { organizationId: 1, aliasId: 1 },
    { unique: true },
  );
  await mdb.collection("subscription_plans").createIndex(
    { organizationId: 1, name: 1 },
  );
  await mdb.collection("subscriptions").createIndex(
    { organizationId: 1, customerId: 1 },
  );
  await mdb.collection("subscriptions").createIndex({ status: 1, periodEnd: 1 });
  await mdb.collection("customer_limits").createIndex(
    { organizationId: 1, customerId: 1 },
    { unique: true },
  );
  await mdb.collection("budgets").createIndex(
    { organizationId: 1, customerId: 1, periodStart: 1 },
  );
  await mdb.collection("usage_records").createIndex(
    { organizationId: 1, customerId: 1, occurredAt: -1 },
  );
  await mdb.collection("usage_records").createIndex(
    { organizationId: 1, modelAliasId: 1, occurredAt: -1 },
  );
  await mdb.collection("usage_records").createIndex(
    { organizationId: 1, providerId: 1, occurredAt: -1 },
  );
  await mdb.collection("rate_limit_counters").createIndex(
    {
      organizationId: 1,
      customerId: 1,
      dimension: 1,
      windowSeconds: 1,
      bucketStart: 1,
      scopeTarget: 1,
    },
    { unique: true, sparse: true },
  );
  await mdb.collection("rate_limit_counters").createIndex(
    { bucketStart: 1 },
    { expireAfterSeconds: 31536000 },
  );
  await mdb.collection("api_keys").createIndex(
    { prefix: 1 },
    { unique: true, sparse: true },
  );
  await mdb.collection("api_keys").createIndex(
    { organizationId: 1, customerId: 1 },
  );
  await mdb.collection("api_keys").createIndex(
    { keyHash: 1 },
    { unique: true, sparse: true },
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error("Bootstrap indexes cannot be rolled back");
}
