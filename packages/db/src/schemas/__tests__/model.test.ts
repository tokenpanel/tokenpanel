import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  providerSdkType,
  providerDoc,
  providerCreateInput,
  providerUpdateInput,
  modelEntryDoc,
  modelEntryInput,
  modelDoc,
  modelCreateInput,
  modelUpdateInput,
  modelMetadataInput,
  modelMetadataStored,
  isValidModelMetadataKey,
  setStringRecordEntry,
  createStringRecord,
  MODEL_METADATA_MAX_ENTRIES,
  MODEL_METADATA_KEY_MAX_LEN,
  MODEL_METADATA_VALUE_MAX_LEN,
  fallbackReorderInput,
} from "../model.ts";

const orgId = () => new ObjectId().toHexString();
const validEntry = () => ({
  providerId: orgId(),
  upstreamModelId: "gpt-4o-mini",
});
const validPrice = () => ({
  inputMinorPerMillion: 300,
  outputMinorPerMillion: 600,
});

test("providerSdkType accepts builtin + plugin variants, rejects others", () => {
  expect(providerSdkType.safeParse("openai-compatible").success).toBe(true);
  expect(providerSdkType.safeParse("anthropic-compatible").success).toBe(true);
  expect(providerSdkType.safeParse("plugin:my-plugin_1").success).toBe(true);
  expect(providerSdkType.safeParse("plugin:UPPER").success).toBe(false);
  expect(providerSdkType.safeParse("plugin:bad space").success).toBe(false);
  expect(providerSdkType.safeParse("gemini-compatible").success).toBe(false);
  expect(providerSdkType.safeParse("plugin:").success).toBe(false);
  expect(providerSdkType.safeParse("").success).toBe(false);
});

test("providerCreateInput requires apiKey + url baseUrl", () => {
  const b = {
    name: "OpenAI",
    sdkType: "openai-compatible",
    apiKey: "sk-xxx",
    baseUrl: "https://api.openai.com/v1",
  };
  expect(providerCreateInput.safeParse(b).success).toBe(true);
  expect(providerCreateInput.safeParse({ ...b, baseUrl: "not-a-url" }).success).toBe(false);
  expect(providerCreateInput.safeParse({ ...b, apiKey: "" }).success).toBe(false);
});

test("providerUpdateInput all optional but validates shapes", () => {
  expect(providerUpdateInput.safeParse({}).success).toBe(true);
  expect(providerUpdateInput.safeParse({ name: "X" }).success).toBe(true);
  expect(providerUpdateInput.safeParse({ baseUrl: "bad" }).success).toBe(false);
  expect(providerUpdateInput.safeParse({ active: true }).success).toBe(true);
  expect(providerUpdateInput.safeParse({ active: "yes" }).success).toBe(false);
});

test("providerDoc defaults active true, headers {}", () => {
  const r = providerDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    name: "OpenAI",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "enc",
    baseUrl: "https://api.openai.com/v1",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.active).toBe(true);
  expect(r.headers).toEqual({});
  expect(r.metadata).toEqual({});
});

test("modelEntryDoc applies priority+active defaults", () => {
  const r = modelEntryDoc.parse({
    id: "e1",
    providerId: new ObjectId(),
    upstreamModelId: "x",
  });
  expect(r.priority).toBe(0);
  expect(r.active).toBe(true);
});

test("modelEntryInput coerces providerId string to ObjectId", () => {
  const r = modelEntryInput.safeParse({
    providerId: orgId(),
    upstreamModelId: "x",
  });
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.providerId).toBeInstanceOf(ObjectId);
});

test("modelDoc requires entries min 1 + aliasId regex", () => {
  const b = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    aliasId: "my-gpt_1",
    displayName: "My GPT",
    entries: [{ id: "e1", providerId: new ObjectId(), upstreamModelId: "x" }],
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: validPrice(),
    currency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  expect(modelDoc.safeParse(b).success).toBe(true);
  expect(modelDoc.safeParse({ ...b, aliasId: "MY-GPT" }).success).toBe(false);
  expect(modelDoc.safeParse({ ...b, aliasId: "my.gpt" }).success).toBe(false);
  expect(modelDoc.safeParse({ ...b, entries: [] }).success).toBe(false);
  expect(modelDoc.safeParse({ ...b, currency: "us" }).success).toBe(false);
});

test("modelDoc applies marginBps default 0, active true", () => {
  const r = modelDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    aliasId: "gpt",
    displayName: "GPT",
    entries: [{ id: "e1", providerId: new ObjectId(), upstreamModelId: "x" }],
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: validPrice(),
    currency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.marginBps).toBe(0);
  expect(r.active).toBe(true);
});

