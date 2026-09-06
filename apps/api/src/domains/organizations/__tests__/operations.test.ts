/**
 * Organization domain operations: pure helpers (toOrganizationView, deriveSlug),
 * list/create/get/update against fake repository Layers. Style matches
 * admin-session.test.ts.
 */
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type {
  MembershipDoc,
  OrganizationDoc,
  UserDoc,
} from "@tokenpanel/db";
import {
  toOrganizationView,
  deriveSlug,
  listOrganizationsForUser,
  createOrganization,
  getOrganization,
  updateOrganization,
} from "../operations.ts";
import {
  OrganizationRepository,
  type NewOrganizationRecord,
  type OrganizationRepositoryService,
} from "../../ports/organization-repository.ts";
import {
  UserRepository,
  type UserRepositoryService,
} from "../../ports/user-repository.ts";
import {
  SessionRepository,
  type NewAdminSessionRecord,
  type SessionRepositoryService,
} from "../../ports/session-repository.ts";
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { ClockTest } from "../../../runtime/layers/clock.ts";
import { AppConfig } from "../../../runtime/services/app-config.ts";
import { PersistenceDuplicateKeyError } from "../../../errors/families.ts";

const USER_ID = new ObjectId();
const ORG_ID = new ObjectId();
const ORG2_ID = new ObjectId();
const NOW = new Date();
const JWT_SECRET = "org-operations-test-secret-32ch!";


function membership(over: Partial<MembershipDoc> = {}): MembershipDoc {
  return {
    organizationId: ORG_ID,
    role: "admin",
    permissions: [],
    ...over,
  };
}

