import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Admin JWT session allowlist.
 * - TTL on expiresAt auto-GCs expired rows (expireAfterSeconds: 0).
 * - userId index supports revoke-all on password change.
 *
 * createIndexes cannot run inside a multi-doc transaction.
 */
export const id = "2026-07-17T03-04-22Z__admin-sessions";
export const phase = "pre" as const;
export const transactional = false as const;

export async function up(mdb: MigrationDb): Promise<void> {
  const sessions = mdb.collection("admin_sessions");
  await sessions.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "admin_sessions_ttl_expiresAt" },
  );
  await sessions.createIndex(
    { userId: 1 },
    { name: "admin_sessions_userId" },
  );
}

export async function down(mdb: MigrationDb): Promise<void> {
  const sessions = mdb.collection("admin_sessions");
  await sessions.dropIndex("admin_sessions_ttl_expiresAt").catch(() => undefined);
  await sessions.dropIndex("admin_sessions_userId").catch(() => undefined);
}
