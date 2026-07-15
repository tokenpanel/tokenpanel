import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  usageRecordDoc,
  usageRecordCreateInput,
  rateLimitCounterDoc,
  rateLimitCounterCreateInput,
} from "../usage.ts";

const custId = () => new ObjectId().toHexString();
const provId = () => new ObjectId().toHexString();

test("usageRecordDoc requires non-negative token counts + status range + protocol enum", () => {
  const b = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    modelAliasId: "gpt",
    providerId: new ObjectId(),
    upstreamModelId: "gpt-4o",
    protocol: "openai",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costMinor: 10,
    priceMinor: 20,
    currency: "USD",
    status: 200,
    occurredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  expect(usageRecordDoc.safeParse(b).success).toBe(true);
  expect(usageRecordDoc.safeParse({ ...b, promptTokens: -1 }).success).toBe(false);
  expect(usageRecordDoc.safeParse({ ...b, status: 99 }).success).toBe(false);
  expect(usageRecordDoc.safeParse({ ...b, status: 600 }).success).toBe(false);
  expect(usageRecordDoc.safeParse({ ...b, protocol: "gemini" }).success).toBe(false);
  expect(usageRecordDoc.safeParse({ ...b, costMinor: -1 }).success).toBe(false);
  // Safe-integer bound: reject values that would poison counters/sums.
  expect(
    usageRecordDoc.safeParse({ ...b, promptTokens: Number.MAX_SAFE_INTEGER + 1 })
      .success,
  ).toBe(false);
  expect(
    usageRecordDoc.safeParse({ ...b, totalTokens: Number.MAX_SAFE_INTEGER })
      .success,
  ).toBe(true);
});

test("usageRecordDoc defaults reasoning/cache tokens 0, billed true, durationMs 0", () => {
  const r = usageRecordDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    modelAliasId: "gpt",
    providerId: new ObjectId(),
    upstreamModelId: "gpt-4o",
    protocol: "openai",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costMinor: 10,
    priceMinor: 20,
    currency: "USD",
    status: 200,
    occurredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.reasoningTokens).toBe(0);
  expect(r.cacheReadTokens).toBe(0);
  expect(r.cacheWriteTokens).toBe(0);
  expect(r.billed).toBe(true);
  expect(r.durationMs).toBe(0);
  expect(r.actorKind).toBe("customer_key");
  expect(r.customerId).toBeInstanceOf(ObjectId);
  expect(r.managementKeyId).toBeUndefined();
  expect(r.customerEmail).toBeUndefined();
});

test("usageRecordDoc allows null customerId for org-internal management calls", () => {
  const b = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: null,
    apiKeyId: null,
    actorKind: "management_key" as const,
    managementKeyId: new ObjectId(),
    modelAliasId: "gpt",
    providerId: new ObjectId(),
    upstreamModelId: "gpt-4o",
    protocol: "openai",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costMinor: 10,
    priceMinor: 0,
    currency: "USD",
    status: 200,
    billed: false,
    occurredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const r = usageRecordDoc.parse(b);
  expect(r.customerId).toBeNull();
  expect(r.actorKind).toBe("management_key");
  expect(r.managementKeyId).toBeInstanceOf(ObjectId);
  expect(r.billed).toBe(false);
});

test("usageRecordDoc management-attributed call carries customerId + customerEmail snapshot", () => {
  const r = usageRecordDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    actorKind: "management_key",
    managementKeyId: new ObjectId(),
    customerEmail: "alice@example.com",
    modelAliasId: "gpt",
    providerId: new ObjectId(),
    upstreamModelId: "gpt-4o",
    protocol: "openai",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costMinor: 10,
    priceMinor: 20,
    currency: "USD",
    status: 200,
    occurredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.actorKind).toBe("management_key");
  expect(r.customerEmail).toBe("alice@example.com");
});

test("usageRecordDoc rejects unknown actorKind", () => {
  expect(
    usageRecordDoc.safeParse({
      _id: new ObjectId(),
      organizationId: new ObjectId(),
      customerId: new ObjectId(),
      actorKind: "anonymous",
      modelAliasId: "gpt",
      providerId: new ObjectId(),
      upstreamModelId: "gpt-4o",
      protocol: "openai",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costMinor: 10,
      priceMinor: 20,
      currency: "USD",
      status: 200,
      occurredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).success,
  ).toBe(false);
});

test("usageRecordCreateInput accepts null customerId", () => {
  const r = usageRecordCreateInput.parse({
    customerId: null,
    actorKind: "management_key",
    managementKeyId: new ObjectId().toHexString(),
    modelAliasId: "gpt",
    providerId: provId(),
    upstreamModelId: "gpt-4o",
    protocol: "anthropic",
    promptTokens: 100,
    completionTokens: 50,
    costMinor: 0,
    priceMinor: 0,
    currency: "USD",
    status: 200,
  });
  expect(r.customerId).toBeNull();
  expect(r.actorKind).toBe("management_key");
});

test("usageRecordCreateInput coerces occurredAt from string, optional tokens default-free", () => {
  const r = usageRecordCreateInput.parse({
    customerId: custId(),
    modelAliasId: "gpt",
    providerId: provId(),
    upstreamModelId: "gpt-4o",
    protocol: "anthropic",
    promptTokens: 100,
    completionTokens: 50,
    costMinor: 10,
    priceMinor: 20,
    currency: "USD",
    status: 200,
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  expect(r.occurredAt).toBeInstanceOf(Date);
  expect(r.reasoningTokens).toBeUndefined();
});

test("rateLimitCounterDoc requires positive windowSeconds + Date bucketStart", () => {
  const b = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    dimension: "tokens",
    windowSeconds: 3600,
    bucketStart: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  expect(rateLimitCounterDoc.safeParse(b).success).toBe(true);
  expect(rateLimitCounterDoc.safeParse({ ...b, windowSeconds: 0 }).success).toBe(false);
  expect(rateLimitCounterDoc.safeParse({ ...b, windowSeconds: -1 }).success).toBe(false);
  expect(rateLimitCounterDoc.safeParse({ ...b, dimension: "bad" }).success).toBe(false);
});

test("rateLimitCounterDoc defaults count 0", () => {
  const r = rateLimitCounterDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    dimension: "requests",
    windowSeconds: 3600,
    bucketStart: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.count).toBe(0);
});

test("rateLimitCounterCreateInput coerces bucketStart from string", () => {
  const r = rateLimitCounterCreateInput.parse({
    customerId: custId(),
    dimension: "tokens",
    windowSeconds: 3600,
    bucketStart: "2026-01-01T00:00:00.000Z",
  });
  expect(r.bucketStart).toBeInstanceOf(Date);
  expect(r.count).toBeUndefined();
});