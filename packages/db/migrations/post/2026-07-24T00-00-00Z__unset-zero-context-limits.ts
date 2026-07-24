import type { ObjectId } from "mongodb";
import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Heal model_catalog rows whose limits.context is 0 or negative.
 *
 * The openai-compatible discovery adapter historically wrote
 * `limits.context: 0` when the upstream /models endpoint omitted
 * context_window (OPENAI_DEFAULT_CONTEXT_TOKENS = 0). The schema
 * (TokenLimits.context) required PositiveSafeInt, so every subsequent
 * read of the catalog (listProviderCatalog) decoded these rows as
 * PersistenceDataError → 500.
 *
 * Fix: $unset limits.context on affected rows so the now-optional
 * field is absent (honest "unknown") rather than a lying 0.
 *
 * Also heals the models collection defensively — the admin form
 * historically required a positive context, but a direct DB write
 * or future code path could have introduced the same defect.
 */

export const id = "2026-07-24T00-00-00Z__unset-zero-context-limits";
export const phase = "post" as const;
export const transactional = true as const;

type CatalogRow = { _id: ObjectId };

export async function up(mdb: MigrationDb): Promise<void> {
  // Filter: limits.context exists but is not a positive number.
  const filter = {
    "limits.context": { $exists: true, $not: { $gt: 0 } },
  };

  // --- model_catalog ---
  const catalogRows = (await mdb
    .collection("model_catalog")
    .find(filter, { projection: { _id: 1 } })
    .toArray()) as unknown as CatalogRow[];

  if (catalogRows.length > 0) {
    await mdb.collection("model_catalog").updateMany(filter, {
      $unset: { "limits.context": "" },
    });
  }

  // --- models (defensive) ---
  const modelRows = (await mdb
    .collection("models")
    .find(filter, { projection: { _id: 1 } })
    .toArray()) as unknown as CatalogRow[];

  if (modelRows.length > 0) {
    await mdb.collection("models").updateMany(filter, {
      $unset: { "limits.context": "" },
    });
  }

  console.log(
    `[migration:unset-zero-context-limits] healed ${catalogRows.length} model_catalog row(s), ${modelRows.length} model row(s)`,
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  // No-op: we cannot reconstruct the original (invalid) value.
  // The field was 0 or negative — both are schema-invalid — so
  // there is nothing meaningful to restore.
}
