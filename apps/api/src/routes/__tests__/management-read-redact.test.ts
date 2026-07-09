import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import type { CustomerDoc } from "@tokenpanel/db";
import {
  maybeRedactCustomer,
  principalHasScope,
} from "../management/read.ts";

function customer(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    externalId: null,
    name: "alice",
    email: "alice@example.com",
    balance: { amountMinor: 10000, currency: "USD" },
    status: "active",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

test("maybeRedactCustomer: returns full doc when caller has balances:read", () => {
  const c = customer({ balance: { amountMinor: 5000, currency: "USD" } });
  const out = maybeRedactCustomer(c, true);
  expect("balance" in out).toBe(true);
  if ("balance" in out) {
    expect(out.balance.amountMinor).toBe(5000);
  }
});

test("maybeRedactCustomer: strips balance when caller lacks balances:read", () => {
  const c = customer({ balance: { amountMinor: 5000, currency: "USD" } });
  const out = maybeRedactCustomer(c, false);
  expect("balance" in out).toBe(false);
  // Other fields preserved.
  expect(out.name).toBe("alice");
  expect(out.email).toBe("alice@example.com");
  expect(out.status).toBe("active");
  expect(out._id).toBe(c._id);
});

test("maybeRedactCustomer: identity when hasBalancesRead true (no copy needed)", () => {
  const c = customer();
  expect(maybeRedactCustomer(c, true)).toBe(c);
});

function fakeContext(scopes: string[]) {
  const principal = {
    kind: "management" as const,
    orgId: new ObjectId(),
    managementKey: {
      _id: new ObjectId(),
      organizationId: new ObjectId(),
      name: "k",
      prefix: "tp_mgmt_abcd",
      keyHash: "h",
      scopes: scopes as any,
      status: "active" as const,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
  return { get: () => principal };
}

test("principalHasScope: true when scope present", () => {
  const c = fakeContext(["customers:read", "balances:read"]);
  expect(principalHasScope(c, "balances:read")).toBe(true);
  expect(principalHasScope(c, "customers:read")).toBe(true);
});

test("principalHasScope: false when scope absent", () => {
  const c = fakeContext(["customers:read"]);
  expect(principalHasScope(c, "balances:read")).toBe(false);
});

test("principalHasScope: false when principal missing (defensive)", () => {
  const c = { get: () => undefined as unknown as import("../../middleware/public-auth.ts").PublicPrincipal };
  expect(principalHasScope(c, "balances:read")).toBe(false);
});
