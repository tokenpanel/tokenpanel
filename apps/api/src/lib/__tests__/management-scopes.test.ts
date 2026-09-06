import { test, expect } from "bun:test";
import {
  assertManagementScope,
  hasScope,
  ManagementScopeError,
  MANAGEMENT_SCOPES,
} from "../management-scopes.ts";
import type { ManagementScope } from "@tokenpanel/db";

/** Widen raw runtime strings so unknown/unrelated values can be exercised. */
const scopes = (...values: string[]): ManagementScope[] =>
  values as ManagementScope[];

test("MANAGEMENT_SCOPES re-export is a non-empty authoritative allow-list", () => {
  expect(MANAGEMENT_SCOPES.length).toBeGreaterThan(0);
  expect(MANAGEMENT_SCOPES).toContain("models:read");
});

test("hasScope: true only on exact match", () => {
  for (const scope of MANAGEMENT_SCOPES) {
    expect(hasScope([scope], scope)).toBe(true);
    expect(hasScope([...MANAGEMENT_SCOPES], scope)).toBe(true);
  }
});

test("hasScope: a granted scope never implies an ungranted one", () => {
  expect(hasScope(["models:read"], "customers:read")).toBe(false);
  expect(
    hasScope(["models:read", "customers:read"], "customers:write"),
  ).toBe(false);
});

test("hasScope: empty scope list grants nothing", () => {
  for (const scope of MANAGEMENT_SCOPES) {
    expect(hasScope([], scope)).toBe(false);
  }
});

test("hasScope: no wildcard or admin implication — the list is exact", () => {
  expect(hasScope(scopes("*"), "models:read")).toBe(false);
  expect(hasScope(scopes("admin"), "models:read")).toBe(false);
  expect(hasScope(scopes("models:*"), "models:read")).toBe(false);
});

test("hasScope: unknown scope values in the grant list never match", () => {
  expect(hasScope(scopes("providers:write"), "models:read")).toBe(false);
  expect(hasScope(scopes("Models:read"), "models:read")).toBe(false);
});

test("assertManagementScope: passes when the key holds the scope", () => {
  expect(
    assertManagementScope({ scopes: ["models:read"] }, "models:read"),
  ).toBeUndefined();
  expect(
    assertManagementScope(
      { scopes: ["models:read", "balances:write"] },
      "balances:write",
    ),
  ).toBeUndefined();
});

test("assertManagementScope: throws ManagementScopeError naming the missing scope", () => {
  const key = { scopes: ["models:read"] as ManagementScope[] };
  let err: unknown = undefined;
  try {
    assertManagementScope(key, "balances:write");
  } catch (caught) {
    err = caught;
  }
  expect(err).toBeInstanceOf(ManagementScopeError);
  expect(err).toBeInstanceOf(Error);
  if (!(err instanceof ManagementScopeError)) throw new Error("unreachable");
  expect(err.required).toBe("balances:write");
  expect(err.name).toBe("ManagementScopeError");
  expect(err.message).toContain("balances:write");
});

test("assertManagementScope: throws when the key has no scopes at all", () => {
  let err: unknown = undefined;
  try {
    assertManagementScope({ scopes: [] }, "customers:read");
  } catch (caught) {
    err = caught;
  }
  expect(err).toBeInstanceOf(ManagementScopeError);
  if (!(err instanceof ManagementScopeError)) throw new Error("unreachable");
  expect(err.required).toBe("customers:read");
  expect(err.message).toContain("customers:read");
});

test("assertManagementScope: missing one of several scopes still throws", () => {
  const key = {
    scopes: ["models:read", "customers:read"] as ManagementScope[],
  };
  expect(() => assertManagementScope(key, "usage:read")).toThrow(
    ManagementScopeError,
  );
});
