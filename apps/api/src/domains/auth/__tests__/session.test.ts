/**
 * Session-domain operations: resolveAdminSession (round-trip + tamper + session
 * state), resolvePublicPrincipal (customer/management key lookup + revoked),
 * touchPublicKeyLastUsed, requireManagementKind.
 * Fake repository Layers + real CryptoTest/JWT; style matches admin-session.test.ts.
 */
import { test, expect } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type {
  AdminSessionDoc,
  ApiKeyDoc,
  CustomerDoc,
  ManagementApiKeyDoc,
  OrganizationDoc,
  UserDoc,
} from "@tokenpanel/db";
import {
  resolveAdminSession,
  resolvePublicPrincipal,
  touchPublicKeyLastUsed,
  requireManagementKind,
} from "../session.ts";
import {
  SessionRepository,
  type SessionRepositoryService,
  type NewAdminSessionRecord,
} from "../../ports/session-repository.ts";
import {
  KeyRepository,
  type KeyRepositoryService,
} from "../../ports/key-repository.ts";
import {
  CustomerRepository,
  type CustomerRepositoryService,
} from "../../ports/customer-repository.ts";
import {
  OrganizationRepository,
  type OrganizationRepositoryService,
} from "../../ports/organization-repository.ts";
import {
  UserRepository,
  type UserRepositoryService,
} from "../../ports/user-repository.ts";
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { ClockTest } from "../../../runtime/layers/clock.ts";
import { hashToken } from "../../../lib/crypto.ts";
import { AppConfig } from "../../../runtime/services/app-config.ts";
import { issueAdminToken } from "../operations.ts";

const USER_ID = new ObjectId();
const ORG_ID = new ObjectId();
const CUSTOMER_ID = new ObjectId();
const KEY_ID = new ObjectId();
const MGMT_KEY_ID = new ObjectId();
const JWT_SECRET = "session-domain-test-secret-32ch!";

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
    memberships: [{ organizationId: ORG_ID, role: "admin", permissions: [] }],
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
    slug: `org-${id.toHexString()}`,
    ownerId: USER_ID,
    defaultCurrency: "USD",
    createdAt: now,
    updatedAt: now,
  };
}

function sessionDoc(
  userId: ObjectId,
  expiresAt: Date,
): AdminSessionDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    userId,
    organizationId: ORG_ID,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}

