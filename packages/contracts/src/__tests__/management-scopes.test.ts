import { test, expect } from "bun:test";
import {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  managementScopeSchema,
} from "../management-scopes.ts";

test("scope definitions have no duplicates and mirror MANAGEMENT_SCOPES", () => {
  const scopeCount: number = MANAGEMENT_SCOPES.length;
  expect(new Set(MANAGEMENT_SCOPES).size).toBe(scopeCount);
  expect(MANAGEMENT_SCOPE_DEFINITIONS.length as number).toBe(scopeCount);
  for (let i = 0; i < MANAGEMENT_SCOPE_DEFINITIONS.length; i++) {
    const def = MANAGEMENT_SCOPE_DEFINITIONS[i]!;
    expect(MANAGEMENT_SCOPES[i]).toBe(def.value);
    expect(def.group.length).toBeGreaterThan(0);
    expect(def.description.length).toBeGreaterThan(0);
  }
});

test("managementScopeSchema accepts defined scopes and rejects unknown", () => {
  for (const s of MANAGEMENT_SCOPES) {
    expect(managementScopeSchema.safeParse(s).success).toBe(true);
  }
  expect(managementScopeSchema.safeParse("models:write").success).toBe(false);
  expect(managementScopeSchema.safeParse("").success).toBe(false);
});
