import { Hono } from "hono";
import { Effect } from "effect";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import { dashboardSummary } from "../domains/analytics/operations.ts";
import { redactCustomerBalance } from "../domains/customers/operations.ts";
import { hasPanelPermission } from "@tokenpanel/contracts";
import { runAdminEffect } from "../http/adapters/boundary.ts";

/**
 * Server-side aggregates so admin UI never sums truncated client fetches.
 */
const dashboardRoutes = new Hono<{ Variables: AuthVariables }>();

dashboardRoutes.use("*", requireAuth);

dashboardRoutes.get(
  "/summary",
  requirePermission("dashboard:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const canReadBalances = hasPanelPermission(
      c.get("role"),
      c.get("permissions"),
      "balances:read",
    );
    const canReadCustomers = hasPanelPermission(
      c.get("role"),
      c.get("permissions"),
      "customers:read",
    );
    return runAdminEffect(
      c,
      dashboardSummary(orgId.toHexString(), {
        includeBalances: canReadBalances,
      }).pipe(
        Effect.map((summary) => {
          const recentCustomers = summary.recentCustomers.map((rc) =>
            canReadCustomers
              ? canReadBalances
                ? rc
                : redactCustomerBalance(rc)
              : { _id: rc._id, status: rc.status },
          );
          return canReadBalances
            ? { ...summary, recentCustomers }
            : {
                ...summary,
                balancesByCurrency: {},
                recentCustomers,
              };
        }),
      ),
      { operation: "dashboardSummary" },
    );
  },
);

export default dashboardRoutes;
