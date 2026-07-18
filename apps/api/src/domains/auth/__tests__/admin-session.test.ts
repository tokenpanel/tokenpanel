/**
 * Admin JWT allowlist: session must exist; logout / password revoke kill tokens.
 */
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { AdminSessionDoc, UserDoc } from "@tokenpanel/db";
import {
  issueAdminToken,
  logout,
  changePassword,
  login,
  updateMe,
  switchActiveOrganization,
} from "../operations.ts";
import { resolveAdminSession } from "../session.ts";
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
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { ClockTest } from "../../../runtime/layers/clock.ts";
import { AppConfig } from "../../../runtime/services/app-config.ts";
import { JWT_DEFAULT_TTL_SECONDS } from "../../../config/security-policy.ts";
import type { OrganizationDoc } from "@tokenpanel/db";

const USER_ID = new ObjectId();
const ORG_ID = new ObjectId();
const JWT_SECRET = "test-secret-key-for-admin-sessions-32b";

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

function sessionStore() {
  const map = new Map<string, AdminSessionDoc>();
  const service: SessionRepositoryService = {
    insert: (record) =>
      Effect.sync(() => {
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
    deleteById: (sessionId) =>
      Effect.sync(() => map.delete(sessionId)),
    deleteByIdForUser: (sessionId, userId) =>
      Effect.sync(() => {
        const cur = map.get(sessionId);
        if (!cur || cur.userId.toHexString() !== userId) return false;
        return map.delete(sessionId);
      }),
    deleteAllForUser: (userId) =>
      Effect.sync(() => {
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
        let n = 0;
        for (const [k, v] of map) {
          if (
            v.userId.toHexString() === userId &&
            k !== keepSessionId
          ) {
            map.delete(k);
            n++;
          }
        }
        return n;
      }),
  };
  return { map, layer: Layer.succeed(SessionRepository, service) };
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

function baseLayers(sessions: Layer.Layer<SessionRepository>) {
  return Layer.mergeAll(sessions, CryptoTest, ClockTest, configLayer);
}

test("issueAdminToken + resolveAdminSession succeeds when session exists", async () => {
  const { layer: sessions } = sessionStore();
  const user = activeUser();
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? user : null),
    countUsers: neverCall,
    findByUsername: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const program = Effect.gen(function* () {
    const issued = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    expect(issued.sessionId).toMatch(/^[a-f0-9]{24}$/);
    const session = yield* resolveAdminSession(issued.token);
    expect(session.sessionId).toBe(issued.sessionId);
    expect(session.user._id.toHexString()).toBe(USER_ID.toHexString());
  });

  await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(baseLayers(sessions), users))),
  );
});

test("resolveAdminSession rejects after logout deletes session", async () => {
  const { layer: sessions } = sessionStore();
  const user = activeUser();
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? user : null),
    countUsers: neverCall,
    findByUsername: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const program = Effect.gen(function* () {
    const issued = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    yield* logout({
      userId: USER_ID.toHexString(),
      sessionId: issued.sessionId,
    });
    const result = yield* resolveAdminSession(issued.token).pipe(
      Effect.either,
    );
    expect(result._tag).toBe("Left");
  });

  await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(baseLayers(sessions), users))),
  );
});

test("changePassword revokes all sessions for user", async () => {
  const { map, layer: sessions } = sessionStore();
  let passwordHash = "old-hash";
  const user = () => activeUser({ passwordHash });

  // CryptoTest uses real Bun.password — seed a real hash.
  const realHash = await Bun.password.hash("oldpassword", {
    algorithm: "argon2id",
  });
  passwordHash = realHash;

  const users = Layer.succeed(UserRepository, {
    findById: neverCall,
    countUsers: neverCall,
    findByUsername: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: (_id: string, hash: string) =>
      Effect.sync(() => {
        passwordHash = hash;
      }),
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const program = Effect.gen(function* () {
    const a = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    const b = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    expect(map.size).toBe(2);
    yield* changePassword({
      userId: USER_ID.toHexString(),
      passwordHash: realHash,
      currentPassword: "oldpassword",
      newPassword: "newpassword1",
    });
    expect(map.size).toBe(0);
    void a;
    void b;
    void user;
    void JWT_DEFAULT_TTL_SECONDS;
  });

  await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(baseLayers(sessions), users))),
  );
});

