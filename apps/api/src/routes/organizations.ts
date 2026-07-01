import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import {
  getDb,
  organizationApiCreateInput,
  organizationApiUpdateInput,
  type OrganizationDoc,
  type UserDoc,
  type UserRole,
} from "@tokenpanel/db";
import { requireAuth, type AuthVariables } from "../middleware/auth.ts";
import { signJwt, randomToken } from "../lib/crypto.ts";

export const organizationRoutes = new Hono<{ Variables: AuthVariables }>();

organizationRoutes.use("*", requireAuth);

/** Response shape for an organization doc (no ObjectId/Date leaking). */
export function toResponse(doc: OrganizationDoc) {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    slug: doc.slug,
    ownerId: doc.ownerId.toHexString(),
    defaultCurrency: doc.defaultCurrency,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Derive a lowercase-hyphenated slug from a name. */
export function deriveSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

/** Find a unique slug, appending a short random suffix on collision. */
async function uniqueSlug(db: Awaited<ReturnType<typeof getDb>>, base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 32; i++) {
    const existing = await db.organizations.findOne({ slug });
    if (!existing) return slug;
    slug = `${base}-${randomToken(2)}`;
  }
  return `${base}-${randomToken(4)}`;
}

/** Membership lookup helper: the user's role for a given org, or null. */
function roleForOrg(user: UserDoc, orgId: ObjectId): UserRole | null {
  const m = user.memberships.find((mm) => mm.organizationId.equals(orgId));
  return m ? m.role : null;
}

/** All org ids the user is a member of. */
function memberOrgIds(user: UserDoc): ObjectId[] {
  return user.memberships.map((m) => m.organizationId);
}

// List orgs the authenticated user belongs to, with their per-org role.
organizationRoutes.get("/", async (c) => {
  const user = c.get("user");
  const db = await getDb();
  const docs = await db.organizations
    .find({ _id: { $in: memberOrgIds(user) } })
    .sort({ createdAt: 1 })
    .toArray();
  return c.json({
    items: docs.map((d) => ({ ...toResponse(d), role: roleForOrg(user, d._id) })),
    activeOrganizationId: user.activeOrganizationId.toHexString(),
  });
});

// Create a new org. The creator becomes the owner + is added as an admin
// member of the new org, and the new org becomes their active org. A fresh
// JWT scoped to the new org is issued.
organizationRoutes.post(
  "/",
  zValidator("json", organizationApiCreateInput),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const secret = process.env.JWT_SECRET;
    if (!secret) return c.json({ error: "server_misconfigured" }, 500);

    const db = await getDb();
    const now = new Date();
    const orgId = new ObjectId();
    const baseSlug = body.slug ?? deriveSlug(body.name);
    const slug = await uniqueSlug(db, baseSlug);

    const orgDoc: Omit<OrganizationDoc, "_id"> & { _id: ObjectId } = {
      _id: orgId,
      name: body.name,
      slug,
      ownerId: user._id,
      defaultCurrency: body.defaultCurrency ?? "USD",
      createdAt: now,
      updatedAt: now,
    };

    try {
      await db.organizations.insertOne(orgDoc);
    } catch {
      return c.json({ error: "organization_creation_failed" }, 409);
    }

    await db.users.updateOne(
      { _id: user._id },
      {
        $push: { memberships: { organizationId: orgId, role: "admin" } },
        $set: { activeOrganizationId: orgId, updatedAt: now },
      },
    );

    const token = signJwt(
      {
        sub: user._id.toHexString(),
        orgId: orgId.toHexString(),
        role: "admin",
      },
      secret,
    );

    const created = await db.organizations.findOne({ _id: orgId });
    if (!created) return c.json({ error: "insert_failed" }, 500);

    return c.json(
      { organization: { ...toResponse(created), role: "admin" }, token },
      201,
    );
  },
);

organizationRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const oid = new ObjectId(id);
  const role = roleForOrg(user, oid);
  if (!role) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const doc = await db.organizations.findOne({ _id: oid });
  if (!doc) return c.json({ error: "not_found" }, 404);
  return c.json({ ...toResponse(doc), role });
});