function userDoc(over: Partial<UserDoc> = {}): UserDoc {
  return {
    _id: USER_ID,
    username: "alice",
    email: "alice@example.com",
    passwordHash: "hash",
    memberships: [membership()],
    activeOrganizationId: ORG_ID,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function orgDoc(
  over: Partial<Omit<OrganizationDoc, "_id" | "ownerId">> & {
    _id?: ObjectId;
    ownerId?: ObjectId;
  } = {},
): OrganizationDoc {
  return {
    _id: over._id ?? ORG_ID,
    name: over.name ?? "default",
    slug: over.slug ?? "default",
    ownerId: over.ownerId ?? USER_ID,
    defaultCurrency: over.defaultCurrency ?? "USD",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function dupError(): PersistenceDuplicateKeyError {
  return new PersistenceDuplicateKeyError({
    code: "persistence_duplicate_key",
    message: "dup",
    retryClass: "never",
  });
}

function orgStore(opts?: {
  readonly slugTaken?: boolean | ((slug: string) => boolean);
  readonly insertError?: PersistenceDuplicateKeyError;
  readonly insertResult?: OrganizationDoc | null;
  readonly updateResult?: OrganizationDoc | null;
}) {
  const slugChecks: string[] = [];
  const insertRecords: unknown[] = [];
  const addedMemberships: [string, string, string, boolean][] = [];
  const updates: unknown[] = [];
  const taken = opts?.slugTaken ?? false;
  const service: OrganizationRepositoryService = {
    insert: (record: NewOrganizationRecord) =>
      Effect.suspend(() => {
        insertRecords.push(record);
        if (opts?.insertError) return Effect.fail(opts.insertError);
        if (opts?.insertResult !== undefined) {
          if (opts.insertResult === null) return Effect.die(new Error("no doc"));
          return Effect.succeed(opts.insertResult);
        }
        return Effect.succeed(orgDoc({ name: record.name, slug: record.slug }));
      }),
    findById: (id: string) =>
      Effect.sync(() =>
        id === ORG_ID.toHexString() ? orgDoc() : null,
      ),
    findByIds: (ids: readonly string[]) =>
      Effect.sync(() =>
        ids
          .filter((id) => id === ORG_ID.toHexString())
          .map(() => orgDoc()),
      ),
    slugTaken: (slug: string, _exclude?: string) =>
      Effect.sync(() => {
        slugChecks.push(slug);
        return typeof taken === "function" ? taken(slug) : taken;
      }),
    update: (id: string, patch: Record<string, unknown>) =>
      Effect.sync(() => {
        updates.push({ id, patch });
        if (opts?.updateResult !== undefined) return opts.updateResult;
        return orgDoc({
          ...(typeof patch.name === "string" ? { name: patch.name } : {}),
          ...(typeof patch.slug === "string" ? { slug: patch.slug } : {}),
        });
      }),
  } as unknown as OrganizationRepositoryService;
  return {
    slugChecks,
    insertRecords,
    addedMemberships,
    updates,
    layer: Layer.succeed(OrganizationRepository, service),
  };
}

const usersLayer = Layer.succeed(UserRepository, {
  addMembership: (userId: string, orgId: string, role: string, makeActive: boolean) =>
    Effect.sync(() => {
      void userId;
      void orgId;
      void role;
      void makeActive;
      return userDoc();
    }),
} as unknown as UserRepositoryService);

function sessionLayer() {
  const touched: { sessionId: string; orgId?: string | undefined }[] = [];
  const service: SessionRepositoryService = {
    insert: (record: NewAdminSessionRecord) =>
      Effect.sync(() => ({
        _id: new ObjectId(),
        userId: new ObjectId(record.userId),
        organizationId: new ObjectId(record.organizationId),
        expiresAt: record.expiresAt,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    touchExpiry: (
      sessionId: string,
      _userId: string,
      _expiresAt: Date,
      organizationId?: string,
    ) =>
      Effect.sync(() => {
        touched.push({ sessionId, orgId: organizationId });
        return null;
      }),
  } as unknown as SessionRepositoryService;
  return { touched, layer: Layer.succeed(SessionRepository, service) };
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

async function run<E, A>(
  program: Effect.Effect<A, E, never>,
): Promise<{ tag: "Right"; value: A } | { tag: "Left"; error: E }> {
  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === "Success") return { tag: "Right", value: exit.value };
  if (exit.cause._tag === "Fail") return { tag: "Left", error: exit.cause.error };
  throw new Error(`unexpected non-fail cause: ${exit.cause._tag}`);
}

test("toOrganizationView maps doc to ISO view; role included only when provided", () => {
  const doc = orgDoc();
  const withRole = toOrganizationView(doc, "admin");
  expect(withRole.id).toBe(ORG_ID.toHexString());
  expect(withRole.ownerId).toBe(USER_ID.toHexString());
  expect(withRole.role).toBe("admin");
  expect(withRole.createdAt).toBe(NOW.toISOString());
  const noRole = toOrganizationView(doc);
  expect("role" in noRole).toBe(false);
});

test("deriveSlug lowercases, hyphenates, trims; falls back to org", () => {
  expect(deriveSlug("  Acme Corp!  ")).toBe("acme-corp");
  expect(deriveSlug("!!!")).toBe("org");
  expect(deriveSlug("MiXeD CaSe_123")).toBe("mixed-case-123");
});

test("listOrganizationsForUser maps memberships to views with roles", async () => {
  const orgs = orgStore();
  const user = userDoc({
    memberships: [
      membership(),
      membership({ organizationId: ORG2_ID, role: "member" }),
    ],
  });
  const result = await run(
    listOrganizationsForUser(user, ORG_ID.toHexString()).pipe(
      Effect.provide(orgs.layer),
    ),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.activeOrganizationId).toBe(ORG_ID.toHexString());
  expect(result.value.items).toHaveLength(1); // only ORG_ID doc exists in fake
  expect(result.value.items[0]?.role).toBe("admin");
});

test("createOrganization derives slug, inserts, adds admin membership, issues JWT", async () => {
  const orgs = orgStore();
  const { layer: sessions } = sessionLayer();
  const result = await run(
    createOrganization({
      userId: USER_ID.toHexString(),
      name: "Acme Corp",
      sessionId: "session-1",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(orgs.layer, usersLayer, sessions, CryptoTest, ClockTest, configLayer),
      ),
    ),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.organization.slug).toBe("acme-corp");
  expect(result.value.organization.role).toBe("admin");
  expect(result.value.token.split(".")).toHaveLength(3);
  expect(orgs.slugChecks).toEqual(["acme-corp"]);
  expect(orgs.insertRecords).toHaveLength(1);
  const inserted = orgs.insertRecords[0] as { defaultCurrency: string };
  expect(inserted.defaultCurrency).toBe("USD");
});

test("createOrganization: explicit slug respected; collision suffix appended", async () => {
  const orgs = orgStore({ slugTaken: (slug) => slug === "custom" });
  const { layer: sessions } = sessionLayer();
  const result = await run(
    createOrganization({
      userId: USER_ID.toHexString(),
      name: "Anything",
      slug: "custom",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(orgs.layer, usersLayer, sessions, CryptoTest, ClockTest, configLayer),
      ),
    ),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.organization.slug.startsWith("custom-")).toBe(true);
  expect(result.value.organization.slug).not.toBe("custom");
});

test("createOrganization: duplicate insert → organization_creation_failed", async () => {
  const orgs = orgStore({ insertError: dupError() });
  const { layer: sessions } = sessionLayer();
  const result = await run(
    createOrganization({
      userId: USER_ID.toHexString(),
      name: "Acme Corp",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(orgs.layer, usersLayer, sessions, CryptoTest, ClockTest, configLayer),
      ),
    ),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("ConflictError");
  expect(result.error.code).toBe("organization_creation_failed");
});

test("getOrganization: non-member → not_found BEFORE repository call", async () => {
  const orgs = orgStore();
  const outsider = userDoc({
    memberships: [membership({ organizationId: ORG2_ID })],
  });
  const result = await run(
    getOrganization({
      user: outsider,
      organizationId: ORG_ID.toHexString(),
    }).pipe(Effect.provide(orgs.layer)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error.code).toBe("not_found");
  expect(result.error._tag).toBe("NotFoundError");
  if (result.error._tag !== "NotFoundError") return;
  expect(result.error.resource).toBe("organization");
  expect(orgs.updates).toHaveLength(0);
  expect(orgs.slugChecks).toHaveLength(0);
});

test("getOrganization: member + missing doc → not_found from repository", async () => {
  const orgs = orgStore();
  const ghost = new ObjectId();
  const result = await run(
    getOrganization({
      user: userDoc(),
      organizationId: ghost.toHexString(),
    }).pipe(Effect.provide(orgs.layer)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error.code).toBe("not_found");
});

test("updateOrganization: member without organization:write → forbidden missing_permission", async () => {
  const orgs = orgStore();
  const member = userDoc({
    memberships: [
      membership({ role: "member", permissions: ["balances:read"] }),
    ],
  });
  const result = await run(
    updateOrganization({
      user: member,
      organizationId: ORG_ID.toHexString(),
      patch: { name: "Renamed" },
    }).pipe(Effect.provide(orgs.layer)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthorizationError");
  if (result.error._tag !== "AuthorizationError") return;
  expect(result.error.reason).toBe("missing_permission");
  expect(result.error.scope).toBe("organization:write");
  expect(orgs.updates).toHaveLength(0);
});

test("updateOrganization: admin renames; slug conflict → slug_taken", async () => {
  const orgs = orgStore({ slugTaken: (slug) => slug === "taken-slug" });
  const ok = await run(
    updateOrganization({
      user: userDoc(),
      organizationId: ORG_ID.toHexString(),
      patch: { name: "Renamed" },
    }).pipe(Effect.provide(orgs.layer)),
  );
  expect(ok.tag).toBe("Right");
  if (ok.tag === "Right") expect(ok.value.name).toBe("Renamed");
  const updatesAfterRename = orgs.updates.length;

  const bad = await run(
    updateOrganization({
      user: userDoc(),
      organizationId: ORG_ID.toHexString(),
      patch: { slug: "taken-slug" },
    }).pipe(Effect.provide(orgs.layer)),
  );
  expect(bad.tag).toBe("Left");
  if (bad.tag !== "Left") return;
  expect(bad.error.code).toBe("slug_taken");
  expect(bad.error._tag).toBe("ConflictError");
  if (bad.error._tag !== "ConflictError") return;
  expect(bad.error.fields).toEqual(["slug"]);
  expect(orgs.updates).toHaveLength(updatesAfterRename);
});

test("updateOrganization: null update → not_found", async () => {
  const orgs = orgStore({ updateResult: null });
  const result = await run(
    updateOrganization({
      user: userDoc(),
      organizationId: ORG_ID.toHexString(),
      patch: { name: "Renamed" },
    }).pipe(Effect.provide(orgs.layer)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("NotFoundError");
  if (result.error._tag !== "NotFoundError") return;
  expect(result.error.resource).toBe("organization");
});
