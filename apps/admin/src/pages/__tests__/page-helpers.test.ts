import { test, expect } from "bun:test";
import { deriveSlug } from "../OrganizationsPage.tsx";
import { parseWhitelist } from "../ApiKeysPage.tsx";
import { initials, customerStatusVariant } from "../DashboardPage.tsx";
import { isoDate, defaultFrom, defaultTo } from "../AnalyticsPage.tsx";

test("deriveSlug: lowercases and separates non-alphanumerics with hyphens", () => {
  expect(deriveSlug("Acme Corp")).toBe("acme-corp");
  expect(deriveSlug("  Spacy  Name  ")).toBe("spacy-name");
  expect(deriveSlug("Ünïcode!@# Co")).toBe("n-code-co");
});

test("deriveSlug: trims leading/trailing hyphens and collapses runs", () => {
  expect(deriveSlug("--weird--name--")).toBe("weird-name");
  expect(deriveSlug("a___b")).toBe("a-b");
});

test("deriveSlug: alphanumerics preserved including digits", () => {
  expect(deriveSlug("Team 42")).toBe("team-42");
  expect(deriveSlug("abc123")).toBe("abc123");
});

test("deriveSlug: no usable characters → empty string (slug must be user-provided)", () => {
  expect(deriveSlug("")).toBe("");
  expect(deriveSlug("!!!")).toBe("");
  expect(deriveSlug("   ")).toBe("");
  expect(deriveSlug("üöä")).toBe("");
});

test("parseWhitelist: splits commas, trims, drops empties", () => {
  expect(parseWhitelist("model-a, model-b")).toEqual(["model-a", "model-b"]);
  expect(parseWhitelist("  model-a  ,, ,model-b")).toEqual(["model-a", "model-b"]);
  expect(parseWhitelist("single")).toEqual(["single"]);
});

test("parseWhitelist: blank input → empty list (payload omits modelWhitelist)", () => {
  expect(parseWhitelist("")).toEqual([]);
  expect(parseWhitelist("  ,  , ")).toEqual([]);
});

test("initials: empty → '?', single word → first two chars uppercased", () => {
  expect(initials("")).toBe("?");
  expect(initials("   ")).toBe("?");
  expect(initials("acme")).toBe("AC");
  expect(initials("A")).toBe("A");
});

test("initials: multi-word → first letters of first two words", () => {
  expect(initials("Jane Doe")).toBe("JD");
  expect(initials("  Jane   Doe  ")).toBe("JD");
  expect(initials("Jean-Luc Picard")).toBe("JP");
});

test("customerStatusVariant: known statuses delegate to labels, unknown → secondary", () => {
  expect(customerStatusVariant("active")).toBe("success");
  expect(customerStatusVariant("suspended")).toBe("warning");
  expect(customerStatusVariant("closed")).toBe("destructive");
  expect(customerStatusVariant("pending")).toBe("secondary");
  expect(customerStatusVariant("totally-unknown")).toBe("secondary");
});

test("isoDate: zero-pads month/day (local-time contract)", () => {
  expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  expect(isoDate(new Date(2026, 11, 31))).toBe("2026-12-31");
});

test("defaultFrom/defaultTo: 30-day window, from ≤ to, both ISO dates", () => {
  const from = defaultFrom();
  const to = defaultTo();
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // 29 days back: newest included day is today (DEFAULT_RANGE_DAYS - 1 offset)
  const expected = new Date();
  expected.setDate(expected.getDate() - 29);
  expect(from).toBe(isoDate(expected));
  expect(new Date(from).getTime()).toBeLessThanOrEqual(new Date(to).getTime());
});
