import { Hono } from "hono";
import { ObjectId } from "mongodb";
import {
  customerCreateInput,
  customerUpdateInput,
} from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import { requireManagementScope } from "../../middleware/management-auth.ts";
import {
  createCustomer,
  updateCustomer,
  closeCustomer,
  adjustCustomerBalance,
} from "../../domains/customers/operations.ts";
import { subscribeCustomer } from "../../domains/plans/operations.ts";
import { runManagementEffect } from "../../http/adapters/boundary.ts";
import { sValidator } from "../../http/validation/validator.ts";
import { isAppError } from "../../errors/families.ts";
import { Schema } from "effect";
import {
  SafeInt,
  CurrencyCode,
  exactOptional,
  maxString,
} from "@tokenpanel/contracts/effect";
import { withParseApi } from "../../http/validation/with-parse-api.ts";

type ManagementAuthVariables = PublicAuthVariables;

const BalanceAdjustBody = Schema.Struct({
  amountMinor: SafeInt,
  currency: CurrencyCode,
  reason: exactOptional(
    Schema.Literal("topup", "adjustment", "refund"),
  ),
  note: exactOptional(maxString(280)),
});
const balanceAdjustBody = withParseApi(BalanceAdjustBody);

const SubscribeBody = Schema.Struct({
  planId: Schema.String.pipe(Schema.minLength(1)),
});
const subscribeBody = withParseApi(SubscribeBody);

const app = new Hono<{ Variables: ManagementAuthVariables }>();

app.post(
  "/customers",
  requireManagementScope("customers:write"),
  sValidator("json", customerCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    return runManagementEffect(
      c,
      createCustomer({
        organizationId: orgId.toHexString(),
        name: body.name,
        externalId: body.externalId,
        email: body.email,
        startingBalance: body.startingBalance,
        metadata: body.metadata,
        openingNote: "management_api",
      }),
      { operation: "mgmt.createCustomer", successStatus: 201 },
    );
  },
);

app.patch(
  "/customers/:id",
  requireManagementScope("customers:write"),
  sValidator("json", customerUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runManagementEffect(
      c,
      updateCustomer({
        organizationId: orgId.toHexString(),
        customerId: id,
        patch: body,
      }),
      { operation: "mgmt.updateCustomer" },
    );
  },
);

app.delete(
  "/customers/:id",
  requireManagementScope("customers:write"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runManagementEffect(
      c,
      closeCustomer({
        organizationId: orgId.toHexString(),
        customerId: id,
      }),
      { operation: "mgmt.closeCustomer" },
    );
  },
);

app.post(
  "/customers/:id/balance",
  requireManagementScope("balances:write"),
  sValidator("json", balanceAdjustBody),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runManagementEffect(
      c,
      adjustCustomerBalance({
        organizationId: orgId.toHexString(),
        customerId: id,
        amountMinor: body.amountMinor,
        currency: body.currency,
        reason: body.reason,
        note: body.note ?? "management_api",
      }),
      {
        operation: "mgmt.adjustCustomerBalance",
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

app.post(
  "/customers/:id/subscription",
  requireManagementScope("customers:write"),
  sValidator("json", subscribeBody),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    if (!ObjectId.isValid(body.planId)) {
      return c.json({ error: "plan_not_found" }, 404);
    }
    return runManagementEffect(
      c,
      subscribeCustomer({
        organizationId: orgId.toHexString(),
        customerId: id,
        planId: body.planId,
      }),
      { operation: "mgmt.subscribeCustomer", successStatus: 201 },
    );
  },
);

export default app;
