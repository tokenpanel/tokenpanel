/**
 * acceptInvite security guards:
 * - Task 6: inviter's current grants are re-checked at accept time. If the
 *   inviter is no longer a member (or can no longer grant the invite's
 *   role/permissions), the invite is revoked and acceptance fails with
 *   AuthorizationError(privilege_escalation).
 * - Task 5: when the invitee is already a member, the invite's role/permissions
 *   are applied (REPLACE semantics) to the existing membership.
 */
import { test, expect } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { InviteDoc, UserDoc } from "@tokenpanel/db";
import { acceptInvite } from "../operations.ts";
import {
  InviteRepository,
  type InviteRepositoryService,
} from "../../ports/invite-repository.ts";
import {
  UserRepository,
  type UserRepositoryService,
} from "../../ports/user-repository.ts";
import {
  SessionRepository,
  type SessionRepositoryService,
} from "../../ports/session-repository.ts";
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { ClockTest } from "../../../runtime/layers/clock.ts";
import { AppConfig } from "../../../runtime/services/app-config.ts";
import { hashToken } from "../../../lib/crypto.ts";

const ORG_ID = new ObjectId();
const INVITER_ID = new ObjectId();
const INVITEE_USER_ID = new ObjectId();
const JWT_SECRET = "accept-invite-test-secret-32-chars!";
const TOKEN = "test-invite-opaque-token-value";

function futureDate(): Date {
  return new Date(Date.now() + 24 * 3600 * 1000);
}

function neverCall(): never {
  throw new Error("unexpected repository call");
}

function inviteDoc(over: Partial<InviteDoc> = {}): InviteDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    invitedBy: INVITER_ID,
    email: "newbie@example.com",
    role: "member",
    permissions: ["customers:read"],
    tokenHash: hashToken(TOKEN),
    status: "pending",
    acceptedAt: null,
    expiresAt: futureDate(),
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function inviterUser(over: Partial<UserDoc> = {}): UserDoc {
  const now = new Date();
  return {
    _id: INVITER_ID,
    username: "inviter",
    email: "inviter@example.com",
    passwordHash: "x",
    memberships: [
      { organizationId: ORG_ID, role: "admin", permissions: [] },
    ],
    activeOrganizationId: ORG_ID,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const configLayer = Layer.succeed(AppConfig, {
  environment: "test",
  port: 3000,
  jwtSecret: JWT_SECRET,
  bootstrapSecret: null,
  corsOrigins: [],
  database: { uri: "mongodb://localhost", name: "test" },
  operational: {
    settlementReconcileIntervalMs: 15_000,
    settlementReconcileBatchSizeCount: 20,
    settlementReconcileInitialDelayMs: 3_000,
    providerHttpTimeoutMs: 0,
    catalogCacheTtlMs: 600_000,
    workerConcurrencyCount: 1,
    shutdownTimeoutMs: 10_000,
  },
  trustProxy: false,
  trustedProxies: [],
  trustCloudflare: false,
});

function sessionLayer(): Layer.Layer<SessionRepository> {
  const service: SessionRepositoryService = {
    insert: (record) =>
      Effect.sync(() => {
        const now = new Date();
        const id = record.id ? new ObjectId(record.id) : new ObjectId();
        return {
          _id: id,
          userId: new ObjectId(record.userId),
          organizationId: new ObjectId(record.organizationId),
          expiresAt: record.expiresAt,
          createdAt: now,
          updatedAt: now,
        };
      }),
    findById: () => Effect.succeed(null),
    touchExpiry: () => Effect.succeed(null),
    deleteById: () => Effect.succeed(false),
    deleteByIdForUser: () => Effect.succeed(false),
    deleteAllForUser: () => Effect.succeed(0),
    deleteAllForUserExcept: () => Effect.succeed(0),
  };
  return Layer.succeed(SessionRepository, service);
}

function invitesLayer(
  invite: InviteDoc,
  onRevoke?: (id: string, orgId: string) => void,
  onMarkAccepted?: (id: string) => void,
): Layer.Layer<InviteRepository> {
  const service: InviteRepositoryService = {
    listByOrg: () => Effect.succeed([invite]),
    insert: neverCall,
    findPendingByTokenHash: (hash) =>
      Effect.succeed(hash === invite.tokenHash ? invite : null),
    revokePending: (id, orgId) => {
      onRevoke?.(id, orgId);
      return Effect.succeed(true);
    },
    claimPending: (id) => {
      onMarkAccepted?.(id);
      return Effect.succeed(true);
    },
    deleteByOrg: neverCall,
  };
  return Layer.succeed(InviteRepository, service);
}

function runAccept(
  layer: Layer.Layer<
    InviteRepository | UserRepository | SessionRepository
  >,
  input: Parameters<typeof acceptInvite>[0],
) {
  return Effect.runPromiseExit(
    acceptInvite(input).pipe(
      Effect.provide(Layer.mergeAll(layer, CryptoTest, ClockTest, configLayer)),
    ),
  );
}

test("acceptInvite revokes invite and fails when inviter is no longer a member", async () => {
  const invite = inviteDoc();
  // Inviter has NO membership in ORG_ID anymore.
  const inviter = inviterUser({
    memberships: [
      { organizationId: new ObjectId(), role: "admin", permissions: [] },
    ],
  });
  const state: {
    revoked: { id: string; orgId: string } | null;
    accepted: boolean;
  } = { revoked: null, accepted: false };
  const invites = invitesLayer(
    invite,
    (id, orgId) => {
      state.revoked = { id, orgId };
    },
    () => {
      state.accepted = true;
    },
  );
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === INVITER_ID.toHexString() ? inviter : null),
    findByEmail: neverCall,
    findByUsername: neverCall,
    findByUsernameOrEmail: neverCall,
    countUsers: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    updateMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const exit = await runAccept(
    Layer.mergeAll(invites, users, sessionLayer()),
    { token: TOKEN, username: "newbie", password: "whatever1" },
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain(
      "Inviter can no longer grant the requested access",
    );
  }
  // Invite must have been revoked and NOT accepted.
  expect(state.revoked).not.toBeNull();
  expect(state.revoked?.id).toBe(invite._id.toHexString());
  expect(state.revoked?.orgId).toBe(ORG_ID.toHexString());
  expect(state.accepted).toBe(false);
});

test("acceptInvite revokes invite when inviter can no longer grant the requested permissions", async () => {
  const invite = inviteDoc({
    role: "member",
    permissions: ["providers:write", "balances:write"],
  });
  // Inviter IS still a member but their grants were reduced and no longer
  // cover the invite's permissions.
  const inviter = inviterUser({
    memberships: [
      {
        organizationId: ORG_ID,
        role: "member",
        permissions: ["customers:read"],
      },
    ],
  });
  const state = { revoked: false, accepted: false };
  const invites = invitesLayer(
    invite,
    () => {
      state.revoked = true;
    },
    () => {
      state.accepted = true;
    },
  );
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === INVITER_ID.toHexString() ? inviter : null),
    findByEmail: neverCall,
    findByUsername: neverCall,
    findByUsernameOrEmail: neverCall,
    countUsers: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    updateMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const exit = await runAccept(
    Layer.mergeAll(invites, users, sessionLayer()),
    { token: TOKEN, username: "newbie", password: "whatever1" },
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain(
      "Inviter can no longer grant the requested access",
    );
  }
  expect(state.revoked).toBe(true);
  expect(state.accepted).toBe(false);
});

