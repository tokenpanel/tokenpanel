import { test, expect } from "bun:test";
import {
  formatMicros,
  formatMicrosFixed,
  columnDecimals,
  formatDate,
  formatNumber,
  formatCompact,
  formatRelative,
  currencyExponent,
} from "../format.ts";

test("currencyExponent: zero-decimal BIF/VUV (not /100)", () => {
  expect(currencyExponent("BIF")).toBe(0);
  expect(currencyExponent("VUV")).toBe(0);
});

test("currencyExponent: four-decimal CLF", () => {
  expect(currencyExponent("CLF")).toBe(4);
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

test("formatMicros: whole-cent amounts render at standard 2dp (USD)", () => {
  expect(formatMicros(150_000, "USD")).toBe("$0.15 USD"); // $0.15
  expect(formatMicros(3_000_000, "USD")).toBe("$3.00 USD"); // $3
  expect(formatMicros(1_234_567, "USD")).toBe("$1.23 USD"); // $1.234567 → 2dp
  expect(formatMicros(0, "USD")).toBe("$0.00 USD");
  expect(formatMicros(-150_000, "USD")).toBe("-$0.15 USD");
});

test("formatMicros: groups thousands in the whole part", () => {
  expect(formatMicros(3_325_960_000, "USD")).toBe("$3,325.96 USD");
  expect(formatMicros(-1_234_567_000_000, "USD")).toBe("-$1,234,567.00 USD");
  expect(formatMicros(999_000_000, "USD")).toBe("$999.00 USD");
  expect(formatMicros(12_345_000_000, "JPY")).toBe("\u00a512,345 JPY");
});

test("formatMicros: sub-cent amounts expand so they never show $0.00", () => {
  expect(formatMicros(300, "USD")).toBe("$0.0003 USD"); // $0.0003
  expect(formatMicros(1, "USD")).toBe("$0.000001 USD");
  expect(formatMicros(5_000, "USD")).toBe("$0.005 USD"); // $0.005, trimmed
});

test("formatMicros: zero-decimal currency (JPY) sub-unit expands", () => {
  expect(formatMicros(1_000_000, "JPY")).toBe("\u00a51 JPY"); // 1 yen
  expect(formatMicros(500_000, "JPY")).toBe("\u00a50.5 JPY"); // sub-yen, trimmed
});

test("formatMicros: three-decimal currency (KWD)", () => {
  expect(formatMicros(1_000, "KWD")).toBe("0.001 KWD"); // 1 fils
  expect(formatMicros(1_500_000, "KWD")).toBe("1.500 KWD");
});
test("formatMicrosFixed: one precision for a column, rounded in micros", () => {
  expect(formatMicrosFixed(-4_916, "USD", 4)).toBe("-$0.0049 USD");
  expect(formatMicrosFixed(-20_000, "USD", 4)).toBe("-$0.0200 USD");
  expect(formatMicrosFixed(1_234_567_890, "USD", 2)).toBe("$1,234.57 USD");
  expect(formatMicrosFixed(500_000, "JPY", 0)).toBe("¥1 JPY");
});

test("columnDecimals: expands only as far as the smallest amount needs (max 4)", () => {
  expect(columnDecimals([-20_000, -10_000], "USD")).toBe(2);
  expect(columnDecimals([-4_916, -20_000], "USD")).toBe(3);
  expect(columnDecimals([-752, -20_000], "USD")).toBe(4);
  expect(columnDecimals([-1, 5_000_000], "USD")).toBe(4);
});
