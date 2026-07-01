import { test, expect } from "bun:test";
import { statusVariant } from "../SettingsPage.tsx";

test("statusVariant: pending→warning, accepted→success, expired/revoked→destructive, default→warning", () => {
  expect(statusVariant("pending")).toBe("warning");
  expect(statusVariant("accepted")).toBe("success");
  expect(statusVariant("expired")).toBe("destructive");
  expect(statusVariant("revoked")).toBe("destructive");
  expect(statusVariant("unknown")).toBe("warning");
});