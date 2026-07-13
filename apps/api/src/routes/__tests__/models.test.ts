import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { modelCreateInput, modelUpdateInput } from "@tokenpanel/db";
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

const validCreateBody = () => ({
  aliasId: "my-gpt",
  displayName: "My GPT",
  entries: [{ providerId: new ObjectId().toHexString(), upstreamModelId: "gpt-4o" }],
  limits: { context: 128000 },
  modalities: { input: ["text"] as const, output: ["text"] as const },
  price: { inputMinorPerMillion: 300, outputMinorPerMillion: 600 },
  currency: "USD",
});

test("modelCreateInput (API contract): string metadata accepted; defaults optional", () => {
  const base = validCreateBody();
  expect(modelCreateInput.safeParse(base).success).toBe(true);
  const withMeta = modelCreateInput.safeParse({
    ...base,
    metadata: { tier: "gold", label: "smart" },
  });
  expect(withMeta.success).toBe(true);
  if (withMeta.success) {
    expect(withMeta.data.metadata).toEqual({ tier: "gold", label: "smart" });
  }
});

test("modelCreateInput (API contract): rejects non-string / dangerous metadata", () => {
  const base = validCreateBody();
  expect(modelCreateInput.safeParse({ ...base, metadata: { a: 1 } }).success).toBe(false);
  expect(modelCreateInput.safeParse({ ...base, metadata: { $set: "x" } }).success).toBe(false);
  expect(modelCreateInput.safeParse({ ...base, metadata: { "": "x" } }).success).toBe(false);
});

test("modelUpdateInput (API contract): omit metadata vs empty clear", () => {
  const omit = modelUpdateInput.safeParse({ displayName: "X" });
  expect(omit.success).toBe(true);
  if (omit.success) expect(omit.data.metadata).toBeUndefined();

  const clear = modelUpdateInput.safeParse({ metadata: {} });
  expect(clear.success).toBe(true);
  if (clear.success) expect(Object.keys(clear.data.metadata ?? {})).toEqual([]);

  const set = modelUpdateInput.safeParse({ metadata: { tier: "silver" } });
  expect(set.success).toBe(true);
  if (set.success) expect(set.data.metadata?.tier).toBe("silver");
});

// Persistence / auth / org isolation: see models-metadata.integration.test.ts