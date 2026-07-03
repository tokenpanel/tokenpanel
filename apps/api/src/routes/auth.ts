import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import { hashPassword, verifyPassword, signJwt } from "../lib/crypto.ts";
import { loginThrottle } from "../lib/throttle.ts";

export const loginBody = z.object({
  username: z.string().min(1).max(60),
  password: z.string().min(1).max(256),
});

export const updateMeBody = z.object({
  email: z.string().email().max(254),
});

export const changePasswordBody = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(8).max(256),
    confirmNewPassword: z.string().min(8).max(256),
  })
  .refine((d) => d.newPassword === d.confirmNewPassword, {
    path: ["confirmNewPassword"],
    message: "Passwords do not match",
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    path: ["newPassword"],
    message: "New password must differ from current",
  });

const auth = new Hono<{ Variables: AuthVariables }>();

/** Shape the auth endpoints return for the current user. Role = active-org role. */
function userResponse(user: {
  _id: { toHexString: () => string };
  username: string;
  email: string;
  status: string;
  memberships: { organizationId: { toHexString: () => string }; role: string }[];
  activeOrganizationId: { toHexString: () => string };
  createdAt: { toISOString: () => string };
  updatedAt: { toISOString: () => string };
}) {
  const activeId = user.activeOrganizationId.toHexString();
  const activeMembership = user.memberships.find(
    (m) => m.organizationId.toHexString() === activeId,
  );
  return {
    id: user._id.toHexString(),
    username: user.username,
    email: user.email,
    status: user.status,
    role: activeMembership?.role ?? "member",
    memberships: user.memberships.map((m) => ({
      organizationId: m.organizationId.toHexString(),
      role: m.role,
    })),
    activeOrganizationId: activeId,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

auth.get("/status", async (c) => {
  const db = await getDb();
  const count = await db.users.countDocuments({});
  return c.json({ needsSetup: count === 0 });
});

auth.post("/login", zValidator("json", loginBody), async (c) => {
  const body = c.req.valid("json");
  // Throttle credential-stuffing per username before any DB lookup.
  const gate = loginThrottle.check(body.username);
  if (!gate.allowed) {
    return c.json(
      { error: "too_many_attempts", retryAfterSeconds: gate.retryAfterSeconds },
      429,
      { "Retry-After": String(gate.retryAfterSeconds) },
    );
  }
  const db = await getDb();
  const user = await db.users.findOne({ username: body.username });
  if (!user) {
    loginThrottle.recordFailure(body.username);
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) {
    loginThrottle.recordFailure(body.username);
    return c.json({ error: "invalid_credentials" }, 401);
  }
  // Correct password — not a brute-force attempt; don't penalize. A disabled
  // account with the right password returns 403 without recording a failure.
  if (user.status === "disabled") {
    return c.json({ error: "forbidden", message: "user disabled" }, 403);
  }
  loginThrottle.recordSuccess(body.username);
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return c.json({ error: "server_misconfigured" }, 500);
  }
  const resp = userResponse(user);
  const token = signJwt(
    {
      sub: user._id.toHexString(),
      orgId: user.activeOrganizationId.toHexString(),
      role: resp.role as "admin" | "member",
    },
    secret,
  );
  return c.json({ token, user: resp });
});

auth.post("/logout", requireAuth, (c) => {
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => {
  const user = c.get("user");
  return c.json(userResponse(user));
});

auth.patch(
  "/me",
  requireAuth,
  zValidator("json", updateMeBody),
  async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    const db = await getDb();

    // No-op if the email is unchanged (e.g. user re-saves the form).
    if (body.email !== user.email) {
      const conflict = await db.users.findOne({
        email: body.email,
        _id: { $ne: user._id },
      });
      if (conflict) {
        return c.json({ error: "email_taken" }, 409);
      }
      await db.users.updateOne(
        { _id: user._id },
        { $set: { email: body.email, updatedAt: new Date() } },
      );
    }

    const updated = await db.users.findOne({ _id: user._id });
    if (!updated) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(userResponse(updated));
  },
);

auth.post(
  "/password",
  requireAuth,
  zValidator("json", changePasswordBody, (result, c) => {
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
    const body = c.req.valid("json");
    const user = c.get("user");
    const db = await getDb();

    const ok = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!ok) {
      return c.json(
        { error: "invalid_credentials", message: "Current password is incorrect." },
        401,
      );
    }

    const newHash = await hashPassword(body.newPassword);
    await db.users.updateOne(
      { _id: user._id },
      { $set: { passwordHash: newHash, updatedAt: new Date() } },
    );

    return c.json({ ok: true });
  },
);

export default auth;