import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Additive: settlement_outbox for durable pending settlement / missing usage.
 * Dual-write begins in application code; enforcement switch is a later canary.
 */
export const id = "2026-07-13T18-00-00Z__settlement-outbox";
export const phase = "pre" as const;
export const transactional = true as const;

export async function up(mdb: MigrationDb): Promise<void> {
  const coll = mdb.collection("settlement_outbox");
  // createIndexes is idempotent-friendly when names are stable.
  await coll.createIndexes([
    {
      key: { status: 1, nextAttemptAt: 1 },
      name: "status_nextAttempt",
    },
    {
      key: { gatewayRequestId: 1 },
      name: "gatewayRequestId_unique",
      unique: true,
    },
    {
      key: { organizationId: 1, createdAt: -1 },
      name: "org_created",
    },
  ]);
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Destructive cleanup is post-phase only; leave collection on down.
  void mdb;
}
