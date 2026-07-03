import { test, expect } from "bun:test";
import { getToken, requireRole } from "../auth.ts";
import type { UserRole } from "@tokenpanel/db";

function req(header: string | undefined): { req: { header: (n: string) => string | undefined } } {
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

// requireRole gates privileged mutations (tokenpanel-6rz): a member of the
// active org must be denied admin-only writes, while an admin passes through.

function roleCtx(role: UserRole | undefined): unknown {
  return {
    get: (k: string) => (k === "role" ? role : undefined),
    json: (body: unknown, status: number) => ({ body, status }),
  };
}

test("requireRole('admin'): member → 403 and next is NOT called", async () => {
  let called = false;
  const next = async () => {
    called = true;
  };
  const res = await requireRole("admin")(roleCtx("member") as never, next as never);
  expect((res as { status: number }).status).toBe(403);
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
  const res = await requireRole("admin")(roleCtx(undefined) as never, next as never);
  expect((res as { status: number }).status).toBe(403);
  expect(called).toBe(false);
});