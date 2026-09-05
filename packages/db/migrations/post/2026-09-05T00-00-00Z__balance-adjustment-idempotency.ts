import type { MigrationDb } from "../../src/migrator/migration-db.ts";

export const id = "2026-09-05T00-00-00Z__balance-adjustment-idempotency";
export const phase = "post" as const;
export const transactional = false as const;

export async function up(mdb: MigrationDb): Promise<void> {
  await mdb.collection("balance_adjustments").createIndex(
    { organizationId: 1, idempotencyKey: 1 },
    {
      name: "ux_balance_adjustments_org_idempotency",
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: "string" } },
    },
  );
}
