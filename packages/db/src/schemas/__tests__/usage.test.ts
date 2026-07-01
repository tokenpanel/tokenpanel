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