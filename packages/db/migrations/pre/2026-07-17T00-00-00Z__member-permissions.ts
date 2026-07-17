import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Additive: membership.permissions + invite.permissions for fine-grained
 * member access control.
 *
 * Compat policy (Option A): existing member memberships without permissions
 * receive all panel *:read atoms so pre-existing read-only members keep
 * dashboard access. New members default to [] (deny) via schema.
 *
 * Frozen snapshot — do not import live @tokenpanel/contracts.
 */
export const id = "2026-07-17T00-00-00Z__member-permissions";
export const phase = "pre" as const;
export const transactional = true as const;

/** Snapshot of PANEL_READ_PERMISSIONS as of 2026-07-17. */
const READ_PERMISSIONS_SNAPSHOT = [
  "dashboard:read",
  "models:read",
  "providers:read",
  "customers:read",
  "balances:read",
  "usage:read",
  "plans:read",
  "customer_keys:read",
  "management_keys:read",
  "invites:read",
  "catalog_sources:read",
] as const;

export async function up(mdb: MigrationDb): Promise<void> {
  const users = mdb.collection("users");
  const invites = mdb.collection("invites");

  // Members missing permissions → grant read snapshot (compat).
  await users.updateMany(
    {
      memberships: {
        $elemMatch: {
          role: "member",
          $or: [
            { permissions: { $exists: false } },
            { permissions: null },
          ],
        },
      },
    },
    {
      $set: {
        "memberships.$[m].permissions": [...READ_PERMISSIONS_SNAPSHOT],
      },
    },
    {
      arrayFilters: [
        {
          "m.role": "member",
          $or: [
            { "m.permissions": { $exists: false } },
            { "m.permissions": null },
          ],
        },
      ],
    },
  );

  // Admins: ensure permissions field is [] (ignored at runtime).
  await users.updateMany(
    {
      memberships: {
        $elemMatch: {
          role: "admin",
          $or: [
            { permissions: { $exists: false } },
            { permissions: null },
          ],
        },
      },
    },
    {
      $set: { "memberships.$[m].permissions": [] },
    },
    {
      arrayFilters: [
        {
          "m.role": "admin",
          $or: [
            { "m.permissions": { $exists: false } },
            { "m.permissions": null },
          ],
        },
      ],
    },
  );

  // Invites: default permissions [].
  await invites.updateMany(
    {
      $or: [
        { permissions: { $exists: false } },
        { permissions: null },
      ],
    },
    { $set: { permissions: [] } },
  );
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Field removal is post-phase only; leave permissions arrays in place.
  void mdb;
}
