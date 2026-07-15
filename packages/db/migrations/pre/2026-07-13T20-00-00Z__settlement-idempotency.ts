import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Additive: usage_records.gatewayRequestId unique (settlement idempotency) and
 * settlement_outbox claim/lease indexes for in_progress recovery.
 */
export const id = "2026-07-13T20-00-00Z__settlement-idempotency";
export const phase = "pre" as const;
export const transactional = true as const;

export async function up(mdb: MigrationDb): Promise<void> {
  // Sparse unique: only docs with a string gatewayRequestId participate.
  // Historical usage rows without the field are ignored by the index.
  await mdb.collection("usage_records").createIndexes([
    {
      key: { gatewayRequestId: 1 },
      name: "gatewayRequestId_unique",
      unique: true,
      partialFilterExpression: { gatewayRequestId: { $type: "string" } },
    },
  ]);

  // Claim recovery: in_progress rows with expired nextAttemptAt (lease) can
  // be reclaimed. status + nextAttemptAt already exists; recreate with same
  // name is a no-op if identical.
  await mdb.collection("settlement_outbox").createIndexes([
    {
      key: { status: 1, nextAttemptAt: 1 },
      name: "status_nextAttempt",
    },
  ]);
}

export async function down(mdb: MigrationDb): Promise<void> {
  void mdb;
}
