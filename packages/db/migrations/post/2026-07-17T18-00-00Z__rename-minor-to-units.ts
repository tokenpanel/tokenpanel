import type { ObjectId } from "mongodb";
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
export const transactional = true as const;

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
 * Promote Minor → Units only when Units is missing (never clobber new writes),
 * then drop Minor. Balance dual-write keeps both equal after swap so dropping
 * Minor is safe when both exist.
 */
async function promoteMissingAndDrop(
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
  const orFilter = SCHEDULE_LEAVES.flatMap(([minor]) => [
    { [`entries.price.${minor}`]: { $exists: true } },
    { [`entries.cost.${minor}`]: { $exists: true } },
  ]);
  if (orFilter.length === 0) return;
  const rows = await coll.find({ $or: orFilter }).toArray();
  for (const row of rows) {
    const entries = (row as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) continue;
    let dirty = false;
    const nextEntries = entries.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const entry = { ...(raw as Record<string, unknown>) };
      for (const key of ["price", "cost"] as const) {
        const sched = entry[key];
        if (!sched || typeof sched !== "object" || Array.isArray(sched)) {
          continue;
        }
        const s = { ...(sched as Record<string, unknown>) };
        let sDirty = false;
        for (const [minor, units] of SCHEDULE_LEAVES) {
          if (minor in s) {
            if (s[units] === undefined) s[units] = s[minor];
            delete s[minor];
            sDirty = true;
          }
        }
        if (sDirty) {
          entry[key] = s;
          dirty = true;
        }
      }
      return entry;
    });
    if (dirty) {
      await coll.updateOne(
        { _id: (row as { _id: ObjectId })._id },
        { $set: { entries: nextEntries } },
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

  // settlement_outbox.context
  const outbox = mdb.collection("settlement_outbox");
  const rows = await outbox
    .find({
      $or: [
        { "context.priceMinor": { $exists: true } },
        { "context.costMinor": { $exists: true } },
        { "context.reservedMinor": { $exists: true } },
        { "context.priceMinorOverride": { $exists: true } },
        { "context.priceSchedule": { $exists: true } },
        { "context.costSchedule": { $exists: true } },
      ],
    })
    .toArray();

  for (const row of rows) {
    const ctx = (row as { context?: Record<string, unknown> }).context;
    if (!ctx || typeof ctx !== "object") continue;
    const next: Record<string, unknown> = { ...ctx };
    let dirty = false;

    const top: Array<[string, string]> = [
      ["priceMinor", "priceUnits"],
      ["costMinor", "costUnits"],
      ["reservedMinor", "reservedUnits"],
      ["priceMinorOverride", "priceUnitsOverride"],
    ];
    for (const [from, to] of top) {
      if (from in next) {
        if (next[to] === undefined) next[to] = next[from];
        delete next[from];
        dirty = true;
      }
    }

    for (const scheduleKey of ["priceSchedule", "costSchedule"] as const) {
      const sched = next[scheduleKey];
      if (!sched || typeof sched !== "object" || Array.isArray(sched)) continue;
      const s = { ...(sched as Record<string, unknown>) };
      let sDirty = false;
      for (const [minor, units] of SCHEDULE_LEAVES) {
        if (minor in s) {
          if (s[units] === undefined) s[units] = s[minor];
          delete s[minor];
          sDirty = true;
        }
      }
      if (sDirty) {
        next[scheduleKey] = s;
        dirty = true;
      }
    }

    if (dirty) {
      await outbox.updateOne({ _id: row._id }, { $set: { context: next } });
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
