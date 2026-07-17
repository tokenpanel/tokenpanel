import { test, expect } from "bun:test";
import {
  PANEL_PERMISSION_DEFINITIONS,
  PANEL_PERMISSIONS,
  PANEL_READ_PERMISSIONS,
  panelPermissionSchema,
  effectivePanelPermissions,
  hasPanelPermission,
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
