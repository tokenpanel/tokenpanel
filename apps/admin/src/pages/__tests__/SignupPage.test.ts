import { test, expect } from "bun:test";
import { validate } from "../SignupPage.tsx";

function form(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    adminEmail: "a@b.com",
    adminUsername: "alice",
    password: "password123",
    confirmPassword: "password123",
    ...over,
  };
}

test("validate: valid form → no errors", () => {
  expect(Object.keys(validate(form() as never))).toHaveLength(0);
});

test("validate: empty email → required error", () => {
  const e = validate(form({ adminEmail: "" }) as never);
  expect(e.adminEmail).toBeTruthy();
});

test("validate: bad email → format error", () => {
  const e = validate(form({ adminEmail: "not-email" }) as never);
  expect(e.adminEmail).toBeTruthy();
});

test("validate: short username (<3) → length error", () => {
  const e = validate(form({ adminUsername: "ab" }) as never);
  expect(e.adminUsername).toBeTruthy();
});

test("validate: username >60 → length error", () => {
  const e = validate(form({ adminUsername: "a".repeat(61) }) as never);
  expect(e.adminUsername).toBeTruthy();
});

test("validate: username with space → regex error", () => {
  const e = validate(form({ adminUsername: "alice bob" }) as never);
  expect(e.adminUsername).toBeTruthy();
});

test("validate: empty password → required error", () => {
  const e = validate(form({ password: "" }) as never);
  expect(e.password).toBeTruthy();
});

test("validate: short password (<8) → length error", () => {
  const e = validate(form({ password: "short" }) as never);
  expect(e.password).toBeTruthy();
});

test("validate: empty confirmPassword → required error", () => {
  const e = validate(form({ confirmPassword: "" }) as never);
  expect(e.confirmPassword).toBeTruthy();
});

test("validate: password mismatch → mismatch error", () => {
  const e = validate(form({ confirmPassword: "different123" }) as never);
  expect(e.confirmPassword).toBeTruthy();
});
