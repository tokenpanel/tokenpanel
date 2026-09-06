import { test, expect } from "bun:test";
import { validateFirstRun, validateInvite, validate } from "../SignupPage.tsx";

const VALID_FIRST = {
  adminEmail: "root@example.com",
  adminUsername: "root",
  password: "hunter2hunter2",
  confirmPassword: "hunter2hunter2",
};

const VALID_INVITE = {
  username: "alice",
  password: "hunter2hunter2",
  confirmPassword: "hunter2hunter2",
};

test("validateFirstRun: valid form → no errors", () => {
  expect(validateFirstRun(VALID_FIRST)).toEqual({});
});

test("validateFirstRun: all empty → every field required", () => {
  expect(validateFirstRun({ adminEmail: "", adminUsername: "", password: "", confirmPassword: "" })).toEqual({
    adminEmail: "Email is required.",
    adminUsername: "Username is required.",
    password: "Password is required.",
    confirmPassword: "Confirm your password.",
  });
});

test("validateFirstRun: email malformed → format error", () => {
  expect(validateFirstRun({ ...VALID_FIRST, adminEmail: "not-an-email" }).adminEmail).toBe(
    "Enter a valid email address.",
  );
  expect(validateFirstRun({ ...VALID_FIRST, adminEmail: "a b@c.d" }).adminEmail).toBeTruthy();
  expect(validateFirstRun({ ...VALID_FIRST, adminEmail: "a@b" }).adminEmail).toBeTruthy();
  // email present + valid → no email error even if other fields fail
  const errs = validateFirstRun({ ...VALID_FIRST, adminUsername: "" });
  expect(errs.adminEmail).toBeUndefined();
});

test("validateFirstRun: username length bounds 3–60, length wins over charset", () => {
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "ab" }).adminUsername).toBe(
    "Username must be 3–60 characters.",
  );
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "a".repeat(61) }).adminUsername).toBeTruthy();
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "a".repeat(60) }).adminUsername).toBeUndefined();
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "a" }).adminUsername).toBe(
    "Username must be 3–60 characters.",
  );
  // 2 chars with an illegal character → length branch fires first
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "a!" }).adminUsername).toBe(
    "Username must be 3–60 characters.",
  );
});

test("validateFirstRun: username charset rejects spaces/symbols/unicode", () => {
  const msg = "Use letters, numbers, dots, hyphens, or underscores only.";
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "bad name" }).adminUsername).toBe(msg);
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "user!" }).adminUsername).toBe(msg);
  expect(validateFirstRun({ ...VALID_FIRST, adminUsername: "üser" }).adminUsername).toBe(msg);
  expect(
    validateFirstRun({ ...VALID_FIRST, adminUsername: "a.b-_9" }).adminUsername,
  ).toBeUndefined();
});

test("validateFirstRun: password min length 8", () => {
  expect(validateFirstRun({ ...VALID_FIRST, password: "h", confirmPassword: "h" }).password).toBe(
    "Password must be at least 8 characters.",
  );
  const errs = validateFirstRun({ ...VALID_FIRST, password: "hunter2hunter2", confirmPassword: "other" });
  expect(errs.password).toBeUndefined();
});

test("validateFirstRun: confirmPassword mismatch / empty", () => {
  expect(
    validateFirstRun({ ...VALID_FIRST, confirmPassword: "different" }).confirmPassword,
  ).toBe("Passwords do not match.");
  expect(validateFirstRun({ ...VALID_FIRST, confirmPassword: "" }).confirmPassword).toBe(
    "Confirm your password.",
  );
});

test("validateFirstRun: independent fields report errors simultaneously", () => {
  const errs = validateFirstRun({
    adminEmail: "nope",
    adminUsername: "x",
    password: "short",
    confirmPassword: "other",
  });
  expect(Object.keys(errs).sort()).toEqual(["adminEmail", "adminUsername", "confirmPassword", "password"]);
});

test("validateInvite: valid → no errors; uses username key (not adminUsername)", () => {
  expect(validateInvite(VALID_INVITE)).toEqual({});
  const errs = validateInvite({ ...VALID_INVITE, username: "" });
  expect(errs.username).toBe("Username is required.");
  expect(errs.adminUsername).toBeUndefined();
});

test("validateInvite: mirrors first-run branch precedence", () => {
  expect(validateInvite({ ...VALID_INVITE, username: "ab" }).username).toBe(
    "Username must be 3–60 characters.",
  );
  expect(validateInvite({ ...VALID_INVITE, username: "a b" }).username).toBe(
    "Use letters, numbers, dots, hyphens, or underscores only.",
  );
  expect(validateInvite({ ...VALID_INVITE, password: "1234567" }).password).toBe(
    "Password must be at least 8 characters.",
  );
  expect(validateInvite({ ...VALID_INVITE, confirmPassword: "zzz" }).confirmPassword).toBe(
    "Passwords do not match.",
  );
});

test("validate (deprecated) delegates to validateFirstRun", () => {
  expect(validate({ ...VALID_FIRST, adminEmail: "" })).toEqual(
    validateFirstRun({ ...VALID_FIRST, adminEmail: "" }),
  );
  expect(validate(VALID_FIRST)).toEqual({});
});
