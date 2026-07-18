import type { MigrationDb } from "../../src/migrator/migration-db.ts";
import type { ObjectId } from "mongodb";

/**
 * Bind each admin session to an organization (per-session tenant context).
 *
 * Background: resolveAdminSession previously used user.activeOrganizationId,
 * so switching org on one device rewrote tenant context for every session.
 * Session rows now own organizationId; request auth reads that field.
 *
 * Phase = post: rewrites existing admin_sessions documents (backfill or
 * delete). New writes already set organizationId at insert time.
 *
 * Strategy:
 * 1. Backfill missing organizationId from the user's activeOrganizationId.
 * 2. Delete orphan sessions (user gone or no usable active org).
 */
export const id = "2026-07-17T12-00-00Z__admin-session-organization-id";
export const phase = "post" as const;
export const transactional = true as const;

type SessionRow = {
  _id: ObjectId;
  userId: ObjectId;
  organizationId?: ObjectId;
};

type UserRow = {
  _id: ObjectId;
  activeOrganizationId?: ObjectId;
};

export async function up(mdb: MigrationDb): Promise<void> {
  const sessions = mdb.collection<SessionRow>("admin_sessions");
  const users = mdb.collection<UserRow>("users");

  const missing = await sessions
    .find({ organizationId: { $exists: false } })
    .toArray();

  let deleted = 0;
  for (const row of missing) {
    const user = await users.findOne({ _id: row.userId });
    const orgId = user?.activeOrganizationId;
    if (!orgId) {
      const reason = user ? "user has no activeOrganizationId" : "user not found";
      console.warn(
        `[migration:admin-session-organization-id] deleting orphan session _id=${row._id.toHexString()} userId=${row.userId.toHexString()} reason=${reason}`,
      );
      await sessions.deleteOne({ _id: row._id });
      deleted++;
      continue;
    }
    await sessions.updateOne(
      { _id: row._id },
      { $set: { organizationId: orgId } },
    );
  }
  console.warn(`[migration:admin-session-organization-id] deleted ${deleted} orphan sessions`);
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Optional rollback: drop the field. Live sessions without organizationId
  // will fail schema decode under the new app — operators should re-login.
  const sessions = mdb.collection("admin_sessions");
  await sessions.updateMany({}, { $unset: { organizationId: "" } });
}