function apiKeyDoc(over: Partial<ApiKeyDoc> = {}): ApiKeyDoc {
  const now = new Date();
  return {
    _id: KEY_ID,
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    name: "customer key",
    prefix: "tp_live_prefix000001",
    keyHash: "hash",
    modelWhitelist: [],
    lastUsedAt: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function mgmtKeyDoc(over: Partial<ManagementApiKeyDoc> = {}): ManagementApiKeyDoc {
  const now = new Date();
  return {
    _id: MGMT_KEY_ID,
    organizationId: ORG_ID,
    name: "management key",
    prefix: "tp_mgmt_prefix000001",
    keyHash: "hash",
    scopes: ["balances:read"],
    status: "active",
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function customerDoc(over: Partial<CustomerDoc> = {}): CustomerDoc {
  const now = new Date();
  return {
    _id: CUSTOMER_ID,
    organizationId: ORG_ID,
    externalId: null,
    name: "Acme",
    email: null,
    balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" },
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function sessionStore(seed?: { id: string; userId: ObjectId; orgId: ObjectId }) {
  const map = new Map<string, AdminSessionDoc>();
  if (seed) {
    map.set(seed.id, sessionDoc(seed.userId, new Date(Date.now() + 3_600_000)));
  }
  const service: SessionRepositoryService = {
    insert: (record: NewAdminSessionRecord) =>
      Effect.sync(() => {
        const doc: AdminSessionDoc = {
          _id: new ObjectId(),
          userId: new ObjectId(record.userId),
          organizationId: new ObjectId(record.organizationId),
          expiresAt: record.expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        map.set(doc._id.toHexString(), doc);
        return doc;
      }),
    findById: (sessionId: string) => Effect.succeed(map.get(sessionId) ?? null),
    touchExpiry: neverCall,
    deleteById: (sessionId: string) => Effect.sync(() => map.delete(sessionId)),
    deleteByIdForUser: neverCall,
    deleteAllForUser: neverCall,
    deleteAllForUserExcept: neverCall,
  } as unknown as SessionRepositoryService;
  return { map, layer: Layer.succeed(SessionRepository, service) };
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

const usersNever = Layer.succeed(UserRepository, {
  findById: neverCall,
} as unknown as UserRepositoryService);

const customersNever = Layer.succeed(CustomerRepository, {
  findByCustomerId: neverCall,
} as unknown as CustomerRepositoryService);

async function runAuth<E, A>(
  program: Effect.Effect<A, E, never>,
): Promise<{ tag: "Right"; value: A } | { tag: "Left"; error: E }> {
  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === "Success") {
    return { tag: "Right", value: exit.value };
  }
  return { tag: "Left", error: Cause.squash(exit.cause) as E };
}

test("resolveAdminSession: mint then resolve round-trips claims and session org", async () => {
  const { layer: sessions } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    findById: (id: string) =>
      Effect.succeed(id === USER_ID.toHexString() ? activeUser() : null),
  } as unknown as UserRepositoryService);
  const program = Effect.gen(function* () {
    const issued = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    return yield* resolveAdminSession(issued.token);
  }).pipe(Effect.provide(Layer.mergeAll(sessions, users, CryptoTest, ClockTest, configLayer)));
  const result = await runAuth(program);
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.user._id.equals(USER_ID)).toBe(true);
  expect(result.value.role).toBe("admin");
  expect(result.value.orgId.toHexString()).toBe(ORG_ID.toHexString());
  expect(typeof result.value.sessionId).toBe("string");
  expect((result.value.sessionId as string).length).toBeGreaterThan(0);
});

test("resolveAdminSession: null bearer → unauthorized without repos touched", async () => {
  const result = await runAuth(
    resolveAdminSession(null).pipe(
      Effect.provide(Layer.mergeAll(sessionStore().layer, usersNever, CryptoTest, ClockTest, configLayer)),
    ),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthenticationError");
  expect(result.error.code).toBe("unauthorized");
});

test("resolveAdminSession: tampered token → unauthorized", async () => {
  const result = await runAuth(
    resolveAdminSession("not.a.jwt").pipe(
      Effect.provide(Layer.mergeAll(sessionStore().layer, usersNever, CryptoTest, ClockTest, configLayer)),
    ),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthenticationError");
  if (result.error._tag !== "AuthenticationError") {
    throw new Error("expected AuthenticationError");
  }
  expect(result.error.reason).toBeDefined();
});

test("resolveAdminSession: revoked session row → unauthorized session_revoked", async () => {
  const { layer: sessions } = sessionStore();
  const users = Layer.succeed(UserRepository, {
    findById: neverCall,
  } as unknown as UserRepositoryService);
  const program = Effect.gen(function* () {
    const issued = yield* issueAdminToken({
      userId: USER_ID.toHexString(),
      orgId: ORG_ID.toHexString(),
      role: "admin",
    });
    // Simulate revocation: the allowlist row is deleted, so the JWT alone fails.
    const sessions = yield* SessionRepository;
    yield* sessions.deleteById(issued.sessionId);
    return yield* resolveAdminSession(issued.token);
  }).pipe(Effect.provide(Layer.mergeAll(sessions, users, CryptoTest, ClockTest, configLayer)));
  const result = await runAuth(program);
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthenticationError");
  if (result.error._tag !== "AuthenticationError") {
    throw new Error("expected AuthenticationError");
  }
  expect(result.error.reason).toBe("session_revoked");
});

test("resolvePublicPrincipal: customer key by prefix → customer principal", async () => {
  const fullKey = "tp_live_prefix000001"; // presented bearer credential
  const key = apiKeyDoc({
    prefix: fullKey.slice(0, 16),
    keyHash: hashToken(fullKey),
  });
  const keys = Layer.succeed(KeyRepository, {
    findCustomerKeyByPrefix: (prefix: string) =>
      Effect.succeed(prefix === key.prefix ? key : null),
    findManagementKeyByPrefix: neverCall,
  } as unknown as KeyRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findById: (id: string) =>
      Effect.succeed(id === ORG_ID.toHexString() ? orgDoc() : null),
  } as unknown as OrganizationRepositoryService);
  const customers = Layer.succeed(CustomerRepository, {
    findByCustomerId: (id: string) =>
      Effect.succeed(id === CUSTOMER_ID.toHexString() ? customerDoc() : null),
  } as unknown as CustomerRepositoryService);
  const program = resolvePublicPrincipal(`Bearer ${fullKey}`).pipe(
    Effect.provide(Layer.mergeAll(keys, orgs, customers, CryptoTest, ClockTest)),
  );
  const result = await runAuth(program);
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  if (result.value.kind !== "customer") throw new Error("expected customer");
  expect(result.value.orgId.equals(ORG_ID)).toBe(true);
  expect(result.value.customer._id.equals(CUSTOMER_ID)).toBe(true);
  expect(result.value.apiKey._id.equals(KEY_ID)).toBe(true);
});

test("resolvePublicPrincipal: revoked customer key → unauthorized", async () => {
  const fullKey = "tp_live_prefix000001";
  const keys = Layer.succeed(KeyRepository, {
    findCustomerKeyByPrefix: () =>
      Effect.succeed(apiKeyDoc({ status: "revoked", keyHash: hashToken(fullKey) })),
    findManagementKeyByPrefix: neverCall,
  } as unknown as KeyRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findById: () => Effect.succeed(orgDoc()),
  } as unknown as OrganizationRepositoryService);
  const result = await runAuth(
    resolvePublicPrincipal(`Bearer ${fullKey}`).pipe(
      Effect.provide(Layer.mergeAll(keys, orgs, customersNever, CryptoTest, ClockTest)),
    ),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthenticationError");
});

test("resolvePublicPrincipal: management key requires existing org", async () => {
  const fullKey = "tp_mgmt_prefix000001";
  const key = mgmtKeyDoc({
    prefix: fullKey.slice(0, 16),
    keyHash: hashToken(fullKey),
  });
  const keys = Layer.succeed(KeyRepository, {
    findCustomerKeyByPrefix: neverCall,
    findManagementKeyByPrefix: (prefix: string) =>
      Effect.succeed(prefix === key.prefix ? key : null),
  } as unknown as KeyRepositoryService);
  const orgs = Layer.succeed(OrganizationRepository, {
    findById: () => Effect.succeed(null),
  } as unknown as OrganizationRepositoryService);
  const result = await runAuth(
    resolvePublicPrincipal(`Bearer ${fullKey}`).pipe(
      Effect.provide(Layer.mergeAll(keys, orgs, customersNever, CryptoTest, ClockTest)),
    ),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthenticationError");
  if (result.error._tag !== "AuthenticationError") {
    throw new Error("expected AuthenticationError");
  }
  expect(result.error.reason).toBe("organization_missing");
});

test("touchPublicKeyLastUsed: customer principal touches customer key prefix", async () => {
  const touched: string[] = [];
  const keys = Layer.succeed(KeyRepository, {
    touchCustomerKeyLastUsed: (prefix: string) =>
      Effect.sync(() => {
        touched.push(`customer:${prefix}`);
      }),
    touchManagementKeyLastUsed: neverCall,
  } as unknown as KeyRepositoryService);
  const principal = {
    kind: "customer" as const,
    orgId: ORG_ID,
    customer: customerDoc(),
    apiKey: apiKeyDoc(),
    prefix: "tp_live_prefix000001",
  };
  await Effect.runPromise(
    Effect.provide(touchPublicKeyLastUsed(principal), keys),
  );
  expect(touched).toEqual(["customer:tp_live_prefix000001"]);
});

test("touchPublicKeyLastUsed: swallows repo failure (fire-and-forget)", async () => {
  const keys = Layer.succeed(KeyRepository, {
    touchCustomerKeyLastUsed: () =>
      Effect.fail(new Error("transient") as never),
    touchManagementKeyLastUsed: neverCall,
  } as unknown as KeyRepositoryService);
  const principal = {
    kind: "customer" as const,
    orgId: ORG_ID,
    customer: customerDoc(),
    apiKey: apiKeyDoc(),
    prefix: "tp_live_prefix000001",
  };
  const out = await Effect.runPromise(
    Effect.provide(touchPublicKeyLastUsed(principal), keys),
  );
  expect(out).toBeUndefined();
});

test("touchPublicKeyLastUsed: management principal touches management prefix", async () => {
  const touched: string[] = [];
  const keys = Layer.succeed(KeyRepository, {
    touchCustomerKeyLastUsed: neverCall,
    touchManagementKeyLastUsed: (prefix: string) =>
      Effect.sync(() => {
        touched.push(`management:${prefix}`);
      }),
  } as unknown as KeyRepositoryService);
  const principal = {
    kind: "management" as const,
    orgId: ORG_ID,
    managementKey: mgmtKeyDoc(),
    prefix: "tp_mgmt_prefix000001",
  };
  await Effect.runPromise(
    Effect.provide(touchPublicKeyLastUsed(principal), keys),
  );
  expect(touched).toEqual(["management:tp_mgmt_prefix000001"]);
});

test("requireManagementKind: management principal passes through", () => {
  const principal = {
    kind: "management" as const,
    orgId: ORG_ID,
    managementKey: mgmtKeyDoc(),
    prefix: "tp_mgmt_prefix000001",
  };
  const out = Effect.runSync(requireManagementKind(principal));
  expect(out.prefix).toBe("tp_mgmt_prefix000001");
});

test("requireManagementKind: customer principal → AuthenticationError", async () => {
  const principal = {
    kind: "customer" as const,
    orgId: ORG_ID,
    customer: customerDoc(),
    apiKey: apiKeyDoc(),
    prefix: "tp_live_prefix000001",
  };
  const result = await runAuth(requireManagementKind(principal));
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthenticationError");
  expect(result.error.code).toBe("unauthorized");
});

test("requireManagementKind: undefined principal → AuthenticationError", async () => {
  const result = await runAuth(requireManagementKind(undefined));
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error.code).toBe("unauthorized");
});
