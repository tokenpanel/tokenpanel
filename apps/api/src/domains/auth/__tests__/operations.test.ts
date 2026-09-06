/**
 * Domain auth operations: signup, login, listInvites, revokeInvite,
 * switchActiveOrganization, updateMe, changePassword, needsSetup.
 * Fake repository Layers + real CryptoTest (argon2id/JWT) + ClockTest.
 */
import { test, expect } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { ObjectId } from "mongodb";
import type {
  AdminSessionDoc,
  InviteDoc,
  OrganizationDoc,
  UserDoc,
} from "@tokenpanel/db";
import type { NewOrganizationRecord } from "../../ports/organization-repository.ts";
import type { NewUserRecord } from "../../ports/user-repository.ts";
import {
  changePassword,
  listInvites,
  login,
  needsSetup,
  revokeInvite,
  signup,
  switchActiveOrganization,
  updateMe,
  issueAdminToken,
} from "../operations.ts";
import {
  SessionRepository,
  type SessionRepositoryService,
} from "../../ports/session-repository.ts";
import {
  UserRepository,
  type UserRepositoryService,
} from "../../ports/user-repository.ts";
import {
  OrganizationRepository,
  type OrganizationRepositoryService,
} from "../../ports/organization-repository.ts";
import {
  InviteRepository,
  type InviteRepositoryService,
} from "../../ports/invite-repository.ts";
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { ClockTest } from "../../../runtime/layers/clock.ts";
import { AppConfig } from "../../../runtime/services/app-config.ts";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceDuplicateKeyError,
} from "../../../errors/families.ts";
import { verifyJwt } from "../../../lib/crypto.ts";
import { Password } from "@tokenpanel/contracts/effect";

const USER_ID = new ObjectId();
const ORG_ID = new ObjectId();
const ORG_B = new ObjectId();
const JWT_SECRET = "auth-operations-test-secret-32ch!";

function neverCall(): never {
  throw new Error("unexpected repository call");
}