test("acceptInvite applies invite role/permissions to an already-member (replace semantics)", async () => {
  const invite = inviteDoc({
    role: "member",
    permissions: ["customers:read", "usage:read"],
  });
  const passwordHash = await Bun.password.hash("newbie-pass1", {
    algorithm: "argon2id",
  });
  // Invitee already has a membership in ORG_ID with different perms.
  const invitee: UserDoc = {
    _id: INVITEE_USER_ID,
    username: "newbie",
    email: "newbie@example.com",
    passwordHash,
    memberships: [
      {
        organizationId: ORG_ID,
        role: "member",
        permissions: ["models:read"],
      },
    ],
    activeOrganizationId: ORG_ID,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const inviter = inviterUser();
  const state: {
    updatedMembership: {
      userId: string;
      orgId: string;
      role: UserDoc["memberships"][number]["role"];
      permissions: UserDoc["memberships"][number]["permissions"];
    } | null;
    activeOrgSet: { userId: string; orgId: string } | null;
    accepted: boolean;
  } = { updatedMembership: null, activeOrgSet: null, accepted: false };

  const invites = invitesLayer(invite, undefined, () => {
    state.accepted = true;
  });
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(
        id === INVITER_ID.toHexString()
          ? inviter
          : id === INVITEE_USER_ID.toHexString()
            ? invitee
            : null,
      ),
    findByEmail: (email: string) =>
      Effect.succeed(email === "newbie@example.com" ? invitee : null),
    findByUsername: neverCall,
    findByUsernameOrEmail: neverCall,
    countUsers: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: (userId: string, orgId: string) => {
      state.activeOrgSet = { userId, orgId };
      return Effect.void;
    },
    addMembership: neverCall,
    updateMembership: (
      userId: string,
      orgId: string,
      role: UserDoc["memberships"][number]["role"],
      permissions: UserDoc["memberships"][number]["permissions"],
    ) => {
      state.updatedMembership = {
        userId,
        orgId,
        role,
        permissions: [...permissions],
      };
      const replaced: UserDoc = {
        ...invitee,
        memberships: [
          {
            organizationId: ORG_ID,
            role: role as UserDoc["memberships"][number]["role"],
            permissions: [...permissions],
          },
        ],
      };
      return Effect.succeed(replaced);
    },
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const exit = await runAccept(
    Layer.mergeAll(invites, users, sessionLayer()),
    { token: TOKEN, username: "newbie", password: "newbie-pass1" },
  );

  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    // Returned view reflects the invite's role/perms (now applied).
    expect(exit.value.user.role).toBe("member");
    expect(exit.value.user.permissions).toEqual([
      "customers:read",
      "usage:read",
    ]);
  }
  // updateMembership was called with the invite's role/perms (replace).
  expect(state.updatedMembership).not.toBeNull();
  expect(state.updatedMembership?.userId).toBe(INVITEE_USER_ID.toHexString());
  expect(state.updatedMembership?.orgId).toBe(ORG_ID.toHexString());
  expect(state.updatedMembership?.role).toBe("member");
  expect(state.updatedMembership?.permissions).toEqual([
    "customers:read",
    "usage:read",
  ]);
  expect(state.activeOrgSet?.orgId).toBe(ORG_ID.toHexString());
  expect(state.accepted).toBe(true);
});
