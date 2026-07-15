import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Document, Filter } from "mongodb";
import {
  getDb,
  type ModelDoc,
  type CustomerDoc,
  type BalanceAdjustmentDoc,
  type SubscriptionDoc,
  type SubscriptionPlanDoc,
} from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import {
  requireManagementScope,
} from "../../middleware/management-auth.ts";
import { parseObjectIdParam, escapeRegExp } from "../route-utils.ts";

type ManagementAuthVariables = PublicAuthVariables;

/**
 * Customer DTO without balance. The customers:read scope grants access to
 * customer identity + status only — balance is gated separately by
 * balances:read so a customers:read-only key cannot observe financial state.
 * Callers that also hold balances:read receive the full CustomerDoc.
 */
export type CustomerRedacted = Omit<CustomerDoc, "balance">;

/** @internal Exported for unit tests. */
export function maybeRedactCustomer(
  customer: CustomerDoc,
  hasBalancesRead: boolean,
): CustomerDoc | CustomerRedacted {
  if (hasBalancesRead) return customer;
  const { balance: _drop, ...rest } = customer;
  void _drop;
  return rest;
}

/** Does the authenticated management principal hold the given scope? @internal */
export function principalHasScope(
  c: { get: (k: "principal") => import("../../middleware/public-auth.ts").PublicPrincipal | undefined },
  scope: import("@tokenpanel/db").ManagementScope,
): boolean {
  const p = c.get("principal");
  return p?.kind === "management" && p.managementKey.scopes.includes(scope);
}

/**
 * Management server-to-server read endpoints. Mounted at "/" in index.ts and
 * self-scoped to /api/management/*. Auth (prefix dispatch + management
 * narrowing) is mounted once on the parent app for /api/management/* — this
 * router only adds per-route scope gates.
 *
 * Every query filters by `organizationId` from the authenticated management
 * key — there is no path that takes an orgId from the request body, so
 * cross-org data leakage is structurally impossible.
 */
const managementRead = new Hono<{ Variables: ManagementAuthVariables }>();

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Public management model DTO — deliberately omits metadata (not a public API extension). */
export function toModelCapability(m: ModelDoc) {
  return {
    aliasId: m.aliasId,
    displayName: m.displayName,
    description: m.description,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    structuredOutput: m.structuredOutput,
    temperature: m.temperature,
    attachment: m.attachment,
    limits: m.limits,
    modalities: m.modalities,
    status: m.status,
    price: m.price,
    currency: m.currency,
    active: m.active,
  };
}

/** GET /api/management/models — list active models (models:read). */
managementRead.get(
  "/api/management/models",
  requireManagementScope("models:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const db = await getDb();
    const docs = await db.models
      .find({ organizationId: orgId, active: true })
      .sort({ aliasId: 1 })
      .toArray();
    return c.json({ items: docs.map(toModelCapability) });
  },
);

/** GET /api/management/models/:aliasId — single model by alias (models:read). */
managementRead.get(
  "/api/management/models/:aliasId",
  requireManagementScope("models:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const aliasId = c.req.param("aliasId");
    const db = await getDb();
    const doc = await db.models.findOne({ organizationId: orgId, aliasId });
    if (!doc) return c.json({ error: "not_found" }, 404);
    return c.json(toModelCapability(doc));
  },
);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const customerListQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  skip: z.coerce.number().int().min(0).default(0),
  status: z.enum(["active", "suspended", "closed"]).optional(),
  q: z.string().max(160).optional(),
});

