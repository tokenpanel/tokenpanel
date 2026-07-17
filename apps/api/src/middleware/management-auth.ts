import type { MiddlewareHandler } from "hono";
import type { ManagementScope } from "@tokenpanel/db";
import type { PublicAuthVariables, PublicPrincipal } from "./public-auth.ts";
import {
  requireManagementScope as requireScopeOp,
} from "../domains/auth/authz.ts";
import type { AuthzPrincipal } from "../domains/auth/types.ts";
import { runMiddlewareEffect } from "../http/adapters/boundary.ts";
import { isAppError } from "../errors/families.ts";
import { renderAdminError } from "../http/renderers/admin.ts";
import { Effect } from "effect";
import { AuthenticationError } from "../errors/families.ts";

/**
 * Variables available to /api/management routes after auth. `principal` is
 * always set (by requirePublicPrincipal) and is always kind="management" after
 * requireManagementPrincipal runs.
 */
export type ManagementAuthVariables = PublicAuthVariables;

/**
 * Narrow the principal to a management key. Returns 401 (not 403) for
 * customer-key callers — uniform 401 prevents enumeration of management endpoints.
 */
export const requireManagementPrincipal: MiddlewareHandler<{
  Variables: ManagementAuthVariables;
}> = async (c, next) => {
  const principal = c.get("principal") as PublicPrincipal | undefined;

  const program = Effect.gen(function* () {
    if (!principal || principal.kind !== "management") {
      return yield* Effect.fail(
        new AuthenticationError({
          code: "unauthorized",
          message: "Unauthorized",
        }),
      );
    }
    return principal;
  });
  const denied = await runMiddlewareEffect(c, program, {
    surface: "admin",
    onSuccess: () => undefined,
    mapError: (err) => (isAppError(err) ? renderAdminError(err) : null),
  });
  if (denied) return denied;
  await next();
};

/**
 * Per-route scope gate for management endpoints.
 */
export function requireManagementScope(scope: ManagementScope): MiddlewareHandler<{
  Variables: ManagementAuthVariables;
}> {
  return async (c, next) => {
    const principal = c.get("principal") as PublicPrincipal | undefined;

    if (!principal || principal.kind !== "management") {
      return c.json({ error: "unauthorized" }, 401);
    }
    const authz: AuthzPrincipal = {
      kind: "management_key",
      keyId: principal.managementKey._id.toHexString(),
      organizationId: principal.orgId.toHexString(),
      scopes: principal.managementKey.scopes,
      status:
        principal.managementKey.status === "revoked" ? "revoked" : "active",
    };
    const denied = await runMiddlewareEffect(
      c,
      requireScopeOp({ principal: authz, scope }),
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
