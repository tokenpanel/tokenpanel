import { test, expect } from "bun:test";
import {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  MANAGEMENT_SCOPES_META,
  managementScopeSchema,
} from "../management-scopes.ts";

test("scope definitions cover every documented scope without duplicates", () => {
  expect(MANAGEMENT_SCOPES).toEqual([
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
  expect(new Set(MANAGEMENT_SCOPES).size).toBe(9);
  expect(MANAGEMENT_SCOPE_DEFINITIONS.length).toBe(9);
});

test("MANAGEMENT_SCOPES_META mirrors definitions (API compatibility shape)", () => {
  expect(MANAGEMENT_SCOPES_META.length).toBe(MANAGEMENT_SCOPE_DEFINITIONS.length);
  for (let i = 0; i < MANAGEMENT_SCOPE_DEFINITIONS.length; i++) {
    const def = MANAGEMENT_SCOPE_DEFINITIONS[i]!;
    const meta = MANAGEMENT_SCOPES_META[i]!;
    expect(meta.scope).toBe(def.value);
    expect(meta.group).toBe(def.group);
    expect(meta.description).toBe(def.description);
    expect(meta.group.length).toBeGreaterThan(0);
    expect(meta.description.length).toBeGreaterThan(0);
  }
});

test("managementScopeSchema accepts all values and rejects unknown", () => {
  for (const s of MANAGEMENT_SCOPES) {
    expect(managementScopeSchema.safeParse(s).success).toBe(true);
  }
  expect(managementScopeSchema.safeParse("models:write").success).toBe(false);
  expect(managementScopeSchema.safeParse("").success).toBe(false);
});
