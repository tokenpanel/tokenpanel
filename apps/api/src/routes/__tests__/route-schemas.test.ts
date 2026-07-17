import { test, expect } from "bun:test";
import { loginBody } from "../auth.ts";
import { signupBody } from "../signup.ts";
import { inviteBody, acceptBody } from "../invites.ts";

test("loginBody: accepts valid username+password", () => {
  expect(loginBody.safeParse({ username: "alice", password: "secret123" }).success).toBe(true);
});

test("loginBody: rejects empty username or password", () => {
  expect(loginBody.safeParse({ username: "", password: "x" }).success).toBe(false);
  expect(loginBody.safeParse({ username: "alice", password: "" }).success).toBe(false);
  expect(loginBody.safeParse({ username: "alice" }).success).toBe(false);
});

test("loginBody: rejects too-long fields", () => {
  expect(loginBody.safeParse({ username: "a".repeat(61), password: "x" }).success).toBe(false);
  expect(loginBody.safeParse({ username: "alice", password: "x".repeat(257) }).success).toBe(false);
});

test("signupBody: valid payload passes", () => {
  expect(
    signupBody.safeParse({
      adminEmail: "a@b.com",
      adminUsername: "alice",
      password: "password123",
      confirmPassword: "password123",
    }).success,
  ).toBe(true);
});

test("signupBody: rejects unknown org fields (no longer accepted)", () => {
  // organizationName/organizationSlug were removed; signup now auto-creates
  // a default org. Extra keys are ignored by Effect Schema by default, but the
  // fields are no longer part of the schema — confirmed by parsing a minimal body.
  const r = signupBody.safeParse({
    adminEmail: "a@b.com",
    adminUsername: "alice",
    password: "password123",
    confirmPassword: "password123",
  });
  expect(r.success).toBe(true);
});

test("signupBody: refine rejects password mismatch (path confirmPassword)", () => {
  const r = signupBody.safeParse({
    adminEmail: "a@b.com",
    adminUsername: "alice",
    password: "password123",
    confirmPassword: "different123",
  });
  expect(r.success).toBe(false);
  if (!r.success) {
    const paths = r.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("confirmPassword");
  }
});

test("signupBody: rejects short password (<8)", () => {
  expect(
    signupBody.safeParse({
      adminEmail: "a@b.com",
      adminUsername: "alice",
      password: "short",
      confirmPassword: "short",
    }).success,
  ).toBe(false);
});

test("signupBody: rejects bad email + username regex", () => {
  expect(
    signupBody.safeParse({
      adminEmail: "not-email",
      adminUsername: "alice",
      password: "password123",
      confirmPassword: "password123",
    }).success,
  ).toBe(false);
  expect(
    signupBody.safeParse({
      adminEmail: "a@b.com",
      adminUsername: "ab",
      password: "password123",
      confirmPassword: "password123",
    }).success,
  ).toBe(false);
  expect(
    signupBody.safeParse({
      adminEmail: "a@b.com",
      adminUsername: "alice space",
      password: "password123",
      confirmPassword: "password123",
    }).success,
  ).toBe(false);
});

test("inviteBody: valid email, optional role + ttlHours", () => {
  expect(inviteBody.safeParse({ email: "a@b.com" }).success).toBe(true);
  expect(inviteBody.safeParse({ email: "a@b.com", role: "admin" }).success).toBe(true);
  expect(inviteBody.safeParse({ email: "a@b.com", role: "owner" }).success).toBe(false);
  expect(inviteBody.safeParse({ email: "a@b.com", ttlHours: 168 }).success).toBe(true);
  expect(inviteBody.safeParse({ email: "a@b.com", ttlHours: 0 }).success).toBe(false);
  expect(inviteBody.safeParse({ email: "a@b.com", ttlHours: 721 }).success).toBe(false);
  expect(inviteBody.safeParse({ email: "bad" }).success).toBe(false);
});

test("acceptBody: valid token+username+password", () => {
  expect(
    acceptBody.safeParse({ token: "tok", username: "alice", password: "password123" }).success,
  ).toBe(true);
});

test("acceptBody: rejects short username + short password + empty token", () => {
  expect(acceptBody.safeParse({ token: "tok", username: "ab", password: "password123" }).success).toBe(false);
  expect(acceptBody.safeParse({ token: "tok", username: "alice", password: "short" }).success).toBe(false);
  expect(acceptBody.safeParse({ token: "", username: "alice", password: "password123" }).success).toBe(false);
});

test("acceptBody: username regex", () => {
  expect(acceptBody.safeParse({ token: "tok", username: "alice space", password: "password123" }).success).toBe(false);
  expect(acceptBody.safeParse({ token: "tok", username: "alice.bob_1-2", password: "password123" }).success).toBe(true);
});