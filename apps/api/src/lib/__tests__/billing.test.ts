import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  BillingError,
  computeCharges,
  checkModelAccess,
} from "../billing.ts";
import type { ModelDoc, ModelEntryDoc } from "@tokenpanel/db";

function entry(over: Partial<ModelEntryDoc> = {}): ModelEntryDoc {
  return {
    id: "e1",
    providerId: new ObjectId(),
    upstreamModelId: "gpt-4o",
    priority: 0,
    active: true,
    ...over,
  };
}

function model(over: Partial<ModelDoc> = {}): ModelDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    aliasId: "my-gpt",
    displayName: "My GPT",
    description: null,
    entries: [entry()],
    reasoning: false,
    toolCall: false,
    structuredOutput: undefined,
    temperature: undefined,
    attachment: false,
    interleaved: undefined,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    status: undefined,
    price: {
      inputMinorPerMillion: 300,
      outputMinorPerMillion: 600,
    },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

test("computeCharges: basic input+output, ceil per bucket", () => {
  const m = model();
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.priceMinor).toBe(
    Math.ceil((1000 * 300) / 1_000_000) + Math.ceil((500 * 600) / 1_000_000),
  );
  expect(c.costMinor).toBe(0);
  expect(c.currency).toBe("USD");
});

test("computeCharges: price uses entry override when present", () => {
  const m = model();
  const e = entry({
    price: {
      inputMinorPerMillion: 1000,
      outputMinorPerMillion: 2000,
    },
  });
  const c = computeCharges({
    entry: e,
    model: m,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.priceMinor).toBe(
    Math.ceil((1000 * 1000) / 1_000_000) + Math.ceil((500 * 2000) / 1_000_000),
  );
});

test("computeCharges: cost uses entry.cost when present", () => {
  const m = model();
  const e = entry({
    cost: {
      inputMinorPerMillion: 100,
      outputMinorPerMillion: 200,
    },
  });
  const c = computeCharges({
    entry: e,
    model: m,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.costMinor).toBe(
    Math.ceil((1000 * 100) / 1_000_000) + Math.ceil((500 * 200) / 1_000_000),
  );
});

test("computeCharges: cost = 0 when no entry.cost schedule", () => {
  const c = computeCharges({
    entry: entry(),
    model: model(),
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.costMinor).toBe(0);
});

test("computeCharges: includes reasoning + cache tokens with ceil", () => {
  const m = model({
    price: {
      inputMinorPerMillion: 300,
      outputMinorPerMillion: 600,
      reasoningMinorPerMillion: 900,
      cacheReadMinorPerMillion: 30,
      cacheWriteMinorPerMillion: 40,
    },
  });
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 1000,
      completionTokens: 500,
      reasoningTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 1850,
    },
  });
  expect(c.priceMinor).toBe(
    Math.ceil((1000 * 300) / 1_000_000) +
      Math.ceil((500 * 600) / 1_000_000) +
      Math.ceil((200 * 900) / 1_000_000) +
      Math.ceil((100 * 30) / 1_000_000) +
      Math.ceil((50 * 40) / 1_000_000),
  );
});

test("computeCharges: zero tokens → zero charges", () => {
  const c = computeCharges({
    entry: entry(),
    model: model(),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  expect(c.priceMinor).toBe(0);
  expect(c.costMinor).toBe(0);
});

test("computeCharges: missing optional price fields contribute 0", () => {
  const m = model({
    price: { inputMinorPerMillion: 300, outputMinorPerMillion: 600 },
  });
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 1000,
      completionTokens: 500,
      reasoningTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 1850,
    },
  });
  expect(c.priceMinor).toBe(
    Math.ceil((1000 * 300) / 1_000_000) + Math.ceil((500 * 600) / 1_000_000),
  );
});

test("checkModelAccess: empty whitelist passes", async () => {
  await expect(checkModelAccess([], "gpt")).resolves.toBeUndefined();
});

test("checkModelAccess: included alias passes", async () => {
  await expect(checkModelAccess(["gpt", "claude"], "gpt")).resolves.toBeUndefined();
});

test("checkModelAccess: excluded alias throws BillingError 403", async () => {
  await expect(checkModelAccess(["claude"], "gpt")).rejects.toMatchObject({
    status: 403,
    code: "model_not_allowed",
  });
  await expect(checkModelAccess(["claude"], "gpt")).rejects.toBeInstanceOf(BillingError);
});

test("BillingError carries status/code/message/extra", () => {
  const e = new BillingError(429, "rate_limited", "too many", { retryAfterSeconds: 60 });
  expect(e.status).toBe(429);
  expect(e.code).toBe("rate_limited");
  expect(e.message).toBe("too many");
  expect(e.extra).toEqual({ retryAfterSeconds: 60 });
  expect(e).toBeInstanceOf(Error);
});