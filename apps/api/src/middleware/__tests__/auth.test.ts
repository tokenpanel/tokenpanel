import { test, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { Layer, ManagedRuntime } from "effect";
import { getToken, requireRole, requirePermission } from "../auth.ts";
import type { UserRole } from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import {
  createAppRuntime,
  clearAppRuntimeSingleton,
  disposeAppRuntime,
} from "../../runtime/app-runtime.ts";
import { makeAppTestLayer } from "../../runtime/layers/test.ts";
import type { AppServices } from "../../runtime/layers/live.ts";

function req(header: string | undefined): {
  req: { header: (n: string) => string | undefined };
} {
  return { req: { header: () => header } };
}

test("getToken: returns token from valid 'Bearer <token>'", () => {
  expect(getToken(req("Bearer abc123"))).toBe("abc123");
});

test("getToken: returns null when Authorization header missing", () => {
  expect(getToken(req(undefined))).toBeNull();
});

test("getToken: returns null for empty header", () => {
  expect(getToken(req(""))).toBeNull();
});

test("getToken: returns null for non-Bearer scheme", () => {
  expect(getToken(req("Basic abc123"))).toBeNull();
});

test("getToken: accepts lowercase 'bearer' scheme", () => {
  expect(getToken(req("bearer abc123"))).toBe("abc123");
});

test("getToken: returns null when wrong part count (1 or 3)", () => {
  expect(getToken(req("Bearer"))).toBeNull();
  expect(getToken(req("Bearer x y"))).toBeNull();
  expect(getToken(req("Bearer x y z"))).toBeNull();
});

test("getToken: 'Bearer ' with empty token returns empty string (split yields 2 parts)", () => {
  expect(getToken(req("Bearer "))).toBe("");
});

// requireRole needs ManagedRuntime (no legacy getDb fallback).

beforeAll(() => {
  const layer = makeAppTestLayer() as Layer.Layer<AppServices, never>;
  createAppRuntime(layer, { install: true });
});

afterAll(async () => {
  await disposeAppRuntime();
  clearAppRuntimeSingleton();
});

function roleCtx(
  role: UserRole | undefined,
  permissions: readonly PanelPermission[] = [],
): unknown {
  const orgId = new ObjectId();
  return {
    get: (k: string) => {
      if (k === "role") return role;
      if (k === "permissions") return permissions;
      if (k === "orgId") return orgId;
      if (k === "user") {
        return {
          _id: new ObjectId(),
          status: "active",
          memberships: [
            {
              organizationId: orgId,
              role: role ?? "member",
              permissions,
            },
          ],
          activeOrganizationId: orgId,
        };
      }
      return undefined;
    },
    req: {
      raw: { signal: undefined },
      header: () => undefined,
    },
    json: (body: unknown, status: number) => ({ body, status }),
  };
}

test("requireRole('admin'): member → 403 and next is NOT called", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  const res = await requireRole("admin")(
    roleCtx("member") as never,
    next as never,
  );
  expect((res as Response).status).toBe(403);
  expect(called).toBe(false);
});

test("requireRole('admin'): admin → next IS called (allowed)", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  await requireRole("admin")(roleCtx("admin") as never, next as never);
  expect(called).toBe(true);
});

test("requireRole('admin'): missing role → 403 (deny by default)", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  const res = await requireRole("admin")(
    roleCtx(undefined) as never,
    next as never,
  );
  expect((res as Response).status).toBe(403);
  expect(called).toBe(false);
});

test("requirePermission: admin always allowed", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  await requirePermission("providers:write")(
    roleCtx("admin") as never,
    next as never,
  );
  expect(called).toBe(true);
});

test("requirePermission: member without grant → 403", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  const res = await requirePermission("providers:write")(
    roleCtx("member", ["providers:read"]) as never,
    next as never,
  );
  expect((res as Response).status).toBe(403);
  expect(called).toBe(false);
});

test("requirePermission: member with grant → allowed", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  await requirePermission("customers:read")(
    roleCtx("member", ["customers:read"]) as never,
    next as never,
  );
  expect(called).toBe(true);
});

test("requirePermission: write implies paired read", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  await requirePermission("invites:read")(
    roleCtx("member", ["invites:write"]) as never,
    next as never,
  );
  expect(called).toBe(true);
});

test("requirePermission: write does not imply other resource read", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  const res = await requirePermission("customers:read")(
    roleCtx("member", ["invites:write"]) as never,
    next as never,
  );
  expect((res as Response).status).toBe(403);
  expect(called).toBe(false);
});

void ManagedRuntime;