function activeUser(over: Partial<UserDoc> = {}): UserDoc {
  const now = new Date();
  return {
    _id: USER_ID,
    username: "alice",
    email: "alice@example.com",
    passwordHash: "hash",
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

function orgDoc(id: ObjectId = ORG_ID): OrganizationDoc {
  const now = new Date();
  return {
    _id: id,
    name: "default",
    slug: "default",
    ownerId: USER_ID,
    defaultCurrency: "USD",
    createdAt: now,
    updatedAt: now,
  };
}

function inviteDoc(over: Partial<InviteDoc> = {}): InviteDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    invitedBy: USER_ID,
    email: "newbie@example.com",
    role: "member",
    permissions: ["customers:read"],
    tokenHash: "tok-hash",
    status: "pending",
    acceptedAt: null,
    expiresAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function sessionStore() {
  const map = new Map<string, AdminSessionDoc>();
  const calls: string[] = [];
  const service: SessionRepositoryService = {
    insert: (record) =>
      Effect.sync(() => {
        calls.push(`insert:${record.organizationId}`);
        const now = new Date();
        const id = record.id ? new ObjectId(record.id) : new ObjectId();
        const doc: AdminSessionDoc = {
          _id: id,
          userId: new ObjectId(record.userId),
          organizationId: new ObjectId(record.organizationId),
          expiresAt: record.expiresAt,
          createdAt: now,
          updatedAt: now,
        };
        map.set(id.toHexString(), doc);
        return doc;
      }),
    findById: (sessionId) => Effect.succeed(map.get(sessionId) ?? null),
    touchExpiry: (sessionId, userId, expiresAt, organizationId) =>
      Effect.sync(() => {
        calls.push(`touch:${sessionId}:${organizationId ?? "-"}`);
        const cur = map.get(sessionId);
        if (!cur || cur.userId.toHexString() !== userId) return null;
        const next: AdminSessionDoc = {
          ...cur,
          expiresAt,
          updatedAt: new Date(),
          ...(organizationId !== undefined
            ? { organizationId: new ObjectId(organizationId) }
            : {}),
        };
        map.set(sessionId, next);
        return next;
      }),
    deleteById: neverCall,
    deleteByIdForUser: neverCall,
    deleteAllForUser: (userId) =>
      Effect.sync(() => {
        calls.push(`deleteAll:${userId}`);
        let n = 0;
        for (const [k, v] of map) {
          if (v.userId.toHexString() === userId) {
            map.delete(k);
            n++;
          }
        }
        return n;
      }),
    deleteAllForUserExcept: (userId, keepSessionId) =>
      Effect.sync(() => {
        calls.push(`deleteExcept:${userId}:${keepSessionId}`);
        let n = 0;
        for (const [k, v] of map) {
          if (v.userId.toHexString() === userId && k !== keepSessionId) {
            map.delete(k);
            n++;
          }
        }
        return n;
      }),
  };
  return { map, calls, layer: Layer.succeed(SessionRepository, service) };
}

const configLayer = Layer.succeed(AppConfig, {
  environment: "test",
  port: 3000,
  jwtSecret: JWT_SECRET,
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

// ---------------------------------------------------------------------------
// needsSetup
// ---------------------------------------------------------------------------

test("needsSetup: true when no users exist", async () => {
  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(0),
  } as unknown as UserRepositoryService);
  const result = await Effect.runPromise(
    needsSetup().pipe(Effect.provide(users)),
  );
  expect(result).toEqual({ needsSetup: true });
});

test("needsSetup: false when users exist", async () => {
  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(3),
  } as unknown as UserRepositoryService);
  const result = await Effect.runPromise(
    needsSetup().pipe(Effect.provide(users)),
  );
  expect(result).toEqual({ needsSetup: false });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

test("login with wrong password fails invalid_credentials and mints no session", async () => {
  const { map, layer: sessions } = sessionStore();
  const hash = await Bun.password.hash("secret123", { algorithm: "argon2id" });
  const user = activeUser({ passwordHash: hash });
  const users = Layer.succeed(UserRepository, {
    findByUsername: (u: string) => Effect.succeed(u === "alice" ? user : null),
  } as unknown as UserRepositoryService);

  const result = await Effect.runPromise(
    login({ username: "alice", password: "wrong-pass" }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("AuthenticationError");
    expect(result.left.code).toBe("invalid_credentials");
  }
  expect(map.size).toBe(0);
});

test("login rejects disabled user after successful password verify", async () => {
  const { map, layer: sessions } = sessionStore();
  const hash = await Bun.password.hash("secret123", { algorithm: "argon2id" });
  const user = activeUser({ passwordHash: hash, status: "disabled" });
  const users = Layer.succeed(UserRepository, {
    findByUsername: (u: string) => Effect.succeed(u === "alice" ? user : null),
  } as unknown as UserRepositoryService);

  const result = await Effect.runPromise(
    login({ username: "alice", password: "secret123" }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("AuthorizationError");
    expect(result.left.code).toBe("user_disabled");
    expect((result.left as AuthorizationError).reason).toBe("user_disabled");
  }
  expect(map.size).toBe(0);
});

// ---------------------------------------------------------------------------
// signup
// ---------------------------------------------------------------------------

test("signup creates default org + admin user, coordinates ids, releases nothing", async () => {
  const { map, layer: sessions } = sessionStore();
  let insertUserRecord: NewUserRecord | null = null;
  let insertOrgRecord: NewOrganizationRecord | null = null;
  let released = 0;

  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(0),
    claimBootstrap: () => Effect.succeed(true),
    releaseBootstrapClaim: () =>
      Effect.sync(() => {
        released++;
      }),
    insertUser: (record: NewUserRecord) =>
      Effect.sync(() => {
        insertUserRecord = record;
        const now = new Date();
        const doc: UserDoc = {
          _id: new ObjectId(record.id),
          username: record.username,
          email: record.email,
          passwordHash: record.passwordHash,
          memberships: [...record.memberships],
          activeOrganizationId: new ObjectId(record.activeOrganizationId),
          status: record.status,
          createdAt: now,
          updatedAt: now,
        };
        return doc;
      }),
  } as unknown as UserRepositoryService);

  const orgs = Layer.succeed(OrganizationRepository, {
    findBySlug: () => Effect.succeed(null),
    insert: (record: NewOrganizationRecord) =>
      Effect.sync(() => {
        insertOrgRecord = record;
        const now = new Date();
        const doc: OrganizationDoc = {
          _id: new ObjectId(record.id),
          name: record.name,
          slug: record.slug,
          ownerId: new ObjectId(record.ownerId),
          defaultCurrency: record.defaultCurrency,
          createdAt: now,
          updatedAt: now,
        };
        return doc;
      }),
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    signup({
      adminUsername: "root",
      adminEmail: "root@example.com",
      password: "root-secret-1",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );

  expect(result.organization.name).toBe("default");
  expect(result.organization.slug).toBe("default");
  expect(result.organization.id).toMatch(/^[a-f0-9]{24}$/);
  expect(result.user.role).toBe("admin");
  expect(result.user.username).toBe("root");
  expect(result.user.activeOrganizationId).toBe(result.organization.id);
  expect(result.token.split(".")).toHaveLength(3);

  // Coordinated ids: org.ownerId references the pre-generated user id.
  const insertedUser = insertUserRecord as NewUserRecord | null;
  const insertedOrg = insertOrgRecord as NewOrganizationRecord | null;
  expect(insertedUser).not.toBeNull();
  expect(insertedOrg).not.toBeNull();
  if (
    insertedUser === null || insertedOrg === null ||
    insertedUser.id === undefined || insertedOrg.id === undefined
  ) {
    throw new Error("expected signup to insert coordinated user and org");
  }
  expect(insertedOrg.ownerId).toBe(insertedUser.id);
  expect(insertedUser.activeOrganizationId).toBe(insertedOrg.id);
  expect(insertedUser.passwordHash).toStartWith("$argon2id");
  expect(insertedUser.memberships[0]!.role).toBe("admin");
  expect(insertedUser.status).toBe("active");

  // JWT carries the coordinated claims.
  const payload = verifyJwt(result.token, JWT_SECRET);
  expect(payload.sub).toBe(result.user.id);
  expect(payload.orgId).toBe(result.organization.id);
  expect(payload.role).toBe("admin");

  // A session row backs the JWT and no bootstrap claim was released.
  expect(map.size).toBe(1);
  expect(released).toBe(0);
});

test("signup fails setup_already_complete when users exist", async () => {
  const { layer: sessions } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(1),
    claimBootstrap: neverCall,
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    insert: neverCall,
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    signup({
      adminUsername: "root",
      adminEmail: "root@example.com",
      password: "root-secret-1",
    }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("ConflictError");
    expect(result.left.code).toBe("setup_already_complete");
  }
});

test("signup fails setup_already_complete when the bootstrap claim is held", async () => {
  const { layer: sessions } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(0),
    claimBootstrap: () => Effect.succeed(false),
    releaseBootstrapClaim: neverCall,
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    insert: neverCall,
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    signup({
      adminUsername: "root",
      adminEmail: "root@example.com",
      password: "root-secret-1",
    }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("ConflictError");
    expect(result.left.code).toBe("setup_already_complete");
  }
});

test("signup maps duplicate org insert to organization_creation_failed and releases claim", async () => {
  const { layer: sessions } = sessionStore();
  let released = 0;
  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(0),
    claimBootstrap: () => Effect.succeed(true),
    releaseBootstrapClaim: () =>
      Effect.sync(() => {
        released++;
      }),
    insertUser: neverCall,
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findBySlug: () => Effect.succeed(null),
    insert: () =>
      Effect.fail(
        new PersistenceDuplicateKeyError({
          code: "persistence_duplicate_key",
          message: "dup",
          retryClass: "never",
        }),
      ),
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    signup({
      adminUsername: "root",
      adminEmail: "root@example.com",
      password: "root-secret-1",
    }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("ConflictError");
    expect(result.left.code).toBe("organization_creation_failed");
  }
  expect(released).toBe(1);
});

test("signup rolls back org and releases claim when user insert hits duplicate", async () => {
  const { layer: sessions } = sessionStore();
  let released = 0;
  let deletedOrgId: string | null = null;
  let insertedOrgId: string | null = null;
  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(0),
    claimBootstrap: () => Effect.succeed(true),
    releaseBootstrapClaim: () =>
      Effect.sync(() => {
        released++;
      }),
    insertUser: () =>
      Effect.fail(
        new PersistenceDuplicateKeyError({
          code: "persistence_duplicate_key",
          message: "dup",
          retryClass: "never",
        }),
      ),
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findBySlug: () => Effect.succeed(null),
    insert: (record: NewOrganizationRecord) =>
      Effect.sync(() => {
        insertedOrgId = record.id!;
        const now = new Date();
        const doc: OrganizationDoc = {
          _id: new ObjectId(record.id),
          name: record.name,
          slug: record.slug,
          ownerId: new ObjectId(record.ownerId),
          defaultCurrency: record.defaultCurrency,
          createdAt: now,
          updatedAt: now,
        };
        return doc;
      }),
    delete: (id: string) =>
      Effect.sync(() => {
        deletedOrgId = id;
      }),
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    signup({
      adminUsername: "root",
      adminEmail: "root@example.com",
      password: "root-secret-1",
    }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("ConflictError");
    expect(result.left.code).toBe("username_or_email_taken");
    expect((result.left as ConflictError).fields).toEqual([
      "username",
      "email",
    ]);
  }
  expect(insertedOrgId).not.toBeNull();
  expect(deletedOrgId).toBe(insertedOrgId);
  expect(released).toBe(1);
});

test("signup appends random suffix when the default slug is taken", async () => {
  const { layer: sessions } = sessionStore();
  let slugLookups = 0;
  let insertedSlug: string | null = null;
  const users = Layer.succeed(UserRepository, {
    countUsers: () => Effect.succeed(0),
    claimBootstrap: () => Effect.succeed(true),
    releaseBootstrapClaim: () => Effect.succeed(undefined),
    insertUser: (record: NewUserRecord) =>
      Effect.sync(() => {
        const now = new Date();
        const doc: UserDoc = {
          _id: new ObjectId(record.id),
          username: record.username,
          email: record.email,
          passwordHash: record.passwordHash,
          memberships: [...record.memberships],
          activeOrganizationId: new ObjectId(record.activeOrganizationId),
          status: record.status,
          createdAt: now,
          updatedAt: now,
        };
        return doc;
      }),
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findBySlug: (slug: string) =>
      Effect.sync(() => {
        slugLookups++;
        return slug === "default" ? orgDoc() : null;
      }),
    insert: (record: NewOrganizationRecord) =>
      Effect.sync(() => {
        insertedSlug = record.slug;
        const now = new Date();
        const doc: OrganizationDoc = {
          _id: new ObjectId(record.id),
          name: record.name,
          slug: record.slug,
          ownerId: new ObjectId(record.ownerId),
          defaultCurrency: record.defaultCurrency,
          createdAt: now,
          updatedAt: now,
        };
        return doc;
      }),
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    signup({
      adminUsername: "root",
      adminEmail: "root@example.com",
      password: "root-secret-1",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );
  const slugSeen: string | null = insertedSlug;
  expect(slugSeen).not.toBeNull();
  if (slugSeen === null) throw new Error("expected insert to capture slug");
  expect(result.organization.slug).toBe(slugSeen);
  expect(result.organization.slug).toMatch(/^default-[0-9a-f]{4}$/);
  expect(slugLookups).toBe(2);
});

// ---------------------------------------------------------------------------
// updateMe
// ---------------------------------------------------------------------------

test("updateMe with unchanged email skips conflict check and session revocation", async () => {
  const { layer: sessions, calls } = sessionStore();
  const user = activeUser();
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? user : null),
    emailTaken: neverCall,
    updateEmail: neverCall,
  } as unknown as UserRepositoryService);

  const view = await Effect.runPromise(
    updateMe({
      userId: USER_ID.toHexString(),
      currentEmail: user.email,
      email: user.email,
      activeOrganizationId: ORG_ID.toHexString(),
      sessionId: "abc",
    }).pipe(
      Effect.provide(Layer.mergeAll(sessions, users)),
    ),
  );
  expect(view.email).toBe("alice@example.com");
  expect(view.activeOrganizationId).toBe(ORG_ID.toHexString());
  expect(calls).toEqual([]);
});

test("updateMe same email with unknown user fails not_found", async () => {
  const { layer: sessions } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    findById: () => Effect.succeed(null),
  } as unknown as UserRepositoryService);

  const result = await Effect.runPromise(
    updateMe({
      userId: USER_ID.toHexString(),
      currentEmail: "alice@example.com",
      email: "alice@example.com",
    }).pipe(Effect.either, Effect.provide(Layer.mergeAll(sessions, users))),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("NotFoundError");
    expect(result.left.code).toBe("not_found");
    expect((result.left as NotFoundError).resource).toBe("user");
  }
});

test("updateMe rejects taken email without revoking sessions", async () => {
  const { layer: sessions, calls } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    emailTaken: () => Effect.succeed(true),
    updateEmail: neverCall,
  } as unknown as UserRepositoryService);

  const result = await Effect.runPromise(
    updateMe({
      userId: USER_ID.toHexString(),
      currentEmail: "alice@example.com",
      email: "bob@example.com",
      sessionId: "abc",
    }).pipe(Effect.either, Effect.provide(Layer.mergeAll(sessions, users))),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("ConflictError");
    expect(result.left.code).toBe("email_taken");
    expect((result.left as ConflictError).fields).toEqual(["email"]);
  }
  expect(calls).toEqual([]);
});

test("updateMe email change with sessionId revokes only other sessions", async () => {
  const { layer: sessions, calls } = sessionStore();
  const user = activeUser();
  const users = Layer.succeed(UserRepository, {
    emailTaken: () => Effect.succeed(false),
    updateEmail: (_id: string, email: string) =>
      Effect.sync(() => ({ ...user, email })),
  } as unknown as UserRepositoryService);

  const view = await Effect.runPromise(
    updateMe({
      userId: USER_ID.toHexString(),
      currentEmail: "alice@example.com",
      email: "alice-new@example.com",
      activeOrganizationId: ORG_ID.toHexString(),
      sessionId: "session-1",
    }).pipe(Effect.provide(Layer.mergeAll(sessions, users))),
  );
  expect(view.email).toBe("alice-new@example.com");
  expect(view.activeOrganizationId).toBe(ORG_ID.toHexString());
  expect(calls).toEqual([`deleteExcept:${USER_ID.toHexString()}:session-1`]);
});

test("updateMe email change without sessionId revokes every session", async () => {
  const { layer: sessions, calls } = sessionStore();
  const user = activeUser();
  const users = Layer.succeed(UserRepository, {
    emailTaken: () => Effect.succeed(false),
    updateEmail: (_id: string, email: string) =>
      Effect.sync(() => ({ ...user, email })),
  } as unknown as UserRepositoryService);

  await Effect.runPromise(
    updateMe({
      userId: USER_ID.toHexString(),
      currentEmail: "alice@example.com",
      email: "alice-new@example.com",
    }).pipe(Effect.provide(Layer.mergeAll(sessions, users))),
  );
  expect(calls).toEqual([`deleteAll:${USER_ID.toHexString()}`]);
});

test("updateMe email change fails not_found when updateEmail misses", async () => {
  const { layer: sessions, calls } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    emailTaken: () => Effect.succeed(false),
    updateEmail: () => Effect.succeed(null),
  } as unknown as UserRepositoryService);

  const result = await Effect.runPromise(
    updateMe({
      userId: USER_ID.toHexString(),
      currentEmail: "alice@example.com",
      email: "alice-new@example.com",
      sessionId: "session-1",
    }).pipe(Effect.either, Effect.provide(Layer.mergeAll(sessions, users))),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("NotFoundError");
    expect((result.left as NotFoundError).resource).toBe("user");
  }
  expect(calls).toEqual([`deleteExcept:${USER_ID.toHexString()}:session-1`]);
});

