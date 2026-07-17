import { Hono } from "hono";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import {
  customerCreateInput,
  customerUpdateInput,
} from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  closeCustomer,
  adjustCustomerBalance,
  listBalanceHistory,
} from "../domains/customers/operations.ts";
import {
  subscribeCustomer,
  getActiveSubscription,
  listCustomerLimits,
  listCustomerBudgets,
} from "../domains/plans/operations.ts";
import { customerUsage } from "../domains/analytics/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import {
  CustomerListQuery,
  HistoryQuery,
  UsageDateRangeQuery,
} from "../http/validation/query.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";
import { isAppError } from "../errors/families.ts";
import { Schema } from "effect";
import { SafeInt, CurrencyCode, exactOptional, maxString } from "@tokenpanel/contracts/effect";

export const customerListQuery = withParseApi(CustomerListQuery);
export const historyQuery = withParseApi(HistoryQuery);
export const usageDateRangeQuery = withParseApi(UsageDateRangeQuery);

const BalanceAdjustBody = Schema.Struct({
  amountMinor: SafeInt,
  currency: CurrencyCode,
  reason: exactOptional(
    Schema.Literal("topup", "adjustment", "refund"),
  ),
  note: exactOptional(maxString(280)),
});
export const balanceAdjustBody = withParseApi(BalanceAdjustBody);

const SubscribeBody = Schema.Struct({
  planId: Schema.String.pipe(Schema.minLength(1)),
});
export const subscribeBody = withParseApi(SubscribeBody);

export { parseObjectIdParam } from "./route-utils.ts";
export { addInterval } from "../domains/plans/interval.ts";

const app = new Hono<{ Variables: AuthVariables }>();

app.use("*", requireAuth);

app.get(
  "/",
  requirePermission("customers:read"),
  sValidator("query", customerListQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    return runAdminEffect(
      c,
      listCustomers({
        organizationId: orgId.toHexString(),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.q !== undefined ? { q: q.q } : {}),
        limit: q.limit,
        skip: q.skip,
      }),
      { operation: "listCustomers" },
    );
  },
);

app.post(
  "/",
  requirePermission("customers:write"),
  sValidator("json", customerCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      createCustomer({
        organizationId: orgId.toHexString(),
        name: body.name,
        externalId: body.externalId,
        email: body.email,
        startingBalance: body.startingBalance,
        metadata: body.metadata,
      }),
      { operation: "createCustomer", successStatus: 201 },
    );
  },
);

app.get("/:id", requirePermission("customers:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    getCustomer({ organizationId: orgId.toHexString(), customerId: id }),
    { operation: "getCustomer" },
  );
});

app.patch(
  "/:id",
  requirePermission("customers:write"),
  sValidator("json", customerUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      updateCustomer({
        organizationId: orgId.toHexString(),
        customerId: id,
        patch: body,
      }),
      { operation: "updateCustomer" },
    );
  },
);

app.delete("/:id", requirePermission("customers:write"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    closeCustomer({
      organizationId: orgId.toHexString(),
      customerId: id,
    }),
    { operation: "closeCustomer" },
  );
});

app.post(
  "/:id/balance",
  requirePermission("balances:write"),
  sValidator("json", balanceAdjustBody),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: id,
        amountMinor: body.amountMinor,
        currency: body.currency,
        reason: body.reason,
        note: body.note,
      }),
      {
        operation: "adjustCustomerBalance",
        mapError: (err) => {
          if (
            isAppError(err) &&
            err._tag === "InsufficientBalanceError" &&
            err.code === "currency_mismatch"
          ) {
            return {
              status: 409,
              body: {
                error: "currency_mismatch",
                balanceCurrency: err.balanceCurrency,
                requestCurrency: err.currency,
              },
              headers: {},
            };
          }
          return null;
        },
      },
    );
  },
);

app.get(
  "/:id/balance/history",
  requirePermission("balances:read"),
  sValidator("query", historyQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const q = c.req.valid("query");
    return runAdminEffect(
      c,
      listBalanceHistory({
        organizationId: orgId.toHexString(),
        customerId: id,
        limit: q.limit,
        skip: q.skip,
      }),
      { operation: "listBalanceHistory" },
    );
  },
);

app.post(
  "/:id/subscription",
  requirePermission("subscriptions:write"),
  sValidator("json", subscribeBody),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    if (!ObjectId.isValid(body.planId)) {
      return c.json({ error: "plan_not_found" }, 404);
    }
    return runAdminEffect(
      c,
      subscribeCustomer({
        organizationId: orgId.toHexString(),
        customerId: id,
        planId: body.planId,
      }),
      { operation: "subscribeCustomer", successStatus: 201 },
    );
  },
);

app.get(
  "/:id/subscription",
  requirePermission("customers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runAdminEffect(
      c,
      getActiveSubscription({
        organizationId: orgId.toHexString(),
        customerId: id,
      }),
      { operation: "getActiveSubscription" },
    );
  },
);

app.get("/:id/limits", requirePermission("customers:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    listCustomerLimits({
      organizationId: orgId.toHexString(),
      customerId: id,
    }).pipe(Effect.map((items) => ({ items }))),
    { operation: "listCustomerLimits" },
  );
});

app.get("/:id/budgets", requirePermission("customers:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    listCustomerBudgets({
      organizationId: orgId.toHexString(),
      customerId: id,
    }).pipe(Effect.map((items) => ({ items }))),
    { operation: "listCustomerBudgets" },
  );
});

app.get(
  "/:id/usage",
  requirePermission("usage:read"),
  sValidator("query", usageDateRangeQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const q = c.req.valid("query");
    return runAdminEffect(
      c,
      customerUsage({
        organizationId: orgId.toHexString(),
        customerId: id,
        from: q.from,
        to: q.to,
      }),
      { operation: "customerUsage" },
    );
  },
);

export default app;
