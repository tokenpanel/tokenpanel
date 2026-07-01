import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { parseObjectIdParam, addInterval } from "../customers.ts";

test("parseObjectIdParam: valid ObjectId → ObjectId", () => {
  const hex = new ObjectId().toHexString();
  const r = parseObjectIdParam(hex);
  expect(r).toBeInstanceOf(ObjectId);
  expect(r?.toHexString()).toBe(hex);
});

test("parseObjectIdParam: invalid → null", () => {
  expect(parseObjectIdParam("not-an-id")).toBeNull();
  expect(parseObjectIdParam("")).toBeNull();
  expect(parseObjectIdParam("507f1f77bcf86cd79943901")).toBeNull();
});

test("addInterval: day adds count days (UTC)", () => {
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const r = addInterval(d, "day", 5);
  expect(r.getUTCDate()).toBe(6);
  expect(r.getUTCMonth()).toBe(0);
});

test("addInterval: week adds count*7 days", () => {
  const d = new Date(Date.UTC(2026, 0, 1));
  const r = addInterval(d, "week", 2);
  expect(r.getUTCDate()).toBe(15);
});

test("addInterval: month advances month, handles year overflow", () => {
  const d = new Date(Date.UTC(2026, 11, 15));
  const r = addInterval(d, "month", 2);
  expect(r.getUTCMonth()).toBe(1);
  expect(r.getUTCFullYear()).toBe(2027);
});

test("addInterval: year advances year", () => {
  const d = new Date(Date.UTC(2026, 5, 1));
  const r = addInterval(d, "year", 3);
  expect(r.getUTCFullYear()).toBe(2029);
});

test("addInterval: unknown interval returns same date (no-op)", () => {
  const d = new Date(Date.UTC(2026, 0, 1));
  const r = addInterval(d, "decade", 10);
  expect(r.getTime()).toBe(d.getTime());
});

test("addInterval: does not mutate input date", () => {
  const d = new Date(Date.UTC(2026, 0, 1));
  const orig = d.getTime();
  addInterval(d, "month", 1);
  expect(d.getTime()).toBe(orig);
});

test("addInterval: month overflow from Jan 31 rolls forward (JS month math)", () => {
  const d = new Date(Date.UTC(2026, 0, 31));
  const r = addInterval(d, "month", 1);
  expect(r.getUTCFullYear()).toBe(2026);
});