test("updateMe email change revokes other sessions but keeps the current one", async () => {
  const { map, layer: sessions } = sessionStore();
  const hash = await Bun.password.hash("secret123", {
    algorithm: "argon2id",
  });
  const startUser = activeUser({ passwordHash: hash });
  let email = startUser.email;
  const users = Layer.succeed(UserRepository, {
    findByUsername: neverCall,
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? startUser : null),
    countUsers: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: () => Effect.succeed(false),
    insertUser: neverCall,
    updateEmail: (_id: string, newEmail: string) =>
      Effect.sync(() => {
        email = newEmail;
        return { ...startUser, email: newEmail };
      }),
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const program = Effect.gen(function* () {
    const a = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    const b = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    expect(map.size).toBe(2);

    // Email change from the device holding session `a`: other sessions are
    // revoked, but `a` stays alive so the requester is not logged out.
    yield* updateMe({
      userId: USER_ID.toHexString(),
      currentEmail: startUser.email,
      email: "alice-new@example.com",
      activeOrganizationId: ORG_ID.toHexString(),
      sessionId: a.sessionId,
    });
    expect(email).toBe("alice-new@example.com");
    expect(map.size).toBe(1);
    expect(map.has(a.sessionId)).toBe(true);
    expect(map.has(b.sessionId)).toBe(false);

    // Current session still resolves; revoked session no longer does.
    yield* resolveAdminSession(a.token);
    const stale = yield* resolveAdminSession(b.token).pipe(Effect.either);
    expect(stale._tag).toBe("Left");
  });

  await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(baseLayers(sessions), users))),
  );
});

test("login mints session-backed token", async () => {
  const { map, layer: sessions } = sessionStore();
  const hash = await Bun.password.hash("secret123", { algorithm: "argon2id" });
  const user = activeUser({ passwordHash: hash });
  const users = Layer.succeed(UserRepository, {
    findByUsername: (u: string) =>
      Effect.succeed(u === "alice" ? user : null),
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? user : null),
    countUsers: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const program = Effect.gen(function* () {
    const res = yield* login({ username: "alice", password: "secret123" });
    expect(res.token.split(".")).toHaveLength(3);
    expect(map.size).toBe(1);
    const session = yield* resolveAdminSession(res.token);
    expect(session.user.username).toBe("alice");
    expect(session.orgId.toHexString()).toBe(ORG_ID.toHexString());
    const row = [...map.values()][0]!;
    expect(row.organizationId.toHexString()).toBe(ORG_ID.toHexString());
  });

  await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(baseLayers(sessions), users))),
  );
});

test("login with unknown username fails with invalid_credentials (dummy argon2 path)", async () => {
  const { layer: sessions } = sessionStore();
  const hash = await Bun.password.hash("secret123", { algorithm: "argon2id" });
  const user = activeUser({ passwordHash: hash });
  const users = Layer.succeed(UserRepository, {
    findByUsername: (u: string) =>
      Effect.succeed(u === "alice" ? user : null),
    findById: neverCall,
    countUsers: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  // Missing username must run the dummy argon2 verify (timing equalization)
  // and then fail with invalid_credentials — it must NOT throw or succeed.
  const result = await Effect.runPromise(
    login({ username: "no-such-user", password: "whatever" }).pipe(
      Effect.either,
      Effect.provide(Layer.mergeAll(baseLayers(sessions), users)),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag !== "Left") throw new Error("expected failure");
  expect(result.left._tag).toBe("AuthenticationError");
  expect(result.left.code).toBe("invalid_credentials");
});

test("resolveAdminSession uses session org, not user.activeOrganizationId", async () => {
  const ORG_B = new ObjectId();
  const { map, layer: sessions } = sessionStore();
  // User preference points at ORG_B, but session was issued for ORG_ID.
  const user = activeUser({
    memberships: [
      { organizationId: ORG_ID, role: "admin", permissions: [] },
      { organizationId: ORG_B, role: "member", permissions: [] },
    ],
    activeOrganizationId: ORG_B,
  });
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? user : null),
    countUsers: neverCall,
    findByUsername: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const program = Effect.gen(function* () {
    const issued = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    const session = yield* resolveAdminSession(issued.token);
    expect(session.orgId.toHexString()).toBe(ORG_ID.toHexString());
    expect(session.role).toBe("admin");
    expect(map.get(issued.sessionId)?.organizationId.toHexString()).toBe(
      ORG_ID.toHexString(),
    );
  });

  await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(baseLayers(sessions), users))),
  );
});

