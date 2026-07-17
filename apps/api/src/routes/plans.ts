import { Hono } from "hono";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import {
  subscriptionPlanCreateInput,
  subscriptionPlanUpdateInput,
} from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";
import {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deactivatePlan,
  normalizeRules,
  genRuleIdFromToken,
} from "../domains/plans/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import { ObjectId as MongoObjectId } from "mongodb";

export function genRuleId(): string {
  return genRuleIdFromToken(new MongoObjectId().toHexString());
}

export function normalizeRulesForRoute(
  rules: Parameters<typeof normalizeRules>[0],
): ReturnType<typeof normalizeRules> {
  return normalizeRules(rules, () => genRuleId());
}

/** Test-compatible alias matching historical route export shape. */
export { normalizeRulesForRoute as normalizeRules };

const planRoutes = new Hono<{ Variables: AuthVariables }>();

planRoutes.use("*", requireAuth);

planRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  return runAdminEffect(
    c,
    listPlans(orgId.toHexString()).pipe(Effect.map((items) => ({ items }))),
    { operation: "listPlans" },
  );
});

planRoutes.post(
  "/",
  requireRole("admin"),
  sValidator("json", subscriptionPlanCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      createPlan({
        organizationId: orgId.toHexString(),
        name: body.name,
        description: body.description,
        price: body.price,
        interval: body.interval,
        intervalCount: body.intervalCount,
        includedCredit: body.includedCredit,
        includedTokens: body.includedTokens,
        rateLimits: body.rateLimits,
      }),
      { operation: "createPlan", successStatus: 201 },
    );
  },
);

planRoutes.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    getPlan({ organizationId: orgId.toHexString(), planId: id }),
    { operation: "getPlan" },
  );
});

planRoutes.patch(
  "/:id",
  requireRole("admin"),
  sValidator("json", subscriptionPlanUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      updatePlan({
        organizationId: orgId.toHexString(),
        planId: id,
        patch: body as Record<string, unknown>,
      }),
      { operation: "updatePlan" },
    );
  },
);

planRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    deactivatePlan({
      organizationId: orgId.toHexString(),
      planId: id,
    }),
    { operation: "deactivatePlan" },
  );
});

export default planRoutes;
