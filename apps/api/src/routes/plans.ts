import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { zValidator } from "@hono/zod-validator";
import {
  getDb,
  subscriptionPlanCreateInput,
  subscriptionPlanUpdateInput,
  type RateLimitRuleInput,
  type SubscriptionPlanDoc,
} from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";

const planRoutes = new Hono<{ Variables: AuthVariables }>();
planRoutes.use("*", requireAuth);

export function genRuleId(): string {
  return new ObjectId().toHexString().slice(0, 12);
}

export function normalizeRules(rules: RateLimitRuleInput[]) {
  return rules.map((r, i) => ({
    id: r.id ?? genRuleId(),
    windowSeconds: r.windowSeconds,
    dimension: r.dimension,
    capValue: r.capValue,
    scope: r.scope ?? "customer",
    scopeTarget: r.scopeTarget ?? null,
    currency: r.currency ?? null,
    active: r.active ?? true,
    _index: i,
  })).map(({ _index, ...rest }) => ({ ...rest }));
}

planRoutes.get("/", async (c) => {
  const db = await getDb();
  const items = await db.subscriptionPlans
    .find({ organizationId: c.get("orgId") })
    .sort({ createdAt: -1 })
    .toArray();
  return c.json({ items });
});

planRoutes.post("/", requireRole("admin"), zValidator("json", subscriptionPlanCreateInput), async (c) => {
  const body = c.req.valid("json");
  const db = await getDb();
  const orgId = c.get("orgId");
  const now = new Date();
  const rateLimits = normalizeRules(body.rateLimits ?? []);
  const insertRes = await db.subscriptionPlans.insertOne({
    _id: new ObjectId(),
    organizationId: orgId,
    name: body.name,
    description: body.description ?? null,
    price: body.price,
    interval: body.interval,
    intervalCount: body.intervalCount,
    includedCredit: body.includedCredit ?? { amountMinor: 0, currency: "USD" },
    includedTokens: body.includedTokens ?? 0,
    rateLimits,
    active: true,
    createdAt: now,
    updatedAt: now,
  } as Omit<SubscriptionPlanDoc, "_id"> & { _id: ObjectId });
  const created = await db.subscriptionPlans.findOne({ _id: insertRes.insertedId });
  return c.json(created, 201);
});

planRoutes.get("/:id", async (c) => {
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const doc = await db.subscriptionPlans.findOne({
    _id: new ObjectId(id),
    organizationId: c.get("orgId"),
  });
  if (!doc) return c.json({ error: "not_found" }, 404);
  return c.json(doc);
});

planRoutes.patch("/:id", requireRole("admin"), zValidator("json", subscriptionPlanUpdateInput), async (c) => {
  const body = c.req.valid("json");
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const orgId = c.get("orgId");
  const existing = await db.subscriptionPlans.findOne({
    _id: new ObjectId(id),
    organizationId: orgId,
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  const $set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === "rateLimits") {
      $set.rateLimits = normalizeRules(v as RateLimitRuleInput[]);
    } else {
      $set[k] = v;
    }
  }
  const updated = await db.subscriptionPlans.findOneAndUpdate(
    { _id: new ObjectId(id), organizationId: orgId },
    { $set },
    { returnDocument: "after" },
  );
  return c.json(updated);
});

planRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const res = await db.subscriptionPlans.updateOne(
    { _id: new ObjectId(id), organizationId: c.get("orgId") },
    { $set: { active: false, updatedAt: new Date() } },
  );
  if (res.matchedCount === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default planRoutes;