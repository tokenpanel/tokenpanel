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
 *
 * This runs while the old image can still serve. It MUST NOT decide which live
 * subscription to cancel. If legacy data violates the invariant, fail before
 * creating the index and require an operator-approved post-phase repair.
 */
export async function up(mdb: MigrationDb): Promise<void> {
  const subs = mdb.collection("subscriptions");

  const dupes = await subs
    .aggregate<{ _id: unknown; count: number }>([
      { $match: { status: "active" } },
      {
        $group: {
          _id: { organizationId: "$organizationId", customerId: "$customerId" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .toArray();

  if (dupes.length > 0) {
    throw new Error(
      "[migration:unique-active-subscription] duplicate active subscriptions exist; resolve them with an operator-approved post-phase repair before retrying",
    );
  }

  await subs.createIndex(
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
