import { test, expect } from "bun:test";
import { updateMeBody, changePasswordBody } from "../auth.ts";

test("updateMeBody: valid email parses", () => {
  const r = updateMeBody.safeParse({ email: "user@example.com" });
  expect(r.success).toBe(true);
});

test("updateMeBody: rejects non-email", () => {
  const r = updateMeBody.safeParse({ email: "not-an-email" });
  expect(r.success).toBe(false);
});

test("updateMeBody: rejects empty string", () => {
  const r = updateMeBody.safeParse({ email: "" });
  expect(r.success).toBe(false);
});

test("changePasswordBody: valid payload parses", () => {
  const r = changePasswordBody.safeParse({
    currentPassword: "oldpass1",
    newPassword: "newpass12",
    confirmNewPassword: "newpass12",
  });
  expect(r.success).toBe(true);
});

test("changePasswordBody: rejects when confirm does not match new", () => {
  const r = changePasswordBody.safeParse({
    currentPassword: "oldpass1",
    newPassword: "newpass12",
    confirmNewPassword: "different12",
  });
  expect(r.success).toBe(false);
  if (!r.success) {
    expect(r.error.issues[0]?.path[0]).toBe("confirmNewPassword");
  }
});

test("changePasswordBody: rejects when new equals current", () => {
  const r = changePasswordBody.safeParse({
    currentPassword: "samepass1",
    newPassword: "samepass1",
    confirmNewPassword: "samepass1",
  });
  expect(r.success).toBe(false);
  if (!r.success) {
    expect(r.error.issues[0]?.path[0]).toBe("newPassword");
  }
});

test("changePasswordBody: rejects new password shorter than 8 chars", () => {
  const r = changePasswordBody.safeParse({
    currentPassword: "oldpass1",
    newPassword: "short",
    confirmNewPassword: "short",
  });
  expect(r.success).toBe(false);
});

test("changePasswordBody: rejects empty current password", () => {
  const r = changePasswordBody.safeParse({
    currentPassword: "",
    newPassword: "newpass12",
    confirmNewPassword: "newpass12",
  });
  expect(r.success).toBe(false);
});
