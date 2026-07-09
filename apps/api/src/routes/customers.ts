import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import {
  getDb,
  getClient,
  customerCreateInput,
  customerUpdateInput,
  type CustomerDoc,
  type BalanceAdjustmentDoc,
  type SubscriptionDoc,
  type SubscriptionPlanDoc,
} from "@tokenpanel/db";
import type { Document, Filter } from "mongodb";
import { requireAuth, requireRole, type AuthVariables } from "../middleware/auth.ts";
import { isDuplicateKeyError } from "../lib/crypto.ts";

const app = new Hono<{ Variables: AuthVariables }>();

app.use("*", requireAuth);

/**
 * Sentinel thrown inside the balance-write transaction when the
 * findOneAndUpdate matches no row (customer deleted between the existence
 * check and the txn). Aborts the txn so the ledger insert rolls back; the
 * caller maps it to a 404.
 */
class BalanceCustomerGone extends Error {}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  skip: z.coerce.number().int().min(0).default(0),
  status: z.enum(["active", "suspended", "closed"]).optional(),
  q: z.string().max(160).optional(),
});

app.get("/", zValidator("query", listQuerySchema), async (c) => {
  const orgId = c.get("orgId");
  const q = c.req.valid("query");
  const db = await getDb();

  const filter: Filter<CustomerDoc> = { organizationId: orgId };
  if (q.status !== undefined) filter["status"] = q.status;
  if (q.q !== undefined && q.q.length > 0) {
    const esc = q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["$or"] = [
      { name: { $regex: esc, $options: "i" } },
      { email: { $regex: esc, $options: "i" } },
    ];
  }

  const [items, total] = await Promise.all([
    db.customers
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(q.skip)
      .limit(q.limit)
      .toArray(),
    db.customers.countDocuments(filter),
  ]);

  return c.json({ items: items as CustomerDoc[], total });
});

app.post("/", requireRole("admin"), zValidator("json", customerCreateInput), async (c) => {
  const orgId = c.get("orgId");
  const body = c.req.valid("json");
  const db = await getDb();

  const now = new Date();
  const startingBalance =
    body.startingBalance ?? { amountMinor: 0, currency: "USD" };

  const or: Filter<CustomerDoc>[] = [];
  if (body.externalId !== undefined) or.push({ externalId: body.externalId });
  if (body.email !== undefined) or.push({ email: body.email });
  if (or.length > 0) {
    const conflict = await db.customers.findOne({
      organizationId: orgId,
      $or: or,
    } as Filter<CustomerDoc>);
    if (conflict) {
      return c.json({ error: "duplicate_external_id_or_email" }, 409);
    }
  }

  const customerId = new ObjectId();
  const doc: CustomerDoc = {
    _id: customerId,
    organizationId: orgId,
    externalId: body.externalId ?? null,
    name: body.name,
    email: body.email ?? null,
    balance: startingBalance,
    status: "active",
    metadata: body.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };

  // Non-zero opening balance must land in the ledger in the same transaction
  // so balance never diverges from balance_adjustments.
  const session = getClient().startSession();
  let created: CustomerDoc | null = null;
  try {
    await session.withTransaction(async () => {
      await db.customers.insertOne(doc, { session });
      if (startingBalance.amountMinor !== 0) {
        const adjustment: BalanceAdjustmentDoc = {
          _id: new ObjectId(),
          organizationId: orgId,
          customerId,
          amountMinor: startingBalance.amountMinor,
          currency: startingBalance.currency,
          reason: "topup",
          usageRecordId: null,
          note: "opening balance",
          occurredAt: now,
          createdAt: now,
          updatedAt: now,
        };
        await db.balanceAdjustments.insertOne(adjustment, { session });
      }
      created = doc;
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return c.json({ error: "duplicate_external_id_or_email" }, 409);
    }
    throw err;
  } finally {
    await session.endSession();
  }
  if (!created) {
    return c.json({ error: "insert_failed" }, 500);
  }
  return c.json(created as CustomerDoc, 201);
});

export function parseObjectIdParam(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

app.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const doc = await db.customers.findOne({ _id: oid, organizationId: orgId });
  if (!doc) return c.json({ error: "not_found" }, 404);
  return c.json(doc as CustomerDoc);
});

