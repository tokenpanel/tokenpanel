/**
 * Authorization decision operations (task 8.1).
 * Surface-agnostic: returns tagged errors, not HTTP.
 */
import { Effect } from "effect";
import type { UserRole, ManagementScope } from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import {
  hasPanelPermission,
  effectivePanelPermissions,
} from "@tokenpanel/contracts";
import {
  AuthenticationError,
  AuthorizationError,
} from "../../errors/families.ts";
import type { AuthzPrincipal } from "./types.ts";

export type RequireRoleInput = {
  readonly principal: AuthzPrincipal;
  readonly role: UserRole;
};

/**
 * Require admin_user principal with the given active-org role.
 * Prefer requirePermission for new admin-panel gates.
 */
export function requireRole(
  input: RequireRoleInput,
): Effect.Effect<void, AuthenticationError | AuthorizationError> {
  return Effect.gen(function* () {
    const p = input.principal;
    if (p.kind !== "admin_user") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Admin session required",
          reason: "wrong_principal_kind",
        }),
      );
    }
    if (p.status !== "active") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "user_disabled",
          message: "User disabled",
          reason: "user_disabled",
        }),
      );
    }
    if (p.role !== input.role) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Insufficient role",
          reason: "role_mismatch",
        }),
      );
    }
  });
}

export type RequirePermissionInput = {
  readonly principal: AuthzPrincipal;
  readonly permission: PanelPermission;
};

/**
 * Require admin_user principal holding `permission` for the active org.
 * Admins hold the full panel catalog; members need an explicit grant.
 */
export function requirePermission(
  input: RequirePermissionInput,
): Effect.Effect<void, AuthenticationError | AuthorizationError> {
  return Effect.gen(function* () {
    const p = input.principal;
    if (p.kind !== "admin_user") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Admin session required",
          reason: "wrong_principal_kind",
        }),
      );
    }
    if (p.status !== "active") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "user_disabled",
          message: "User disabled",
          reason: "user_disabled",
        }),
      );
    }
    if (
      !hasPanelPermission(p.role, p.permissions, input.permission)
    ) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Missing required permission",
          reason: "missing_permission",
          scope: input.permission,
        }),
      );
    }
  });
}

/**
 * Pure permission check for redaction / conditional UI data.
 */
export function principalHasPermission(
  principal: AuthzPrincipal,
  required: PanelPermission,
): boolean {
  if (principal.kind !== "admin_user") return false;
  if (principal.status !== "active") return false;
  return hasPanelPermission(
    principal.role,
    principal.permissions,
    required,
  );
}

export { effectivePanelPermissions, hasPanelPermission };

export type RequireScopeInput = {
  readonly principal: AuthzPrincipal;
  readonly scope: ManagementScope;
};

/**
 * Require management_key principal holding `scope`.
 * Does not leak resource existence (uniform forbidden).
 */
export function requireManagementScope(
  input: RequireScopeInput,
): Effect.Effect<void, AuthorizationError> {
  return Effect.gen(function* () {
    const p = input.principal;
    if (p.kind !== "management_key") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Management key required",
          reason: "wrong_principal_kind",
        }),
      );
    }
    if (p.status !== "active") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Key revoked",
          reason: "key_revoked",
        }),
      );
    }
    if (!p.scopes.includes(input.scope)) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "missing_scope",
          message: "Missing required scope",
          reason: "missing_scope",
          scope: input.scope,
        }),
      );
    }
  });
}

/**
 * Pure scope check (no Effect) for composing in other domain ops.
 */
export function hasManagementScope(
  scopes: readonly string[],
  required: ManagementScope,
): boolean {
  return scopes.includes(required);
}

/**
 * Membership role for a given org, or null if not a member.
 */
export function roleForOrganization(
  memberships: readonly { organizationId: { equals: (id: { toHexString: () => string } | string) => boolean } | { toHexString: () => string }; role: UserRole }[],
  organizationIdHex: string,
): UserRole | null {
  for (const m of memberships) {
    const id =
      typeof m.organizationId === "object" &&
      m.organizationId !== null &&
      "toHexString" in m.organizationId
        ? m.organizationId.toHexString()
        : String(m.organizationId);
    if (id === organizationIdHex) return m.role;
  }
  return null;
}