// ---------------------------------------------------------------------------
// changePassword
// ---------------------------------------------------------------------------

test("changePassword with wrong current password fails and changes nothing", async () => {
  const { layer: sessions, calls } = sessionStore();
  const hash = await Bun.password.hash("correct-horse", {
    algorithm: "argon2id",
  });
  let newHash: string | null = null;
  const users = Layer.succeed(UserRepository, {
    updatePasswordHash: (_id: string, hash: string) =>
      Effect.sync(() => {
        newHash = hash;
      }),
  } as unknown as UserRepositoryService);

  const result = await Effect.runPromise(
    changePassword({
      userId: USER_ID.toHexString(),
      passwordHash: hash,
      currentPassword: "not-the-password",
      newPassword: "brand-new-pass-1",
    }).pipe(Effect.either, Effect.provide(Layer.mergeAll(sessions, CryptoTest, users))),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("AuthenticationError");
    expect(result.left.code).toBe("invalid_credentials");
  }
  expect(newHash).toBeNull();
  expect(calls).toEqual([]);
});

test("changePassword stores a fresh argon2 hash and revokes all sessions", async () => {
  const { layer: sessions, calls } = sessionStore();
  const hash = await Bun.password.hash("correct-horse", {
    algorithm: "argon2id",
  });
  let capturedHash: string | null = null;
  const users = Layer.succeed(UserRepository, {
    updatePasswordHash: (_id: string, hash: string) =>
      Effect.sync(() => {
        capturedHash = hash;
      }),
  } as unknown as UserRepositoryService);

  const result = await Effect.runPromise(
    changePassword({
      userId: USER_ID.toHexString(),
      passwordHash: hash,
      currentPassword: "correct-horse",
      newPassword: "brand-new-pass-1",
    }).pipe(Effect.provide(Layer.mergeAll(sessions, CryptoTest, users))),
  );
  expect(result).toEqual({ ok: true });
  expect(capturedHash).toStartWith("$argon2id");
  expect(capturedHash).not.toBe(hash);
  // Hash actually verifies against the new password.
  expect(await Bun.password.verify("brand-new-pass-1", capturedHash!)).toBe(
    true,
  );
  expect(calls).toEqual([`deleteAll:${USER_ID.toHexString()}`]);
});

