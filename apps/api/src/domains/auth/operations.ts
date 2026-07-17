/**
 * Auth / identity task-oriented Effect operations (task 8.1).
 * Depends only on ports + Crypto/Clock/AppConfig + tagged errors.
 * No Hono, no raw collection strings, no Effect.run*.
 */
import { Effect } from "effect";
import type { UserRole } from "@tokenpanel/db";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ConfigurationError,
  InvalidStateError,
  NotFoundError,
} from "../../errors/families.ts";
import type { RepoError } from "../ports/common.ts";
import { UserRepository } from "../ports/user-repository.ts";
import { InviteRepository } from "../ports/invite-repository.ts";
import { OrganizationRepository } from "../ports/organization-repository.ts";
import { Crypto } from "../../runtime/services/crypto.ts";
import { Clock } from "../../runtime/services/clock.ts";
import { AppConfig } from "../../runtime/services/app-config.ts";
import {
  INVITE_DEFAULT_TTL_HOURS,
  INVITE_TOKEN_BYTES,
} from "../../config/security-policy.ts";
import { toUserView } from "./view.ts";
import type {
  AcceptInviteInput,
  AcceptInviteResult,
  ChangePasswordInput,
  CreateInviteInput,
  CreateInviteResult,
  LoginInput,
  LoginResult,
  SignupInput,
  SignupResult,
  UpdateMeInput,
  UserView,
} from "./types.ts";

export type AuthDomainError =
  | AuthenticationError
  | AuthorizationError
  | ConflictError
  | ConfigurationError
  | InvalidStateError
  | NotFoundError
  | RepoError;

function jwtSecret(
  secret: string,
): Effect.Effect<string, ConfigurationError> {
  if (secret.length < 16) {
    return Effect.fail(
      new ConfigurationError({
        code: "server_misconfigured",
        message: "JWT secret not configured",
        variable: "JWT_SECRET",
      }),
    );
  }
  return Effect.succeed(secret);
}

/**
 * Allocate a unique organization slug with bounded random suffix retries.
 */
function allocateUniqueSlug(
  base: string,
): Effect.Effect<string, RepoError, OrganizationRepository | Crypto> {
  return Effect.gen(function* () {
    const orgs = yield* OrganizationRepository;
    const crypto = yield* Crypto;
    let slug = base;
    for (let i = 0; i < 32; i++) {
      const existing = yield* orgs.findBySlug(slug);
      if (!existing) return slug;
      const suffix = yield* crypto.randomToken(2);
      slug = `${base}-${suffix}`;
    }
    const suffix = yield* crypto.randomToken(4);
    return `${base}-${suffix}`;
  });
}

/** GET /auth/status — whether first-run signup is needed. */
export const needsSetup = (): Effect.Effect<
  { needsSetup: boolean },
  RepoError,
  UserRepository
> =>
  Effect.gen(function* () {
    const users = yield* UserRepository;
    const count = yield* users.countUsers();
    return { needsSetup: count === 0 };
  });

/**
 * Login with username/password. Issues JWT for active-org membership role.
 * Caller owns brute-force throttle (surface concern).
 */
export const login = (
  input: LoginInput,
): Effect.Effect<LoginResult, AuthDomainError, UserRepository | Crypto | AppConfig> =>
  Effect.gen(function* () {
    const users = yield* UserRepository;
    const crypto = yield* Crypto;
    const config = yield* AppConfig;

    const user = yield* users.findByUsername(input.username);
    if (!user) {
      return yield* Effect.fail(
        new AuthenticationError({
          code: "invalid_credentials",
          message: "Invalid credentials",
        }),
      );
    }
    const ok = yield* crypto.verifyPassword(input.password, user.passwordHash);
    if (!ok) {
      return yield* Effect.fail(
        new AuthenticationError({
          code: "invalid_credentials",
          message: "Invalid credentials",
        }),
      );
    }
    if (user.status === "disabled") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "user_disabled",
          message: "user disabled",
          reason: "user_disabled",
        }),
      );
    }

    const view = toUserView(user);
    const secret = yield* jwtSecret(config.jwtSecret);
    const token = yield* crypto.signJwt(
      {
        sub: user._id.toHexString(),
        orgId: user.activeOrganizationId.toHexString(),
        role: view.role,
      },
      secret,
    );
    return { token, user: view };
  });

