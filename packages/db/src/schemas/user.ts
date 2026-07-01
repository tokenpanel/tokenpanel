import { z } from "zod";
import { objectId, objectIdFromString, timestampFields } from "./common.ts";

/**
 * User = an admin/member of an Organization who can log into the admin panel.
 * The first user is created via first-run signup; subsequent users via invite.
 */
export const userRole = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof userRole>;

/**
 * Membership = the (user, organization) edge. Role is per-membership, NOT
 * global on the user: an admin in org A may be a member in org B. A user must
 * have at least one membership. `activeOrganizationId` selects which
 * membership's role governs the current session.
 */
export const membershipDoc = z.object({
  organizationId: objectId,
  role: userRole,
});

export const membershipInput = z.object({
  organizationId: objectIdFromString,
  role: userRole,
});

export type MembershipDoc = z.infer<typeof membershipDoc>;
export type MembershipInput = z.infer<typeof membershipInput>;

export const userDoc = z.object({
  _id: objectId,
  /** Per-org memberships. Min 1. Role lives here, not on the user. */
  memberships: z.array(membershipDoc).min(1),
  /** Currently selected org for this session. Must have a matching membership. */
  activeOrganizationId: objectId,
  /** Unique login handle. */
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.string().email().max(254),
  /** Argon2id hash via Bun.password.hash. Never returned to clients. */
  passwordHash: z.string().min(1),
  status: z.enum(["active", "disabled"]).default("active"),
  ...timestampFields,
});

export const userCreateInput = z.object({
  memberships: z.array(membershipInput).min(1),
  activeOrganizationId: objectIdFromString,
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.string().email().max(254),
  password: z.string().min(8).max(256),
});

/** Patch shape for editing users (never allows password or role change here;
 *  role is mutated via the membership edge, not the user doc). */
export const userUpdateInput = z.object({
  email: z.string().email().max(254).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export type UserDoc = z.infer<typeof userDoc>;
export type UserCreateInput = z.infer<typeof userCreateInput>;
export type UserUpdateInput = z.infer<typeof userUpdateInput>;

/**
 * Invite = pending invitation to join the panel as a User.
 * Created by an admin; consumed via accept-invite using `token`.
 */
export const inviteDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  /** Inviter user id. */
  invitedBy: objectId,
  email: z.string().email().max(254),
  role: userRole.default("member"),
  /** Opaque random token (hashed at rest). */
  tokenHash: z.string().min(1),
  status: z.enum(["pending", "accepted", "revoked"]).default("pending"),
  /** When the invite was accepted (if it was). */
  acceptedAt: z.instanceof(Date).nullish(),
  /** Auto-expire. */
  expiresAt: z.instanceof(Date),
  ...timestampFields,
});

export const inviteCreateInput = z.object({
  organizationId: objectIdFromString,
  invitedBy: objectIdFromString,
  email: z.string().email().max(254),
  role: userRole.optional(),
  /** Hours until expiry. */
  ttlHours: z.number().int().positive().max(720).default(168),
});

export type InviteDoc = z.infer<typeof inviteDoc>;
export type InviteCreateInput = z.infer<typeof inviteCreateInput>;