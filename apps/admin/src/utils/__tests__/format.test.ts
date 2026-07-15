import { test, expect } from "bun:test";
import {
  formatMoney,
  formatDate,
  formatNumber,
  formatCompact,
  formatRelative,
  currencyExponent,
} from "../format.ts";

test("formatMoney: USD positive includes ISO code", () => {
  expect(formatMoney(12345, "USD")).toBe("$123.45 USD");
  expect(formatMoney(100, "USD")).toBe("$1.00 USD");
  expect(formatMoney(0, "USD")).toBe("$0.00 USD");
});

test("formatMoney: negative adds leading minus", () => {
  expect(formatMoney(-12345, "USD")).toBe("-$123.45 USD");
  expect(formatMoney(-100, "USD")).toBe("-$1.00 USD");
});

test("formatMoney: dollar currencies are disambiguated by ISO code", () => {
  expect(formatMoney(12345, "AUD")).toBe("$123.45 AUD");
  expect(formatMoney(12345, "CAD")).toBe("$123.45 CAD");
  expect(formatMoney(12345, "NZD")).toBe("$123.45 NZD");
  expect(formatMoney(12345, "HKD")).toBe("$123.45 HKD");
  expect(formatMoney(12345, "SGD")).toBe("$123.45 SGD");
});

test("formatMoney: EUR/GBP/INR use symbol + 2 decimals + code", () => {
  expect(formatMoney(12345, "EUR")).toBe("\u20ac123.45 EUR");
  expect(formatMoney(12345, "GBP")).toBe("\u00a3123.45 GBP");
  expect(formatMoney(12345, "INR")).toBe("\u20b9123.45 INR");
});

test("formatMoney: JPY zero-decimal minor units (1 minor = 1 yen)", () => {
  expect(formatMoney(12345, "JPY")).toBe("\u00a512345 JPY");
  expect(formatMoney(100, "JPY")).toBe("\u00a5100 JPY");
  expect(formatMoney(0, "JPY")).toBe("\u00a50 JPY");
});

test("formatMoney: three-decimal currencies (KWD)", () => {
  // 1.234 KWD = 1234 minor
  expect(formatMoney(1234, "KWD")).toBe("1.234 KWD");
  expect(formatMoney(1, "KWD")).toBe("0.001 KWD");
});

test("currencyExponent: zero-decimal BIF/VUV (not /100)", () => {
  expect(currencyExponent("BIF")).toBe(0);
  expect(currencyExponent("VUV")).toBe(0);
  expect(formatMoney(1234, "BIF")).toBe("1234 BIF");
  expect(formatMoney(50, "VUV")).toBe("50 VUV");
});

test("currencyExponent: four-decimal CLF", () => {
  expect(currencyExponent("CLF")).toBe(4);
  // 1.2345 CLF = 12345 minor
  expect(formatMoney(12345, "CLF")).toBe("1.2345 CLF");
  expect(formatMoney(1, "CLF")).toBe("0.0001 CLF");
});

test("formatMoney: unknown currency → 'X.XX CODE' fallback", () => {
  expect(formatMoney(12345, "XYZ")).toBe("123.45 XYZ");
  expect(formatMoney(0, "ABC")).toBe("0.00 ABC");
});

test("formatMoney: minor < 10 pads with leading zero", () => {
  expect(formatMoney(105, "USD")).toBe("$1.05 USD");
  expect(formatMoney(5, "USD")).toBe("$0.05 USD");
});

test("formatMoney: currency uppercased", () => {
  expect(formatMoney(12345, "usd")).toBe("$123.45 USD");
  expect(formatMoney(12345, "jpy")).toBe("\u00a512345 JPY");
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