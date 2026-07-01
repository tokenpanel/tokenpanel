import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { genEntryId, normalizeEntries } from "../models.ts";

test("genEntryId: returns 12-char hex string", () => {
  const id = genEntryId();
  expect(id).toHaveLength(12);
  expect(/^[0-9a-f]+$/.test(id)).toBe(true);
});

test("genEntryId: stable within process (timestamp+machine slice)", () => {
  const id = genEntryId();
  expect(id).toHaveLength(12);
  expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  const id2 = genEntryId();
  expect(id2).toHaveLength(12);
});

test("normalizeEntries: applies id/priority/active defaults, preserves overrides", () => {
  const entries = [
    { providerId: new ObjectId(), upstreamModelId: "a" },
    { providerId: new ObjectId(), upstreamModelId: "b", id: "fixed", priority: 5, active: false },
  ];
  const out = normalizeEntries(entries);
  expect(out).toHaveLength(2);
  expect(out[0]?.id).toHaveLength(12);
  expect(out[0]?.priority).toBe(0);
  expect(out[0]?.active).toBe(true);
  expect(out[1]?.id).toBe("fixed");
  expect(out[1]?.priority).toBe(5);
  expect(out[1]?.active).toBe(false);
});

test("normalizeEntries: priority defaults to index for multiple entries", () => {
  const entries = [
    { providerId: new ObjectId(), upstreamModelId: "a" },
    { providerId: new ObjectId(), upstreamModelId: "b" },
    { providerId: new ObjectId(), upstreamModelId: "c" },
  ];
  const out = normalizeEntries(entries);
  expect(out.map((e) => e.priority)).toEqual([0, 1, 2]);
});

test("normalizeEntries: preserves cost/price overrides", () => {
  const price = { inputMinorPerMillion: 300, outputMinorPerMillion: 600 };
  const out = normalizeEntries([{ providerId: new ObjectId(), upstreamModelId: "x", price }]);
  expect(out[0]?.price).toEqual(price);
});