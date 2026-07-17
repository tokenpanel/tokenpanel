/**
 * Pure mapping: UserDoc → UserView (shared by login/signup/me/invite).
 */
import type { UserDoc, UserRole } from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import { effectivePanelPermissions } from "@tokenpanel/contracts";
import type { UserView } from "./types.ts";

/**
 * @param activeOrganizationIdOverride — session-scoped tenant (prefer over
 *   user.activeOrganizationId for authenticated request views).
 */
export function toUserView(
  user: UserDoc,
  roleOverride?: UserRole,
  permissionsOverride?: readonly PanelPermission[],
  activeOrganizationIdOverride?: string,
): UserView {
  const activeId =
    activeOrganizationIdOverride ?? user.activeOrganizationId.toHexString();
  const activeMembership = user.memberships.find(
    (m) => m.organizationId.toHexString() === activeId,
  );
  const role = roleOverride ?? activeMembership?.role ?? "member";
  const storedPermissions =
    permissionsOverride ??
    (activeMembership?.permissions as readonly PanelPermission[] | undefined) ??
    [];
  const permissions = effectivePanelPermissions(role, storedPermissions);
  return {
    id: user._id.toHexString(),
    username: user.username,
    email: user.email,
    status: user.status,
    role,
    permissions,
    memberships: user.memberships.map((m) => ({
      organizationId: m.organizationId.toHexString(),
      role: m.role,
      permissions: (m.permissions ?? []) as readonly PanelPermission[],
    })),
    activeOrganizationId: activeId,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
