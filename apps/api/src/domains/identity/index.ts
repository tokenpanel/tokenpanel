/**
 * Identity domain — re-exports auth membership / invite / user view ops.
 * Kept as a discoverable ownership root per design layout.
 */
export {
  toUserView,
  roleForOrganization,
  requireRole,
  requireManagementScope,
  hasManagementScope,
  listInvites,
  createInvite,
  revokeInvite,
  acceptInvite,
  switchActiveOrganization,
  updateMe,
  changePassword,
  type UserView,
  type MembershipView,
  type AuthzPrincipal,
  type CreateInviteInput,
  type AcceptInviteInput,
} from "../auth/index.ts";