organizationRoutes.patch(
  "/:id",
  zValidator("json", organizationApiUpdateInput),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const oid = new ObjectId(id);
    if (!roleForOrg(user, oid)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();

    const $set: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "slug") {
        const existing = await db.organizations.findOne({
          slug: v,
          _id: { $ne: oid },
        });
        if (existing) return c.json({ error: "slug_taken" }, 409);
      }
      $set[k] = v;
    }

    const updated = await db.organizations.findOneAndUpdate(
      { _id: oid },
      { $set },
      { returnDocument: "after" },
    );
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ ...toResponse(updated), role: roleForOrg(user, oid) });
  },
);

// Delete an org. Owner only. Refused if the org still has any business data
// (providers/customers/models/plans/apiKeys) — user must clean up first.
// Also refused if it's the user's only org (a user must always belong to one).
organizationRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const oid = new ObjectId(id);
  if (!roleForOrg(user, oid)) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const org = await db.organizations.findOne({ _id: oid });
  if (!org) return c.json({ error: "not_found" }, 404);
  if (!org.ownerId.equals(user._id)) {
    return c.json({ error: "forbidden", reason: "not_owner" }, 403);
  }
  if (user.memberships.length <= 1) {
    return c.json({ error: "last_org", message: "cannot delete your only organization" }, 409);
  }

  const [providers, customers, models, plans, apiKeys] = await Promise.all([
    db.providers.countDocuments({ organizationId: oid }),
    db.customers.countDocuments({ organizationId: oid }),
    db.models.countDocuments({ organizationId: oid }),
    db.subscriptionPlans.countDocuments({ organizationId: oid }),
    db.apiKeys.countDocuments({ organizationId: oid }),
  ]);
  const counts = { providers, customers, models, plans, apiKeys };
  const total = providers + customers + models + plans + apiKeys;
  if (total > 0) {
    return c.json({ error: "org_not_empty", counts }, 409);
  }

  // Remove the org from every member's memberships. For any user whose
  // activeOrganizationId was this org, repoint to another remaining org.
  const members = await db.users
    .find({ "memberships.organizationId": oid })
    .toArray();
  for (const m of members) {
    const remaining = m.memberships.filter(
      (mm) => !mm.organizationId.equals(oid),
    );
    if (remaining.length === 0) continue; // shouldn't happen, but guard
    const stillActive = remaining.some((mm) =>
      mm.organizationId.equals(m.activeOrganizationId),
    );
    const nextActive = stillActive
      ? m.activeOrganizationId
      : remaining[0]!.organizationId;
    await db.users.updateOne(
      { _id: m._id },
      {
        $pull: { memberships: { organizationId: oid } },
        $set: { activeOrganizationId: nextActive, updatedAt: new Date() },
      },
    );
  }

  // Clean up invites for this org (no business data left to worry about).
  await db.invites.deleteMany({ organizationId: oid });
  await db.organizations.deleteOne({ _id: oid });
  return c.json({ ok: true });
});

// Switch the active organization for the current session. Issues a new JWT
// scoped to the chosen org with that membership's role. The org must be one
// of the user's memberships.
organizationRoutes.post("/switch", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null) as
    | { organizationId?: string }
    | null;
  const targetId = body?.organizationId;
  if (!targetId || !ObjectId.isValid(targetId)) {
    return c.json({ error: "invalid_organization_id" }, 400);
  }
  const oid = new ObjectId(targetId);
  const role = roleForOrg(user, oid);
  if (!role) return c.json({ error: "forbidden", reason: "not_a_member" }, 403);

  const db = await getDb();
  const org = await db.organizations.findOne({ _id: oid });
  if (!org) return c.json({ error: "not_found" }, 404);

  await db.users.updateOne(
    { _id: user._id },
    { $set: { activeOrganizationId: oid, updatedAt: new Date() } },
  );

  const secret = process.env.JWT_SECRET;
  if (!secret) return c.json({ error: "server_misconfigured" }, 500);
  const token = signJwt(
    {
      sub: user._id.toHexString(),
      orgId: oid.toHexString(),
      role,
    },
    secret,
  );
  return c.json({
    token,
    role,
    activeOrganizationId: oid.toHexString(),
    organization: { ...toResponse(org), role },
  });
});

export default organizationRoutes;
