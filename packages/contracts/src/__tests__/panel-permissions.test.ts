import { test, expect } from "bun:test";
import {
  PANEL_PERMISSION_DEFINITIONS,
  PANEL_PERMISSIONS,
  PANEL_READ_PERMISSIONS,
  panelPermissionSchema,
  effectivePanelPermissions,
  hasPanelPermission,
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
