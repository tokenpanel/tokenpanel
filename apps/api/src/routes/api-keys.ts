import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import type { Filter } from "mongodb";
import {
  getDb,
  apiKeyUpdateInput,
  type ApiKeyDoc,
  type CustomerDoc,
} from "@tokenpanel/db";
import { requireAuth, requireRole, type AuthVariables } from "../middleware/auth.ts";
import { hashToken, randomToken, isDuplicateKeyError } from "../lib/crypto.ts";

const apiKeyRoutes = new Hono<{ Variables: AuthVariables }>();

apiKeyRoutes.use("*", requireAuth);

export const KEY_PREFIX_LITERAL = "tp_live_";
/**
 * Lookup prefix length — matches the public auth dispatcher's PREFIX_LENGTH
 * (16). 8 literal + 8 random hex ≈ 4.3B combos; birthday collision ~65K keys.
 */
export const PREFIX_LENGTH = 16;

/** Max regeneration attempts when a generated prefix collides with an existing one. */
const MAX_PREFIX_RETRIES = 5;

type StrippedApiKey = Omit<ApiKeyDoc, "keyHash"> & { hasKey: true };

export function stripKey(doc: ApiKeyDoc): StrippedApiKey {
  const { keyHash: _omit, ...rest } = doc;
  void _omit;
  return { ...rest, hasKey: true };
}

export function parseObjectIdParam(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

const listQuerySchema = z.object({
  customerId: z.string().min(1).max(64).optional(),
});

apiKeyRoutes.get("/", zValidator("query", listQuerySchema), async (c) => {
  const orgId = c.get("orgId");
  const q = c.req.valid("query");
  const db = await getDb();

  const filter: Filter<ApiKeyDoc> = { organizationId: orgId };
  if (q.customerId !== undefined) {
    if (!ObjectId.isValid(q.customerId)) {
      return c.json({ error: "invalid_customer_id" }, 400);
    }
    filter.customerId = new ObjectId(q.customerId);
  }

  const docs = await db.apiKeys
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();

  const items = docs.map((d) => stripKey(d as ApiKeyDoc));
  return c.json({ items });
});

const createBodySchema = z.object({
  customerId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  modelWhitelist: z.array(z.string().min(1).max(80)).optional(),
});

apiKeyRoutes.post("/", requireRole("admin"), zValidator("json", createBodySchema), async (c) => {
  const orgId = c.get("orgId");
  const body = c.req.valid("json");
  const db = await getDb();

  if (!ObjectId.isValid(body.customerId)) {
    return c.json({ error: "invalid_customer_id" }, 400);
  }
  const customerId = new ObjectId(body.customerId);

  const customer = await db.customers.findOne({
    _id: customerId,
    organizationId: orgId,
  });
  if (!customer) {
    return c.json({ error: "customer_not_found" }, 404);
  }

  // Build the secret: prefix literal + 24 random hex bytes. Prefix is exactly
  // PREFIX_LENGTH chars so the auth dispatcher can slice(0, N) on either key
  // kind. Full key is returned exactly once; only prefix + hash persist.
  //
  // Retry on a prefix collision against the unique index — astronomically
  // rare with 16 hex chars of entropy (16^8 ≈ 4.3B combos, birthday at ~65K
  // keys) but handled defensively so creation is deterministic for operators.
  const now = new Date();
  let attempt = 0;
  let created: { doc: ApiKeyDoc; fullKey: string } | null = null;
  while (attempt < MAX_PREFIX_RETRIES) {
    attempt += 1;
    const tokenPart = randomToken(24);
    const fullKey = `${KEY_PREFIX_LITERAL}${tokenPart}`;
    const prefix = fullKey.slice(0, PREFIX_LENGTH);
    const keyHash = hashToken(fullKey);

    const doc: ApiKeyDoc = {
      _id: new ObjectId(),
      organizationId: orgId,
      customerId,
      name: body.name,
      prefix,
      keyHash,
      modelWhitelist: body.modelWhitelist ?? [],
      status: "active",
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await db.apiKeys.insertOne(doc);
      created = { doc, fullKey };
      break;
    } catch (err) {
      if (isDuplicateKeyError(err)) continue;
      throw err;
    }
  }

  if (!created) {
    return c.json({ error: "prefix_collision" }, 503);
  }

  return c.json({ apiKey: stripKey(created.doc), key: created.fullKey }, 201);
});

apiKeyRoutes.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();

  const doc = await db.apiKeys.findOne({
    _id: oid,
    organizationId: orgId,
  });
  if (!doc) return c.json({ error: "not_found" }, 404);

  return c.json(stripKey(doc as ApiKeyDoc));
});

apiKeyRoutes.patch(
  "/:id",
  requireRole("admin"),
  zValidator("json", apiKeyUpdateInput),
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

    const updated = await db.apiKeys.findOneAndUpdate(
      { _id: oid, organizationId: orgId },
      { $set: update },
      { returnDocument: "after" },
    );
    if (!updated) return c.json({ error: "not_found" }, 404);

    return c.json(stripKey(updated as ApiKeyDoc));
  },
);

apiKeyRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();

  const updated = await db.apiKeys.findOneAndUpdate(
    { _id: oid, organizationId: orgId },
    { $set: { status: "revoked", updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!updated) return c.json({ error: "not_found" }, 404);

  return c.json({ ok: true, status: updated.status });
});

export default apiKeyRoutes;
export { apiKeyRoutes };
export type { CustomerDoc };