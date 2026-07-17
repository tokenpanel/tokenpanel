/**
 * Pure mapping: UserDoc → UserView (shared by login/signup/me/invite).
 */
import type { UserDoc, UserRole } from "@tokenpanel/db";
import type { UserView } from "./types.ts";

export function toUserView(user: UserDoc, roleOverride?: UserRole): UserView {
  const activeId = user.activeOrganizationId.toHexString();
  const activeMembership = user.memberships.find(
    (m) => m.organizationId.toHexString() === activeId,
  );
  const role = roleOverride ?? activeMembership?.role ?? "member";
  return {
    id: user._id.toHexString(),
    username: user.username,
    email: user.email,
    status: user.status,
    role,
    memberships: user.memberships.map((m) => ({
      organizationId: m.organizationId.toHexString(),
      role: m.role,
    })),
    activeOrganizationId: activeId,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
