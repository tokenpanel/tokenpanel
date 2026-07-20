/**
 * Auth / identity domain value types (no Hono, no Mongo).
 */
import type { UserRole } from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import type { HexId } from "../ports/common.ts";

export type MembershipView = {
  readonly organizationId: HexId;
  readonly role: UserRole;
  /** Explicit grants (members only; empty for admins in storage). */
  readonly permissions: readonly PanelPermission[];
};

/** Public user view used by auth surfaces (admin JWT session). */
export type UserView = {
  readonly id: HexId;
  readonly username: string;
  readonly email: string;
  readonly status: string;
  readonly role: UserRole;
  /**
   * Effective permissions for the active organization.
   * Admins receive the full panel catalog; members only their grants.
   */
  readonly permissions: readonly PanelPermission[];
  readonly memberships: readonly MembershipView[];
  readonly activeOrganizationId: HexId;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
};

export type LoginInput = {
  readonly username: string;
  readonly password: string;
};

export type LoginResult = {
  readonly token: string;
  readonly user: UserView;
};

export type SignupInput = {
  readonly adminEmail: string;
  readonly adminUsername: string;
  readonly password: string;
};

export type SignupResult = {
  readonly token: string;
  readonly user: UserView;
  readonly organization: {
    readonly id: HexId;
    readonly name: string;
    readonly slug: string;
  };
};

export type UpdateMeInput = {
  readonly userId: HexId;
  readonly currentEmail: string;
  readonly email: string;
  /** Session tenant so the response matches request org context. */
  readonly activeOrganizationId?: HexId | undefined;
  /**
   * Current allowlist session id. When the email changes, all OTHER sessions
   * for the user are revoked; this one is kept so the requester is not logged
   * out mid-flow. When omitted, every session is revoked.
   */
  readonly sessionId?: HexId | undefined;
};

export type ChangePasswordInput = {
  readonly userId: HexId;
  readonly passwordHash: string;
  readonly currentPassword: string;
  readonly newPassword: string;
};

export type CreateInviteInput = {
  readonly organizationId: HexId;
  readonly invitedBy: HexId;
  readonly email: string;
  readonly role?: UserRole | undefined;
  readonly permissions?: readonly PanelPermission[] | undefined;
  readonly ttlHours?: number | undefined;
  /**
   * Actor performing the invite (active-org membership).
   * Required so domain can reject privilege escalation:
   * grant ⊆ actor effective permissions.
   */
  readonly actorRole: UserRole;
  readonly actorPermissions: readonly PanelPermission[];
};

export type CreateInviteResult = {
  readonly invite: {
    readonly id: HexId;
    readonly organizationId: HexId;
    readonly email: string;
    readonly role: UserRole;
    readonly permissions: readonly PanelPermission[];
    readonly status: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  };
  /** Opaque token — returned once; never re-fetchable. */
  readonly token: string;
};

export type AcceptInviteInput = {
  readonly token: string;
  readonly username: string;
  readonly password: string;
};

export type AcceptInviteResult = {
  readonly token: string;
  readonly user: UserView;
};

/** Actor context for authorization decisions (surface-agnostic). */
export type AuthzPrincipal =
  | {
      readonly kind: "admin_user";
      readonly userId: HexId;
      readonly organizationId: HexId;
      readonly role: UserRole;
      /** Stored membership grants (empty for admin; check via hasPanelPermission). */
      readonly permissions: readonly PanelPermission[];
      readonly status: "active" | "disabled";
    }
  | {
      readonly kind: "management_key";
      readonly keyId: HexId;
      readonly organizationId: HexId;
      readonly scopes: readonly string[];
      readonly status: "active" | "revoked";
    };