/**
 * First-run signup: create default org + admin user + JWT.
 */
export const signup = (
  input: SignupInput,
): Effect.Effect<
  SignupResult,
  AuthDomainError,
  UserRepository | OrganizationRepository | Crypto | Clock | AppConfig
> =>
  Effect.gen(function* () {
    const users = yield* UserRepository;
    const orgs = yield* OrganizationRepository;
    const crypto = yield* Crypto;
    const clock = yield* Clock;
    const config = yield* AppConfig;

    const count = yield* users.countUsers();
    if (count !== 0) {
      return yield* Effect.fail(
        new ConflictError({
          code: "setup_already_complete",
          message: "Setup already complete",
        }),
      );
    }

    const secret = yield* jwtSecret(config.jwtSecret);
    const slug = yield* allocateUniqueSlug("default");
    const passwordHash = yield* crypto.hashPassword(input.password);

    // Pre-generate coordinated ids (24 hex) so ownerId can reference user before insert.
    const userIdHex = yield* crypto.randomToken(12);
    const orgIdHex = yield* crypto.randomToken(12);
    void clock;

    const org = yield* orgs
      .insert({
        id: orgIdHex,
        name: "default",
        slug,
        ownerId: userIdHex,
        defaultCurrency: "USD",
      })
      .pipe(
        Effect.mapError((e) =>
          e._tag === "PersistenceDuplicateKeyError"
            ? new ConflictError({
                code: "organization_creation_failed",
                message: "Organization creation failed",
              })
            : e,
        ),
      );

    const user = yield* users
      .insertUser({
        id: userIdHex,
        username: input.adminUsername,
        email: input.adminEmail,
        passwordHash,
        memberships: [{ organizationId: org._id, role: "admin" as const }],
        activeOrganizationId: org._id.toHexString(),
        status: "active",
      })
      .pipe(
        Effect.catchAll((e) =>
          Effect.gen(function* () {
            yield* orgs.delete(org._id.toHexString());
            if (e._tag === "PersistenceDuplicateKeyError") {
              return yield* Effect.fail(
                new ConflictError({
                  code: "username_or_email_taken",
                  message: "Username or email taken",
                  fields: ["username", "email"],
                }),
              );
            }
            return yield* Effect.fail(e);
          }),
        ),
      );

    const token = yield* crypto.signJwt(
      {
        sub: user._id.toHexString(),
        orgId: org._id.toHexString(),
        role: "admin",
      },
      secret,
    );

    return {
      token,
      user: toUserView(user, "admin"),
      organization: {
        id: org._id.toHexString(),
        name: "default",
        slug,
      },
    };
  });

/** PATCH /me — update email with uniqueness check. */
export const updateMe = (
  input: UpdateMeInput,
): Effect.Effect<UserView, AuthDomainError, UserRepository> =>
  Effect.gen(function* () {
    const users = yield* UserRepository;
    if (input.email !== input.currentEmail) {
      const taken = yield* users.emailTaken(input.email, input.userId);
      if (taken) {
        return yield* Effect.fail(
          new ConflictError({
            code: "email_taken",
            message: "Email already in use",
            fields: ["email"],
          }),
        );
      }
      const updated = yield* users.updateEmail(input.userId, input.email);
      if (!updated) {
        return yield* Effect.fail(
          new NotFoundError({
            code: "not_found",
            message: "User not found",
            resource: "user",
            id: input.userId,
          }),
        );
      }
      return toUserView(updated);
    }
    const user = yield* users.findById(input.userId);
    if (!user) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "User not found",
          resource: "user",
          id: input.userId,
        }),
      );
    }
    return toUserView(user);
  });