/** GET /api/management/customers — paginated list (customers:read). */
managementRead.get(
  "/api/management/customers",
  requireManagementScope("customers:read"),
  zValidator("query", customerListQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    const db = await getDb();

    const filter: Filter<CustomerDoc> = { organizationId: orgId };
    if (q.status !== undefined) filter.status = q.status;
    if (q.q !== undefined && q.q.length > 0) {
      const esc = escapeRegExp(q.q);
      filter.$or = [
        { name: { $regex: esc, $options: "i" } },
        { email: { $regex: esc, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      db.customers.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).toArray(),
      db.customers.countDocuments(filter),
    ]);

    const hasBalancesRead = principalHasScope(c, "balances:read");
    return c.json({ items: items.map((d) => maybeRedactCustomer(d, hasBalancesRead)), total });
  },
);

const emailQuery = z.object({
  email: z.string().email().max(254),
});

/**
 * GET /api/management/customers/lookup?email= — first-class email lookup
 * (customers:read). Email matching is case-insensitive and ALWAYS scoped to
 * the key's org, so a same-email customer in another org returns 404.
 */
managementRead.get(
  "/api/management/customers/lookup",
  requireManagementScope("customers:read"),
  zValidator("query", emailQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    const db = await getDb();
    const customer = await db.customers.findOne({
      organizationId: orgId,
      email: q.email.toLowerCase(),
    });
    if (!customer) return c.json({ error: "not_found" }, 404);
    return c.json(maybeRedactCustomer(customer, principalHasScope(c, "balances:read")));
  },
);

/** GET /api/management/customers/:id — customer detail (customers:read). */
managementRead.get(
  "/api/management/customers/:id",
  requireManagementScope("customers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const db = await getDb();
    const doc = await db.customers.findOne({ _id: oid, organizationId: orgId });
    if (!doc) return c.json({ error: "not_found" }, 404);
    return c.json(maybeRedactCustomer(doc, principalHasScope(c, "balances:read")));
  },
);

// ---------------------------------------------------------------------------
// Balances + history
// ---------------------------------------------------------------------------

/** GET /api/management/customers/:id/balance — current balance (balances:read). */
managementRead.get(
  "/api/management/customers/:id/balance",
  requireManagementScope("balances:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const db = await getDb();
    const customer = await db.customers.findOne(
      { _id: oid, organizationId: orgId },
      { projection: { balance: 1, status: 1, name: 1, email: 1 } },
    );
    if (!customer) return c.json({ error: "not_found" }, 404);
    return c.json({
      customer: {
        _id: customer._id,
        name: customer.name,
        email: customer.email,
        status: customer.status,
      },
      balance: customer.balance,
    });
  },
);

const historyQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

/** GET /api/management/customers/:id/balance-history (balances:read). */
managementRead.get(
  "/api/management/customers/:id/balance-history",
  requireManagementScope("balances:read"),
  zValidator("query", historyQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const q = c.req.valid("query");
    const db = await getDb();

    const filter = { organizationId: orgId, customerId: oid };
    const [items, total] = await Promise.all([
      db.balanceAdjustments.find(filter).sort({ occurredAt: -1, _id: -1 }).skip(q.skip).limit(q.limit).toArray(),
      db.balanceAdjustments.countDocuments(filter),
    ]);

    return c.json({ items: items as BalanceAdjustmentDoc[], total });
  },
);

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** GET /api/management/customers/:id/subscription (customers:read). */
managementRead.get(
  "/api/management/customers/:id/subscription",
  requireManagementScope("customers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const db = await getDb();

    const subscription = await db.subscriptions.findOne(
      { organizationId: orgId, customerId: oid, status: "active" },
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
  },
);

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** GET /api/management/plans — list active plans (plans:read). */
managementRead.get(
  "/api/management/plans",
  requireManagementScope("plans:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const db = await getDb();
    const docs = await db.subscriptionPlans
      .find({ organizationId: orgId, active: true })
      .sort({ name: 1 })
      .toArray();
    return c.json({ items: docs });
  },
);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const usageQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** GET /api/management/customers/:id/usage — per-customer usage summary (usage:read). */
managementRead.get(
  "/api/management/customers/:id/usage",
  requireManagementScope("usage:read"),
  zValidator("query", usageQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const q = c.req.valid("query");
    const db = await getDb();

    const match: Record<string, unknown> = { organizationId: orgId, customerId: oid };
    const occurredAt: Record<string, unknown> = {};
    if (q.from) occurredAt.$gte = new Date(q.from);
    if (q.to) occurredAt.$lte = new Date(q.to);
    if (Object.keys(occurredAt).length > 0) match.occurredAt = occurredAt;

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

    const rows = (await db.usageRecords.aggregate(pipeline).toArray()) as unknown as Array<{
      _id: string;
      requests: number;
      tokens: number;
      costMinor: number;
      priceMinor: number;
      currency: string;
    }>;

    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostMinor = 0;
    let totalPriceMinor = 0;
    const currency = rows.length > 0 ? rows[0]?.currency ?? "USD" : "USD";
    const byModel = rows.map((r) => {
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
  },
);

export default managementRead;
