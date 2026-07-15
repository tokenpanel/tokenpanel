import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Additive: ensure customer.balance.reservedMinor exists (default 0).
 * Used by dual-write atomic reservation canary (ADR 001). Safe on re-run.
 */
export const id = "2026-07-14T00-40-00Z__balance-reserved-minor";
export const phase = "pre" as const;
export const transactional = true as const;

export async function up(mdb: MigrationDb): Promise<void> {
  const customers = mdb.collection("customers");
  // Backfill missing reservedMinor only — never overwrite non-zero holds.
  await customers.updateMany(
    {
      $or: [
        { "balance.reservedMinor": { $exists: false } },
        { "balance.reservedMinor": null },
      ],
    },
    { $set: { "balance.reservedMinor": 0 } },
  );
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Destructive field drop is post-phase only; leave reservedMinor on down.
  void mdb;
}
