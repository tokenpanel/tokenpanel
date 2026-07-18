import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Additive: usage_records.gatewayRequestId unique (settlement idempotency) and
 * settlement_outbox claim/lease indexes for in_progress recovery.
 */
export const id = "2026-07-13T20-00-00Z__settlement-idempotency";
export const phase = "pre" as const;
// createIndexes on existing collections cannot run inside a multi-doc transaction.
export const transactional = false as const;

/**
 * Pre runs while the old image can still write usage. It must not silently
 * discard another request's idempotency key. Detect legacy duplicates and
 * stop for an operator-approved post-phase repair instead.
 */
export async function up(mdb: MigrationDb): Promise<void> {
  const usage = mdb.collection("usage_records");

  const dupes = await usage
    .aggregate<{ _id: string; count: number }>([
      { $match: { gatewayRequestId: { $type: "string" } } },
      {
        $group: {
          _id: "$gatewayRequestId",
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .toArray();

  if (dupes.length > 0) {
    throw new Error(
      "[migration:settlement-idempotency] duplicate gatewayRequestId values exist; resolve them with an operator-approved post-phase repair before retrying",
    );
  }

  // Sparse unique: only docs with a string gatewayRequestId participate.
  // Historical usage rows without the field are ignored by the index.
  await usage.createIndexes([
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
