import type { MiddlewareHandler } from "hono";
import { ObjectId } from "mongodb";
import type { UserDoc, UserRole } from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import { Effect } from "effect";
import {
  resolveAdminSession,
  requireRole as requireRoleOp,
  requirePermission as requirePermissionOp,
} from "../domains/auth/index.ts";
import type { AuthzPrincipal } from "../domains/auth/types.ts";
import {
  runMiddlewareEffect,
  renderedToResponse,
} from "../http/adapters/boundary.ts";
import { isAppError } from "../errors/families.ts";
import { renderAdminError } from "../http/renderers/admin.ts";

export type AuthVariables = {
  user: UserDoc;
  /** Session-scoped tenant (from admin_sessions.organizationId). */
  orgId: ObjectId;
  /** Role for the session org, resolved from the user's memberships. */
  role: UserRole;
  /** Stored membership grants for the session org (empty when admin). */
  permissions: readonly PanelPermission[];
  /** Allowlist session id (JWT `sid`). */
  sessionId: string;
};

type AuthMiddleware = MiddlewareHandler<{ Variables: AuthVariables }>;

export function getToken(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const h = c.req.header("Authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2) return null;
  const [scheme, token] = parts as [string, string];
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}

/**
 * Admin JWT auth via ManagedRuntime + domain session op.
 * Production and tests must install ManagedRuntime (bootApi / test helper).
 */
function adminPrincipalFromContext(c: {
  get: {
    (key: "user"): UserDoc;
    (key: "orgId"): ObjectId;
    (key: "role"): UserRole;
    (key: "permissions"): readonly PanelPermission[];
  };
}): AuthzPrincipal {
  const user = c.get("user");
  return {
    kind: "admin_user",
    userId: user._id.toHexString(),
    organizationId: c.get("orgId").toHexString(),
    role: c.get("role"),
    permissions: c.get("permissions"),
    status: user.status === "disabled" ? "disabled" : "active",
  };
}

export const requireAuth: AuthMiddleware = async (c, next) => {
  const token = getToken(c);
  const denied = await runMiddlewareEffect(c, resolveAdminSession(token), {
    surface: "admin",
    onSuccess: (session) => {
      c.set("user", session.user);
      c.set("orgId", session.orgId);
      c.set("role", session.role);
      c.set(
        "permissions",
        session.permissions as readonly PanelPermission[],
      );
      c.set("sessionId", session.sessionId);
    },
    mapError: (err) => {
      if (!isAppError(err)) return null;
      return renderAdminError(err);
    },
  });
  if (denied) return denied;
  await next();
};

/**
 * Require a specific role for the ACTIVE organization (domain requireRole).
 * Prefer requirePermission for new gates.
 */
export function requireRole(role: UserRole): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const principal = adminPrincipalFromContext(c);
    const denied = await runMiddlewareEffect(
      c,
      requireRoleOp({ principal, role }),
      {
        surface: "admin",
        onSuccess: () => undefined,
        mapError: (err) => (isAppError(err) ? renderAdminError(err) : null),
      },
    );
    if (denied) return denied;
    await next();
  };
}

/**
 * Require a panel permission for the ACTIVE organization.
 */
export function requirePermission(
  permission: PanelPermission,
): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const principal = adminPrincipalFromContext(c);
    const denied = await runMiddlewareEffect(
      c,
      requirePermissionOp({ principal, permission }),
      {
        surface: "admin",
        onSuccess: () => undefined,
        mapError: (err) => (isAppError(err) ? renderAdminError(err) : null),
      },
    );
    if (denied) return denied;
    await next();
  };
}

/** Test/helper: run role check as Effect without Hono. */
export function checkRoleEffect(
  principal: AuthzPrincipal,
  role: UserRole,
): Effect.Effect<void, unknown> {
  return requireRoleOp({ principal, role });
}

/** Test/helper: run permission check as Effect without Hono. */
export function checkPermissionEffect(
  principal: AuthzPrincipal,
  permission: PanelPermission,
): Effect.Effect<void, unknown> {
  return requirePermissionOp({ principal, permission });
}

void renderedToResponse;
