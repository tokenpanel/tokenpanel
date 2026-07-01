import { test, expect } from "bun:test";
import { pathLabel } from "../Layout.tsx";

test("pathLabel: '/' → 'Dashboard'", () => {
  expect(pathLabel("/")).toBe("Dashboard");
});

test("pathLabel: known nav routes → labels", () => {
  expect(pathLabel("/providers")).toBe("Providers");
  expect(pathLabel("/models")).toBe("Models");
  expect(pathLabel("/customers")).toBe("Customers");
  expect(pathLabel("/plans")).toBe("Plans");
  expect(pathLabel("/playground")).toBe("Playground");
  expect(pathLabel("/analytics")).toBe("Analytics");
  expect(pathLabel("/api-keys")).toBe("API Keys");
  expect(pathLabel("/settings")).toBe("Settings");
});

test("pathLabel: unknown route → 'TokenPanel' fallback", () => {
  expect(pathLabel("/nonexistent")).toBe("TokenPanel");
  expect(pathLabel("/admin/customers/123")).toBe("TokenPanel");
});