import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Additive dual-field copy: *Minor → *Units (keep Minor for old writers).
 *
 * Discourse deploy: this runs from the NEW image while the OLD container still
 * serves. Old code continues to read/write *Minor. New fields sit alongside so
 * after swap the new API can use *Units immediately (with dual-read fallback).
 *
 * post/2026-07-17T18-00-00Z__rename-minor-to-units.ts later re-syncs and drops
 * *Minor (destructive — only after new code is live).
 *
 * Safe on re-run: only sets Units when missing.
 */
export const id = "2026-07-17T17-50-00Z__money-units-dual-fields";
export const phase = "pre" as const;
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

/** Copy scalar path minor → units when units missing (aggregation $set). */
async function copyScalar(
  coll: ReturnType<MigrationDb["collection"]>,
  minorPath: string,
  unitsPath: string,
): Promise<void> {
  await coll.updateMany(
    {
      [minorPath]: { $exists: true },
      [unitsPath]: { $exists: false },
    },
    [{ $set: { [unitsPath]: `$${minorPath}` } }],
  );
}

async function copySchedulePrefix(
  coll: ReturnType<MigrationDb["collection"]>,
  prefix: string,
): Promise<void> {
  for (const [minorLeaf, unitsLeaf] of SCHEDULE_LEAVES) {
    await copyScalar(
      coll,
      `${prefix}.${minorLeaf}`,
      `${prefix}.${unitsLeaf}`,
    );
  }
}

/**
 * Server-side additive copy of entry[].price|cost schedule leaves. The
 * aggregation pipeline reads `entries` at write time per document, so a
 * concurrent old-container write to `entries[i].price.*Minor*` between match
 * and update is observed (no stale read-modify-write clobber). For each leaf,
 * set Units from Minor only when Units is missing; entries without the Minor
 * leaf are left untouched (idempotent).
 */
async function copyModelEntrySchedules(
  coll: ReturnType<MigrationDb["collection"]>,
): Promise<void> {
  for (const prefix of ["price", "cost"] as const) {
    for (const [minorLeaf, unitsLeaf] of SCHEDULE_LEAVES) {
      await coll.updateMany(
        {
          entries: {
            $elemMatch: {
              [`${prefix}.${minorLeaf}`]: { $exists: true },
              [`${prefix}.${unitsLeaf}`]: { $exists: false },
            },
          },
        },
        [{
          $set: {
            entries: {
              $map: {
                input: { $ifNull: ["$entries", []] },
                as: "e",
                in: {
                  $mergeObjects: [
                    "$$e",
                    {
                      [prefix]: {
                        $cond: [
                          {
                            $or: [
                              { $eq: [{ $type: `$$e.${prefix}` }, "missing"] },
                              { $eq: [`$$e.${prefix}`, null] },
                            ],
                          },
                          "$$REMOVE",
                          {
                            $mergeObjects: [
                              `$$e.${prefix}`,
                              {
                                [unitsLeaf]: {
                                  $ifNull: [
                                    `$$e.${prefix}.${unitsLeaf}`,
                                    { $ifNull: [`$$e.${prefix}.${minorLeaf}`, "$$REMOVE"] },
                                  ],
                                },
                              },
                            ],
                          },
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

export async function up(mdb: MigrationDb): Promise<void> {
  // customers.balance
  await copyScalar(
    mdb.collection("customers"),
    "balance.amountMinor",
    "balance.amountUnits",
  );
  await copyScalar(
    mdb.collection("customers"),
    "balance.reservedMinor",
    "balance.reservedUnits",
  );

  // balance_adjustments, budgets
  await copyScalar(
    mdb.collection("balance_adjustments"),
    "amountMinor",
    "amountUnits",
  );
  await copyScalar(mdb.collection("budgets"), "amountMinor", "amountUnits");

  // plans
  await copyScalar(
    mdb.collection("subscription_plans"),
    "price.amountMinor",
    "price.amountUnits",
  );
  await copyScalar(
    mdb.collection("subscription_plans"),
    "includedCredit.amountMinor",
    "includedCredit.amountUnits",
  );

  // usage
  await copyScalar(mdb.collection("usage_records"), "costMinor", "costUnits");
  await copyScalar(mdb.collection("usage_records"), "priceMinor", "priceUnits");

  // models root schedules + entry overrides
  await copySchedulePrefix(mdb.collection("models"), "price");
  await copySchedulePrefix(mdb.collection("models"), "cost");
  await copyModelEntrySchedules(mdb.collection("models"));

  // catalog cost schedules
  await copySchedulePrefix(mdb.collection("model_catalog"), "cost");
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Additive-only reverse would $unset Units — forbidden in spirit of down
  // for dual-field pre; leave Units in place (harmless extra fields).
  void mdb;
}
