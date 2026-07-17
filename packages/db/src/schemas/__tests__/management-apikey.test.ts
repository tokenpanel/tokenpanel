import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  managementApiKeyDoc,
  managementApiKeyCreateInput,
  managementApiKeyUpdateInput,
  managementScope,
  MANAGEMENT_SCOPES,
} from "../management-apikey.ts";

const base = {
  _id: new ObjectId(),
  organizationId: new ObjectId(),
  name: "internal-ci",
  prefix: "tp_mgmt_abcd",
  keyHash: "hash",
  createdAt: new Date(),
  updatedAt: new Date(),
};

test("managementScope enum covers all documented scope categories", () => {
  expect([...MANAGEMENT_SCOPES]).toEqual([
    "models:read",
    "customers:read",
    "customers:write",
    "balances:read",
    "balances:write",
    "usage:read",
    "plans:read",
    "subscriptions:write",
    "chat:write",
  ]);
  for (const s of MANAGEMENT_SCOPES) {
    expect(managementScope.safeParse(s).success).toBe(true);
  }
  expect(managementScope.safeParse("providers:write").success).toBe(false);
  expect(managementScope.safeParse("admin:impersonate").success).toBe(false);
});

test("managementApiKeyDoc: scopes default [], status default active, lastUsedAt nullish", () => {
  const r = managementApiKeyDoc.parse(base);
  expect(r.scopes).toEqual([]);
  expect(r.status).toBe("active");
  expect(r.lastUsedAt).toBeUndefined();
});

test("managementApiKeyDoc: rejects unknown scopes and bad prefix length", () => {
  expect(
    managementApiKeyDoc.safeParse({ ...base, scopes: ["models:read", "admin:all"] }).success,
  ).toBe(false);
  expect(managementApiKeyDoc.safeParse({ ...base, prefix: "short" }).success).toBe(false);
  expect(managementApiKeyDoc.safeParse({ ...base, prefix: "x".repeat(21) }).success).toBe(false);
  expect(managementApiKeyDoc.safeParse({ ...base, status: "deleted" }).success).toBe(false);
});

test("managementApiKeyDoc: accepts all valid scopes", () => {
  const r = managementApiKeyDoc.parse({ ...base, scopes: [...MANAGEMENT_SCOPES] });
  expect(r.scopes).toHaveLength(MANAGEMENT_SCOPES.length);
});

test("managementApiKeyCreateInput: name + scopes required-ish, dedups not enforced at schema", () => {
  expect(managementApiKeyCreateInput.safeParse({ name: "k" }).success).toBe(true);
  expect(managementApiKeyCreateInput.safeParse({ name: "", scopes: [] }).success).toBe(false);
  expect(
    managementApiKeyCreateInput.safeParse({ name: "k", scopes: ["customers:read"] }).success,
  ).toBe(true);
  expect(
    managementApiKeyCreateInput.safeParse({ name: "k", scopes: ["unknown:all"] }).success,
  ).toBe(false);
});

test("managementApiKeyUpdateInput: all optional, validates enums", () => {
  expect(managementApiKeyUpdateInput.safeParse({}).success).toBe(true);
  expect(managementApiKeyUpdateInput.safeParse({ status: "revoked" }).success).toBe(true);
  expect(managementApiKeyUpdateInput.safeParse({ status: "deleted" }).success).toBe(false);
  expect(managementApiKeyUpdateInput.safeParse({ scopes: ["chat:write"] }).success).toBe(true);
  expect(managementApiKeyUpdateInput.safeParse({ scopes: ["chat:admin"] }).success).toBe(false);
  expect(managementApiKeyUpdateInput.safeParse({ name: "" }).success).toBe(false);
});
