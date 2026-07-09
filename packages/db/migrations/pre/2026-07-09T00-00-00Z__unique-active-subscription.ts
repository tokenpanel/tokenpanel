import type { MigrationDb } from "../../src/migrator/migration-db.ts";

export const id = "2026-07-09T00-00-00Z__unique-active-subscription";
export const phase = "pre" as const;
export const transactional = false as const;

/**
 * At most one active subscription per (organization, customer).
 * App-level check-then-insert is racy under concurrency; this partial unique
 * index is the safety net (insert races surface as E11000 → 409).
 *
 * Only `status: "active"` is treated as live. Historical rows (past_due,
 * canceled, ended) are excluded so re-subscribe after cancel remains possible.
 * Additive only (createIndex) — SafeMigrate-safe for pre/.
 */
export async function up(mdb: MigrationDb): Promise<void> {
  await mdb.collection("subscriptions").createIndex(
    { organizationId: 1, customerId: 1 },
    {
      unique: true,
      name: "org_customer_one_active_subscription",
      partialFilterExpression: {
        status: "active",
      },
    },
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error("Unique active subscription index migration cannot be rolled back");
}
