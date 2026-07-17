import { Hono } from "hono";
import { Effect } from "effect";
import { sValidator } from "../http/validation/validator.ts";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import {
  listInvites,
  createInvite,
  revokeInvite,
  acceptInvite,
} from "../domains/auth/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { isAppError } from "../errors/families.ts";
import { InviteBody, AcceptInviteBody } from "../http/validation/identity.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";
import { inviteThrottle } from "../lib/throttle.ts";
import { getRequestClientIp } from "../lib/client-ip.ts";

export const inviteBody = withParseApi(InviteBody);
export const acceptInviteBody = withParseApi(AcceptInviteBody);
/** Historical test export name. */
export const acceptBody = acceptInviteBody;

export const inviteRoutes = new Hono<{ Variables: AuthVariables }>();

inviteRoutes.use("*", requireAuth);

inviteRoutes.get("/", requirePermission("invites:read"), async (c) => {
  const orgId = c.get("orgId");
  return runAdminEffect(
    c,
    listInvites(orgId.toHexString()).pipe(
      Effect.map((items) => ({ items })),
    ),
    { operation: "listInvites" },
  );
});

inviteRoutes.post(
  "/",
  requirePermission("invites:write"),
  sValidator("json", inviteBody),
  async (c) => {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const actorRole = c.get("role");
    const actorPermissions = c.get("permissions");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      createInvite({
        organizationId: orgId.toHexString(),
        invitedBy: user._id.toHexString(),
        email: body.email,
        actorRole,
        actorPermissions,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.permissions !== undefined
          ? { permissions: body.permissions }
          : {}),
        ...(body.ttlHours !== undefined ? { ttlHours: body.ttlHours } : {}),
      }),
      { operation: "createInvite", successStatus: 201 },
    );
  },
);

inviteRoutes.delete("/:id", requirePermission("invites:write"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  return runAdminEffect(c, revokeInvite(id, orgId.toHexString()), {
    operation: "revokeInvite",
  });
});

/** Public accept-invite (no auth). Mounted under /admin/auth. */
export const acceptInviteRoute = new Hono();

acceptInviteRoute.post(
  "/accept-invite",
  sValidator("json", acceptInviteBody),
  async (c) => {
    const body = c.req.valid("json");
    const clientIp = getRequestClientIp(c);
    const gate = inviteThrottle.check(clientIp);
    if (!gate.allowed) {
      return c.json(
        { error: "too_many_attempts" },
        429,
        { "Retry-After": String(gate.retryAfterSeconds) },
      );
    }
    return runAdminEffect(
      c,
      acceptInvite({
        token: body.token,
        username: body.username,
        password: body.password,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => inviteThrottle.recordSuccess(clientIp)),
        ),
        Effect.tapError((err) =>
          Effect.sync(() => {
            // Count credential / token failures toward lockout (Argon2 oracle +
            // token brute-force). Validation-style domain errors still cost.
            if (isAppError(err)) {
              inviteThrottle.recordFailure(clientIp);
            }
          }),
        ),
      ),
      {
        operation: "acceptInvite",
        successStatus: 201,
        mapError: (err) => {
          if (!isAppError(err)) return null;
          if (err._tag === "InvalidStateError" && err.code === "expired") {
            return { status: 410, body: { error: "expired" }, headers: {} };
          }
          if (err._tag === "NotFoundError" && err.code === "invalid_or_expired") {
            return {
              status: 404,
              body: { error: "invalid_or_expired" },
              headers: {},
            };
          }
          return null;
        },
      },
    );
  },
);

export default inviteRoutes;
