import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import {
  getDb,
  providerCreateInput,
  providerUpdateInput,
  type ProviderDoc,
  type ModelCatalogDoc,
} from "@tokenpanel/db";
import { requireAuth, type AuthVariables } from "../middleware/auth.ts";
import { encryptSecret, decryptSecret } from "../lib/crypto.ts";
import {
  getAdapter,
  listAdapters,
  buildAdapterContext,
  type DiscoveredModel,
} from "../providers/index.ts";

type ProviderResponse = Omit<ProviderDoc, "apiKeyEncrypted"> & {
  hasApiKey: boolean;
};

export function maskProvider(doc: ProviderDoc): ProviderResponse {
  const { apiKeyEncrypted, ...rest } = doc;
  void apiKeyEncrypted;
  return { ...rest, hasApiKey: true };
}

export function parseObjectIdParam(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

export const providerRoutes = new Hono<{ Variables: AuthVariables }>();

providerRoutes.use("*", requireAuth);

providerRoutes.get("/adapters", (c) => {
  return c.json({ items: listAdapters() });
});

providerRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const db = await getDb();
  const docs = await db.providers
    .find({ organizationId: orgId })
    .sort({ createdAt: -1 })
    .toArray();
  const items = docs.map(maskProvider);
  return c.json({ items });
});

providerRoutes.post("/", zValidator("json", providerCreateInput), async (c) => {
  const orgId = c.get("orgId");
  const body = c.req.valid("json");
  if (!getAdapter(body.sdkType)) {
    return c.json({ error: "unknown_sdk_type", sdkType: body.sdkType }, 422);
  }
  const db = await getDb();
  const now = new Date();
  const doc: ProviderDoc = {
    _id: new ObjectId(),
    organizationId: orgId,
    name: body.name,
    sdkType: body.sdkType,
    apiKeyEncrypted: encryptSecret(body.apiKey),
    baseUrl: body.baseUrl,
    providerOrg: body.providerOrg ?? null,
    headers: body.headers ?? {},
    active: true,
    metadata: body.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
  const insertResult = await db.providers.insertOne(doc);
  const created = await db.providers.findOne({ _id: insertResult.insertedId });
  if (!created) {
    return c.json({ error: "insert_failed" }, 500);
  }
  return c.json(maskProvider(created), 201);
});

providerRoutes.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const doc = await db.providers.findOne({ _id: oid, organizationId: orgId });
  if (!doc) return c.json({ error: "not_found" }, 404);
  return c.json(maskProvider(doc));
});

providerRoutes.patch(
  "/:id",
  zValidator("json", providerUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    if (body.sdkType !== undefined && !getAdapter(body.sdkType)) {
      return c.json({ error: "unknown_sdk_type", sdkType: body.sdkType }, 422);
    }
    const db = await getDb();
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "apiKey") {
        update.apiKeyEncrypted = encryptSecret(v as string);
      } else {
        update[k] = v;
      }
    }
    const updated = await db.providers.findOneAndUpdate(
      { _id: oid, organizationId: orgId },
      { $set: update },
      { returnDocument: "after" },
    );
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json(maskProvider(updated));
  },
);

providerRoutes.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const existing = await db.providers.findOne({
    _id: oid,
    organizationId: orgId,
  });
  if (!existing) return c.json({ error: "not_found" }, 404);
  const refCount = await db.models.countDocuments({
    organizationId: orgId,
    "entries.providerId": oid,
  });
  if (refCount > 0) {
    return c.json({ error: "provider_in_use", refCount }, 409);
  }
  await db.modelCatalog.deleteMany({
    organizationId: orgId,
    providerId: oid,
  });
  await db.providers.deleteOne({ _id: oid, organizationId: orgId });
  return c.json({ ok: true });
});

providerRoutes.get("/:id/discover-models", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const provider = await db.providers.findOne({
    _id: oid,
    organizationId: orgId,
  });
  if (!provider) return c.json({ error: "not_found" }, 404);
  const adapter = getAdapter(provider.sdkType);
  if (!adapter) {
    return c.json(
      { error: "unknown_sdk_type", sdkType: provider.sdkType },
      422,
    );
  }
  const apiKey = decryptSecret(provider.apiKeyEncrypted);
  const ctx = buildAdapterContext({
    baseUrl: provider.baseUrl,
    apiKey,
    providerOrg: provider.providerOrg,
    headers: provider.headers,
  });
  let models: DiscoveredModel[];
  try {
    models = await adapter.listModels(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "upstream_error", message }, 502);
  }
  const now = new Date();
  for (const m of models) {
    const setFields: Record<string, unknown> = {
      displayName: m.displayName,
      reasoning: m.reasoning ?? false,
      toolCall: m.toolCall ?? false,
      attachment: m.attachment ?? false,
      limits: m.limits,
      modalities: m.modalities,
      raw: m.raw ?? {},
      discoveredAt: now,
      updatedAt: now,
    };
    if (m.structuredOutput !== undefined)
      setFields.structuredOutput = m.structuredOutput;
    if (m.temperature !== undefined) setFields.temperature = m.temperature;
    if (m.status !== undefined) setFields.status = m.status;
    if (m.cost !== undefined) setFields.cost = m.cost;
    await db.modelCatalog.findOneAndUpdate(
      {
        organizationId: orgId,
        providerId: oid,
        upstreamModelId: m.upstreamModelId,
      },
      {
        $set: setFields,
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
  return c.json({ items: models });
});

providerRoutes.get("/:id/models", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const provider = await db.providers.findOne({
    _id: oid,
    organizationId: orgId,
  });
  if (!provider) return c.json({ error: "not_found" }, 404);
  const items = await db.modelCatalog
    .find({ organizationId: orgId, providerId: oid })
    .sort({ upstreamModelId: 1 })
    .toArray();
  return c.json({ items: items as ModelCatalogDoc[] });
});

export default providerRoutes;