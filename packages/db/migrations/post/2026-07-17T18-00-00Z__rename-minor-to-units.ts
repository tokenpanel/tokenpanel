import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Destructive cleanup after money dual-field pre migration + new code swap.
 *
 * pre/2026-07-17T17-50-00Z__money-units-dual-fields copied *Minor → *Units.
 * New code dual-reads/writes both during the swap→post window. This post phase:
 * 1. Re-syncs Units from Minor where Minor still exists (catches old-writer
 *    updates between pre and swap, and any dual-write alignment).
 * 2. $unsets all *Minor keys (and nested schedule leaves).
 * 3. Remaps rate-limit dimension spend_minor → spend_units.
 * 4. Rewrites settlement_outbox.context legacy keys.
 *
 * Safe only after new code is live (new API understands Units). Safe on re-run:
 * missing Minor paths no-op.
 */
export const id = "2026-07-17T18-00-00Z__rename-minor-to-units";
export const phase = "post" as const;
// non-transactional: 9 collections of updateMany/$unset (risk of 16MB oplog cap + lock contention); each step is independently idempotent and resumable on retry.
export const transactional = false as const;

const SCHEDULE_LEAVES = [
  ["inputMinorPerMillion", "inputUnitsPerMillion"],
  ["outputMinorPerMillion", "outputUnitsPerMillion"],
  ["reasoningMinorPerMillion", "reasoningUnitsPerMillion"],
  ["cacheReadMinorPerMillion", "cacheReadUnitsPerMillion"],
  ["cacheWriteMinorPerMillion", "cacheWriteUnitsPerMillion"],
  ["inputAudioMinorPerMillion", "inputAudioUnitsPerMillion"],
  ["outputAudioMinorPerMillion", "outputAudioUnitsPerMillion"],
] as const;

/**
 * Promote Minor → Units whenever Minor is present (Minor wins over stale Units
 * backfilled by pre during the pre→swap window), then drop Minor. The $ifNull
 * falls back to existing Units only when Minor is somehow null, so a null Minor
 * never clobbers a real Units value.
 */
async function promoteMissingAndDrop(
  coll: ReturnType<MigrationDb["collection"]>,
  minorPath: string,
  unitsPath: string,
): Promise<void> {
  await coll.updateMany(
    { [minorPath]: { $exists: true } },
    [{ $set: { [unitsPath]: { $ifNull: [`$${minorPath}`, `$${unitsPath}`] } } }],
  );
  await coll.updateMany(
    { [minorPath]: { $exists: true } },
    { $unset: { [minorPath]: "" } },
  );
}

async function resyncAndDropScalar(
  coll: ReturnType<MigrationDb["collection"]>,
  minorPath: string,
  unitsPath: string,
): Promise<void> {
  await promoteMissingAndDrop(coll, minorPath, unitsPath);
}

async function resyncAndDropSchedulePrefix(
  coll: ReturnType<MigrationDb["collection"]>,
  prefix: string,
): Promise<void> {
  for (const [minorLeaf, unitsLeaf] of SCHEDULE_LEAVES) {
    await resyncAndDropScalar(
      coll,
      `${prefix}.${minorLeaf}`,
      `${prefix}.${unitsLeaf}`,
    );
  }
}

