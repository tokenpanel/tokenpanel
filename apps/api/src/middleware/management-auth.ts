import type { MiddlewareHandler } from "hono";
import type { ManagementScope } from "@tokenpanel/db";
import type { PublicAuthVariables, PublicPrincipal } from "./public-auth.ts";

/**
 * Variables available to /api/management routes after auth. `principal` is
 * always set (by requirePublicPrincipal) and is always kind="management" after
 * requireManagementPrincipal runs.
 */
export type ManagementAuthVariables = PublicAuthVariables;

/**
 * Narrow the principal to a management key. Mount after requirePublicPrincipal
 * (once on the parent app for `/api/management/*` in index.ts):
 *
 *   app.use("/api/management/*", requirePublicPrincipal);
 *   app.use("/api/management/*", requireManagementPrincipal);
 *
 * Returns 401 (not 403) for customer-key callers so a customer key cannot
 * distinguish "this is a management endpoint" from "this endpoint does not
 * exist" — uniform 401 prevents enumeration.
 */
export const requireManagementPrincipal: MiddlewareHandler<{
  Variables: ManagementAuthVariables;
}> = async (c, next) => {
  const principal = c.get("principal") as PublicPrincipal | undefined;
  if (!principal || principal.kind !== "management") {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

/**
 * Per-route scope gate for management endpoints. Returns 403 (with no resource
 * details) when the scope is missing — existence-hiding is important here
 * because management endpoints expose org data. A revoked key never reaches
 * this check (the public principal middleware rejects it first).
 */
export function requireManagementScope(scope: ManagementScope): MiddlewareHandler<{
  Variables: ManagementAuthVariables;
}> {
  return async (c, next) => {
    const principal = c.get("principal") as PublicPrincipal | undefined;
    if (!principal || principal.kind !== "management") {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!principal.managementKey.scopes.includes(scope)) {
      return c.json({ error: "forbidden", reason: "missing_scope" }, 403);
    }
    await next();
  };
}
