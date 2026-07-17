import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import { dashboardSummary } from "../domains/analytics/operations.ts";
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
    return runAdminEffect(c, dashboardSummary(orgId.toHexString()), {
      operation: "dashboardSummary",
    });
  },
);

export default dashboardRoutes;