async function cleanupModelEntrySchedules(
  coll: ReturnType<MigrationDb["collection"]>,
): Promise<void> {
  // Do every transform on MongoDB's current document. A client-side
  // find/map/update loop can overwrite a model entry concurrently changed by
  // the live API between its read and write.
  for (const prefix of ["price", "cost"] as const) {
    for (const [minor, units] of SCHEDULE_LEAVES) {
      await coll.updateMany(
        {
          entries: {
            $elemMatch: { [`${prefix}.${minor}`]: { $exists: true } },
          },
        },
        [{
          $set: {
            entries: {
              $map: {
                input: { $ifNull: ["$entries", []] },
                as: "entry",
                in: {
                  $mergeObjects: [
                    "$$entry",
                    {
                      [prefix]: {
                        $cond: [
                          {
                            $ne: [
                              { $type: `$$entry.${prefix}.${minor}` },
                              "missing",
                            ],
                          },
                          {
                            $unsetField: {
                              field: minor,
                              input: {
                                $setField: {
                                  field: units,
                                  input: `$$entry.${prefix}`,
                                  value: {
                                    $ifNull: [
                                      `$$entry.${prefix}.${minor}`,
                                      `$$entry.${prefix}.${units}`,
                                    ],
                                  },
                                },
                              },
                            },
                          },
                          `$$entry.${prefix}`,
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }],
      );
    }
  }
}

async function rewriteRuleDimensions(
  coll: ReturnType<MigrationDb["collection"]>,
  field: "rateLimits" | "rules",
): Promise<void> {
  await coll.updateMany(
    { [`${field}.dimension`]: "spend_minor" },
    { $set: { [`${field}.$[r].dimension`]: "spend_units" } },
    { arrayFilters: [{ "r.dimension": "spend_minor" }] },
  );
}

export async function up(mdb: MigrationDb): Promise<void> {
  // --- customers.balance ---
  await resyncAndDropScalar(
    mdb.collection("customers"),
    "balance.amountMinor",
    "balance.amountUnits",
  );
  await resyncAndDropScalar(
    mdb.collection("customers"),
    "balance.reservedMinor",
    "balance.reservedUnits",
  );

  await resyncAndDropScalar(
    mdb.collection("balance_adjustments"),
    "amountMinor",
    "amountUnits",
  );
  await resyncAndDropScalar(
    mdb.collection("budgets"),
    "amountMinor",
    "amountUnits",
  );

  await resyncAndDropScalar(
    mdb.collection("subscription_plans"),
    "price.amountMinor",
    "price.amountUnits",
  );
  await resyncAndDropScalar(
    mdb.collection("subscription_plans"),
    "includedCredit.amountMinor",
    "includedCredit.amountUnits",
  );
  await rewriteRuleDimensions(
    mdb.collection("subscription_plans"),
    "rateLimits",
  );
  await rewriteRuleDimensions(mdb.collection("customer_limits"), "rules");

  await resyncAndDropScalar(
    mdb.collection("usage_records"),
    "costMinor",
    "costUnits",
  );
  await resyncAndDropScalar(
    mdb.collection("usage_records"),
    "priceMinor",
    "priceUnits",
  );

  await resyncAndDropSchedulePrefix(mdb.collection("models"), "price");
  await resyncAndDropSchedulePrefix(mdb.collection("models"), "cost");
  await cleanupModelEntrySchedules(mdb.collection("models"));

  await resyncAndDropSchedulePrefix(mdb.collection("model_catalog"), "cost");

  await mdb.collection("rate_limit_counters").updateMany(
    { dimension: "spend_minor" },
    { $set: { dimension: "spend_units" } },
  );

  // settlement_outbox.context. Keep transforms server-side for the same
  // reason as model entries: outbox workers may update a context while post
  // migration runs.
  const outbox = mdb.collection("settlement_outbox");
  const top: Array<[string, string]> = [
    ["priceMinor", "priceUnits"],
    ["costMinor", "costUnits"],
    ["reservedMinor", "reservedUnits"],
    ["priceMinorOverride", "priceUnitsOverride"],
  ];
  for (const [minor, units] of top) {
    await outbox.updateMany(
      { [`context.${minor}`]: { $exists: true } },
      [{
        $set: {
          context: {
            $unsetField: {
              field: minor,
              input: {
                $setField: {
                  field: units,
                  input: "$context",
                  value: { $ifNull: [`$context.${minor}`, `$context.${units}`] },
                },
              },
            },
          },
        },
      }],
    );
  }

  for (const scheduleKey of ["priceSchedule", "costSchedule"] as const) {
    for (const [minor, units] of SCHEDULE_LEAVES) {
      await outbox.updateMany(
        { [`context.${scheduleKey}.${minor}`]: { $exists: true } },
        [{
          $set: {
            context: {
              $setField: {
                field: scheduleKey,
                input: "$context",
                value: {
                  $unsetField: {
                    field: minor,
                    input: {
                      $setField: {
                        field: units,
                        input: `$context.${scheduleKey}`,
                        value: {
                          $ifNull: [
                            `$context.${scheduleKey}.${minor}`,
                            `$context.${scheduleKey}.${units}`,
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }],
      );
    }
  }
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Best-effort: re-create Minor from Units (cannot restore post-drop divergence).
  const pairs: Array<[string, string, string]> = [
    ["customers", "balance.amountUnits", "balance.amountMinor"],
    ["customers", "balance.reservedUnits", "balance.reservedMinor"],
    ["balance_adjustments", "amountUnits", "amountMinor"],
    ["budgets", "amountUnits", "amountMinor"],
    ["subscription_plans", "price.amountUnits", "price.amountMinor"],
    ["subscription_plans", "includedCredit.amountUnits", "includedCredit.amountMinor"],
    ["usage_records", "costUnits", "costMinor"],
    ["usage_records", "priceUnits", "priceMinor"],
  ];
  for (const [coll, units, minor] of pairs) {
    await mdb.collection(coll).updateMany(
      { [units]: { $exists: true }, [minor]: { $exists: false } },
      [{ $set: { [minor]: `$${units}` } }],
    );
  }
  await mdb.collection("subscription_plans").updateMany(
    { "rateLimits.dimension": "spend_units" },
    { $set: { "rateLimits.$[r].dimension": "spend_minor" } },
    { arrayFilters: [{ "r.dimension": "spend_units" }] },
  );
  await mdb.collection("customer_limits").updateMany(
    { "rules.dimension": "spend_units" },
    { $set: { "rules.$[r].dimension": "spend_minor" } },
    { arrayFilters: [{ "r.dimension": "spend_units" }] },
  );
  await mdb.collection("rate_limit_counters").updateMany(
    { dimension: "spend_units" },
    { $set: { dimension: "spend_minor" } },
  );
}