// ---------------------------------------------------------------------------
// listInvites / revokeInvite
// ---------------------------------------------------------------------------

test("listInvites maps docs to views and strips tokenHash", async () => {
  const pending = inviteDoc();
  const withDefaults = inviteDoc({ permissions: [] });
  const invites = Layer.succeed(InviteRepository, {
    listByOrg: (orgId: string) =>
      Effect.succeed(
        orgId === ORG_ID.toHexString() ? [pending, withDefaults] : [],
      ),
  } as unknown as InviteRepositoryService);

  const items = await Effect.runPromise(
    listInvites(ORG_ID.toHexString()).pipe(Effect.provide(invites)),
  );
  expect(items).toHaveLength(2);
  expect(items[0]).toEqual({
    id: pending._id.toHexString(),
    email: "newbie@example.com",
    role: "member",
    permissions: ["customers:read"],
    status: "pending",
    expiresAt: pending.expiresAt,
    createdAt: pending.createdAt,
  });
  // Nullish stored permissions surface as empty grants.
  expect(items[1]!.permissions).toEqual([]);
  expect(JSON.stringify(items[0])).not.toContain("tok-hash");
  expect(JSON.stringify(items[0])).not.toContain("tokenHash");
});

test("revokeInvite succeeds when the pending invite is revoked", async () => {
  const revoked: { id: string; orgId: string } | null = null;
  let captured: { id: string; orgId: string } | undefined;
  const invites = Layer.succeed(InviteRepository, {
    revokePending: (id: string, orgId: string) =>
      Effect.sync(() => {
        captured = { id, orgId };
        return true;
      }),
  } as unknown as InviteRepositoryService);

  const result = await Effect.runPromise(
    revokeInvite("abc123", ORG_ID.toHexString()).pipe(
      Effect.provide(invites),
    ),
  );
  expect(result).toEqual({ ok: true });
  expect(captured).toEqual({ id: "abc123", orgId: ORG_ID.toHexString() });
  void revoked;
});

