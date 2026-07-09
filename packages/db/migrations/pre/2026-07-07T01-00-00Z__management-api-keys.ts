import type { MigrationDb } from "../../src/migrator/migration-db.ts";

export const id = "2026-07-07T01-00-00Z__management-api-keys";
export const phase = "pre" as const;
export const transactional = false as const;

export async function up(mdb: MigrationDb): Promise<void> {
  // management_api_keys collection — separate from customer api_keys so the
  // key purpose cannot be confused at the storage layer. Indexes mirror the
  // customer key set, minus the customer axis:
  //   - unique prefix + unique keyHash for O(1) auth lookup
  //   - org + status for admin list-with-filter
  //   - org + createdAt for stable chronological listing
  // All createIndex calls are idempotent and additive; pre/ migrations are
  // SafeMigrate-linted to forbid destructive ops. Sequential (not Promise.all)
  // because the runner binds every op to a single ClientSession.
  await mdb.collection("management_api_keys").createIndex(
    { prefix: 1 },
    { unique: true, sparse: true },
  );
  await mdb.collection("management_api_keys").createIndex(
    { keyHash: 1 },
    { unique: true, sparse: true },
  );
  await mdb.collection("management_api_keys").createIndex(
    { organizationId: 1, status: 1 },
  );
  await mdb.collection("management_api_keys").createIndex(
    { organizationId: 1, createdAt: -1 },
  );

  // usage_records: organizationId-only path for org-internal management calls
  // (customerId null). The existing customerId+occurredAt index does not cover
  // these efficiently because Mongo will skip the leading null field — this
  // compound index lets "give me all internal mgmt usage in this org" avoid a
  // collection scan. partialFilterExpression limits index size to only the
  // internal-call docs (customerId null is rare in steady state).
  await mdb.collection("usage_records").createIndex(
    { organizationId: 1, actorKind: 1, occurredAt: -1 },
    { partialFilterExpression: { customerId: null } },
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error("Management API keys migration cannot be rolled back");
}
