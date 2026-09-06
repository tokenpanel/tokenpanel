/**
 * Live HTTP round-trips for the admin CRUD surfaces against the in-memory
 * replica set: organizations, models, subscription plans, api keys.
 *
 * Harness: real Mongo (memory replset) + makeAppTestLayer → createAppRuntime
 * install → Hono app.route(admin routers) → app.request with a signed admin
 * JWT (seeded user + admin_sessions row), mirroring customers.test.ts.
 * Every response status is a real status code; every "persisted" claim is
 * asserted against stored Mongo rows via the typed db handle (logical key →
 * physical collection, e.g. apiKeys → api_keys).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { ObjectId } from "mongodb";
import { Hono } from "hono";
import { Layer } from "effect";
import {
  getDb,
  getClient,
  type TypedDb,
} from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "@tokenpanel/db/test-support/memory-server";
import {
  customerFixture,
  providerFixture,
} from "@tokenpanel/db/test-support/persistence-fixtures";
import type { AuthVariables } from "../../middleware/auth.ts";
import {
  requirePublicPrincipal,
  type PublicAuthVariables,
} from "../../middleware/public-auth.ts";
import { apiKeyThrottle } from "../../lib/throttle.ts";
import {
  clearAppRuntimeSingleton,
  createAppRuntime,
  disposeAppRuntime,
} from "../../runtime/app-runtime.ts";
import {
  makeAppTestLayer,
  makeTestConfig,
} from "../../runtime/layers/test.ts";
import type { AppServices } from "../../runtime/layers/live.ts";
import { signJwt } from "../../lib/crypto.ts";
import organizationRoutes from "../organizations.ts";
import { createModelRoutes } from "../models.ts";
import plansApp from "../plans.ts";
import apiKeysApp from "../api-keys.ts";

const TEST_DB = "tokenpanel_admin_crud_test";
const JWT_SECRET = "admin-crud-test-secret-32-chars-min!!";

const RESET_COLLECTIONS = [
  "organizations",
  "users",
  "adminSessions",
  "customers",
  "providers",
  "models",
  "subscriptionPlans",
  "apiKeys",
] as const;

// Stable auth triangle ids: re-seeded before every test so the token signed
// in beforeAll stays valid across per-test resets.
const orgId = new ObjectId();
const userId = new ObjectId();
const sessionId = new ObjectId();
const customerId = new ObjectId();
const providerId = new ObjectId();

const orgIdHex = orgId.toHexString();
const userIdHex = userId.toHexString();
const customerHex = customerId.toHexString();
const providerHex = providerId.toHexString();

let handle: TestDbHandle | null = null;
let db: TypedDb | null = null;
let adminToken = "";
let adminApp: Hono<{ Variables: AuthVariables }> | null = null;
let publicApp: Hono<{ Variables: PublicAuthVariables }> | null = null;

async function seedBaseRows(): Promise<void> {
  const now = new Date();
  await db!.organizations.insertOne({
    _id: orgId,
    name: "Base Org",
    slug: "base-org",
    ownerId: userId,
    // EUR on purpose: plan creation must resolve currency from the org.
    defaultCurrency: "EUR",
    createdAt: now,
    updatedAt: now,
  });
  await db!.users.insertOne({
    _id: userId,
    memberships: [{ organizationId: orgId, role: "admin", permissions: [] }],
    activeOrganizationId: orgId,
    username: "crud-admin",
    email: "crud-admin@example.com",
    passwordHash: "x",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db!.adminSessions.insertOne({
    _id: sessionId,
    userId,
    organizationId: orgId,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: now,
    updatedAt: now,
  });
  await db!.customers.insertOne(
    customerFixture({ _id: customerId, organizationId: orgId }),
  );
  await db!.providers.insertOne(
    providerFixture({ _id: providerId, organizationId: orgId }),
  );
}

/** Admin-surface request with the signed JWT; optional JSON body. */
async function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = adminToken,
): Promise<Response> {
  return adminApp!.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Probe for customer-key usage: public auth, then a trivial handler. */
async function probeUseKey(key: string): Promise<Response> {
  return publicApp!.request("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
}

beforeAll(async () => {
  handle = await startTestDb({ databaseName: TEST_DB });
  // The apiKey throttle is a process-wide singleton keyed by client IP;
  // clear it so sibling test files cannot lock this suite out at the gate.
  apiKeyThrottle.clear();
  db = await getDb();

  adminToken = signJwt(
    {
      sub: userIdHex,
      orgId: orgIdHex,
      role: "admin",
      sid: sessionId.toHexString(),
    },
    JWT_SECRET,
    600,
  );

  const config = makeTestConfig({
    jwtSecret: JWT_SECRET,
    database: { uri: handle.uri, name: TEST_DB },
  });
  // Full AppServices graph with the harness' real Mongo handles (see
  // customers.test.ts: the declared MongoUnavailableError channel is dead).
  const layer = makeAppTestLayer({
    config,
    mongo: { db, client: getClient(), rawDb: handle.rawDb },
  }) as Layer.Layer<AppServices, never, never>;
  createAppRuntime(layer, { install: true });

  adminApp = new Hono<{ Variables: AuthVariables }>();
  adminApp.route("/v1/admin/organizations", organizationRoutes);
  adminApp.route("/v1/admin/models", createModelRoutes());
  adminApp.route("/v1/admin/plans", plansApp);
  adminApp.route("/v1/admin/api-keys", apiKeysApp);

  publicApp = new Hono<{ Variables: PublicAuthVariables }>();
  publicApp.use("/v1/*", requirePublicPrincipal);
  publicApp.post("/v1/chat/completions", (c) => c.json({ ok: true }, 200));
}, TEST_DB_START_TIMEOUT_MS);

beforeEach(async () => {
  await resetTestCollections(...RESET_COLLECTIONS);
  await seedBaseRows();
});

afterAll(async () => {
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
  await resetTestCollections(...RESET_COLLECTIONS);
  await stopTestDb();
});

describe("organizations CRUD (live HTTP)", () => {
  test("create → list → update persists org rows and moves the session", async () => {
    // Before create the user belongs to the base org only.
    const beforeList = await req("GET", "/v1/admin/organizations");
    expect(beforeList.status).toBe(200);
    const before = (await beforeList.json()) as {
      items: { id: string; role?: string | null }[];
      activeOrganizationId: string;
    };
    expect(before.items.map((i) => i.id)).toEqual([orgIdHex]);
    expect(before.activeOrganizationId).toBe(orgIdHex);

    const created = await req("POST", "/v1/admin/organizations", {
      name: "Foo Inc",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      organization: {
        id: string;
        name: string;
        slug: string;
        ownerId: string;
        defaultCurrency: string;
        role?: string | null;
      };
      token: string;
    };
    const createdHex = createdBody.organization.id;
    expect(createdHex).not.toBe(orgIdHex);
    expect(createdBody.organization.name).toBe("Foo Inc");
    expect(createdBody.organization.slug).toBe("foo-inc");
    expect(createdBody.organization.ownerId).toBe(userIdHex);
    // No currency sent → schema default, independent of the base org's EUR.
    expect(createdBody.organization.defaultCurrency).toBe("USD");
    expect(createdBody.organization.role).toBe("admin");
    expect(createdBody.token.length).toBeGreaterThan(0);

    // Persisted row.
    const rawOrg = await db!.organizations.findOne({
      _id: new ObjectId(createdHex),
    });
    expect(rawOrg).not.toBeNull();
    expect(rawOrg!.name).toBe("Foo Inc");
    expect(rawOrg!.slug).toBe("foo-inc");

    // The response token is bound to the NEW org (the session moved);
    // the old admin token no longer matches the session's organizationId.
    const stale = await req("GET", "/v1/admin/organizations");
    expect(stale.status).toBe(401);

    const listRes = await req(
      "GET",
      "/v1/admin/organizations",
      undefined,
      createdBody.token,
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      items: { id: string }[];
      activeOrganizationId: string;
    };
    expect(list.items.map((i) => i.id).sort()).toEqual(
      [orgIdHex, createdHex].sort(),
    );
    expect(list.activeOrganizationId).toBe(createdHex);

    const patched = await req(
      "PATCH",
      `/v1/admin/organizations/${createdHex}`,
      { name: "Foo Renamed", defaultCurrency: "GBP" },
      createdBody.token,
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      name: string;
      slug: string;
      defaultCurrency: string;
    };
    expect(patchedBody.name).toBe("Foo Renamed");
    expect(patchedBody.defaultCurrency).toBe("GBP");
    expect(patchedBody.slug).toBe("foo-inc");

    const rawPatched = await db!.organizations.findOne({
      _id: new ObjectId(createdHex),
    });
    expect(rawPatched).not.toBeNull();
    expect(rawPatched!.name).toBe("Foo Renamed");
    expect(rawPatched!.defaultCurrency).toBe("GBP");
    expect(rawPatched!.slug).toBe("foo-inc");
  });
});

describe("models CRUD (live HTTP)", () => {
  const validCreateBody = () => ({
    aliasId: "gpt-x",
    displayName: "GPT X",
    entries: [{ providerId: providerHex, upstreamModelId: "gpt-4o" }],
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputMicrosPerMillion: 300, outputMicrosPerMillion: 600 },
    status: "ga",
    currency: "USD",
  });

  test("create with unknown provider id → 400 provider_not_found, nothing stored", async () => {
    const res = await req("POST", "/v1/admin/models", {
      ...validCreateBody(),
      aliasId: "ghost",
      entries: [
        { providerId: new ObjectId().toHexString(), upstreamModelId: "x" },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "provider_not_found" });
    expect(await db!.models.countDocuments({})).toBe(0);
  });

  test("create → list → update replaces entries in place", async () => {
    const created = await req("POST", "/v1/admin/models", validCreateBody());
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      _id: string;
      aliasId: string;
      displayName: string;
      entries: {
        id: string;
        providerId: string;
        upstreamModelId: string;
        priority: number;
        active: boolean;
      }[];
      price: { inputMicrosPerMillion: number; outputMicrosPerMillion: number };
      marginBps: number;
      status?: string;
      currency: string;
    };
    const modelHex = body._id;
    expect(modelHex).toMatch(/^[0-9a-f]{24}$/);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.providerId).toBe(providerHex);
    expect(body.entries[0]!.upstreamModelId).toBe("gpt-4o");
    expect(body.entries[0]!.priority).toBe(0);
    expect(body.entries[0]!.active).toBe(true);
    expect(body.entries[0]!.id).toMatch(/^[0-9a-f]{12}$/);
    expect(body.price).toEqual({
      inputMicrosPerMillion: 300,
      outputMicrosPerMillion: 600,
    });
    expect(body.marginBps).toBe(0);
    expect(body.status).toBe("ga");
    expect(body.currency).toBe("USD");

    const rawCreated = await db!.models.findOne({
      _id: new ObjectId(modelHex),
    });
    expect(rawCreated).not.toBeNull();
    expect(rawCreated!.aliasId).toBe("gpt-x");

    const listRes = await req("GET", "/v1/admin/models");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: { _id: string }[] };
    expect(list.items.map((m) => m._id)).toContain(modelHex);

    // Entries replace (not append): one new entry swaps out the old one.
    const patched = await req("PATCH", `/v1/admin/models/${modelHex}`, {
      displayName: "GPT X Renamed",
      entries: [
        {
          id: "repl-a",
          providerId: providerHex,
          upstreamModelId: "claude-x",
          priority: 5,
        },
      ],
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      displayName: string;
      entries: {
        id: string;
        upstreamModelId: string;
        priority: number;
      }[];
    };
    expect(patchedBody.displayName).toBe("GPT X Renamed");
    expect(patchedBody.entries).toHaveLength(1);
    expect(patchedBody.entries[0]!.id).toBe("repl-a");
    expect(patchedBody.entries[0]!.upstreamModelId).toBe("claude-x");
    expect(patchedBody.entries[0]!.priority).toBe(5);

    const rawPatched = await db!.models.findOne({
      _id: new ObjectId(modelHex),
    });
    expect(rawPatched).not.toBeNull();
    expect(rawPatched!.displayName).toBe("GPT X Renamed");
    expect(rawPatched!.entries).toHaveLength(1);
    expect(rawPatched!.entries[0]!.id).toBe("repl-a");
    expect(rawPatched!.entries[0]!.upstreamModelId).toBe("claude-x");
    expect(rawPatched!.entries[0]!.priority).toBe(5);
  });
});

describe("subscription plans CRUD (live HTTP)", () => {
  test("create → list → update → deactivate", async () => {
    // Unknown plan id up front: not_found, nothing created.
    const missing = await req(
      "DELETE",
      `/v1/admin/plans/${new ObjectId().toHexString()}`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    // price.currency is organization-owned: the base org is EUR, so the
    // stored plan currency is resolved from the org despite the "USD" body.
    const created = await req("POST", "/v1/admin/plans", {
      name: "Pro",
      price: { amountMicros: 2_000_000, currency: "USD" },
      interval: "month",
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      _id: string;
      name: string;
      price: { amountMicros: number; currency: string };
      interval: string;
      intervalCount: number;
      includedCredit: { amountMicros: number; currency: string };
      includedTokens: number;
      rateLimits: unknown[];
      active: boolean;
    };
    const planHex = body._id;
    expect(planHex).toMatch(/^[0-9a-f]{24}$/);
    expect(body.name).toBe("Pro");
    expect(body.price).toEqual({ amountMicros: 2_000_000, currency: "EUR" });
    expect(body.interval).toBe("month");
    expect(body.intervalCount).toBe(1);
    expect(body.includedCredit).toEqual({ amountMicros: 0, currency: "EUR" });
    expect(body.includedTokens).toBe(0);
    expect(body.rateLimits).toEqual([]);
    expect(body.active).toBe(true);

    const rawCreated = await db!.subscriptionPlans.findOne({
      _id: new ObjectId(planHex),
    });
    expect(rawCreated).not.toBeNull();
    expect(rawCreated!.price).toEqual({
      amountMicros: 2_000_000,
      currency: "EUR",
    });

    const listRes = await req("GET", "/v1/admin/plans");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: { _id: string }[] };
    expect(list.items.map((p) => p._id)).toContain(planHex);

    // Amount updates, currency stays stamped to the org currency even when
    // the request body claims USD.
    const patched = await req("PATCH", `/v1/admin/plans/${planHex}`, {
      name: "Pro Plus",
      price: { amountMicros: 3_000_000, currency: "USD" },
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      name: string;
      price: { amountMicros: number; currency: string };
    };
    expect(patchedBody.name).toBe("Pro Plus");
    expect(patchedBody.price).toEqual({
      amountMicros: 3_000_000,
      currency: "EUR",
    });

    // DELETE is a soft deactivate.
    const deactivated = await req("DELETE", `/v1/admin/plans/${planHex}`);
    expect(deactivated.status).toBe(200);
    expect(await deactivated.json()).toEqual({ ok: true });

    const rawDeactivated = await db!.subscriptionPlans.findOne({
      _id: new ObjectId(planHex),
    });
    expect(rawDeactivated).not.toBeNull();
    expect(rawDeactivated!.active).toBe(false);
    expect(rawDeactivated!.name).toBe("Pro Plus");
  });
});

describe("api keys issue/list/revoke (live HTTP)", () => {
  test("issue → list → use → revoke → use rejected, all states persisted", async () => {
    // Foreign key first: issuing for an unknown customer fails 404 without
    // leaving a row behind.
    const missing = await req("POST", "/v1/admin/api-keys", {
      customerId: new ObjectId().toHexString(),
      name: "ghost-key",
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "customer_not_found" });
    expect(await db!.apiKeys.countDocuments({})).toBe(0);

    const issued = await req("POST", "/v1/admin/api-keys", {
      customerId: customerHex,
      name: "ci-key",
    });
    expect(issued.status).toBe(201);
    const issuedBody = (await issued.json()) as {
      apiKey: {
        _id: string;
        name: string;
        prefix: string;
        status: string;
        hasKey: boolean;
        keyHash?: string;
      };
      key: string;
    };
    const keyHex = issuedBody.apiKey._id;
    const plaintextKey = issuedBody.key;
    expect(keyHex).toMatch(/^[0-9a-f]{24}$/);
    expect(issuedBody.apiKey.name).toBe("ci-key");
    expect(issuedBody.apiKey.status).toBe("active");
    expect(issuedBody.apiKey.hasKey).toBe(true);
    expect("keyHash" in issuedBody.apiKey).toBe(false);
    expect(issuedBody.apiKey.prefix).toMatch(/^tp_live_[0-9a-f]{8}$/);
    expect(plaintextKey.startsWith(issuedBody.apiKey.prefix)).toBe(true);
    expect(plaintextKey.length).toBeGreaterThan(16);

    // Persisted row stores a hash, never the plaintext.
    const rawIssued = await db!.apiKeys.findOne({
      _id: new ObjectId(keyHex),
    });
    expect(rawIssued).not.toBeNull();
    expect(rawIssued!.status).toBe("active");
    expect(rawIssued!.customerId.toHexString()).toBe(customerHex);
    const storedHash = rawIssued!.keyHash;
    expect(storedHash.length).toBeGreaterThan(0);
    expect(storedHash).not.toBe(plaintextKey);

    // List exposes metadata but neither plaintext nor hash.
    const listRes = await req(
      "GET",
      `/v1/admin/api-keys?customerId=${customerHex}`,
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText.includes(plaintextKey)).toBe(false);
    expect(listText.includes("keyHash")).toBe(false);
    const list = JSON.parse(listText) as {
      items: { _id: string; status: string; hasKey: boolean }[];
      total: number;
    };
    expect(list.total).toBe(1);
    expect(list.items[0]!._id).toBe(keyHex);
    expect(list.items[0]!.status).toBe("active");
    expect(list.items[0]!.hasKey).toBe(true);

    // Active key resolves a principal on the public surface (probe 200).
    const before = await probeUseKey(plaintextKey);
    expect(before.status).toBe(200);

    const revoked = await req("DELETE", `/v1/admin/api-keys/${keyHex}`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true, status: "revoked" });

    // Soft revoke: row remains, status flipped.
    const rawRevoked = await db!.apiKeys.findOne({
      _id: new ObjectId(keyHex),
    });
    expect(rawRevoked).not.toBeNull();
    expect(rawRevoked!.status).toBe("revoked");

    // GET by id still resolves it — with revoked status.
    const fetched = await req("GET", `/v1/admin/api-keys/${keyHex}`);
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as { status: string };
    expect(fetchedBody.status).toBe("revoked");

    // List keeps the row (no hard delete) and reports revoked status.
    const afterList = await req("GET", "/v1/admin/api-keys");
    expect(afterList.status).toBe(200);
    const afterListBody = (await afterList.json()) as {
      items: { _id: string; status: string }[];
      total: number;
    };
    expect(afterListBody.total).toBe(1);
    expect(afterListBody.items[0]!._id).toBe(keyHex);
    expect(afterListBody.items[0]!.status).toBe("revoked");

    // The same plaintext now fails auth on the public surface.
    const after = await probeUseKey(plaintextKey);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "unauthorized" });
  });
});
