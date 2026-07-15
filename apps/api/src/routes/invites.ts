import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getDb, type InviteDoc, type UserDoc, type UserRole } from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";
import { hashPassword, verifyPassword, randomToken, hashToken, signJwt } from "../lib/crypto.ts";
import { inviteThrottle } from "../lib/throttle.ts";
import { requireJwtSecret } from "../config/state.ts";

const inviteRoutes = new Hono<{ Variables: AuthVariables }>();

export const inviteBody = z.object({
  email: z.string().email().max(254),
  role: z.enum(["admin", "member"]).optional(),
  ttlHours: z.number().int().positive().max(720).optional(),
});

inviteRoutes.get("/", requireAuth, requireRole("admin"), async (c) => {
  const db = await getDb();
  const items = await db.invites
    .find({ organizationId: c.get("orgId") })
    .sort({ createdAt: -1 })
    .toArray();
  const safe = items.map(({ tokenHash, ...rest }) => rest);
  return c.json({ items: safe });
});

inviteRoutes.post("/", requireAuth, requireRole("admin"), zValidator("json", inviteBody), async (c) => {
  const body = c.req.valid("json");
  const db = await getDb();
  const orgId = c.get("orgId");
  const user = c.get("user");
  const ttlHours = body.ttlHours ?? 168;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  const token = randomToken(32);
  const tokenHash = hashToken(token);
  const now = new Date();
  const insertRes = await db.invites.insertOne({
    _id: new ObjectId(),
    organizationId: orgId,
    invitedBy: user._id,
    email: body.email,
    role: body.role ?? "member",
    tokenHash,
    status: "pending",
    acceptedAt: null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  } as Omit<InviteDoc, "_id"> & { _id: ObjectId });
  const invite = await db.invites.findOne({ _id: insertRes.insertedId });
  if (!invite) return c.json({ error: "internal" }, 500);
  const { tokenHash: _omit, ...safe } = invite;
  void _omit;
  return c.json({ invite: safe, token }, 201);
});

inviteRoutes.delete("/:id", requireAuth, requireRole("admin"), async (c) => {
  const db = await getDb();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  const res = await db.invites.updateOne(
    { _id: new ObjectId(id), organizationId: c.get("orgId"), status: "pending" },
    { $set: { status: "revoked", updatedAt: new Date() } },
  );
  if (res.matchedCount === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export const acceptBody = z.object({
  token: z.string().min(1),
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(256),
});

export const acceptInviteRoute = new Hono();
acceptInviteRoute.post("/accept-invite", zValidator("json", acceptBody), async (c) => {
  const body = c.req.valid("json");
  // Throttle invite-token guessing before any DB lookup.
  const gate = inviteThrottle.check(body.token);
  if (!gate.allowed) {
    return c.json(
      { error: "too_many_attempts", retryAfterSeconds: gate.retryAfterSeconds },
      429,
      { "Retry-After": String(gate.retryAfterSeconds) },
    );
  }
  const db = await getDb();
  const tokenHash = hashToken(body.token);
  const invite = await db.invites.findOne({ tokenHash, status: "pending" });
  if (!invite) {
    inviteThrottle.recordFailure(body.token);
    return c.json({ error: "invalid_or_expired" }, 404);
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    inviteThrottle.recordFailure(body.token);
    return c.json({ error: "expired" }, 410);
  }

  let secret: string;
  try {
    secret = requireJwtSecret();
  } catch {
    return c.json({ error: "server_misconfigured" }, 500);
  }

  const now = new Date();
  const orgId = invite.organizationId;
  const inviteRole = invite.role as UserRole;

  // Existing user (by email) joins the invite's org with the invite's role.
  // Role is per-membership: their role in OTHER orgs is unaffected. If they
  // are already a member of this org, keep their existing role there (the
  // invite is redundant) and just switch active.
  const existingUser = await db.users.findOne({ email: invite.email });

  let userId: ObjectId;
  let username: string;
  let memberships: { organizationId: ObjectId; role: string }[];

  if (existingUser) {
    const ok = await verifyPassword(body.password, existingUser.passwordHash);
    if (!ok) {
      inviteThrottle.recordFailure(body.token);
      return c.json({ error: "invalid_credentials" }, 401);
    }
    if (existingUser.status !== "active") {
      return c.json({ error: "forbidden", reason: "user_disabled" }, 403);
    }
    userId = existingUser._id;
    username = existingUser.username;
    const alreadyMember = existingUser.memberships.some((m) =>
      m.organizationId.equals(orgId),
    );
    if (alreadyMember) {
      memberships = existingUser.memberships;
      await db.users.updateOne(
        { _id: existingUser._id },
        { $set: { activeOrganizationId: orgId, updatedAt: now } },
      );
    } else {
      memberships = [
        ...existingUser.memberships,
        { organizationId: orgId, role: inviteRole },
      ];
      await db.users.updateOne(
        { _id: existingUser._id },
        {
          $push: { memberships: { organizationId: orgId, role: inviteRole } },
          $set: { activeOrganizationId: orgId, updatedAt: now },
        },
      );
    }
  } else {
    // New user — username must be globally unique.
    const taken = await db.users.findOne({
      $or: [{ username: body.username }, { email: invite.email }],
    });
    if (taken) return c.json({ error: "username_or_email_taken" }, 409);

    const passwordHash = await hashPassword(body.password);
    userId = new ObjectId();
    username = body.username;
    memberships = [{ organizationId: orgId, role: inviteRole }];
    await db.users.insertOne({
      _id: userId,
      memberships: [{ organizationId: orgId, role: inviteRole }],
      activeOrganizationId: orgId,
      username: body.username,
      email: invite.email,
      passwordHash,
      status: "active",
      createdAt: now,
      updatedAt: now,
    } as Omit<UserDoc, "_id"> & { _id: ObjectId });
  }

  await db.invites.updateOne(
    { _id: invite._id },
    { $set: { status: "accepted", acceptedAt: now, updatedAt: now } },
  );

  inviteThrottle.recordSuccess(body.token);
  const token = signJwt(
    {
      sub: userId.toHexString(),
      orgId: orgId.toHexString(),
      role: inviteRole,
    },
    secret,
  );
  return c.json(
    {
      token,
      user: {
        id: userId.toHexString(),
        username,
        email: invite.email,
        role: inviteRole,
        status: "active",
        memberships: memberships.map((m) => ({
          organizationId: m.organizationId.toHexString(),
          role: m.role,
        })),
        activeOrganizationId: orgId.toHexString(),
      },
    },
    201,
  );
});

export default inviteRoutes;