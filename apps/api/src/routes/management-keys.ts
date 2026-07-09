import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import type { Filter } from "mongodb";
import {
  getDb,
  managementApiKeyDoc,
  managementApiKeyCreateInput,
  managementApiKeyUpdateInput,
  type ManagementApiKeyDoc,
  type ManagementScope,
} from "@tokenpanel/db";
import { requireAuth, requireRole, type AuthVariables } from "../middleware/auth.ts";
import { hashToken, randomToken, isDuplicateKeyError } from "../lib/crypto.ts";
import { PREFIX_LENGTH as PUBLIC_PREFIX_LENGTH } from "../middleware/public-auth.ts";

const managementKeyRoutes = new Hono<{ Variables: AuthVariables }>();

// Full lifecycle is admin-only: listing prefixes/scopes/lastUsedAt is still
// sensitive metadata (targeting + social engineering), so members cannot list
// or read either — matches tokenpanel-ml2.3 acceptance criteria.
managementKeyRoutes.use("*", requireAuth, requireRole("admin"));

/** Literal `tp_mgmt_` prefix for management API keys. */
export const KEY_PREFIX_LITERAL = "tp_mgmt_";
/**
 * Lookup prefix length — matches the public auth dispatcher's PREFIX_LENGTH so
 * a single slice(0, N) on either key kind resolves to the right doc.
 * 8 literal + 8 random hex ≈ 4.3B prefix combos.
 */
export const PREFIX_LENGTH = PUBLIC_PREFIX_LENGTH;

/** Max regeneration attempts when a generated prefix collides with an existing one. */
const MAX_PREFIX_RETRIES = 5;

type StrippedManagementKey = Omit<ManagementApiKeyDoc, "keyHash"> & { hasKey: true };

export function stripKey(doc: ManagementApiKeyDoc): StrippedManagementKey {
  const { keyHash: _omit, ...rest } = doc;
  void _omit;
  return { ...rest, hasKey: true };
}

export function parseObjectIdParam(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

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

    // Build the secret: prefix literal + 24 random hex bytes. The prefix is
    // exactly PREFIX_LENGTH chars so the auth dispatcher can slice(0, N) on
    // either key kind without knowing which kind it is. Full key is returned
    // exactly once; only prefix + hash persist.
    //
    // Retry on a prefix-collision against the unique index so an operator
    // never sees a 500 from a vanishingly-rare birthday collision. With 16
    // hex chars of entropy (16^8 ≈ 4.3B combos) the probability of even one
    // collision across thousands of keys is < 1e-6, but we handle it anyway
    // — the cost is one extra hash per retry, the benefit is deterministic
    // creation semantics.
    const now = new Date();
    let attempt = 0;
    let created: { doc: ManagementApiKeyDoc; fullKey: string } | null = null;
    while (attempt < MAX_PREFIX_RETRIES) {
      attempt += 1;
      const tokenPart = randomToken(24);
      const fullKey = `${KEY_PREFIX_LITERAL}${tokenPart}`;
      const prefix = fullKey.slice(0, PREFIX_LENGTH);
      const keyHash = hashToken(fullKey);

      const doc: ManagementApiKeyDoc = managementApiKeyDoc.parse({
        _id: new ObjectId(),
        organizationId: orgId,
        name: body.name,
        prefix,
        keyHash,
        scopes: body.scopes,
        status: "active",
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      try {
        await db.managementApiKeys.insertOne(doc);
        created = { doc, fullKey };
        break;
      } catch (err) {
        if (isDuplicateKeyError(err)) continue;
        throw err;
      }
    }

    if (!created) {
      // Exhausted retries — astronomically unlikely (would require 5
      // consecutive 16-hex-char collisions), but surface a clear error
      // rather than succeeding with a non-unique key.
      return c.json({ error: "prefix_collision" }, 503);
    }

    return c.json({ managementKey: stripKey(created.doc), key: created.fullKey }, 201);
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

export const MANAGEMENT_SCOPES_META: readonly { scope: ManagementScope; group: string; description: string }[] = [
  { scope: "models:read", group: "Models", description: "List models and read capabilities / pricing." },
  { scope: "customers:read", group: "Customers", description: "Look up customers by email and read their details." },
  { scope: "customers:write", group: "Customers", description: "Create / update / suspend / reactivate customers." },
  { scope: "balances:read", group: "Balances", description: "Read customer balance and ledger history." },
  { scope: "balances:write", group: "Balances", description: "Top up / adjust / refund customer balances." },
  { scope: "usage:read", group: "Usage", description: "Read per-customer usage summaries." },
  { scope: "plans:read", group: "Plans", description: "List subscription plans." },
  { scope: "subscriptions:write", group: "Plans", description: "Assign / change a customer's subscription plan." },
  { scope: "chat:write", group: "Chat", description: "Call /v1/chat/completions and /v1/messages." },
];

managementKeyRoutes.get("/__scopes/meta", (c) => {
  return c.json({ items: MANAGEMENT_SCOPES_META });
});

export default managementKeyRoutes;
export { managementKeyRoutes };
