import {
  afterAll,
  beforeAll,
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
  getRawDb,
} from "@tokenpanel/db";
import {
  TEST_DB_START_TIMEOUT_MS,
  resetTestCollections,
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "@tokenpanel/db/test-support/memory-server";
import type { AuthVariables } from "../../middleware/auth.ts";
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
import { parseObjectIdParam, addInterval } from "../customers.ts";
import customersApp from "../customers.ts";

test("parseObjectIdParam: valid ObjectId → ObjectId", () => {
  const hex = new ObjectId().toHexString();
  const r = parseObjectIdParam(hex);
  expect(r).toBeInstanceOf(ObjectId);
  expect(r?.toHexString()).toBe(hex);
});

test("parseObjectIdParam: invalid → null", () => {
  expect(parseObjectIdParam("not-an-id")).toBeNull();
  expect(parseObjectIdParam("")).toBeNull();
  expect(parseObjectIdParam("507f1f77bcf86cd79943901")).toBeNull();
});

test("addInterval: day adds count days (UTC)", () => {
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const r = addInterval(d, "day", 5);
  expect(r.getUTCDate()).toBe(6);
  expect(r.getUTCMonth()).toBe(0);
});

test("addInterval: week adds count*7 days", () => {
  const d = new Date(Date.UTC(2026, 0, 1));
  const r = addInterval(d, "week", 2);
  expect(r.getUTCDate()).toBe(15);
});

test("addInterval: month advances month, handles year overflow", () => {
  const d = new Date(Date.UTC(2026, 11, 15));
  const r = addInterval(d, "month", 2);
  expect(r.getUTCMonth()).toBe(1);
  expect(r.getUTCFullYear()).toBe(2027);
});

test("addInterval: year advances year", () => {
  const d = new Date(Date.UTC(2026, 5, 1));
  const r = addInterval(d, "year", 3);
  expect(r.getUTCFullYear()).toBe(2029);
});

test("addInterval: unknown interval returns same date (no-op)", () => {
  const d = new Date(Date.UTC(2026, 0, 1));
  const r = addInterval(d, "decade", 10);
  expect(r.getTime()).toBe(d.getTime());
});

test("addInterval: does not mutate input date", () => {
  const d = new Date(Date.UTC(2026, 0, 1));
  const orig = d.getTime();
  addInterval(d, "month", 1);
  expect(d.getTime()).toBe(orig);
});

test("addInterval: month overflow from Jan 31 rolls forward (JS month math)", () => {
  const d = new Date(Date.UTC(2026, 0, 31));
  const r = addInterval(d, "month", 1);
  expect(r.getUTCFullYear()).toBe(2026);
});

describe("GET /v1/admin/customers email filter (live route)", () => {
  const TEST_DB = "tokenpanel_customers_route_test";
  let handle: TestDbHandle | null = null;
  const jwtSecret = "route-email-test-secret-32-chars-min!!";
  let sharedGet: (path: string) => Promise<Response> = async () => {
    throw new Error("not initialized");
  };
  let targetHex = "";
  let orgA = new ObjectId();
  let orgB = new ObjectId();
  let adminId = new ObjectId();
  let sessionId = new ObjectId();

  beforeAll(async () => {
    handle = await startTestDb({ databaseName: TEST_DB });
    const db = getRawDb();
    orgA = new ObjectId();
    orgB = new ObjectId();
    adminId = new ObjectId();
    sessionId = new ObjectId();
    const targetId = new ObjectId();


    await db.collection("organizations").insertMany([
      { _id: orgA, name: "org-a", slug: "org-a", ownerId: adminId, defaultCurrency: "USD", createdAt: new Date(), updatedAt: new Date() },
      { _id: orgB, name: "org-b", slug: "org-b", ownerId: adminId, defaultCurrency: "USD", createdAt: new Date(), updatedAt: new Date() },
    ] as never[]);
    await db.collection("users").insertOne({
      _id: adminId,
      memberships: [{ organizationId: orgA, role: "admin", permissions: [] }],
      activeOrganizationId: orgA,
      username: "route-admin",
      email: "route-admin@example.com",
      passwordHash: "x",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await db.collection("admin_sessions").insertOne({
      _id: sessionId,
      userId: adminId,
      organizationId: orgA,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    // Stored emails are lowercase (creation normalizes). Trap rows share the
    // target's email as substring/prefix lookalikes.
    await db.collection("customers").insertMany([
      { _id: targetId, organizationId: orgA, externalId: null, name: "Target", email: "ada@example.com", balance: { amountMicros: 500, reservedMicros: 0, currency: "USD" }, status: "active", metadata: {}, createdAt: new Date(), updatedAt: new Date() },
      { _id: new ObjectId(), organizationId: orgA, externalId: null, name: "Suffix trap", email: "ada@example.com.museum", balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" }, status: "active", metadata: {}, createdAt: new Date(), updatedAt: new Date() },
      { _id: new ObjectId(), organizationId: orgA, externalId: null, name: "Prefix trap", email: "not-ada@example.com", balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" }, status: "active", metadata: {}, createdAt: new Date(), updatedAt: new Date() },
      { _id: new ObjectId(), organizationId: orgB, externalId: null, name: "Other org", email: "ada@example.com", balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" }, status: "active", metadata: {}, createdAt: new Date(), updatedAt: new Date() },
    ] as never[]);
    await db.collection("customers").createIndex(
      { organizationId: 1, email: 1 },
      {
        name: "organizationId_1_email_1_unique",
        unique: true,
        partialFilterExpression: { email: { $type: "string" } },
      },
    );

    const config = makeTestConfig({
      jwtSecret,
      database: { uri: handle.uri, name: TEST_DB },
    });
    // Full AppServices test graph with real Mongo handles injected. The
    // declared MongoUnavailableError channel is dead in practice (Mongo is
    // already connected via the harness singleton); createAppRuntime requires
    // a never error channel, so assert it away.
    const layer = makeAppTestLayer({
      config,
      mongo: { db: await getDb(), client: getClient(), rawDb: getRawDb() },
    }) as Layer.Layer<AppServices, never, never>;
    createAppRuntime(layer, { install: true });

    const t = signJwt(
      {
        sub: adminId.toHexString(),
        orgId: orgA.toHexString(),
        role: "admin",
        sid: sessionId.toHexString(),
      },
      jwtSecret,
      600,
    );

    const app = new Hono<{ Variables: AuthVariables }>();
    app.route("/v1/admin/customers", customersApp);
    sharedGet = (path: string) =>
      Promise.resolve(
        app.request(path, { headers: { Authorization: `Bearer ${t}` } }),
      );
    targetHex = targetId.toHexString();
  }, TEST_DB_START_TIMEOUT_MS);

  afterAll(async () => {
    await disposeAppRuntime().catch(() => undefined);
    clearAppRuntimeSingleton();
    await resetTestCollections(
      "customers",
      "organizations",
      "users",
      "adminSessions",
    );
    await stopTestDb();
  });

  test("uppercase email query returns exactly the target row", async () => {
    const res = await sharedGet("/v1/admin/customers?email=Ada@Example.COM");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      items: { _id: string; balance?: unknown }[];
    };
    expect(body.total).toBe(1);
    expect(body.items[0]!._id).toBe(targetHex);
    // Admin role ⇒ balances:read ⇒ balance present (not redacted).
    expect(body.items[0]!.balance).toEqual(
      expect.objectContaining({ amountMicros: 500 }),
    );
  });

  test("distinct lookalike email returns only its own row", async () => {
    const res = await sharedGet("/v1/admin/customers?email=ada@example.com.museum");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  test("unfiltered list is organization-scoped", async () => {
    const res = await sharedGet("/v1/admin/customers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(3);
  });
});