import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Drop rate-limit rules that still use the removed `endpoint` scope.
 *
 * LimitScope no longer includes `"endpoint"` (stream identity is customer /
 * plan / model only). Stored plans and customer limits that still carry
 * `scope: "endpoint"` fail Effect Schema decode on read after upgrade.
 *
 * Phase = post: destructive array rewrite — run after container swap so new
 * code (which rejects endpoint on write) is already live. Idempotent: $pull
 * is a no-op when no matching elements remain.
 *
 * Does not touch rate_limit_counters (those store scopeTarget, not scope;
 * orphan endpoint counters age out with the rolling window).
 */
export const id = "2026-07-17T19-00-00Z__drop-endpoint-scope-rules";
export const phase = "post" as const;
export const transactional = true as const;

export async function up(mdb: MigrationDb): Promise<void> {
  const plans = await mdb.collection("subscription_plans").updateMany(
    { "rateLimits.scope": "endpoint" },
    { $pull: { rateLimits: { scope: "endpoint" } } },
  );
  const limits = await mdb.collection("customer_limits").updateMany(
    { "rules.scope": "endpoint" },
    { $pull: { rules: { scope: "endpoint" } } },
  );

  console.log(
    `[migration:drop-endpoint-scope-rules] subscription_plans matched=${plans.matchedCount} modified=${plans.modifiedCount}; customer_limits matched=${limits.matchedCount} modified=${limits.modifiedCount}`,
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error(
    "drop-endpoint-scope-rules cannot be rolled back: removed endpoint-scoped rules are not recoverable",
  );
}
