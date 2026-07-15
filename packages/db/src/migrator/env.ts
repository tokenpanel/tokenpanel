/**
 * Migrator executable env parser (separate from application runtime config).
 * The migrator is its own process boundary and may run without the API.
 */

export type MigratorRuntimeConfig = Readonly<{
  uri: string;
  databaseName: string;
}>;

export function parseMigratorEnv(
  source: Readonly<Record<string, string | undefined>>,
): MigratorRuntimeConfig {
  const uri = source.MONGODB_URI;
  if (!uri || uri.length === 0) {
    throw new Error(
      "MONGODB_URI not set. Required for migrator (mongodb:// or mongodb+srv://).",
    );
  }
  if (!uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
    throw new Error("MONGODB_URI must start with mongodb:// or mongodb+srv://");
  }
  const databaseName =
    source.MONGODB_DB && source.MONGODB_DB.length > 0
      ? source.MONGODB_DB
      : "tokenpanel";
  return Object.freeze({ uri, databaseName });
}