app.patch("/:id", requireRole("admin"), zValidator("json", customerUpdateInput), async (c) => {
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

  if (body.externalId !== undefined || body.email !== undefined) {
    const or: Filter<CustomerDoc>[] = [];
    if (body.externalId !== undefined) or.push({ externalId: body.externalId });
    if (body.email !== undefined) or.push({ email: body.email });
    const dup = await db.customers.findOne({
      organizationId: orgId,
      _id: { $ne: oid },
      $or: or,
    } as Filter<CustomerDoc>);
    if (dup) return c.json({ error: "duplicate_external_id_or_email" }, 409);
  }

  const updated = await db.customers.findOneAndUpdate(
    { _id: oid, organizationId: orgId },
    { $set: update },
    { returnDocument: "after" },
  );
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json(updated as CustomerDoc);
});

app.delete("/:id", requireRole("admin"), async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();
  const updated = await db.customers.findOneAndUpdate(
    { _id: oid, organizationId: orgId },
    { $set: { status: "closed", updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, status: updated.status });
});

const balanceBodySchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  reason: z.enum(["topup", "adjustment", "refund"]).default("topup"),
  note: z.string().max(280).optional(),
});

app.post(
  "/:id/balance",
  requireRole("admin"),
  zValidator("json", balanceBodySchema),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();

    const customer = await db.customers.findOne({
      _id: oid,
      organizationId: orgId,
    });
    if (!customer) return c.json({ error: "not_found" }, 404);

    // Never relabel an existing nonzero balance by overwriting currency.
    // amountMinor: 0 + different currency would otherwise turn USD into EUR
    // without conversion.
    if (customer.balance.currency !== body.currency) {
      if (customer.balance.amountMinor !== 0) {
        return c.json(
          {
            error: "currency_mismatch",
            balanceCurrency: customer.balance.currency,
            requestCurrency: body.currency,
          },
          409,
        );
      }
    }

    const now = new Date();
    const adjustment: BalanceAdjustmentDoc = {
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: oid,
      amountMinor: body.amountMinor,
      currency: body.currency,
      reason: body.reason,
      usageRecordId: null,
      note: body.note ?? null,
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
    };

    // Insert the ledger entry and mutate the balance inside ONE transaction
    // so a transient failure (or a customer deleted mid-call) cannot leave a
    // ledger row without the matching balance mutation, or vice versa.
    const session = getClient().startSession();
    let updated: CustomerDoc | null = null;
    try {
      await session.withTransaction(async () => {
        await db.balanceAdjustments.insertOne(adjustment, { session });
        const setFields: Record<string, unknown> = { updatedAt: now };
        if (
          customer.balance.currency !== body.currency &&
          customer.balance.amountMinor === 0
        ) {
          setFields["balance.currency"] = body.currency;
        }
        const res = await db.customers.findOneAndUpdate(
          {
            _id: oid,
            organizationId: orgId,
            "balance.currency": customer.balance.currency,
          },
          {
            $inc: { "balance.amountMinor": body.amountMinor },
            $set: setFields,
          },
          { returnDocument: "after", session },
        );
        if (!res) throw new BalanceCustomerGone();
        updated = res as CustomerDoc;
      });
    } catch (err) {
      if (!(err instanceof BalanceCustomerGone)) throw err;
    } finally {
      await session.endSession();
    }
    if (!updated) return c.json({ error: "not_found" }, 404);

    return c.json({ customer: updated, adjustment }, 201);
  },
);

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

app.get(
  "/:id/balance-history",
  zValidator("query", historyQuerySchema),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const q = c.req.valid("query");
    const db = await getDb();

    const filter = { organizationId: orgId, customerId: oid };
    const [items, total] = await Promise.all([
      db.balanceAdjustments
        .find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(q.skip)
        .limit(q.limit)
        .toArray(),
      db.balanceAdjustments.countDocuments(filter),
    ]);

    return c.json({
      items: items as BalanceAdjustmentDoc[],
      total,
    });
  },
);

const subscribeBodySchema = z.object({
  planId: z.string().min(1).max(64),
});

export function addInterval(date: Date, interval: string, count: number): Date {
  const d = new Date(date);
  switch (interval) {
    case "day":
      d.setUTCDate(d.getUTCDate() + count);
      return d;
    case "week":
      d.setUTCDate(d.getUTCDate() + count * 7);
      return d;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + count);
      return d;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + count);
      return d;
    default:
      return d;
  }
}

