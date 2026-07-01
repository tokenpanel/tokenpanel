import { test, expect } from "bun:test";
import {
  formatMoney,
  formatDate,
  formatNumber,
  formatCompact,
  formatRelative,
} from "../format.ts";

test("formatMoney: USD positive", () => {
  expect(formatMoney(12345, "USD")).toBe("$123.45");
  expect(formatMoney(100, "USD")).toBe("$1.00");
  expect(formatMoney(0, "USD")).toBe("$0.00");
});

test("formatMoney: negative adds leading minus", () => {
  expect(formatMoney(-12345, "USD")).toBe("-$123.45");
  expect(formatMoney(-100, "USD")).toBe("-$1.00");
});

test("formatMoney: other dollar currencies (AUD/CAD/NZD/HKD/SGD)", () => {
  expect(formatMoney(12345, "AUD")).toBe("$123.45");
  expect(formatMoney(12345, "CAD")).toBe("$123.45");
  expect(formatMoney(12345, "NZD")).toBe("$123.45");
  expect(formatMoney(12345, "HKD")).toBe("$123.45");
  expect(formatMoney(12345, "SGD")).toBe("$123.45");
});

test("formatMoney: EUR/GBP/INR use symbol + 2 decimals", () => {
  expect(formatMoney(12345, "EUR")).toBe("\u20ac123.45");
  expect(formatMoney(12345, "GBP")).toBe("\u00a3123.45");
  expect(formatMoney(12345, "INR")).toBe("\u20b9123.45");
});

test("formatMoney: JPY no decimals (minor/100 = major, no cents shown)", () => {
  expect(formatMoney(12345, "JPY")).toBe("\u00a5123");
  expect(formatMoney(100, "JPY")).toBe("\u00a51");
  expect(formatMoney(0, "JPY")).toBe("\u00a50");
});

test("formatMoney: unknown currency → 'X.XX CODE' fallback", () => {
  expect(formatMoney(12345, "XYZ")).toBe("123.45 XYZ");
  expect(formatMoney(0, "ABC")).toBe("0.00 ABC");
});

test("formatMoney: minor < 10 pads with leading zero", () => {
  expect(formatMoney(105, "USD")).toBe("$1.05");
  expect(formatMoney(5, "USD")).toBe("$0.05");
});

test("formatMoney: currency uppercased", () => {
  expect(formatMoney(12345, "usd")).toBe("$123.45");
  expect(formatMoney(12345, "jpy")).toBe("\u00a5123");
});

test("formatDate: null/undefined → em dash", () => {
  expect(formatDate(null)).toBe("\u2014");
  expect(formatDate(undefined)).toBe("\u2014");
});

test("formatDate: invalid date → em dash", () => {
  expect(formatDate(new Date("not-a-date"))).toBe("\u2014");
  expect(formatDate("not-a-date")).toBe("\u2014");
});

test("formatDate: valid date returns locale string", () => {
  const s = formatDate("2026-01-15T10:30:00Z");
  expect(s).not.toBe("\u2014");
  expect(s.length).toBeGreaterThan(0);
});

test("formatNumber: uses toLocaleString", () => {
  expect(formatNumber(1234567)).toBe("1,234,567");
  expect(formatNumber(0)).toBe("0");
});

test("formatCompact: large numbers compact", () => {
  const s = formatCompact(1500000);
  expect(s).toMatch(/1\.5M|2M/);
  expect(formatCompact(0)).toBe("0");
});

test("formatRelative: null/undefined → em dash", () => {
  expect(formatRelative(null)).toBe("\u2014");
  expect(formatRelative(undefined)).toBe("\u2014");
});

test("formatRelative: invalid date → em dash", () => {
  expect(formatRelative("not-a-date")).toBe("\u2014");
});

test("formatRelative: past < 60s → 'just now'", () => {
  const d = new Date(Date.now() - 30_000);
  expect(formatRelative(d)).toBe("just now");
});

test("formatRelative: future < 60s → 'soon'", () => {
  const d = new Date(Date.now() + 30_000);
  expect(formatRelative(d)).toBe("soon");
});

test("formatRelative: past minutes → 'Xm ago'", () => {
  const d = new Date(Date.now() - 5 * 60_000);
  expect(formatRelative(d)).toBe("5m ago");
});

test("formatRelative: future minutes → 'in Xm'", () => {
  const d = new Date(Date.now() + 5 * 60_000);
  expect(formatRelative(d)).toBe("in 5m");
});

test("formatRelative: past hours → 'Xh ago'", () => {
  const d = new Date(Date.now() - 3 * 3600_000);
  expect(formatRelative(d)).toBe("3h ago");
});

test("formatRelative: past days → 'Xd ago'", () => {
  const d = new Date(Date.now() - 2 * 86400_000);
  expect(formatRelative(d)).toBe("2d ago");
});

test("formatRelative: boundary 59s vs 60s", () => {
  const justUnder = new Date(Date.now() - 59_000);
  expect(formatRelative(justUnder)).toBe("just now");
});