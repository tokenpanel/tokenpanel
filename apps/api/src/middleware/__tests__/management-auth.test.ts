/**
 * Integration tests for the management-auth middleware:
 *
 *   requirePublicPrincipal → requireManagementPrincipal → requireManagementScope
 *
 * Driven over real Hono apps via app.request with the app runtime installed
 * (runMiddlewareEffect resolves the process singleton). Credential resolution
 * hits the in-memory Mongo harness: ManagementApiKeys rows carry real Date
 * TimestampFields and a real hashToken() of the presented key, mirroring
 * domains/keys/operations.ts issueManagementKey (tp_mgmt_ literal + 24 random
 * bytes, sha256 of the full key).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { Layer } from "effect";
import type {
  ManagementApiKeyDoc,
  ManagementScope,
} from "@tokenpanel/db";
import {
  collections,
  getDb,
  getClient,
  getRawDb,
} from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "@tokenpanel/db/test-support/memory-server";
import {
  apiKeyFixture,
  customerFixture,
  managementApiKeyFixture,
  organizationFixture,
} from "@tokenpanel/db/test-support/persistence-fixtures";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  API_KEY_SECRET_BYTES,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../../config/security-policy.ts";
import { hashToken, randomToken } from "../../lib/crypto.ts";
import { apiKeyThrottle } from "../../lib/throttle.ts";
import {
  requireManagementPrincipal,
  requireManagementScope,
  type ManagementAuthVariables,
} from "../management-auth.ts";
import { requirePublicPrincipal } from "../public-auth.ts";
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

const TEST_DB = "tokenpanel_mgmt_auth_test";
const DB_START_TIMEOUT = TEST_DB_START_TIMEOUT_MS;

type Env = { Variables: ManagementAuthVariables };

/** Issue key material exactly like domains/keys/operations.ts issueManagementKey. */
function issuedManagementKey(input: {
  organizationId: ObjectId;
  scopes: readonly ManagementScope[];
  status: "active" | "revoked";
}): { key: string; doc: ManagementApiKeyDoc } {
  const key = `${MANAGEMENT_KEY_PREFIX_LITERAL}${randomToken(API_KEY_SECRET_BYTES)}`;
  const doc = managementApiKeyFixture({
    _id: new ObjectId(),
    organizationId: input.organizationId,
    name: "s2s",
    prefix: key.slice(0, API_KEY_LOOKUP_PREFIX_CHARS),
    keyHash: hashToken(key),
    scopes: [...input.scopes],
    status: input.status,
    lastUsedAt: null,
  });
  return { key, doc };
}

function get(
  app: Hono<Env>,
  path: string,
  key?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (key !== undefined) headers.Authorization = `Bearer ${key}`;
  return Promise.resolve(app.request(path, { headers }));
}

let handle: TestDbHandle | null = null;
const orgId = new ObjectId();
let activeKey = "";
let activeKeyIdHex = "";
let revokedKey = "";

