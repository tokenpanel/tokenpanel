import { test, expect } from "bun:test";
import {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  MANAGEMENT_SCOPES_META,
  managementScopeSchema,
} from "../management-scopes.ts";

test("scope definitions have no duplicates and META mirrors them", () => {
  const scopeCount: number = MANAGEMENT_SCOPES.length;
  expect(new Set(MANAGEMENT_SCOPES).size).toBe(scopeCount);
  expect(MANAGEMENT_SCOPE_DEFINITIONS.length as number).toBe(scopeCount);
  expect(MANAGEMENT_SCOPES_META.length as number).toBe(scopeCount);
  for (let i = 0; i < MANAGEMENT_SCOPE_DEFINITIONS.length; i++) {
    const def = MANAGEMENT_SCOPE_DEFINITIONS[i]!;
    const meta = MANAGEMENT_SCOPES_META[i]!;
    expect(meta.scope).toBe(def.value);
    expect(meta.group).toBe(def.group);
    expect(meta.description).toBe(def.description);
  }
});

test("managementScopeSchema accepts defined scopes and rejects unknown", () => {
  for (const s of MANAGEMENT_SCOPES) {
    expect(managementScopeSchema.safeParse(s).success).toBe(true);
  }
  expect(managementScopeSchema.safeParse("models:write").success).toBe(false);
  expect(managementScopeSchema.safeParse("").success).toBe(false);
});
