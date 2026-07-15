/**
 * HTTP integration for model metadata against createModelRoutes with
 * injected getDb + requireAuth (no production test-hook env seam).
 *
 * Exercises persistence, clear/preserve PATCH semantics, 400 validation,
 * member 403, and cross-org isolation without a live MongoDB.
 */
import { test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import {
  type ModelDoc,
  type ModelEntryDoc,
  type TypedDb,
} from "@tokenpanel/db";
import { createModelRoutes } from "../models.ts";
import type { AuthVariables } from "../../middleware/auth.ts";

type MemModel = ModelDoc;
type MemProvider = {
  _id: ObjectId;
  organizationId: ObjectId;
  name: string;
};

let orgA: ObjectId;
let orgB: ObjectId;
let providerA: ObjectId;
let role: "admin" | "member";
let activeOrg: ObjectId;
let models: MemModel[];
let providers: MemProvider[];

function oidEq(a: unknown, b: ObjectId): boolean {
  if (a instanceof ObjectId) return a.equals(b);
  if (typeof a === "string") return a === b.toHexString();
  return false;
}

function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "_id") {
      if (v instanceof ObjectId) {
        if (!oidEq(doc._id, v)) return false;
      } else if (typeof v === "object" && v !== null && "$in" in v) {
        const arr = (v as { $in: ObjectId[] }).$in;
        const hit = arr.some((id) => oidEq(doc._id, id));
        if (!hit) return false;
      } else return false;
    } else if (k === "organizationId" && v instanceof ObjectId) {
      if (!oidEq(doc.organizationId, v)) return false;
    } else if (doc[k] !== v) {
      // shallow equality for other fields
      if (v instanceof ObjectId) {
        if (!oidEq(doc[k], v)) return false;
      } else if (doc[k] !== v) {
        return false;
      }
    }
  }
  return true;
}

function makeCollection<T extends { _id: ObjectId }>(store: T[]) {
  return {
    find(filter: Record<string, unknown> = {}) {
      const matched = store.filter((d) =>
        matchFilter(d as unknown as Record<string, unknown>, filter),
      );
      return {
        sort(_spec: Record<string, number>) {
          return {
            toArray: async () => [...matched],
          };
        },
        toArray: async () => [...matched],
      };
    },
    async findOne(filter: Record<string, unknown>) {
      return (
        store.find((d) =>
          matchFilter(d as unknown as Record<string, unknown>, filter),
        ) ?? null
      );
    },
    async insertOne(doc: T) {
      store.push(doc);
      return { insertedId: doc._id };
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
      _opts?: { returnDocument?: string },
    ) {
      const idx = store.findIndex((d) =>
        matchFilter(d as unknown as Record<string, unknown>, filter),
      );
      if (idx < 0) return null;
      const cur = store[idx]!;
      const next = { ...cur, ...update.$set } as T;
      store[idx] = next;
      return next;
    },
    async deleteOne(filter: Record<string, unknown>) {
      const idx = store.findIndex((d) =>
        matchFilter(d as unknown as Record<string, unknown>, filter),
      );
      if (idx < 0) return { deletedCount: 0 };
      store.splice(idx, 1);
      return { deletedCount: 1 };
    },
  };
}

function makeDb(): TypedDb {
  return {
    models: makeCollection(models) as unknown as TypedDb["models"],
    providers: makeCollection(providers) as unknown as TypedDb["providers"],
  } as TypedDb;
}

function seed(): void {
  orgA = new ObjectId();
  orgB = new ObjectId();
  providerA = new ObjectId();
  role = "admin";
  activeOrg = orgA;
  models = [];
  providers = [{ _id: providerA, organizationId: orgA, name: "OpenAI" }];
}

/** DI models router mounted at the same path as apps/api. */
function buildApp(): Hono {
  const app = new Hono();
  const routes = createModelRoutes({
    getDb: async () => makeDb(),
    requireAuth: async (c, next) => {
      c.set(
        "user",
        {
          _id: new ObjectId(),
          email: "a@b.com",
          username: "admin",
          passwordHash: "x",
          status: "active",
          activeOrganizationId: activeOrg,
          memberships: [{ organizationId: activeOrg, role }],
          createdAt: new Date(),
          updatedAt: new Date(),
        } as AuthVariables["user"],
      );
      c.set("orgId", activeOrg);
      c.set("role", role);
      await next();
    },
  });
  app.route("/admin/models", routes);
  return app;
}

