import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Additive: covering indexes for customers dashboard hot paths.
 * - { organizationId: 1, createdAt: -1 } backs the recentCustomers
 *   query (find by org, sort createdAt desc, limit 5) — eliminates the
 *   in-memory sort of every customer in the org per dashboard load (P4).
 * - { organizationId: 1, name: 1 } backs case-insensitive name search
 *   (organizationId + name regex) — narrows the collection scan per
 *   keystroke to the org partition (P7).
 *
 * Index-only migration: run outside a transaction (project convention,
 * commit 679a883). createIndex is idempotent; partial progress is resumable.
 */
export const id = "2026-07-17T22-12-34Z__customers-perf-indexes";
export const phase = "pre" as const;
export const transactional = false as const;

export async function up(mdb: MigrationDb): Promise<void> {
  const customers = mdb.collection("customers");
  await customers.createIndex(
    { organizationId: 1, createdAt: -1 },
    { name: "customers_org_createdAt" },
  );
  await customers.createIndex(
    { organizationId: 1, name: 1 },
    { name: "customers_org_name" },
  );
}

export async function down(mdb: MigrationDb): Promise<void> {
  const customers = mdb.collection("customers");
  await customers.dropIndex("customers_org_createdAt").catch(() => undefined);
  await customers.dropIndex("customers_org_name").catch(() => undefined);
}