/** POST /password — verify current, set new hash. */
export const changePassword = (
  input: ChangePasswordInput,
): Effect.Effect<{ ok: true }, AuthDomainError, UserRepository | Crypto> =>
  Effect.gen(function* () {
    const users = yield* UserRepository;
    const crypto = yield* Crypto;
    const ok = yield* crypto.verifyPassword(
      input.currentPassword,
      input.passwordHash,
    );
    if (!ok) {
      return yield* Effect.fail(
        new AuthenticationError({
          code: "invalid_credentials",
          message: "Current password is incorrect.",
        }),
      );
    }
    const newHash = yield* crypto.hashPassword(input.newPassword);
    yield* users.updatePasswordHash(input.userId, newHash);
    return { ok: true as const };
  });

/** Admin creates invite; returns opaque token once. */
export const createInvite = (
  input: CreateInviteInput,
): Effect.Effect<
  CreateInviteResult,
  AuthDomainError,
  InviteRepository | Crypto | Clock
> =>
  Effect.gen(function* () {
    const invites = yield* InviteRepository;
    const crypto = yield* Crypto;
    const clock = yield* Clock;
    const ttlHours = input.ttlHours ?? INVITE_DEFAULT_TTL_HOURS;
    const expiresAt = new Date(clock.nowMs() + ttlHours * 3600 * 1000);
    const token = yield* crypto.randomToken(INVITE_TOKEN_BYTES);
    const tokenHash = yield* crypto.hashToken(token);
    const role: UserRole = input.role ?? "member";
    const invite = yield* invites.insert({
      organizationId: input.organizationId,
      invitedBy: input.invitedBy,
      email: input.email,
      role,
      tokenHash,
      expiresAt,
    });
    return {
      invite: {
        id: invite._id.toHexString(),
        organizationId: invite.organizationId.toHexString(),
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      },
      token,
    };
  });

/** List invites for an org (tokenHash stripped by adapter or caller). */
export const listInvites = (
  organizationId: string,
): Effect.Effect<
  readonly {
    readonly id: string;
    readonly email: string;
    readonly role: UserRole;
    readonly status: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }[],
  RepoError,
  InviteRepository
> =>
  Effect.gen(function* () {
    const invites = yield* InviteRepository;
    const items = yield* invites.listByOrg(organizationId);
    return items.map((i) => ({
      id: i._id.toHexString(),
      email: i.email,
      role: i.role,
      status: i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    }));
  });

/** Revoke a pending invite. */
export const revokeInvite = (
  inviteId: string,
  organizationId: string,
): Effect.Effect<{ ok: true }, AuthDomainError, InviteRepository> =>
  Effect.gen(function* () {
    const invites = yield* InviteRepository;
    const ok = yield* invites.revokePending(inviteId, organizationId);
    if (!ok) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Invite not found",
          resource: "invite",
          id: inviteId,
        }),
      );
    }
    return { ok: true as const };
  });

/**
 * Accept invite: existing user (password verify) joins org, or new user created.
 */
export const acceptInvite = (
  input: AcceptInviteInput,
): Effect.Effect<
  AcceptInviteResult,
  AuthDomainError,
  InviteRepository | UserRepository | Crypto | Clock | AppConfig
