import type { MigrationDb } from "../../src/migrator/migration-db.ts";

export const id = "2026-07-09T00-00-00Z__unique-customer-email-index";
export const phase = "post" as const;
/** Index drop/create is not safe inside a multi-doc transaction. */
export const transactional = false as const;

/**
 * After historical duplicate cleanup
 * (2026-07-07T02-00-00Z__lowercase-customer-emails), upgrade the customers
 * (organizationId, email) index from sparse non-unique to partial unique so
 * concurrent creates cannot recreate duplicates. Null emails are unbounded
 * (same pattern as externalId).
 *
 * Phase = post: dropIndex is destructive (SafeMigrate forbids it in pre/).
 * Ordering is filename/id order within post/, so this runs after the cleanup
 * migration. Applied state is tracked in `_migrations`.
 */
export async function up(mdb: MigrationDb): Promise<void> {
  const customers = mdb.collection("customers");

  // Bootstrap creates sparse non-unique with default name organizationId_1_email_1.
  // Drop it if present so we can replace with a unique partial. Ignore missing.
  const legacyName = "organizationId_1_email_1";
  try {
    await customers.dropIndex(legacyName);
    console.log(
      `[migration:unique-customer-email-index] dropped non-unique index "${legacyName}"`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // IndexNotFound is fine (fresh install that never had it, or already dropped).
    if (!/index not found/i.test(msg) && !/ns not found/i.test(msg)) {
      // Also accept Mongo code 27 IndexNotFound if message format differs.
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: number }).code
          : undefined;
      if (code !== 27) throw err;
    }
    console.log(
      `[migration:unique-customer-email-index] index "${legacyName}" not present — continuing`,
    );
  }

  await customers.createIndex(
    { organizationId: 1, email: 1 },
    {
      unique: true,
      name: "organizationId_1_email_1_unique",
      partialFilterExpression: { email: { $type: "string" } },
    },
  );
  console.log(
    "[migration:unique-customer-email-index] unique partial (organizationId, email) index ensured",
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error("Unique customer email index migration cannot be rolled back");
}
