import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import type { Filter } from "mongodb";
import { MANAGEMENT_SCOPES_META } from "@tokenpanel/contracts";
import {
  getDb,
  managementApiKeyDoc,
  managementApiKeyCreateInput,
  managementApiKeyUpdateInput,
  type ManagementApiKeyDoc,
} from "@tokenpanel/db";
import { requireAuth, requireRole, type AuthVariables } from "../middleware/auth.ts";
import {
  MANAGEMENT_KEY_PREFIX_LITERAL,
  API_KEY_LOOKUP_PREFIX_CHARS,
  issueApiKeyWithRetry,
} from "../services/api-key-issuer.ts";
import { parseObjectIdParam } from "./route-utils.ts";

export { MANAGEMENT_SCOPES_META };

const managementKeyRoutes = new Hono<{ Variables: AuthVariables }>();

// Full lifecycle is admin-only: listing prefixes/scopes/lastUsedAt is still
// sensitive metadata (targeting + social engineering), so members cannot list
// or read either — matches tokenpanel-ml2.3 acceptance criteria.
managementKeyRoutes.use("*", requireAuth, requireRole("admin"));

/** Literal `tp_mgmt_` prefix for management API keys. */
export const KEY_PREFIX_LITERAL = MANAGEMENT_KEY_PREFIX_LITERAL;
/**
 * Lookup prefix length — matches the public auth dispatcher's PREFIX_LENGTH so
 * a single slice(0, N) on either key kind resolves to the right doc.
 * 8 literal + 8 random hex ≈ 4.3B prefix combos.
 */
export const PREFIX_LENGTH = API_KEY_LOOKUP_PREFIX_CHARS;

type StrippedManagementKey = Omit<ManagementApiKeyDoc, "keyHash"> & { hasKey: true };

export function stripKey(doc: ManagementApiKeyDoc): StrippedManagementKey {
  const { keyHash: _omit, ...rest } = doc;
  void _omit;
  return { ...rest, hasKey: true };
}

export { parseObjectIdParam };

const listQuerySchema = z.object({
  status: z.enum(["active", "revoked"]).optional(),
});

managementKeyRoutes.get("/", zValidator("query", listQuerySchema), async (c) => {
  const orgId = c.get("orgId");
  const q = c.req.valid("query");
  const db = await getDb();

  const filter: Filter<ManagementApiKeyDoc> = { organizationId: orgId };
  if (q.status !== undefined) filter.status = q.status;

  const docs = await db.managementApiKeys
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();

  return c.json({ items: docs.map((d) => stripKey(d)) });
});

managementKeyRoutes.post(
  "/",
  zValidator("json", managementApiKeyCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    const db = await getDb();

    // Key material + bounded unique-prefix retry: services/api-key-issuer.ts
    const now = new Date();
    let createdDoc: ManagementApiKeyDoc | null = null;
    const result = await issueApiKeyWithRetry({
      literal: KEY_PREFIX_LITERAL,
      insert: async (issued) => {
        const doc: ManagementApiKeyDoc = managementApiKeyDoc.parse({
          _id: new ObjectId(),
          organizationId: orgId,
          name: body.name,
          prefix: issued.prefix,
          keyHash: issued.keyHash,
          scopes: body.scopes,
          status: "active",
          lastUsedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        await db.managementApiKeys.insertOne(doc);
        createdDoc = doc;
      },
    });

    if (!result.ok || !createdDoc) {
      return c.json({ error: "prefix_collision" }, 503);
    }

    return c.json(
      { managementKey: stripKey(createdDoc), key: result.issued.fullKey },
      201,
    );
  },
);

managementKeyRoutes.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();

  const doc = await db.managementApiKeys.findOne({ _id: oid, organizationId: orgId });
  if (!doc) return c.json({ error: "not_found" }, 404);

  return c.json(stripKey(doc));
});

managementKeyRoutes.patch(
  "/:id",
  zValidator("json", managementApiKeyUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      update[k] = v;
    }

    const updated = await db.managementApiKeys.findOneAndUpdate(
      { _id: oid, organizationId: orgId },
      { $set: update },
      { returnDocument: "after" },
    );
    if (!updated) return c.json({ error: "not_found" }, 404);

    return c.json(stripKey(updated));
  },
);

managementKeyRoutes.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();

  // Soft-delete: revoke so existing key-rotation analytics remains intact and
  // any in-flight request that authenticated seconds ago still completes. A
  // hard delete would break the prefix uniqueness invariant for any future key
  // that happened to collide on prefix.
  const updated = await db.managementApiKeys.findOneAndUpdate(
    { _id: oid, organizationId: orgId },
    { $set: { status: "revoked", updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!updated) return c.json({ error: "not_found" }, 404);

  return c.json({ ok: true, status: updated.status });
});

managementKeyRoutes.get("/__scopes/meta", (c) => {
  return c.json({ items: MANAGEMENT_SCOPES_META });
});

export default managementKeyRoutes;
export { managementKeyRoutes };