const createBody = (over: Record<string, unknown> = {}) => ({
  aliasId: "my-gpt",
  displayName: "My GPT",
  entries: [
    {
      providerId: providerA.toHexString(),
      upstreamModelId: "gpt-4o",
    },
  ],
  limits: { context: 128000 },
  modalities: { input: ["text"], output: ["text"] },
  price: { inputMinorPerMillion: 300, outputMinorPerMillion: 600 },
  currency: "USD",
  ...over,
});

beforeEach(() => {
  seed();
});

test("production router: create → set → omit preserves → clear → round-trip", async () => {
  const app = buildApp();

  const createdRes = await app.request("/admin/models", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(
      createBody({ metadata: { tier: "gold", note: "line1\r\nline2" } }),
    ),
  });
  expect(createdRes.status).toBe(201);
  const created = (await createdRes.json()) as {
    _id: string;
    metadata: Record<string, string>;
  };
  // Write contract normalizes CR/CRLF → LF
  expect(created.metadata.tier).toBe("gold");
  expect(created.metadata.note).toBe("line1\nline2");
  const id = String(created._id);

  const setRes = await app.request(`/admin/models/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ metadata: { tier: "silver", label: "smart" } }),
  });
  expect(setRes.status).toBe(200);
  const setDoc = (await setRes.json()) as { metadata: Record<string, string> };
  expect(setDoc.metadata.tier).toBe("silver");
  expect(setDoc.metadata.label).toBe("smart");
  expect(setDoc.metadata.note).toBeUndefined();

  // Omitted metadata keeps existing map (PATCH preserve) — production $set loop.
  const omitRes = await app.request(`/admin/models/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ displayName: "Renamed" }),
  });
  expect(omitRes.status).toBe(200);
  const omitDoc = (await omitRes.json()) as {
    displayName: string;
    metadata: Record<string, string>;
  };
  expect(omitDoc.displayName).toBe("Renamed");
  expect(omitDoc.metadata.tier).toBe("silver");
  expect(omitDoc.metadata.label).toBe("smart");

  const clearRes = await app.request(`/admin/models/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ metadata: {} }),
  });
  expect(clearRes.status).toBe(200);
  const clearDoc = (await clearRes.json()) as { metadata: Record<string, string> };
  expect(Object.keys(clearDoc.metadata)).toEqual([]);

  const getRes = await app.request(`/admin/models/${id}`, {
    headers: { authorization: "Bearer t" },
  });
  expect(getRes.status).toBe(200);
  const got = (await getRes.json()) as {
    metadata: Record<string, string>;
    displayName: string;
  };
  expect(Object.keys(got.metadata)).toEqual([]);
  expect(got.displayName).toBe("Renamed");
});

test("production router: non-string / dangerous keys → 400, no write", async () => {
  const app = buildApp();
  const createdRes = await app.request("/admin/models", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(createBody({ metadata: { tier: "gold" } })),
  });
  expect(createdRes.status).toBe(201);
  const created = (await createdRes.json()) as { _id: string };
  const id = String(created._id);

  const bad = await app.request(`/admin/models/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ metadata: { tier: 1 } }),
  });
  expect(bad.status).toBe(400);
  const still = models.find((m) => m._id.toHexString() === id);
  expect(still?.metadata.tier).toBe("gold");

  const reserved = await app.request(`/admin/models/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ metadata: { $set: "x" } }),
  });
  expect(reserved.status).toBe(400);
  expect(still?.metadata.tier).toBe("gold");
});

test("production router: member write → 403", async () => {
  role = "member";
  const app = buildApp();
  const res = await app.request("/admin/models", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(createBody()),
  });
  expect(res.status).toBe(403);
  expect(models).toHaveLength(0);
});

test("production router: cross-org model id → 404 (no leak)", async () => {
  const app = buildApp();
  activeOrg = orgA;
  const createdRes = await app.request("/admin/models", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(createBody({ metadata: { secret: "org-a-only" } })),
  });
  expect(createdRes.status).toBe(201);
  const created = (await createdRes.json()) as { _id: string };
  const id = String(created._id);

  activeOrg = orgB;
  role = "admin";
  const getB = await app.request(`/admin/models/${id}`, {
    headers: { authorization: "Bearer t" },
  });
  expect(getB.status).toBe(404);
  const body = (await getB.json()) as { error?: string; metadata?: unknown };
  expect(body.error).toBe("not_found");
  expect(body.metadata).toBeUndefined();

  const patchB = await app.request(`/admin/models/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ metadata: { hacked: "yes" } }),
  });
  expect(patchB.status).toBe(404);

  const still = models.find((m) => m._id.toHexString() === id);
  expect(still?.metadata.secret).toBe("org-a-only");
});

// silence unused type import when tree-shaken
void (0 as unknown as ModelEntryDoc);
