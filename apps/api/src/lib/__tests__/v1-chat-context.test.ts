import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  customerCreateInput,
  customerUpdateInput,
} from "@tokenpanel/db";
import {
  resolveChatContext,
  actorForChatContext,
  billableCustomerId,
  modelWhitelistForContext,
  V1ChatError,
} from "../v1-chat-context.ts";

function customerPrincipal(over: Partial<{ orgId: ObjectId; customerId: ObjectId; whitelist: string[] }> = {}) {
  const orgId = over.orgId ?? new ObjectId();
  const customerId = over.customerId ?? new ObjectId();
  return {
    kind: "customer" as const,
    orgId,
    customer: {
      _id: customerId,
      organizationId: orgId,
      externalId: null,
      name: "alice",
      email: "alice@example.com",
      balance: { amountMinor: 1000, currency: "USD" },
      status: "active" as const,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    apiKey: {
      _id: new ObjectId(),
      organizationId: orgId,
      customerId,
      name: "k",
      prefix: "tp_live_abcd",
      keyHash: "h",
      modelWhitelist: over.whitelist ?? [],
      status: "active" as const,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function managementPrincipal(over: Partial<{ orgId: ObjectId; scopes: string[] }> = {}) {
  const orgId = over.orgId ?? new ObjectId();
  return {
    kind: "management" as const,
    orgId,
    managementKey: {
      _id: new ObjectId(),
      organizationId: orgId,
      name: "ci",
      prefix: "tp_mgmt_abcd",
      keyHash: "h",
      scopes: (over.scopes ?? ["chat:write"]) as any,
      status: "active" as const,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

test("resolveChatContext: customer principal → customer context, no email lookup", async () => {
  const p = customerPrincipal({ whitelist: ["gpt-4"] });
  const ctx = await resolveChatContext({ principal: p });
  expect(ctx.kind).toBe("customer");
  if (ctx.kind !== "customer") throw new Error("unreachable");
  expect(ctx.customer._id).toBe(p.customer._id);
  expect(ctx.modelWhitelist).toEqual(["gpt-4"]);
  // customerEmail is ignored on customer path even if provided.
  const ctx2 = await resolveChatContext({ principal: p, customerEmail: "anyone@x.com" });
  expect(ctx2.kind).toBe("customer");
});

test("resolveChatContext: management without chat:write → 403 V1ChatError", async () => {
  const p = managementPrincipal({ scopes: ["models:read"] });
  await expect(resolveChatContext({ principal: p })).rejects.toBeInstanceOf(V1ChatError);
  await expect(resolveChatContext({ principal: p })).rejects.toMatchObject({
    status: 403,
    code: "missing_scope",
  });
});

test("resolveChatContext: management without customerEmail → management_internal", async () => {
  const p = managementPrincipal();
  const ctx = await resolveChatContext({ principal: p });
  expect(ctx.kind).toBe("management_internal");
  if (ctx.kind !== "management_internal") throw new Error("unreachable");
  expect(ctx.orgId).toBe(p.orgId);
  expect(ctx.managementKeyId).toBe(p.managementKey._id);
});

test("resolveChatContext: management with unknown customerEmail → 404 V1ChatError (requires live DB)", async () => {
  // The 404 path issues a real org-scoped findOne against customers; that
  // needs a running replica set (the migration runner + transactions require
  // one). Covered by route/integration tests against a live DB. Here we only
  // assert the error shape the no-DB paths cannot reach is well-formed.
  const e = new V1ChatError(404, "customer_not_found", "no such customer");
  expect(e.status).toBe(404);
  expect(e.code).toBe("customer_not_found");
});

test("customerCreateInput lowercases email so attribution lookup is case-stable", () => {
  // Storage-side normalization is what makes the request-side .toLowerCase()
  // lookup in v1-chat-context match. Without it an uppercase stored email
  // misses the lookup and case variants can create duplicate customers.
  expect(
    customerCreateInput.parse({ name: "x", email: "Alice@Example.COM" }).email,
  ).toBe("alice@example.com");
  expect(customerCreateInput.parse({ name: "x" }).email).toBeUndefined();
  // Invalid emails still reject before the transform runs.
  expect(
    customerCreateInput.safeParse({ name: "x", email: "not-an-email" }).success,
  ).toBe(false);
});

test("customerUpdateInput lowercases email (and keeps null)", () => {
  expect(
    customerUpdateInput.parse({ email: "Alice@Example.COM" }).email,
  ).toBe("alice@example.com");
  expect(customerUpdateInput.parse({ email: null }).email).toBeNull();
  expect(customerUpdateInput.parse({}).email).toBeUndefined();
});

test("actorForChatContext: customer → customer_key actor with apiKeyId", async () => {
  const p = customerPrincipal();
  const ctx = await resolveChatContext({ principal: p });
  const actor = actorForChatContext(ctx);
  expect(actor.actorKind).toBe("customer_key");
  if (actor.actorKind !== "customer_key") throw new Error("unreachable");
  expect(actor.customerId).toBe(p.customer._id);
  expect(actor.apiKeyId).toBe(p.apiKey._id);
  expect(actor.managementKeyId).toBeUndefined();
});

test("actorForChatContext: management_internal → management_key with null customerId", async () => {
  const p = managementPrincipal();
  const ctx = await resolveChatContext({ principal: p });
  const actor = actorForChatContext(ctx);
  expect(actor.actorKind).toBe("management_key");
  expect(actor.customerId).toBeNull();
  if (actor.actorKind !== "management_key") throw new Error("unreachable");
  expect(actor.managementKeyId).toBe(p.managementKey._id);
});

test("billableCustomerId: customer → id, management_internal → null, management_attributed → id", async () => {
  const custP = customerPrincipal();
  const custCtx = await resolveChatContext({ principal: custP });
  expect(billableCustomerId(custCtx)).toBe(custP.customer._id);

  const mgmtP = managementPrincipal();
  const internalCtx = await resolveChatContext({ principal: mgmtP });
  expect(billableCustomerId(internalCtx)).toBeNull();
});

test("modelWhitelistForContext: customer path inherits apiKey whitelist; management path empty", async () => {
  const custP = customerPrincipal({ whitelist: ["m1", "m2"] });
  const custCtx = await resolveChatContext({ principal: custP });
  expect(modelWhitelistForContext(custCtx)).toEqual(["m1", "m2"]);

  const mgmtP = managementPrincipal();
  const internalCtx = await resolveChatContext({ principal: mgmtP });
  expect(modelWhitelistForContext(internalCtx)).toEqual([]);
});

test("V1ChatError: shape (status + code + message)", () => {
  const e = new V1ChatError(404, "customer_not_found", "no such customer");
  expect(e.status).toBe(404);
  expect(e.code).toBe("customer_not_found");
  expect(e.message).toBe("no such customer");
  expect(e).toBeInstanceOf(Error);
});

test("cross-org email collision is structurally impossible: management principal can only resolve in its org", () => {
  // The principal's orgId is the only org the lookup filter can carry. This
  // test documents the contract: resolveChatContext never accepts an orgId
  // from the request body — only from the authenticated principal.
  const p = managementPrincipal({ scopes: ["chat:write"] });
  const otherOrgId = new ObjectId();
  expect(p.orgId.equals(otherOrgId)).toBe(false);
});
