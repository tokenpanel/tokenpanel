import { test, expect } from "bun:test";
import { getToken } from "../auth.ts";

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