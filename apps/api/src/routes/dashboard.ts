import { Hono } from "hono";
import { getDb, type CustomerDoc } from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";

/**
 * Server-side aggregates so admin UI never sums truncated client fetches.
 */
const dashboardRoutes = new Hono<{ Variables: AuthVariables }>();

dashboardRoutes.use("*", requireAuth);

dashboardRoutes.get("/summary", async (c) => {
  const orgId = c.get("orgId");
  const db = await getDb();

  const [
    customerCount,
    modelCount,
    providerCount,
    plans,
    balanceAgg,
    recentCustomers,
  ] = await Promise.all([
    db.customers.countDocuments({ organizationId: orgId }),
    db.models.countDocuments({ organizationId: orgId }),
    db.providers.countDocuments({ organizationId: orgId }),
    db.subscriptionPlans
      .find({ organizationId: orgId })
      .project({ active: 1, status: 1 })
      .toArray(),
    db.customers
      .aggregate<{ _id: string; totalMinor: number }>([
        { $match: { organizationId: orgId } },
        {
          $group: {
            _id: "$balance.currency",
            totalMinor: { $sum: "$balance.amountMinor" },
          },
        },
      ])
      .toArray(),
    db.customers
      .find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray(),
  ]);

  const activePlanCount = plans.filter(
    (p) =>
      (p as { active?: boolean; status?: string }).active === true ||
      (p as { status?: string }).status === "active",
  ).length;

  const balancesByCurrency: Record<string, number> = {};
  for (const row of balanceAgg) {
    if (row._id) balancesByCurrency[row._id] = row.totalMinor;
  }

  return c.json({
    customers: customerCount,
    models: modelCount,
    providers: providerCount,
    activePlans: activePlanCount,
    balancesByCurrency,
    recentCustomers: recentCustomers.map((c: CustomerDoc) => ({
      _id: c._id.toHexString(),
      name: c.name,
      email: c.email ?? null,
      balance: c.balance,
      status: c.status,
      createdAt: c.createdAt?.toISOString?.() ?? c.createdAt,
    })),
  });
});

export default dashboardRoutes;
