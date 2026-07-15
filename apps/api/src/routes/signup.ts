import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import { getDb } from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { hashPassword, signJwt, randomToken } from "../lib/crypto.ts";
import { requireJwtSecret } from "../config/state.ts";

export const signupBody = z
  .object({
    adminEmail: z.string().email().max(254),
    adminUsername: z.string().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/),
    password: z.string().min(8).max(256),
    confirmPassword: z.string().min(8).max(256),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

export const signupRoutes = new Hono<{ Variables: AuthVariables }>();

signupRoutes.post(
  "/signup",
  zValidator("json", signupBody, (result, c) => {
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
    const db = await getDb();

    const userCount = await db.users.countDocuments({});
    if (userCount !== 0) {
      return c.json({ error: "setup_already_complete" }, 409);
    }

    let secret: string;
    try {
      secret = requireJwtSecret();
    } catch {
      return c.json({ error: "server_misconfigured" }, 500);
    }

    const now = new Date();
    const userId = new ObjectId();

    // Default organization — every user starts with one named "default".
    // They can rename it or create more later via /admin/organizations.
    const baseSlug = "default";
    let slug = baseSlug;
    let slugAttempt = 0;
    while (slugAttempt < 32) {
      const existing = await db.organizations.findOne({ slug });
      if (!existing) break;
      slug = `${baseSlug}-${randomToken(2)}`;
      slugAttempt++;
    }

    const orgId = new ObjectId();
    const orgDoc = {
      _id: orgId,
      name: "default",
      slug,
      ownerId: userId,
      defaultCurrency: "USD",
      createdAt: now,
      updatedAt: now,
    };

    try {
      await db.organizations.insertOne(orgDoc);
    } catch {
      return c.json({ error: "organization_creation_failed" }, 409);
    }

    const passwordHash = await hashPassword(body.password);
    const userDoc = {
      _id: userId,
      memberships: [{ organizationId: orgId, role: "admin" as const }],
      activeOrganizationId: orgId,
      username: body.adminUsername,
      email: body.adminEmail,
      passwordHash,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await db.users.insertOne(userDoc);
    } catch {
      await db.organizations.deleteOne({ _id: orgId });
      return c.json({ error: "username_or_email_taken" }, 409);
    }

    const token = signJwt(
      {
        sub: userId.toHexString(),
        orgId: orgId.toHexString(),
        role: "admin",
      },
      secret,
    );

    return c.json(
      {
        token,
        user: {
          id: userId.toHexString(),
          username: body.adminUsername,
          email: body.adminEmail,
          role: "admin",
          status: "active",
          memberships: [
            { organizationId: orgId.toHexString(), role: "admin" },
          ],
          activeOrganizationId: orgId.toHexString(),
        },
        organization: {
          id: orgId.toHexString(),
          name: "default",
          slug,
        },
      },
      201,
    );
  },
);

export default signupRoutes;