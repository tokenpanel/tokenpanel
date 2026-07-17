/**
 * Effect Schema for admin panel permissions (browser-safe).
 */
import { Schema } from "effect";
import {
  PANEL_PERMISSION_DEFINITIONS,
  PANEL_PERMISSIONS,
  PANEL_READ_PERMISSIONS,
  effectivePanelPermissions,
  hasPanelPermission,
  canGrantPanelAccess,
  type PanelPermission,
  type PanelPermissionDefinition,
} from "../panel-permissions.ts";

export {
  PANEL_PERMISSION_DEFINITIONS,
  PANEL_PERMISSIONS,
  PANEL_READ_PERMISSIONS,
  effectivePanelPermissions,
  hasPanelPermission,
  canGrantPanelAccess,
};
export type { PanelPermission, PanelPermissionDefinition };

const permissionLiterals = PANEL_PERMISSIONS as unknown as [
  PanelPermission,
  ...PanelPermission[],
];

export const PanelPermissionSchema = Schema.Literal(...permissionLiterals);
export type PanelPermissionType = Schema.Schema.Type<
  typeof PanelPermissionSchema
>;

/** Lowercase alias for camelCase import sites. */
export const panelPermissionSchema = PanelPermissionSchema;
