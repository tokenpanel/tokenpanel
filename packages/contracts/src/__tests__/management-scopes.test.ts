import { test, describe, it, expect } from "bun:test";
import {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  managementScopeSchema,
  canGrantManagementScopes,
  requiredPanelPermissionForScope,
  type ManagementScope,
} from "../management-scopes.ts";
import {
  PANEL_PERMISSIONS,
  type PanelPermission,
} from "../panel-permissions.ts";

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

describe("requiredPanelPermissionForScope", () => {
  it("returns a valid PanelPermission for every defined scope", () => {
    const valid = new Set<string>(PANEL_PERMISSIONS);
    for (const scope of MANAGEMENT_SCOPES) {
      const required = requiredPanelPermissionForScope(scope);
      expect(valid.has(required)).toBe(true);
    }
  });

  it("returns the expected mapping for each scope", () => {
    const expected: Record<ManagementScope, PanelPermission> = {
      "models:read": "models:read",
      "customers:read": "customers:read",
      "customers:write": "customers:write",
      "balances:read": "balances:read",
      "balances:write": "balances:write",
      "usage:read": "usage:read",
      "plans:read": "plans:read",
      "subscriptions:write": "subscriptions:write",
      "chat:write": "playground:write",
    };
    for (const scope of MANAGEMENT_SCOPES) {
      expect(requiredPanelPermissionForScope(scope)).toBe(expected[scope]);
    }
  });
});

describe("canGrantManagementScopes", () => {
  it("admin can grant any single scope", () => {
    for (const scope of MANAGEMENT_SCOPES) {
      expect(canGrantManagementScopes("admin", [], [scope])).toBe(true);
    }
  });

  it("admin can grant every scope at once", () => {
    expect(canGrantManagementScopes("admin", [], MANAGEMENT_SCOPES)).toBe(true);
  });

  it("admin bypasses even with undefined permissions", () => {
    expect(
      canGrantManagementScopes("admin", undefined, MANAGEMENT_SCOPES),
    ).toBe(true);
  });

  it("member with no permissions cannot grant any scope", () => {
    for (const scope of MANAGEMENT_SCOPES) {
      expect(canGrantManagementScopes("member", [], [scope])).toBe(false);
    }
  });

  it("member with undefined permissions cannot grant any scope", () => {
    for (const scope of MANAGEMENT_SCOPES) {
      expect(canGrantManagementScopes("member", undefined, [scope])).toBe(false);
    }
  });

  describe("member with customers:write", () => {
    const perms: PanelPermission[] = ["customers:write"];

    it("can grant customers:read (write implies read)", () => {
      expect(canGrantManagementScopes("member", perms, ["customers:read"])).toBe(
        true,
      );
    });

    it("can grant customers:write", () => {
      expect(canGrantManagementScopes("member", perms, ["customers:write"])).toBe(
        true,
      );
    });

    it("cannot grant balances, models, usage, plans, subscriptions, or chat scopes", () => {
      const ungrantable: ManagementScope[] = [
        "balances:read",
        "balances:write",
        "models:read",
        "usage:read",
        "plans:read",
        "subscriptions:write",
        "chat:write",
      ];
      for (const scope of ungrantable) {
        expect(canGrantManagementScopes("member", perms, [scope])).toBe(false);
      }
    });
  });

  describe("member with balances:write", () => {
    const perms: PanelPermission[] = ["balances:write"];

    it("can grant balances:read and balances:write", () => {
      expect(canGrantManagementScopes("member", perms, ["balances:read"])).toBe(
        true,
      );
      expect(canGrantManagementScopes("member", perms, ["balances:write"])).toBe(
        true,
      );
    });

    it("cannot grant customers scopes", () => {
      expect(canGrantManagementScopes("member", perms, ["customers:read"])).toBe(
        false,
      );
      expect(
        canGrantManagementScopes("member", perms, ["customers:write"]),
      ).toBe(false);
    });
  });

  describe("member with only management_keys:write", () => {
    // management_keys:write lets a member issue keys, but no management scope
    // maps to a management_keys permission — so this member can attach no
    // scope. This is the privilege-escalation defense in action.
    const perms: PanelPermission[] = ["management_keys:write"];

    it("cannot grant any management scope", () => {
      for (const scope of MANAGEMENT_SCOPES) {
        expect(canGrantManagementScopes("member", perms, [scope])).toBe(false);
      }
    });

    it("can grant an empty scope set", () => {
      expect(canGrantManagementScopes("member", perms, [])).toBe(true);
    });
  });

  describe("member with playground:write", () => {
    const perms: PanelPermission[] = ["playground:write"];

    it("can grant chat:write (cross-mapping to playground:write)", () => {
      expect(canGrantManagementScopes("member", perms, ["chat:write"])).toBe(
        true,
      );
    });

    it("cannot grant unrelated scopes", () => {
      expect(canGrantManagementScopes("member", perms, ["customers:read"])).toBe(
        false,
      );
      expect(canGrantManagementScopes("member", perms, ["models:read"])).toBe(
        false,
      );
    });
  });

  it("empty scopes array returns true for any actor (no additions requested)", () => {
    expect(canGrantManagementScopes("member", [], [])).toBe(true);
    expect(canGrantManagementScopes("member", ["customers:write"], [])).toBe(
      true,
    );
    expect(canGrantManagementScopes("admin", [], [])).toBe(true);
  });

  it("mixed scopes with one ungrantable fails the whole batch", () => {
    expect(
      canGrantManagementScopes("member", ["customers:write"], [
        "customers:read",
        "balances:write",
      ]),
    ).toBe(false);
  });

  it("mixed scopes all grantable passes", () => {
    expect(
      canGrantManagementScopes(
        "member",
        ["customers:write", "balances:write"],
        ["customers:read", "customers:write", "balances:read", "balances:write"],
      ),
    ).toBe(true);
  });
});
