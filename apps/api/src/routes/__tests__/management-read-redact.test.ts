import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import type { CustomerDoc, ModelDoc } from "@tokenpanel/db";
import {
  maybeRedactCustomer,
  principalHasScope,
  toModelCapability,
} from "../management/read.ts";

function customer(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    externalId: null,
    name: "alice",
    email: "alice@example.com",
    balance: { amountUnits: 10000, reservedUnits: 0, currency: "USD" },
    status: "active",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

test("maybeRedactCustomer: returns full doc when caller has balances:read", () => {
  const c = customer({
    balance: { amountUnits: 5000, reservedUnits: 0, currency: "USD" },
  });
  const out = maybeRedactCustomer(c, true);
  expect("balance" in out).toBe(true);
  if ("balance" in out) {
    expect(out.balance.amountUnits).toBe(5000);
  }
});

test("maybeRedactCustomer: strips balance when caller lacks balances:read", () => {
  const c = customer({
    balance: { amountUnits: 5000, reservedUnits: 0, currency: "USD" },
  });
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

function modelDoc(over: Partial<ModelDoc> = {}): ModelDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    aliasId: "my-gpt",
    displayName: "My GPT",
    description: null,
    entries: [{ id: "e1", providerId: new ObjectId(), upstreamModelId: "gpt-4o", priority: 0, active: true }],
    reasoning: false,
    toolCall: false,
    structuredOutput: undefined,
    temperature: undefined,
    attachment: false,
    interleaved: undefined,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    status: undefined,
    price: { inputUnitsPerMillion: 300, outputUnitsPerMillion: 600 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: { tier: "gold", internal: "secret-ish" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

test("toModelCapability: omits metadata from management model DTO", () => {
  const out = toModelCapability(modelDoc());
  expect("metadata" in out).toBe(false);
  expect(out.aliasId).toBe("my-gpt");
  expect(out.displayName).toBe("My GPT");
  expect(out.active).toBe(true);
});

test("toModelCapability: omits entries, marginBps, ids, timestamps", () => {
  const out = toModelCapability(modelDoc());
  expect("entries" in out).toBe(false);
  expect("marginBps" in out).toBe(false);
  expect("_id" in out).toBe(false);
  expect("organizationId" in out).toBe(false);
  expect("createdAt" in out).toBe(false);
  expect("updatedAt" in out).toBe(false);
  expect(out.price).toEqual({
    inputUnitsPerMillion: 300,
    outputUnitsPerMillion: 600,
  });
});
