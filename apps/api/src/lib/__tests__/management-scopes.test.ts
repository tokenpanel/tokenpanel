import { test, expect } from "bun:test";
import {
  hasScope,
  assertManagementScope,
  ManagementScopeError,
} from "../management-scopes.ts";
import { MANAGEMENT_SCOPES, type ManagementScope } from "@tokenpanel/db";

const key: { scopes: ManagementScope[] } = { scopes: ["models:read", "chat:write"] };

test("hasScope: returns true when scope present, false otherwise", () => {
  expect(hasScope(key.scopes, "models:read")).toBe(true);
  expect(hasScope(key.scopes, "chat:write")).toBe(true);
  expect(hasScope(key.scopes, "customers:write")).toBe(false);
});

test("hasScope: empty scope set denies every scope", () => {
  for (const scope of MANAGEMENT_SCOPES) {
    expect(hasScope([], scope)).toBe(false);
  }
});

test("assertManagementScope: throws ManagementScopeError when missing", () => {
  expect(() => assertManagementScope(key, "balances:write")).toThrow(ManagementScopeError);
  const err = (() => {
    try {
      assertManagementScope(key, "balances:write");
      return null;
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(ManagementScopeError);
  expect((err as ManagementScopeError).required).toBe("balances:write");
});

test("assertManagementScope: no throw when scope present", () => {
  expect(() => assertManagementScope(key, "models:read")).not.toThrow();
  expect(() => assertManagementScope(key, "chat:write")).not.toThrow();
});

test("ManagementScopeError: carries required scope for diagnostics", () => {
  const e = new ManagementScopeError("usage:read");
  expect(e.required).toBe("usage:read");
  expect(e.message).toContain("usage:read");
});