// Full chain under test: public principal resolution → management narrowing
// → optional per-route scope gate.
let chainApp: Hono<Env>;
// requireManagementPrincipal alone (nothing upstream sets a principal).
let bareApp: Hono<Env>;
// Upstream stub injects a customer-key principal (enumeration-safety probe).
let customerKeyApp: Hono<Env>;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: TEST_DB });
  await resetTestCollections("managementApiKeys", "organizations");

  const db = getRawDb();
  await db
    .collection("organizations")
    .insertOne(
      organizationFixture({
        _id: orgId,
        slug: "mgmt-auth-test",
        ownerId: new ObjectId(),
      }) as never,
    );

  const active = issuedManagementKey({
    organizationId: orgId,
    scopes: ["models:read"],
    status: "active",
  });
  const revoked = issuedManagementKey({
    organizationId: orgId,
    scopes: ["models:read"],
    status: "revoked",
  });
  activeKey = active.key;
  activeKeyIdHex = active.doc._id.toHexString();
  revokedKey = revoked.key;
  await db
    .collection(collections.managementApiKeys)
    .insertMany([active.doc, revoked.doc] as never[]);
  const config = makeTestConfig({
    database: { uri: handle.uri, name: TEST_DB },
  });
  // Full AppServices test graph with real Mongo handles injected. The declared
  // MongoUnavailableError channel is dead in practice (Mongo is already
  // connected via the harness singleton); createAppRuntime requires a never
  // error channel, so assert it away.
  const layer = makeAppTestLayer({
    config,
    mongo: { db: await getDb(), client: getClient(), rawDb: getRawDb() },
  }) as Layer.Layer<AppServices, never, never>;
  createAppRuntime(layer, { install: true });

  chainApp = new Hono<Env>();
  chainApp.use("/api/management/*", requirePublicPrincipal);
  chainApp.use("/api/management/*", requireManagementPrincipal);
  chainApp.get("/api/management/whoami", (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "management") {
      return c.json({ kind: principal.kind }, 500);
    }
    return c.json({
      kind: principal.kind,
      orgId: c.get("orgId").toHexString(),
      keyId: principal.managementKey._id.toHexString(),
      name: principal.managementKey.name,
    });
  });
  chainApp.get(
    "/api/management/models",
    requireManagementScope("models:read"),
    (c) => c.json({ ok: true }),
  );
  chainApp.get(
    "/api/management/customers",
    requireManagementScope("customers:read"),
    (c) => c.json({ ok: true }),
  );

  bareApp = new Hono<Env>();
  bareApp.use("/api/management/*", requireManagementPrincipal);
  bareApp.get("/api/management/whoami", (c) => c.json({ ok: true }));

  customerKeyApp = new Hono<Env>();
  customerKeyApp.use("/api/management/*", async (c, next) => {
    c.set("principal", {
      kind: "customer",
      orgId,
      customer: customerFixture({
        _id: new ObjectId(),
        organizationId: orgId,
      }),
      apiKey: apiKeyFixture({
        _id: new ObjectId(),
        organizationId: orgId,
      }),
    });
    await next();
  });
  customerKeyApp.use("/api/management/*", requireManagementPrincipal);
  customerKeyApp.get("/api/management/whoami", (c) => c.json({ ok: true }));
}, DB_START_TIMEOUT);
afterAll(async () => {
  // requirePublicPrincipal fires the lastUsedAt touch as a detached fiber —
  // the promise is internal to the middleware, so the only observable signal
  // is the DB write itself. Wait for it (bounded) before disposing the runtime
  // so the fiber cannot be interrupted mid-write and reject unhandled.
  const prefix = activeKey.slice(0, API_KEY_LOOKUP_PREFIX_CHARS);
  for (let i = 0; i < 200; i++) {
    const touched = await getRawDb()
      .collection(collections.managementApiKeys)
      .findOne({ prefix, lastUsedAt: { $type: "date" } });
    if (touched !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await disposeAppRuntime().catch(() => undefined);
  clearAppRuntimeSingleton();
  await resetTestCollections("managementApiKeys", "organizations");
  await stopTestDb();
});

beforeEach(() => {
  apiKeyThrottle.clear();
});

// ---------------------------------------------------------------------------
// requireManagementPrincipal in isolation (no upstream public-auth).
// ---------------------------------------------------------------------------

test("requireManagementPrincipal: no principal set → 401, handler not reached", async () => {
  const res = await get(bareApp, "/api/management/whoami");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("requireManagementPrincipal: customer-key principal → 401 (enumeration-safe), handler not reached", async () => {
  const res = await get(customerKeyApp, "/api/management/whoami");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("missing credential: no Authorization header, X-API-Key alone is ignored → 401", async () => {
  const res = await chainApp.request("/api/management/whoami", {
    headers: { "X-API-Key": activeKey },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("invalid credential: wrong auth scheme → 401", async () => {
  const res = await chainApp.request("/api/management/whoami", {
    headers: { Authorization: `Basic ${activeKey}` },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("invalid credential: bearer token with unclassifiable prefix → 401", async () => {
  const res = await chainApp.request("/api/management/whoami", {
    headers: { Authorization: "Bearer garbage-not-a-key" },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("unknown management key (well-formed tp_mgmt_ token, absent from store) → 401", async () => {
  const unknown = `${MANAGEMENT_KEY_PREFIX_LITERAL}${randomToken(API_KEY_SECRET_BYTES)}`;
  const res = await get(chainApp, "/api/management/whoami", unknown);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("revoked management key → 401 even though the hash matches", async () => {
  const res = await get(chainApp, "/api/management/whoami", revokedKey);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

// ---------------------------------------------------------------------------
// Valid key reaches handlers carrying the management principal context.
// ---------------------------------------------------------------------------

test("valid management key → handler reached with management principal context", async () => {
  const res = await get(chainApp, "/api/management/whoami", activeKey);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    kind: "management",
    orgId: orgId.toHexString(),
    keyId: activeKeyIdHex,
    name: "s2s",
  });
});

test("requireManagementScope: held scope → 200", async () => {
  const res = await get(chainApp, "/api/management/models", activeKey);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("requireManagementScope: unheld scope → 403 missing_scope", async () => {
  const res = await get(chainApp, "/api/management/customers", activeKey);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: "forbidden",
    reason: "missing_scope",
  });
});
