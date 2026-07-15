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
import {
  CUSTOMER_KEY_PREFIX_LITERAL,
  API_KEY_LOOKUP_PREFIX_CHARS,
  issueApiKeyWithRetry,
} from "../services/api-key-issuer.ts";
import { parseObjectIdParam } from "./route-utils.ts";

const apiKeyRoutes = new Hono<{ Variables: AuthVariables }>();

apiKeyRoutes.use("*", requireAuth);

export const KEY_PREFIX_LITERAL = CUSTOMER_KEY_PREFIX_LITERAL;
/**
 * Lookup prefix length — matches the public auth dispatcher's PREFIX_LENGTH
 * (16). 8 literal + 8 random hex ≈ 4.3B combos; birthday collision ~65K keys.
 */
export const PREFIX_LENGTH = API_KEY_LOOKUP_PREFIX_CHARS;

type StrippedApiKey = Omit<ApiKeyDoc, "keyHash"> & { hasKey: true };

export function stripKey(doc: ApiKeyDoc): StrippedApiKey {
  const { keyHash: _omit, ...rest } = doc;
  void _omit;
  return { ...rest, hasKey: true };
}

export { parseObjectIdParam };

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

  // Key material + bounded unique-prefix retry: apps/api/src/services/api-key-issuer.ts
  const now = new Date();
  let createdDoc: ApiKeyDoc | null = null;
  const result = await issueApiKeyWithRetry({
    literal: KEY_PREFIX_LITERAL,
    insert: async (issued) => {
      const doc: ApiKeyDoc = {
        _id: new ObjectId(),
        organizationId: orgId,
        customerId,
        name: body.name,
        prefix: issued.prefix,
        keyHash: issued.keyHash,
        modelWhitelist: body.modelWhitelist ?? [],
        status: "active",
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await db.apiKeys.insertOne(doc);
      createdDoc = doc;
    },
  });

  if (!result.ok || !createdDoc) {
    return c.json({ error: "prefix_collision" }, 503);
  }

  return c.json({ apiKey: stripKey(createdDoc), key: result.issued.fullKey }, 201);
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