test("modelCreateInput requires entries min 1 + price + currency", () => {
  const b = {
    aliasId: "my-gpt",
    displayName: "My GPT",
    entries: [validEntry()],
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: validPrice(),
    currency: "USD",
  };
  expect(modelCreateInput.safeParse(b).success).toBe(true);
  expect(modelCreateInput.safeParse({ ...b, entries: [] }).success).toBe(false);
  expect(modelCreateInput.safeParse({ ...b, aliasId: "BAD" }).success).toBe(false);
  expect(modelCreateInput.safeParse({ ...b, currency: "us" }).success).toBe(false);
  expect(modelCreateInput.safeParse({ ...b, price: { inputMinorPerMillion: 300 } }).success).toBe(false);
});

test("fallbackReorderInput requires id+priority array", () => {
  expect(fallbackReorderInput.safeParse({ entries: [{ id: "e1", priority: 0 }] }).success).toBe(true);
  expect(fallbackReorderInput.safeParse({ entries: [{ id: "e1", priority: -1 }] }).success).toBe(false);
  expect(fallbackReorderInput.safeParse({ entries: [{ id: "", priority: 0 }] }).success).toBe(false);
  expect(fallbackReorderInput.safeParse({ entries: [] }).success).toBe(true);
});

// ─── model metadata (string key/value pairs) ───────────────────────────────

test("isValidModelMetadataKey: accepts normal keys, dots, case-sensitive shapes", () => {
  expect(isValidModelMetadataKey("cost_tier")).toBe(true);
  expect(isValidModelMetadataKey("a")).toBe(true);
  expect(isValidModelMetadataKey("a.b.c")).toBe(true);
  expect(isValidModelMetadataKey("CostTier")).toBe(true);
  expect(isValidModelMetadataKey("x".repeat(MODEL_METADATA_KEY_MAX_LEN))).toBe(true);
});

test("isValidModelMetadataKey: rejects empty, overlong, NUL, CR/LF, leading $, reserved", () => {
  expect(isValidModelMetadataKey("")).toBe(false);
  expect(isValidModelMetadataKey("x".repeat(MODEL_METADATA_KEY_MAX_LEN + 1))).toBe(false);
  expect(isValidModelMetadataKey("a\0b")).toBe(false);
  expect(isValidModelMetadataKey("a\nb")).toBe(false);
  expect(isValidModelMetadataKey("a\rb")).toBe(false);
  expect(isValidModelMetadataKey("$set")).toBe(false);
  expect(isValidModelMetadataKey("__proto__")).toBe(false);
  expect(isValidModelMetadataKey("prototype")).toBe(false);
  expect(isValidModelMetadataKey("constructor")).toBe(false);
});

test("modelMetadataInput: empty object accepted; trims keys; normalizes CR→LF in values", () => {
  const empty = modelMetadataInput.safeParse({});
  expect(empty.success).toBe(true);
  if (empty.success) expect(Object.keys(empty.data)).toEqual([]);

  const r = modelMetadataInput.safeParse({
    "  cost_tier  ": "  gold  ",
    intelligence: "",
    note: "line1\r\nline2\rline3",
  });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.cost_tier).toBe("  gold  ");
    expect(r.data.intelligence).toBe("");
    expect(r.data.note).toBe("line1\nline2\nline3");
  }
  expect(modelMetadataInput.safeParse({ "a\nb": "v" }).success).toBe(false);
});

test("modelMetadataInput / stored: reject Date/Map/RegExp (not empty map)", () => {
  expect(modelMetadataInput.safeParse(new Date()).success).toBe(false);
  expect(modelMetadataInput.safeParse(new Map()).success).toBe(false);
  expect(modelMetadataInput.safeParse(/x/).success).toBe(false);
  expect(modelMetadataStored.safeParse(new Date()).success).toBe(false);
  expect(modelMetadataStored.safeParse(new Map()).success).toBe(false);
  expect(modelMetadataStored.safeParse(/x/).success).toBe(false);
});

test("modelMetadataStored: no write entry/length caps (oversized legacy rehydrates)", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < MODEL_METADATA_MAX_ENTRIES + 5; i++) {
    many[`k${i}`] = "v";
  }
  expect(modelMetadataStored.safeParse(many).success).toBe(true);
  expect(
    modelMetadataStored.safeParse({
      long: "x".repeat(MODEL_METADATA_VALUE_MAX_LEN + 10),
    }).success,
  ).toBe(true);
  // write path still rejects
  expect(modelMetadataInput.safeParse(many).success).toBe(false);
});

