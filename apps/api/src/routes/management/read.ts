import { Hono } from "hono";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import { requireManagementScope } from "../../middleware/management-auth.ts";
import {
  listCustomers,
  getCustomer,
  listBalanceHistory,
  redactCustomerBalance,
} from "../../domains/customers/operations.ts";
import {
  getActiveSubscription,
  listCustomerLimits,
  listCustomerBudgets,
  listPlans,
  getPlan,
} from "../../domains/plans/operations.ts";
import {
  listModels,
  getModel,
  listActiveModels,
  toModelCapability,
} from "../../domains/models/operations.ts";
import { customerUsage } from "../../domains/analytics/operations.ts";
import { runManagementEffect } from "../../http/adapters/boundary.ts";
import { sValidator } from "../../http/validation/validator.ts";
import {
  CustomerListQuery,
  HistoryQuery,
  UsageDateRangeQuery,
} from "../../http/validation/query.ts";
import { withParseApi } from "../../http/validation/with-parse-api.ts";
import type { CustomerDoc, ManagementScope } from "@tokenpanel/db";
import type { PublicPrincipal } from "../../middleware/public-auth.ts";

type ManagementAuthVariables = PublicAuthVariables;

/** Test helper: strip balance from a customer DTO. */
export function redactCustomer(
  customer: CustomerDoc,
): Omit<CustomerDoc, "balance"> {
  return redactCustomerBalance(customer);
}

/**
 * Scope check helper for tests / thin adapters.
 * Accepts either a PublicPrincipal or a Hono-like `{ get("principal") }`.
 */
export function principalHasScope(
  principalOrCtx:
    | PublicPrincipal
    | { get: (k: "principal") => PublicPrincipal | undefined },
  scope: ManagementScope,
): boolean {
  const principal =
    "kind" in principalOrCtx
      ? principalOrCtx
      : principalOrCtx.get("principal");
  if (!principal || principal.kind !== "management") return false;
  return principal.managementKey.scopes.includes(scope);
}

export { toModelCapability };

const customerListQuery = withParseApi(CustomerListQuery);
const historyQuery = withParseApi(HistoryQuery);
const usageDateRangeQuery = withParseApi(UsageDateRangeQuery);

const app = new Hono<{ Variables: ManagementAuthVariables }>();

function hasBalancesRead(c: {
  get: (k: "principal") => ManagementAuthVariables["principal"];
}): boolean {
  const p = c.get("principal");
  if (p.kind !== "management") return false;
  return p.managementKey.scopes.includes("balances:read");
}

app.get(
  "/customers",
  requireManagementScope("customers:read"),
  sValidator("query", customerListQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    const redact = !hasBalancesRead(c);
    return runManagementEffect(
      c,
      listCustomers({
        organizationId: orgId.toHexString(),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.q !== undefined ? { q: q.q } : {}),
        limit: q.limit,
        skip: q.skip,
      }).pipe(
        Effect.map((page) => ({
          ...page,
          items: page.items.map((item) =>
            redact ? redactCustomerBalance(item) : item,
          ),
        })),
      ),
      { operation: "mgmt.listCustomers" },
    );
  },
);

app.get(
  "/customers/:id",
  requireManagementScope("customers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const redact = !hasBalancesRead(c);
    return runManagementEffect(
      c,
      getCustomer({
        organizationId: orgId.toHexString(),
        customerId: id,
      }).pipe(
        Effect.map((doc) =>
          redact ? redactCustomerBalance(doc) : doc,
        ),
      ),
      { operation: "mgmt.getCustomer" },
    );
  },
);

app.get(
  "/customers/:id/balance/history",
  requireManagementScope("balances:read"),
  sValidator("query", historyQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const q = c.req.valid("query");
    return runManagementEffect(
      c,
      listBalanceHistory({
        organizationId: orgId.toHexString(),
        customerId: id,
        limit: q.limit,
        skip: q.skip,
      }),
      { operation: "mgmt.listBalanceHistory" },
    );
  },
);

app.get(
  "/customers/:id/subscription",
  requireManagementScope("customers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runManagementEffect(
      c,
      getActiveSubscription({
        organizationId: orgId.toHexString(),
        customerId: id,
      }),
      { operation: "mgmt.getActiveSubscription" },
    );
  },
);

app.get(
  "/customers/:id/limits",
  requireManagementScope("customers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runManagementEffect(
      c,
      listCustomerLimits({
        organizationId: orgId.toHexString(),
        customerId: id,
      }).pipe(Effect.map((items) => ({ items }))),
      { operation: "mgmt.listCustomerLimits" },
    );
  },
);

app.get(
  "/customers/:id/budgets",
  requireManagementScope("customers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runManagementEffect(
      c,
      listCustomerBudgets({
        organizationId: orgId.toHexString(),
        customerId: id,
      }).pipe(Effect.map((items) => ({ items }))),
      { operation: "mgmt.listCustomerBudgets" },
    );
  },
);

app.get(
  "/customers/:id/usage",
  requireManagementScope("usage:read"),
  sValidator("query", usageDateRangeQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const q = c.req.valid("query");
    return runManagementEffect(
      c,
      customerUsage({
        organizationId: orgId.toHexString(),
        customerId: id,
        from: q.from,
        to: q.to,
      }),
      { operation: "mgmt.customerUsage" },
    );
  },
);

app.get(
  "/models",
  requireManagementScope("models:read"),
  async (c) => {
    const orgId = c.get("orgId");
    return runManagementEffect(
      c,
      listModels(orgId.toHexString()).pipe(
        Effect.map((items) => ({
          items: items.map(toModelCapability),
        })),
      ),
      { operation: "mgmt.listModels" },
    );
  },
);

app.get(
  "/models/active",
  requireManagementScope("models:read"),
  async (c) => {
    const orgId = c.get("orgId");
    return runManagementEffect(
      c,
      listActiveModels(orgId.toHexString()).pipe(
        Effect.map((items) => ({
          items: items.map(toModelCapability),
        })),
      ),
      { operation: "mgmt.listActiveModels" },
    );
  },
);

app.get(
  "/models/:id",
  requireManagementScope("models:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runManagementEffect(
      c,
      getModel({ organizationId: orgId.toHexString(), modelId: id }).pipe(
        Effect.map(toModelCapability),
      ),
      { operation: "mgmt.getModel" },
    );
  },
);

app.get(
  "/plans",
  requireManagementScope("plans:read"),
  async (c) => {
    const orgId = c.get("orgId");
    return runManagementEffect(
      c,
      listPlans(orgId.toHexString()).pipe(
        Effect.map((items) => ({ items })),
      ),
      { operation: "mgmt.listPlans" },
    );
  },
);

app.get(
  "/plans/:id",
  requireManagementScope("plans:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runManagementEffect(
      c,
      getPlan({ organizationId: orgId.toHexString(), planId: id }),
      { operation: "mgmt.getPlan" },
    );
  },
);

export default app;
