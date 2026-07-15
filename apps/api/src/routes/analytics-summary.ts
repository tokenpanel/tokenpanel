import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";

/**
 * Org-wide usage aggregates + ranked customers without N+1 client fetches.
 */
const analyticsSummaryRoutes = new Hono<{ Variables: AuthVariables }>();

analyticsSummaryRoutes.use("*", requireAuth);

const querySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  top: z.coerce.number().int().positive().max(100).default(20),
});

analyticsSummaryRoutes.get(
  "/summary",
  zValidator("query", querySchema),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return c.json({ error: "invalid_date_range" }, 400);
    }
    // Inclusive end-of-day if date-only.
    if (q.to.length <= 10) {
      to.setUTCHours(23, 59, 59, 999);
    }

    const db = await getDb();
    const match = {
      organizationId: orgId,
      occurredAt: { $gte: from, $lte: to },
    };

    const [totalsByCurrency, byCustomer] = await Promise.all([
      db.usageRecords
        .aggregate<{
          _id: string;
          requests: number;
          tokens: number;
          costMinor: number;
          priceMinor: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: "$currency",
              requests: { $sum: 1 },
              tokens: { $sum: "$totalTokens" },
              costMinor: { $sum: "$costMinor" },
              priceMinor: { $sum: "$priceMinor" },
            },
          },
        ])
        .toArray(),
      db.usageRecords
        .aggregate<{
          _id: { customerId: unknown; currency: string };
          requests: number;
          tokens: number;
          costMinor: number;
          priceMinor: number;
        }>([
          { $match: { ...match, customerId: { $ne: null } } },
          {
            $group: {
              _id: { customerId: "$customerId", currency: "$currency" },
              requests: { $sum: 1 },
              tokens: { $sum: "$totalTokens" },
              costMinor: { $sum: "$costMinor" },
              priceMinor: { $sum: "$priceMinor" },
            },
          },
          // Rank within each currency, then take top N per currency (not global).
          { $sort: { priceMinor: -1 } },
          {
            $group: {
              _id: "$_id.currency",
              rows: { $push: "$$ROOT" },
            },
          },
          {
            $project: {
              rows: { $slice: ["$rows", q.top] },
            },
          },
          { $unwind: "$rows" },
          { $replaceRoot: { newRoot: "$rows" } },
          // Stable presentation order: highest price first across currencies.
          { $sort: { priceMinor: -1 } },
        ])
        .toArray(),
    ]);

    const totals = {
      requests: totalsByCurrency.reduce((s, r) => s + r.requests, 0),
      tokens: totalsByCurrency.reduce((s, r) => s + r.tokens, 0),
      byCurrency: totalsByCurrency.map((r) => ({
        currency: r._id || "USD",
        requests: r.requests,
        tokens: r.tokens,
        costMinor: r.costMinor,
        priceMinor: r.priceMinor,
      })),
    };

    const customerIds = byCustomer
      .map((r) => r._id.customerId)
      .filter((id): id is import("mongodb").ObjectId => id != null);

    const customers =
      customerIds.length > 0
        ? await db.customers
            .find({ _id: { $in: customerIds }, organizationId: orgId })
            .toArray()
        : [];
    const nameById = new Map(
      customers.map((cu) => [cu._id.toHexString(), cu.name]),
    );

    return c.json({
      from: from.toISOString(),
      to: to.toISOString(),
      totals,
      topCustomers: byCustomer.map((r) => {
        const rawId = r._id.customerId;
        const id =
          rawId &&
          typeof (rawId as { toHexString?: () => string }).toHexString ===
            "function"
            ? (rawId as { toHexString: () => string }).toHexString()
            : String(rawId);
        return {
          customerId: id,
          customerName: nameById.get(id) ?? "Unknown",
          currency: r._id.currency || "USD",
          requests: r.requests,
          tokens: r.tokens,
          costMinor: r.costMinor,
          priceMinor: r.priceMinor,
        };
      }),
    });
  },
);

export default analyticsSummaryRoutes;
