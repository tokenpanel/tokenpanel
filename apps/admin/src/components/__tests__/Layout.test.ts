import { test, expect } from "bun:test";
import { pathLabel, orgInitials } from "../Layout.tsx";

test("pathLabel: root maps to Dashboard", () => {
  expect(pathLabel("/")).toBe("Dashboard");
});

test("pathLabel: every nav route maps to its nav label", () => {
  expect(pathLabel("/analytics")).toBe("Analytics");
  expect(pathLabel("/providers")).toBe("Providers");
  expect(pathLabel("/models")).toBe("Models");
  expect(pathLabel("/plans")).toBe("Plans");
  expect(pathLabel("/customers")).toBe("Customers");
  expect(pathLabel("/api-keys")).toBe("API Keys");
  expect(pathLabel("/management-keys")).toBe("Management Keys");
  expect(pathLabel("/playground")).toBe("Playground");
  expect(pathLabel("/organizations")).toBe("Organizations");
  expect(pathLabel("/settings")).toBe("Settings");
});

test("pathLabel: unknown path falls back to app title (breadcrumb contract)", () => {
  expect(pathLabel("/models/some-id")).toBe("TokenPanel");
  expect(pathLabel("/nonexistent")).toBe("TokenPanel");
  expect(pathLabel("")).toBe("TokenPanel");
});

test("orgInitials: empty/whitespace → 'O'", () => {
  expect(orgInitials("")).toBe("O");
  expect(orgInitials("   ")).toBe("O");
});

test("orgInitials: single word takes first two chars, uppercased", () => {
  expect(orgInitials("acme")).toBe("AC");
  expect(orgInitials("A")).toBe("A");
  expect(orgInitials("  token  ")).toBe("TO");
});

test("orgInitials: multi-word takes initials of first two words", () => {
  expect(orgInitials("Acme Corp")).toBe("AC");
  expect(orgInitials("  Acme   Corp  ")).toBe("AC");
  expect(orgInitials("The Boring Company")).toBe("TB");
});