test("org switch rebinds only the current session; other session stays put", async () => {
  const ORG_B = new ObjectId();
  const { map, layer: sessions } = sessionStore();
  let activeOrg = ORG_ID;
  const userDoc = (): UserDoc =>
    activeUser({
      memberships: [
        { organizationId: ORG_ID, role: "admin", permissions: [] },
        { organizationId: ORG_B, role: "member", permissions: [] },
      ],
      activeOrganizationId: activeOrg,
    });

  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? userDoc() : null),
    countUsers: neverCall,
    findByUsername: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: (_userId: string, organizationId: string) =>
      Effect.sync(() => {
        activeOrg = new ObjectId(organizationId);
      }),
    addMembership: neverCall,
    findMembersOfOrg: neverCall,
    pullMembershipAndRepoint: neverCall,
  } as unknown as UserRepositoryService);

  const orgDoc = (id: ObjectId): OrganizationDoc => {
    const now = new Date();
    return {
      _id: id,
      name: "org",
      slug: "org",
      ownerId: USER_ID,
      defaultCurrency: "USD",
      createdAt: now,
      updatedAt: now,
    };
  };
  const orgs = Layer.succeed(OrganizationRepository, {
    findById: (id: string) =>
      Effect.succeed(
        id === ORG_B.toHexString()
          ? orgDoc(ORG_B)
          : id === ORG_ID.toHexString()
            ? orgDoc(ORG_ID)
            : null,
      ),
    findByIds: neverCall,
    findBySlug: neverCall,
    slugTaken: neverCall,
    insert: neverCall,
    update: neverCall,
    delete: neverCall,
    countBusinessData: neverCall,
  } as unknown as OrganizationRepositoryService);

  const program = Effect.gen(function* () {
    const deviceA = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    const deviceB = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    expect(map.size).toBe(2);

    // Device A switches to ORG_B.
    const switched = yield* switchActiveOrganization({
      userId: USER_ID.toHexString(),
      targetOrganizationId: ORG_B.toHexString(),
      sessionId: deviceA.sessionId,
      memberships: userDoc().memberships,
    });

    const sessionA = yield* resolveAdminSession(switched.token);
    expect(sessionA.orgId.toHexString()).toBe(ORG_B.toHexString());
    expect(sessionA.role).toBe("member");
    expect(map.get(deviceA.sessionId)?.organizationId.toHexString()).toBe(
      ORG_B.toHexString(),
    );

    // Device B still bound to ORG_ID despite user preference moving to ORG_B.
    expect(activeOrg.toHexString()).toBe(ORG_B.toHexString());
    const sessionB = yield* resolveAdminSession(deviceB.token);
    expect(sessionB.orgId.toHexString()).toBe(ORG_ID.toHexString());
    expect(sessionB.role).toBe("admin");
    expect(map.get(deviceB.sessionId)?.organizationId.toHexString()).toBe(
      ORG_ID.toHexString(),
    );

    // Stale pre-switch token for device A (old JWT org claim) must fail.
    const stale = yield* resolveAdminSession(deviceA.token).pipe(Effect.either);
    expect(stale._tag).toBe("Left");
  });

  await Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(baseLayers(sessions), users, orgs)),
    ),
  );
});