> =>
  Effect.gen(function* () {
    const invites = yield* InviteRepository;
    const users = yield* UserRepository;
    const crypto = yield* Crypto;
    const clock = yield* Clock;
    const config = yield* AppConfig;

    const tokenHash = yield* crypto.hashToken(input.token);
    const invite = yield* invites.findPendingByTokenHash(tokenHash);
    if (!invite) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "invalid_or_expired",
          message: "Invalid or expired invite",
          resource: "invite",
        }),
      );
    }
    if (invite.expiresAt.getTime() < clock.nowMs()) {
      return yield* Effect.fail(
        new InvalidStateError({
          code: "expired",
          message: "Invite expired",
          resource: "invite",
        }),
      );
    }

    const secret = yield* jwtSecret(config.jwtSecret);
    const orgId = invite.organizationId;
    const inviteRole = invite.role as UserRole;
    const existingUser = yield* users.findByEmail(invite.email);

    let userId: string;
    let username: string;
    let memberships: { organizationId: string; role: UserRole }[];

    if (existingUser) {
      const ok = yield* crypto.verifyPassword(
        input.password,
        existingUser.passwordHash,
      );
      if (!ok) {
        return yield* Effect.fail(
          new AuthenticationError({
            code: "invalid_credentials",
            message: "Invalid credentials",
          }),
        );
      }
      if (existingUser.status !== "active") {
        return yield* Effect.fail(
          new AuthorizationError({
            code: "user_disabled",
            message: "User disabled",
            reason: "user_disabled",
          }),
        );
      }
      userId = existingUser._id.toHexString();
      username = existingUser.username;
      const alreadyMember = existingUser.memberships.some((m) =>
        m.organizationId.equals(orgId),
      );
      if (alreadyMember) {
        memberships = existingUser.memberships.map((m) => ({
          organizationId: m.organizationId.toHexString(),
          role: m.role,
        }));
        yield* users.setActiveOrganization(userId, orgId.toHexString());
      } else {
        const updated = yield* users.addMembership(
          userId,
          orgId.toHexString(),
          inviteRole,
          true,
        );
        memberships = (updated?.memberships ?? [
          ...existingUser.memberships,
          { organizationId: orgId, role: inviteRole },
        ]).map((m) => ({
          organizationId: m.organizationId.toHexString(),
          role: m.role,
        }));
      }
    } else {
      const taken = yield* users.findByUsernameOrEmail(
        input.username,
        invite.email,
      );
      if (taken) {
        return yield* Effect.fail(
          new ConflictError({
            code: "username_or_email_taken",
            message: "Username or email taken",
            fields: ["username", "email"],
          }),
        );
      }
      const passwordHash = yield* crypto.hashPassword(input.password);
      const created = yield* users.insertUser({
        username: input.username,
        email: invite.email,
        passwordHash,
        memberships: [{ organizationId: orgId, role: inviteRole }],
        activeOrganizationId: orgId.toHexString(),
        status: "active",
      });
      userId = created._id.toHexString();
      username = created.username;
      memberships = created.memberships.map((m) => ({
        organizationId: m.organizationId.toHexString(),
        role: m.role,
      }));
    }

    yield* invites.markAccepted(invite._id.toHexString());

    const token = yield* crypto.signJwt(
      {
        sub: userId,
        orgId: orgId.toHexString(),
        role: inviteRole,
      },
      secret,
    );

    const user: UserView = {
      id: userId,
      username,
      email: invite.email,
      role: inviteRole,
      status: "active",
      memberships,
      activeOrganizationId: orgId.toHexString(),
    };
    return { token, user };
  });

/**
 * Switch active organization membership for a user and issue a new JWT.
 */
export const switchActiveOrganization = (input: {
  readonly userId: string;
  readonly targetOrganizationId: string;
  readonly memberships: readonly {
    readonly organizationId: { toHexString: () => string };
    readonly role: UserRole;
  }[];
}): Effect.Effect<
  { token: string; role: UserRole; activeOrganizationId: string },
  AuthDomainError,
  UserRepository | OrganizationRepository | Crypto | AppConfig
> =>
  Effect.gen(function* () {
    const membership = input.memberships.find(
      (m) => m.organizationId.toHexString() === input.targetOrganizationId,
    );
    if (!membership) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Not a member of organization",
          reason: "not_a_member",
        }),
      );
    }
    const orgs = yield* OrganizationRepository;
    const org = yield* orgs.findById(input.targetOrganizationId);
    if (!org) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Organization not found",
          resource: "organization",
          id: input.targetOrganizationId,
        }),
      );
    }
    const users = yield* UserRepository;
    yield* users.setActiveOrganization(
      input.userId,
      input.targetOrganizationId,
    );
    const config = yield* AppConfig;
    const crypto = yield* Crypto;
    const secret = yield* jwtSecret(config.jwtSecret);
    const token = yield* crypto.signJwt(
      {
        sub: input.userId,
        orgId: input.targetOrganizationId,
        role: membership.role,
      },
      secret,
    );
    return {
      token,
      role: membership.role,
      activeOrganizationId: input.targetOrganizationId,
    };
  });
