import { Hono } from "hono";
import { sValidator } from "../http/validation/validator.ts";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";
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
import { Effect } from "effect";

export const inviteBody = withParseApi(InviteBody);
export const acceptInviteBody = withParseApi(AcceptInviteBody);
/** Historical test export name. */
export const acceptBody = acceptInviteBody;

export const inviteRoutes = new Hono<{ Variables: AuthVariables }>();

inviteRoutes.use("*", requireAuth);

inviteRoutes.get("/", async (c) => {
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
  requireRole("admin"),
  sValidator("json", inviteBody),
  async (c) => {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      createInvite({
        organizationId: orgId.toHexString(),
        invitedBy: user._id.toHexString(),
        email: body.email,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.ttlHours !== undefined ? { ttlHours: body.ttlHours } : {}),
      }),
      { operation: "createInvite", successStatus: 201 },
    );
  },
);

inviteRoutes.delete("/:id", requireRole("admin"), async (c) => {
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
    return runAdminEffect(
      c,
      acceptInvite({
        token: body.token,
        username: body.username,
        password: body.password,
      }),
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
