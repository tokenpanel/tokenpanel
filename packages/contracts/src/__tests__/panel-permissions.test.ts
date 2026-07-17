import { test, expect } from "bun:test";
import {
  PANEL_PERMISSION_DEFINITIONS,
  PANEL_PERMISSIONS,
  PANEL_READ_PERMISSIONS,
  panelPermissionSchema,
  effectivePanelPermissions,
  hasPanelPermission,
  writeCompanionOf,
  canGrantPanelAccess,
} from "../panel-permissions.ts";

test("permission definitions have no duplicates and mirror PANEL_PERMISSIONS", () => {
  const count: number = PANEL_PERMISSIONS.length;
  expect(new Set(PANEL_PERMISSIONS).size).toBe(count);
  // Cast: DEFINITIONS is `as const` so .length is a numeric literal (22).
  expect(PANEL_PERMISSION_DEFINITIONS.length as number).toBe(count);
  for (let i = 0; i < PANEL_PERMISSION_DEFINITIONS.length; i++) {
    const def = PANEL_PERMISSION_DEFINITIONS[i]!;
    expect(PANEL_PERMISSIONS[i]).toBe(def.value);
    expect(def.group.length).toBeGreaterThan(0);
    expect(def.description.length).toBeGreaterThan(0);
  }
});

test("panelPermissionSchema accepts defined permissions and rejects unknown", () => {
  for (const p of PANEL_PERMISSIONS) {
    expect(panelPermissionSchema.safeParse(p).success).toBe(true);
  }
  expect(panelPermissionSchema.safeParse("chat:write").success).toBe(false);
  expect(panelPermissionSchema.safeParse("providers:secrets").success).toBe(
    false,
  );
  expect(panelPermissionSchema.safeParse("").success).toBe(false);
});

test("PANEL_READ_PERMISSIONS are only :read atoms", () => {
  expect(PANEL_READ_PERMISSIONS.length).toBeGreaterThan(0);
  for (const p of PANEL_READ_PERMISSIONS) {
    expect(p.endsWith(":read")).toBe(true);
  }
});

test("effectivePanelPermissions: admin gets full catalog", () => {
  expect(effectivePanelPermissions("admin", [])).toEqual(PANEL_PERMISSIONS);
  expect(effectivePanelPermissions("admin", undefined)).toEqual(
    PANEL_PERMISSIONS,
  );
});

test("effectivePanelPermissions: member gets only grants", () => {
  expect(effectivePanelPermissions("member", undefined)).toEqual([]);
  expect(effectivePanelPermissions("member", [])).toEqual([]);
  expect(
    effectivePanelPermissions("member", ["customers:read", "usage:read"]),
  ).toEqual(["customers:read", "usage:read"]);
});

test("hasPanelPermission", () => {
  expect(hasPanelPermission("admin", [], "providers:write")).toBe(true);
  expect(hasPanelPermission("member", [], "providers:read")).toBe(false);
  expect(
    hasPanelPermission("member", ["providers:read"], "providers:read"),
  ).toBe(true);
  expect(
    hasPanelPermission("member", ["providers:read"], "providers:write"),
  ).toBe(false);
});

test("writeCompanionOf maps read→write only when pair exists", () => {
  expect(writeCompanionOf("invites:read")).toBe("invites:write");
  expect(writeCompanionOf("providers:read")).toBe("providers:write");
  expect(writeCompanionOf("dashboard:read")).toBeNull();
  expect(writeCompanionOf("usage:read")).toBeNull();
  expect(writeCompanionOf("invites:write")).toBeNull();
  expect(writeCompanionOf("playground:write")).toBeNull();
});

test("hasPanelPermission: write implies paired read", () => {
  // write-only grant satisfies read check for the same resource
  expect(
    hasPanelPermission("member", ["invites:write"], "invites:read"),
  ).toBe(true);
  expect(
    hasPanelPermission("member", ["balances:write"], "balances:read"),
  ).toBe(true);
  expect(
    hasPanelPermission(
      "member",
      ["customer_keys:write"],
      "customer_keys:read",
    ),
  ).toBe(true);
  expect(
    hasPanelPermission(
      "member",
      ["management_keys:write"],
      "management_keys:read",
    ),
  ).toBe(true);
  expect(
    hasPanelPermission("member", ["providers:write"], "providers:read"),
  ).toBe(true);
  // write does not imply a different resource's read
  expect(
    hasPanelPermission("member", ["invites:write"], "customers:read"),
  ).toBe(false);
  // read still does not imply write
  expect(
    hasPanelPermission("member", ["invites:read"], "invites:write"),
  ).toBe(false);
  // read-only catalog atoms have no write companion
  expect(
    hasPanelPermission("member", ["dashboard:read"], "dashboard:read"),
  ).toBe(true);
  expect(
    hasPanelPermission("member", [], "dashboard:read"),
  ).toBe(false);
});

test("canGrantPanelAccess: write does not expand grantable read atoms", () => {
  // Holding write lets the actor *use* read ops, but grant composition is
  // still the stored set — cannot bestow invites:read from write alone.
  expect(
    canGrantPanelAccess(
      "member",
      ["invites:write"],
      "member",
      ["invites:read"],
    ),
  ).toBe(false);
  expect(
    canGrantPanelAccess(
      "member",
      ["invites:write"],
      "member",
      ["invites:write"],
    ),
  ).toBe(true);
});

test("canGrantPanelAccess: admin may grant anything", () => {
  expect(canGrantPanelAccess("admin", [], "admin", [])).toBe(true);
  expect(
    canGrantPanelAccess("admin", [], "member", ["providers:write"]),
  ).toBe(true);
  expect(canGrantPanelAccess("admin", [], "member", [])).toBe(true);
});

test("canGrantPanelAccess: member may only grant subset of own perms", () => {
  const actor: readonly (typeof PANEL_PERMISSIONS)[number][] = [
    "invites:write",
    "invites:read",
    "customers:read",
  ];
  expect(canGrantPanelAccess("member", actor, "member", [])).toBe(true);
  expect(
    canGrantPanelAccess("member", actor, "member", ["invites:write"]),
  ).toBe(true);
  expect(
    canGrantPanelAccess("member", actor, "member", [
      "invites:write",
      "customers:read",
    ]),
  ).toBe(true);
  // Escalation: permission actor does not hold.
  expect(
    canGrantPanelAccess("member", actor, "member", ["providers:write"]),
  ).toBe(false);
  expect(
    canGrantPanelAccess("member", actor, "member", [
      "invites:write",
      "providers:read",
    ]),
  ).toBe(false);
  // Admin role ⇒ full catalog; member cannot grant.
  expect(canGrantPanelAccess("member", actor, "admin", [])).toBe(false);
  expect(
    canGrantPanelAccess("member", ["invites:write"], "admin", []),
  ).toBe(false);
});

test("canGrantPanelAccess: member with full catalog can grant admin", () => {
  // Edge case: effective permissions equal full catalog.
  expect(
    canGrantPanelAccess("member", PANEL_PERMISSIONS, "admin", []),
  ).toBe(true);
});