app.post(
  "/:id/subscribe",
  requireRole("admin"),
  zValidator("json", subscribeBodySchema),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();

    if (!ObjectId.isValid(body.planId)) {
      return c.json({ error: "plan_not_found" }, 404);
    }
    const planId = new ObjectId(body.planId);

    const customer = await db.customers.findOne({
      _id: oid,
      organizationId: orgId,
    });
    if (!customer) return c.json({ error: "not_found" }, 404);

    const plan = await db.subscriptionPlans.findOne({
      _id: planId,
      organizationId: orgId,
    });
    if (!plan) return c.json({ error: "plan_not_found" }, 404);
    if (!plan.active) return c.json({ error: "plan_not_active" }, 409);

    const existing = await db.subscriptions.findOne({
      organizationId: orgId,
      customerId: oid,
      status: "active",
    });
    if (existing) {
      return c.json(
        { error: "subscription_already_active", subscriptionId: existing._id },
        409,
      );
    }

    const now = new Date();
    const periodEnd = addInterval(
      now,
      plan.interval,
      plan.intervalCount,
    );

    const subscription: SubscriptionDoc = {
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: oid,
      planId,
      status: "active",
      periodStart: now,
      periodEnd,
      canceledAt: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const insertResult = await db.subscriptions.insertOne(subscription);
      const created = await db.subscriptions.findOne({
        _id: insertResult.insertedId,
      });
      if (!created) return c.json({ error: "insert_failed" }, 500);
      return c.json(created as SubscriptionDoc, 201);
    } catch (err) {
      // Unique partial index on active status is the race safety net.
      if (isDuplicateKeyError(err)) {
        return c.json({ error: "subscription_already_active" }, 409);
      }
      throw err;
    }
  },
);

app.get("/:id/subscription", async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const db = await getDb();

  const subscription = await db.subscriptions.findOne(
    {
      organizationId: orgId,
      customerId: oid,
      status: "active",
    },
    { sort: { createdAt: -1 } },
  );
  if (!subscription) return c.json({ error: "not_found" }, 404);

  const plan = await db.subscriptionPlans.findOne({
    _id: subscription.planId,
    organizationId: orgId,
  });

  return c.json({
    subscription: subscription as SubscriptionDoc,
    plan: plan as SubscriptionPlanDoc | null,
  });
});

const usageQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

app.get("/:id/usage", zValidator("query", usageQuerySchema), async (c) => {
  const orgId = c.get("orgId");
  const oid = parseObjectIdParam(c.req.param("id"));
  if (!oid) return c.json({ error: "not_found" }, 404);
  const q = c.req.valid("query");
  const db = await getDb();

  const match: Record<string, unknown> = {
    organizationId: orgId,
    customerId: oid,
  };
  const occurredAt: Record<string, unknown> = {};
  if (q.from) occurredAt["$gte"] = new Date(q.from);
  if (q.to) occurredAt["$lte"] = new Date(q.to);
  if (Object.keys(occurredAt).length > 0) match["occurredAt"] = occurredAt;

  const pipeline: Document[] = [
    { $match: match },
    {
      $group: {
        _id: "$modelAliasId",
        requests: { $sum: 1 },
        tokens: { $sum: "$totalTokens" },
        costMinor: { $sum: "$costMinor" },
        priceMinor: { $sum: "$priceMinor" },
        currency: { $first: "$currency" },
      },
    },
    { $sort: { costMinor: -1 } },
  ];

  const rows = await db.usageRecords
    .aggregate(pipeline)
    .toArray();

  type AggRow = {
    _id: string;
    requests: number;
    tokens: number;
    costMinor: number;
    priceMinor: number;
    currency: string;
  };
  const typedRows = (rows as unknown as AggRow[]).filter(
    (r): r is AggRow => r !== null && typeof r === "object",
  );

  let totalRequests = 0;
  let totalTokens = 0;
  let totalCostMinor = 0;
  let totalPriceMinor = 0;
  const currency =
    typedRows.length > 0 ? (typedRows[0]?.currency ?? "USD") : "USD";

  const byModel = typedRows.map((r) => {
    totalRequests += r.requests;
    totalTokens += r.tokens;
    totalCostMinor += r.costMinor;
    totalPriceMinor += r.priceMinor;
    return {
      modelAliasId: r._id,
      requests: r.requests,
      tokens: r.tokens,
      costMinor: r.costMinor,
      priceMinor: r.priceMinor,
    };
  });

  return c.json({
    totalRequests,
    totalTokens,
    totalCostMinor,
    totalPriceMinor,
    currency,
    byModel,
  });
});

export default app;