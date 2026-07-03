import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import {
  getDb,
  modelCreateInput,
  modelUpdateInput,
  fallbackReorderInput,
  modelEntryInput,
  type ModelDoc,
  type ModelEntryDoc,
} from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";

const modelRoutes = new Hono<{ Variables: AuthVariables }>();

export function genEntryId(): string {
  return new ObjectId().toHexString().slice(0, 12);
}

export function normalizeEntries(
  entries: z.infer<typeof modelEntryInput>[],
): Omit<ModelEntryDoc, "providerId">[] & { providerId: ObjectId }[] {
  return entries.map((e, i) => ({
    id: e.id ?? genEntryId(),
    providerId: e.providerId,
    upstreamModelId: e.upstreamModelId,
    cost: e.cost,
    price: e.price,
    priority: e.priority ?? i,
    active: e.active ?? true,
  }));
}

modelRoutes.use("*", requireAuth);

modelRoutes.get("/", async (c) => {
  const db = await getDb();
  const orgId = c.get("orgId");
  const items = await db.models
    .find({ organizationId: orgId })
    .sort({ createdAt: -1 })
    .toArray();
  return c.json({ items });
});

modelRoutes.post("/", requireRole("admin"), zValidator("json", modelCreateInput), async (c) => {
  const body = c.req.valid("json");
  const db = await getDb();
  const orgId = c.get("orgId");

  const providerIds = body.entries.map((e) => e.providerId);
  const providers = await db.providers
    .find({ _id: { $in: providerIds }, organizationId: orgId })
    .toArray();
  if (providers.length !== providerIds.length) {
    return c.json({ error: "provider_not_found" }, 400);
  }

  const entries = normalizeEntries(body.entries).sort(
    (a, b) => a.priority - b.priority,
  );

  const now = new Date();
  const insertRes = await db.models.insertOne({
    _id: new ObjectId(),
    organizationId: orgId,
    aliasId: body.aliasId,
    displayName: body.displayName,
    description: body.description ?? null,
    entries,
    reasoning: body.reasoning ?? false,
    toolCall: body.toolCall ?? false,
    structuredOutput: body.structuredOutput,
    temperature: body.temperature,
    attachment: body.attachment ?? false,
    limits: body.limits,
    modalities: body.modalities,
    status: body.status,
    price: body.price,
    marginBps: body.marginBps ?? 0,
    currency: body.currency,
    active: true,
    metadata: body.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  } as Omit<ModelDoc, "_id"> & { _id: ObjectId });
  const created = await db.models.findOne({ _id: insertRes.insertedId });
  return c.json(created, 201);
});

modelRoutes.get("/:id", async (c) => {
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const doc = await db.models.findOne({
    _id: new ObjectId(id),
    organizationId: c.get("orgId"),
  });
  if (!doc) return c.json({ error: "not_found" }, 404);
  return c.json(doc);
});

modelRoutes.patch("/:id", requireRole("admin"), zValidator("json", modelUpdateInput), async (c) => {
  const body = c.req.valid("json");
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const orgId = c.get("orgId");
  const existing = await db.models.findOne({
    _id: new ObjectId(id),
    organizationId: orgId,
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  if (body.entries) {
    const providerIds = body.entries.map((e) => e.providerId);
    const providers = await db.providers
      .find({ _id: { $in: providerIds }, organizationId: orgId })
      .toArray();
    if (providers.length !== providerIds.length) {
      return c.json({ error: "provider_not_found" }, 400);
    }
  }

  const $set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === "entries") {
      $set.entries = normalizeEntries(v as z.infer<typeof modelEntryInput>[]).sort(
        (a, b) => a.priority - b.priority,
      );
    } else {
      $set[k] = v;
    }
  }

  const updated = await db.models.findOneAndUpdate(
    { _id: new ObjectId(id), organizationId: orgId },
    { $set },
    { returnDocument: "after" },
  );
  return c.json(updated);
});

modelRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const res = await db.models.deleteOne({
    _id: new ObjectId(id),
    organizationId: c.get("orgId"),
  });
  if (res.deletedCount === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

modelRoutes.patch(
  "/:id/fallbacks",
  requireRole("admin"),
  zValidator("json", fallbackReorderInput),
  async (c) => {
    const body = c.req.valid("json");
    const db = await getDb();
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const orgId = c.get("orgId");
    const existing = await db.models.findOne({
      _id: new ObjectId(id),
      organizationId: orgId,
    });
    if (!existing) return c.json({ error: "not_found" }, 404);

    const priorityMap = new Map(body.entries.map((e) => [e.id, e.priority]));
    const validIds = new Set(existing.entries.map((e) => e.id));
    for (const e of body.entries) {
      if (!validIds.has(e.id)) return c.json({ error: "entry_not_found", id: e.id }, 400);
    }
    const newEntries = existing.entries
      .map((e) => ({ ...e, priority: priorityMap.get(e.id) ?? e.priority }))
      .sort((a, b) => a.priority - b.priority);

    const updated = await db.models.findOneAndUpdate(
      { _id: new ObjectId(id), organizationId: orgId },
      { $set: { entries: newEntries, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    return c.json(updated);
  },
);

modelRoutes.post("/:id/entries", requireRole("admin"), zValidator("json", modelEntryInput), async (c) => {
  const body = c.req.valid("json");
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const orgId = c.get("orgId");
  const existing = await db.models.findOne({
    _id: new ObjectId(id),
    organizationId: orgId,
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  const provider = await db.providers.findOne({
    _id: body.providerId,
    organizationId: orgId,
  });
  if (!provider) return c.json({ error: "provider_not_found" }, 400);

  const maxPriority = existing.entries.reduce((m, e) => Math.max(m, e.priority), -1);
  const newEntry: ModelEntryDoc = {
    id: body.id ?? genEntryId(),
    providerId: body.providerId,
    upstreamModelId: body.upstreamModelId,
    cost: body.cost,
    price: body.price,
    priority: body.priority ?? maxPriority + 1,
    active: body.active ?? true,
  };
  const entries = [...existing.entries, newEntry].sort((a, b) => a.priority - b.priority);
  const updated = await db.models.findOneAndUpdate(
    { _id: new ObjectId(id), organizationId: orgId },
    { $set: { entries, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  return c.json(updated);
});

modelRoutes.delete("/:id/entries/:entryId", requireRole("admin"), async (c) => {
  const db = await getDb();
  const id = c.req.param("id");
  const entryId = c.req.param("entryId");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const orgId = c.get("orgId");
  const existing = await db.models.findOne({
    _id: new ObjectId(id),
    organizationId: orgId,
  });
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.entries.length <= 1) {
    return c.json({ error: "last_entry" }, 409);
  }
  const entries = existing.entries.filter((e) => e.id !== entryId);
  if (entries.length === existing.entries.length) {
    return c.json({ error: "entry_not_found" }, 404);
  }
  const updated = await db.models.findOneAndUpdate(
    { _id: new ObjectId(id), organizationId: orgId },
    { $set: { entries, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  return c.json(updated);
});

export default modelRoutes;