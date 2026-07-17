import { Hono } from "hono";
import { Effect } from "effect";
import { sValidator } from "../http/validation/validator.ts";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import { loginThrottle } from "../lib/throttle.ts";
import { getRequestClientIp } from "../lib/client-ip.ts";
import {
  needsSetup,
  login as loginOp,
  logout as logoutOp,
  updateMe as updateMeOp,
  changePassword as changePasswordOp,
} from "../domains/auth/operations.ts";
import { toUserView } from "../domains/auth/view.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { isAppError } from "../errors/families.ts";
import {
  LoginBody,
  UpdateMeBody,
  ChangePasswordBody,
} from "../http/validation/identity.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";

export const loginBody = withParseApi(LoginBody);
export const updateMeBody = withParseApi(UpdateMeBody);
export const changePasswordBody = withParseApi(ChangePasswordBody);

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

authRoutes.get("/status", async (c) => {
  return runAdminEffect(c, needsSetup(), { operation: "needsSetup" });
});

authRoutes.post("/login", sValidator("json", loginBody), async (c) => {
  const body = c.req.valid("json");
  const clientIp = getRequestClientIp(c);
  const gate = loginThrottle.check(clientIp);
  if (!gate.allowed) {
    return c.json(
      { error: "too_many_attempts" },
      429,
      { "Retry-After": String(gate.retryAfterSeconds) },
    );
  }
  return runAdminEffect(
    c,
    loginOp({ username: body.username, password: body.password }).pipe(
      Effect.tap(() =>
        Effect.sync(() => loginThrottle.recordSuccess(clientIp)),
      ),
      Effect.tapError(() =>
        Effect.sync(() => loginThrottle.recordFailure(clientIp)),
      ),
    ),
    {
      operation: "login",
      mapError: (err) => {
        if (!isAppError(err)) return null;
        if (
          err._tag === "AuthorizationError" &&
          (err.code === "user_disabled" || err.reason === "user_disabled")
        ) {
          return {
            status: 403,
            body: { error: "forbidden", message: "user disabled" },
            headers: {},
          };
        }
        return null;
      },
    },
  );
});

authRoutes.post("/logout", requireAuth, async (c) => {
  const user = c.get("user");
  const sessionId = c.get("sessionId");
  return runAdminEffect(
    c,
    logoutOp({
      userId: user._id.toHexString(),
      sessionId,
    }),
    { operation: "logout" },
  );
});

authRoutes.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const role = c.get("role");
  const permissions = c.get("permissions");
  const orgId = c.get("orgId");
  // Session-scoped tenant + role/permissions from resolveAdminSession.
  return c.json(
    toUserView(user, role, permissions, orgId.toHexString()),
  );
});

authRoutes.patch(
  "/me",
  requireAuth,
  sValidator("json", updateMeBody),
  async (c) => {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      updateMeOp({
        userId: user._id.toHexString(),
        currentEmail: user.email,
        email: body.email,
        activeOrganizationId: orgId.toHexString(),
      }),
      { operation: "updateMe" },
    );
  },
);

authRoutes.post(
  "/password",
  requireAuth,
  sValidator("json", changePasswordBody, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "validation_error",
          details: result.error.flatten().fieldErrors,
        },
        422,
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      changePasswordOp({
        userId: user._id.toHexString(),
        passwordHash: user.passwordHash,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      }),
      { operation: "changePassword" },
    );
  },
);

export default authRoutes;