test("modelMetadataInput: rejects non-string values", () => {
  expect(modelMetadataInput.safeParse({ a: 1 }).success).toBe(false);
  expect(modelMetadataInput.safeParse({ a: true }).success).toBe(false);
  expect(modelMetadataInput.safeParse({ a: null }).success).toBe(false);
  expect(modelMetadataInput.safeParse({ a: { nested: "x" } }).success).toBe(false);
  expect(modelMetadataInput.safeParse({ a: ["x"] }).success).toBe(false);
});

test("modelMetadataInput: rejects blank/duplicate-normalized/dangerous keys", () => {
  expect(modelMetadataInput.safeParse({ "": "v" }).success).toBe(false);
  expect(modelMetadataInput.safeParse({ "   ": "v" }).success).toBe(false);
  expect(modelMetadataInput.safeParse({ $set: "v" }).success).toBe(false);
  // Avoid object-literal __proto__ special-case; set as own property.
  const protoKey: Record<string, string> = Object.create(null);
  protoKey["__proto__"] = "v";
  expect(modelMetadataInput.safeParse(protoKey).success).toBe(false);
  expect(modelMetadataInput.safeParse({ prototype: "v" }).success).toBe(false);
  expect(modelMetadataInput.safeParse({ constructor: "v" }).success).toBe(false);
  // duplicate after trim
  expect(
    modelMetadataInput.safeParse({ "a": "1", " a ": "2" }).success,
  ).toBe(false);
});

test("modelMetadataInput: rejects overlong key/value and excess pairs", () => {
  expect(
    modelMetadataInput.safeParse({
      ["k".repeat(MODEL_METADATA_KEY_MAX_LEN + 1)]: "v",
    }).success,
  ).toBe(false);
  expect(
    modelMetadataInput.safeParse({
      k: "v".repeat(MODEL_METADATA_VALUE_MAX_LEN + 1),
    }).success,
  ).toBe(false);
  const many: Record<string, string> = {};
  for (let i = 0; i < MODEL_METADATA_MAX_ENTRIES + 1; i++) {
    many[`k${i}`] = "v";
  }
  expect(modelMetadataInput.safeParse(many).success).toBe(false);
  const okMany: Record<string, string> = {};
  for (let i = 0; i < MODEL_METADATA_MAX_ENTRIES; i++) {
    okMany[`k${i}`] = "v";
  }
  expect(modelMetadataInput.safeParse(okMany).success).toBe(true);
});

test("modelCreateInput: accepts string metadata; rejects non-string", () => {
  const b = {
    aliasId: "my-gpt",
    displayName: "My GPT",
    entries: [validEntry()],
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: validPrice(),
    currency: "USD",
  };
  expect(
    modelCreateInput.safeParse({ ...b, metadata: { tier: "gold" } }).success,
  ).toBe(true);
  expect(
    modelCreateInput.safeParse({ ...b, metadata: { tier: 1 } }).success,
  ).toBe(false);
  expect(modelCreateInput.safeParse({ ...b, metadata: {} }).success).toBe(true);
});

test("modelUpdateInput: metadata optional (omit keeps map); empty object clears", () => {
  expect(modelUpdateInput.safeParse({}).success).toBe(true);
  expect(modelUpdateInput.safeParse({ metadata: {} }).success).toBe(true);
  const r = modelUpdateInput.safeParse({ metadata: { a: "b" } });
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.metadata?.a).toBe("b");
  expect(modelUpdateInput.safeParse({ metadata: { a: 1 } }).success).toBe(false);
});

test("modelMetadataStored: preserves own __proto__ key (unlike z.record)", () => {
  const raw = createStringRecord();
  setStringRecordEntry(raw, "__proto__", "legacy");
  setStringRecordEntry(raw, "tier", "gold");
  const r = modelMetadataStored.safeParse(raw);
  expect(r.success).toBe(true);
  if (r.success) {
    expect(Object.prototype.hasOwnProperty.call(r.data, "__proto__")).toBe(true);
    expect(r.data["__proto__"]).toBe("legacy");
    expect(r.data.tier).toBe("gold");
  }
});

test("modelDoc: metadata defaults to empty and requires string values", () => {
  const base = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    aliasId: "gpt",
    displayName: "GPT",
    entries: [{ id: "e1", providerId: new ObjectId(), upstreamModelId: "x" }],
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: validPrice(),
    currency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const r = modelDoc.parse(base);
  expect(Object.keys(r.metadata)).toEqual([]);
  expect(modelDoc.safeParse({ ...base, metadata: { a: "b" } }).success).toBe(true);
  expect(modelDoc.safeParse({ ...base, metadata: { a: 1 } }).success).toBe(false);
});