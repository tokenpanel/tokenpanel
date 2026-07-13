import type { MiddlewareHandler } from "hono";
import { ObjectId } from "mongodb";
import type { UserDoc, UserRole } from "@tokenpanel/db";
import { getDb } from "@tokenpanel/db";
import { verifyJwt, JwtError } from "../lib/crypto.ts";

export type AuthVariables = {
  user: UserDoc;
  orgId: ObjectId;
  /** Role for the active org, resolved from the user's memberships. */
  role: UserRole;
};

type AuthMiddleware = MiddlewareHandler<{ Variables: AuthVariables }>;

/** Test-only override so route integration tests can inject org/role without JWT. */
let requireAuthForTests: AuthMiddleware | null = null;

/**
 * Hard gate for test hooks. Production (NODE_ENV=production) always rejects.
 * Outside production, TOKENPANEL_TEST_HOOKS=1 must be set by the test process
 * so a stray import cannot silently bypass JWT auth.
 */
function assertTestHooksAllowed(action: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${action} is forbidden when NODE_ENV=production`);
  }
  if (process.env.TOKENPANEL_TEST_HOOKS !== "1") {
    throw new Error(
      `${action} requires TOKENPANEL_TEST_HOOKS=1 (test processes only)`,
    );
  }
}

function testAuthHookActive(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.TOKENPANEL_TEST_HOOKS === "1" &&
    requireAuthForTests !== null
  );
}

/**
 * Install/clear a test-only requireAuth override.
 * Requires TOKENPANEL_TEST_HOOKS=1 and is forbidden in production.
 * Pass `null` to restore JWT-backed auth.
 */
export function setRequireAuthForTests(fn: AuthMiddleware | null): void {
  assertTestHooksAllowed("setRequireAuthForTests");
  requireAuthForTests = fn;
}

export function getToken(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const h = c.req.header("Authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2) return null;
  const [scheme, token] = parts as [string, string];
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}

export const requireAuth: AuthMiddleware = async (c, next) => {
  if (testAuthHookActive()) {
    return requireAuthForTests!(c, next);
  }
  // Drop a leaked override if env was cleared so production paths stay pure.
  requireAuthForTests = null;
  const token = getToken(c);
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let payload: ReturnType<typeof verifyJwt>;
  try {
    payload = verifyJwt(token, process.env.JWT_SECRET!);
  } catch (err) {
    if (err instanceof JwtError) {
      return c.json({ error: "unauthorized", reason: err.message }, 401);
    }
    return c.json({ error: "unauthorized" }, 401);
  }
  const db = await getDb();
  const user = await db.users.findOne({ _id: new ObjectId(payload.sub) });
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (user.status !== "active") {
    return c.json({ error: "forbidden", reason: "user_disabled" }, 403);
  }
  // Resolve the active-org membership. Role is per-membership, not global.
  // The active org MUST have a matching membership or the session is invalid.
  const activeMembership = user.memberships.find((m) =>
    m.organizationId.equals(user.activeOrganizationId),
  );
  if (!activeMembership) {
    return c.json({ error: "unauthorized", reason: "no_active_org_membership" }, 401);
  }
  c.set("user", user);
  c.set("orgId", user.activeOrganizationId);
  c.set("role", activeMembership.role);
  await next();
};

/**
 * Require a specific role for the ACTIVE organization. Role is read from
 * `c.get("role")`, which requireAuth resolved from the user's membership for
 * `c.get("orgId")`. A user who is admin in org A but member in org B will pass
 * this for admin-only actions only while A is active.
 */
export function requireRole(role: UserRole): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const activeRole = c.get("role");
    if (activeRole !== role) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}