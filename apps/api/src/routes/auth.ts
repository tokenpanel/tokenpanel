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
import {
  LoginBody,
  UpdateMeBody,
  ChangePasswordBody,
} from "../http/validation/identity.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";
import { respondWithCode } from "../http/error-context.ts";

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
    return respondWithCode(
      c,
      "too_many_attempts",
      () =>
        c.json({ error: "too_many_attempts" }, 429, {
          "Retry-After": String(gate.retryAfterSeconds),
        }),
      { retryAfterSeconds: gate.retryAfterSeconds },
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
    const sessionId = c.get("sessionId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      updateMeOp({
        userId: user._id.toHexString(),
        currentEmail: user.email,
        email: body.email,
        activeOrganizationId: orgId.toHexString(),
        sessionId,
      }),
      { operation: "updateMe" },
    );
  },
);

authRoutes.post(
  "/password",
  requireAuth,
  sValidator("json", changePasswordBody),
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
