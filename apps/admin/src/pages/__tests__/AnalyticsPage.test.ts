import { test, expect } from "bun:test";
import { isoDate, defaultFrom, defaultTo } from "../AnalyticsPage.tsx";

test("isoDate: yyyy-mm-dd format with zero-padding", () => {
  expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  expect(isoDate(new Date(2026, 10, 25))).toBe("2026-11-25");
  expect(isoDate(new Date(2026, 5, 1))).toBe("2026-06-01");
});

test("defaultTo: today's iso date", () => {
  const today = new Date();
  expect(defaultTo()).toBe(isoDate(today));
});

test("defaultFrom: 29 days before today", () => {
  const from = defaultFrom();
  const expected = new Date();
  expected.setDate(expected.getDate() - 29);
  expect(from).toBe(isoDate(expected));
});

test("defaultFrom is before defaultTo", () => {
  expect(defaultFrom() <= defaultTo()).toBe(true);
});