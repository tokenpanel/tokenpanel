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