test("revokeInvite fails not_found for an unknown invite", async () => {
  const invites = Layer.succeed(InviteRepository, {
    revokePending: () => Effect.succeed(false),
  } as unknown as InviteRepositoryService);

  const result = await Effect.runPromise(
    revokeInvite("missing", ORG_ID.toHexString()).pipe(
      Effect.either,
      Effect.provide(invites),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("NotFoundError");
    expect(result.left.code).toBe("not_found");
    expect((result.left as NotFoundError).resource).toBe("invite");
    expect((result.left as NotFoundError).id).toBe("missing");
  }
});

// ---------------------------------------------------------------------------
// switchActiveOrganization
// ---------------------------------------------------------------------------

test("switchActiveOrganization rebinds session, repoints preference, issues JWT for target org", async () => {
  const { map, layer: sessions } = sessionStore();
  let preference: { userId: string; orgId: string } | null = null;
  const users = Layer.succeed(UserRepository, {
    setActiveOrganization: (userId: string, orgId: string) =>
      Effect.sync(() => {
        preference = { userId, orgId };
      }),
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findById: (id: string) =>
      Effect.succeed(id === ORG_B.toHexString() ? orgDoc(ORG_B) : null),
  } as unknown as OrganizationRepositoryService);

  const seed = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* issueAdminToken({
        userId: USER_ID.toHexString(),
        orgId: ORG_ID.toHexString(),
        role: "admin",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer),
      ),
    ),
  );

  const result = await Effect.runPromise(
    switchActiveOrganization({
      userId: USER_ID.toHexString(),
      targetOrganizationId: ORG_B.toHexString(),
      sessionId: seed.sessionId,
      memberships: activeUser({
        memberships: [
          { organizationId: ORG_ID, role: "admin", permissions: [] },
          { organizationId: ORG_B, role: "member", permissions: [] },
        ],
      }).memberships,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );

  expect(result.role).toBe("member");
  expect(result.activeOrganizationId).toBe(ORG_B.toHexString());
  const savedPreference = preference as { userId: string; orgId: string } | null;
  expect(savedPreference).toEqual({
    userId: USER_ID.toHexString(),
    orgId: ORG_B.toHexString(),
  });
  // Session row rebound to ORG_B; token payload mirrors it.
  expect(map.get(seed.sessionId)?.organizationId.toHexString()).toBe(
    ORG_B.toHexString(),
  );
  const payload = verifyJwt(result.token, JWT_SECRET);
  expect(payload.orgId).toBe(ORG_B.toHexString());
  expect(payload.role).toBe("member");
  expect(payload.sid).toBe(seed.sessionId);
});

test("switchActiveOrganization rejects a non-member target before any repo call", async () => {
  const { layer: sessions } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    setActiveOrganization: neverCall,
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findById: neverCall,
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    switchActiveOrganization({
      userId: USER_ID.toHexString(),
      targetOrganizationId: ORG_B.toHexString(),
      sessionId: "session-1",
      memberships: [
        { organizationId: ORG_ID, role: "admin" },
      ],
    }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("AuthorizationError");
    expect(result.left.code).toBe("forbidden");
    expect((result.left as AuthorizationError).reason).toBe("not_a_member");
  }
});

test("switchActiveOrganization fails not_found when the target org is gone", async () => {
  const { map, layer: sessions } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    setActiveOrganization: neverCall,
  } as unknown as UserRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findById: () => Effect.succeed(null),
  } as unknown as OrganizationRepositoryService);

  const result = await Effect.runPromise(
    switchActiveOrganization({
      userId: USER_ID.toHexString(),
      targetOrganizationId: ORG_B.toHexString(),
      sessionId: "session-1",
      memberships: [{ organizationId: ORG_B, role: "member" }],
    }).pipe(
      Effect.either,
      Effect.provide(
        Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer, users, orgs),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("NotFoundError");
    expect(result.left.code).toBe("not_found");
    expect((result.left as NotFoundError).resource).toBe("organization");
    expect((result.left as NotFoundError).id).toBe(ORG_B.toHexString());
  }
  // No session was minted for the failed switch.
  expect(map.size).toBe(0);
});

test("Password wire schema rejects short passwords (weak-password gate is wire-level)", () => {
  const tooShort = Schema.decodeUnknownEither(Password)("short");
  expect(tooShort._tag).toBe("Left");
  const minOk = Schema.decodeUnknownEither(Password)("12345678");
  expect(minOk._tag).toBe("Right");
});
