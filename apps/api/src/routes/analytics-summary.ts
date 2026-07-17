import { Hono } from "hono";
import { sValidator } from "../http/validation/validator.ts";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import { analyticsSummary } from "../domains/analytics/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { AnalyticsSummaryQuery } from "../http/validation/query.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";

export const analyticsSummaryQuery = withParseApi(AnalyticsSummaryQuery);

const analyticsSummaryRoutes = new Hono<{ Variables: AuthVariables }>();

analyticsSummaryRoutes.use("*", requireAuth);

analyticsSummaryRoutes.get(
  "/summary",
  requirePermission("usage:read"),
  sValidator("query", analyticsSummaryQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    return runAdminEffect(
      c,
      analyticsSummary({
        organizationId: orgId.toHexString(),
        from: q.from,
        to: q.to,
        top: q.top,
      }),
      { operation: "analyticsSummary" },
    );
  },
);

export default analyticsSummaryRoutes;
