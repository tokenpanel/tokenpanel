import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  BillingError,
  applyTokenSchedule,
  computeCharges,
  checkModelAccess,
  estimatePromptTokens,
  worstCaseActiveEntryPrice,
  resolveCompletionCap,
  DEFAULT_COMPLETION_CAP,
} from "../billing.ts";
import type { ModelDoc, ModelEntryDoc } from "@tokenpanel/db";
import type { ChatMessage } from "../../providers/index.ts";

function entry(over: Partial<ModelEntryDoc> = {}): ModelEntryDoc {
  return {
    id: "e1",
    providerId: new ObjectId(),
    upstreamModelId: "gpt-4o",
    priority: 0,
    active: true,
    ...over,
  } as ModelEntryDoc;
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
      inputUnitsPerMillion: 300,
      outputUnitsPerMillion: 600,
    },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as ModelDoc;
}

test("applyTokenSchedule: non-reasoning output + reasoning tier", () => {
  const amount = applyTokenSchedule(
    {
      inputUnitsPerMillion: 1_000_000,
      outputUnitsPerMillion: 2_000_000,
      reasoningUnitsPerMillion: 4_000_000,
    },
    {
      promptTokens: 1,
      completionTokens: 3, // includes 1 reasoning
      reasoningTokens: 1,
      totalTokens: 4,
    },
  );
  // 1*1 + 2*2 + 1*4 = 1+4+4 = 9 (rates are per million; ceil of exact)
  expect(amount).toBe(1 + 4 + 4);
});

test("computeCharges: basic input+output, ceil per bucket", () => {
  const m = model();
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.priceUnits).toBe(
    Math.ceil((1000 * 300) / 1_000_000) + Math.ceil((500 * 600) / 1_000_000),
  );
  expect(c.costUnits).toBe(0);
  expect(c.currency).toBe("USD");
});

test("computeCharges: price uses entry override when present", () => {
  const m = model();
  const e = entry({
    price: {
      inputUnitsPerMillion: 1000,
      outputUnitsPerMillion: 2000,
    },
  });
  const c = computeCharges({
    entry: e,
    model: m,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.priceUnits).toBe(
    Math.ceil((1000 * 1000) / 1_000_000) + Math.ceil((500 * 2000) / 1_000_000),
  );
});

test("computeCharges: cost uses entry.cost when present", () => {
  const m = model();
  const e = entry({
    cost: {
      inputUnitsPerMillion: 100,
      outputUnitsPerMillion: 200,
    },
  });
  const c = computeCharges({
    entry: e,
    model: m,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.costUnits).toBe(
    Math.ceil((1000 * 100) / 1_000_000) + Math.ceil((500 * 200) / 1_000_000),
  );
});

test("computeCharges: cost = 0 when no entry.cost schedule", () => {
  const c = computeCharges({
    entry: entry(),
    model: model(),
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  });
  expect(c.costUnits).toBe(0);
});

test("computeCharges: reasoning is inside completion — no double charge", () => {
  const m = model({
    price: {
      inputUnitsPerMillion: 300,
      outputUnitsPerMillion: 600,
      reasoningUnitsPerMillion: 900,
      cacheReadUnitsPerMillion: 30,
      cacheWriteUnitsPerMillion: 40,
    },
  });
  // completion=500 includes reasoning=200 → bill 300@output + 200@reasoning.
  // subset: prompt=1000 includes cacheRead=100 + cacheWrite=50 → uncached 850.
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 1000,
      completionTokens: 500,
      reasoningTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 1500,
      cacheAccounting: "subset",
    },
  });
  expect(c.priceUnits).toBe(
    Math.ceil((850 * 300) / 1_000_000) + // uncached prompt
      Math.ceil((300 * 600) / 1_000_000) + // non-reasoning output only
      Math.ceil((200 * 900) / 1_000_000) +
      Math.ceil((100 * 30) / 1_000_000) +
      Math.ceil((50 * 40) / 1_000_000),
  );
});

test("computeCharges: OpenAI subset cache — uncached+cache tier not double-billed", () => {
  // Reproduction: full prompt@input + cache@tier = 1050; correct subset = 550.
  const m = model({
    price: {
      inputUnitsPerMillion: 1_000_000,
      outputUnitsPerMillion: 0,
      cacheReadUnitsPerMillion: 100_000,
    },
  });
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 1000,
      completionTokens: 0,
      cacheReadTokens: 500,
      totalTokens: 1000,
      cacheAccounting: "subset",
    },
  });
  // 500 uncached * 1 + 500 cached * 0.1 = 500 + 50 = 550
  expect(c.priceUnits).toBe(550);
  expect(c.priceUnits).not.toBe(1050);
});

test("computeCharges: Anthropic additive cache even when cache < input", () => {
  // Amount heuristic would peel to 550; Anthropic requires 1000+500 = 1050.
  const m = model({
    price: {
      inputUnitsPerMillion: 1_000_000,
      outputUnitsPerMillion: 0,
      cacheReadUnitsPerMillion: 100_000,
    },
  });
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 1000,
      completionTokens: 0,
      cacheReadTokens: 500,
      totalTokens: 1000,
      cacheAccounting: "additive",
    },
  });
  // 1000*1 + 500*0.1 = 1000 + 50 = 1050
  expect(c.priceUnits).toBe(1050);
});

test("computeCharges: protocol override stamps additive without usage field", () => {
  const m = model({
    price: {
      inputUnitsPerMillion: 1_000_000,
      outputUnitsPerMillion: 0,
      cacheReadUnitsPerMillion: 100_000,
    },
  });
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 1000,
      completionTokens: 0,
      cacheReadTokens: 500,
      totalTokens: 1000,
      // no cacheAccounting on usage
    },
    cacheAccounting: "additive",
  });
  expect(c.priceUnits).toBe(1050);
});

test("computeCharges: no reasoning rate falls back to full completion at output", () => {
  const m = model({
    price: {
      inputUnitsPerMillion: 300,
      outputUnitsPerMillion: 600,
      // no reasoningUnitsPerMillion
    },
  });
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 1000,
      completionTokens: 500,
      reasoningTokens: 200,
      totalTokens: 1500,
    },
  });
  // reasoning rate defaults to output rate → full completion charged once.
  expect(c.priceUnits).toBe(
    Math.ceil((1000 * 300) / 1_000_000) + Math.ceil((500 * 600) / 1_000_000),
  );
});

test("computeCharges: reasoning > completion clamps (never negative non-reasoning)", () => {
  const m = model({
    price: {
      inputUnitsPerMillion: 0,
      outputUnitsPerMillion: 1000,
      reasoningUnitsPerMillion: 2000,
    },
  });
  const c = computeCharges({
    entry: entry(),
    model: m,
    usage: {
      promptTokens: 0,
      completionTokens: 100,
      reasoningTokens: 150, // provider bug — clamp to 100
      totalTokens: 100,
    },
  });
  expect(c.priceUnits).toBe(Math.ceil((100 * 2000) / 1_000_000));
});

test("computeCharges: zero tokens → zero charges", () => {
  const c = computeCharges({
    entry: entry(),
    model: model(),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  expect(c.priceUnits).toBe(0);
  expect(c.costUnits).toBe(0);
});

test("computeCharges: missing optional price fields contribute 0", () => {
  const m = model({
    price: { inputUnitsPerMillion: 300, outputUnitsPerMillion: 600 },
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
  expect(c.priceUnits).toBe(
    Math.ceil((1000 * 300) / 1_000_000) + Math.ceil((500 * 600) / 1_000_000),
  );
});

test("checkModelAccess: empty whitelist passes", async () => {
  await expect(checkModelAccess([], "gpt")).resolves.toBeUndefined();
});

test("checkModelAccess: included alias passes", async () => {
  await expect(checkModelAccess(["gpt", "claude"], "gpt")).resolves.toBeUndefined();
});

test("checkModelAccess: excluded alias throws AppError model_not_allowed", async () => {
  await expect(checkModelAccess(["claude"], "gpt")).rejects.toMatchObject({
    _tag: "AuthorizationError",
    code: "model_not_allowed",
  });
});

test("BillingError compat maps to AppError tags", () => {
  const e = new BillingError(429, "rate_limited", "too many", { retryAfterSeconds: 60 });
  expect(e.status).toBe(429);
  expect(e.code).toBe("rate_limited");
  expect(e.message).toBe("too many");
  expect(e.extra).toEqual({ retryAfterSeconds: 60 });
  expect(e).toBeInstanceOf(Error);
  const app = e.toAppError();
  expect(app._tag).toBe("RateLimitExceededError");
  expect(app.code).toBe("rate_limited");
});

// estimatePromptTokens drives the conservative pre-call balance/limit check
// (ksx). It must over-estimate so limits are enforced before the paid call.

test("estimatePromptTokens: string content → ceil(chars/4), min 1", () => {
  expect(estimatePromptTokens([{ role: "user", content: "a" }])).toBe(1);
  expect(estimatePromptTokens([{ role: "user", content: "abcdefgh" }])).toBe(2);
});

test("estimatePromptTokens: sums text across multiple messages", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "abcd" },
    { role: "user", content: "efgh" },
  ];
  expect(estimatePromptTokens(msgs)).toBe(2);
});

test("estimatePromptTokens: array text parts contribute their text length", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "abcd" }, { type: "text", text: "efgh" }] },
  ];
  expect(estimatePromptTokens(msgs)).toBe(2);
});

test("estimatePromptTokens: non-text parts add a fixed overhead (image/audio)", () => {
  const textOnly = estimatePromptTokens([{ role: "user", content: "abcd" }]);
  const withImage = estimatePromptTokens([
    { role: "user", content: [{ type: "text", text: "abcd" }, { type: "image_url", imageUrl: { url: "x" } }] },
  ]);
  expect(withImage).toBe(textOnly + 768);
});

test("estimatePromptTokens: empty content still returns at least 1", () => {
  expect(estimatePromptTokens([{ role: "user", content: "" }])).toBe(1);
  expect(estimatePromptTokens([{ role: "user", content: [] }])).toBe(1);
});

// worstCaseActiveEntryPrice + resolveCompletionCap back the conservative
// pre-flight spend estimate (tokenpanel-ygv). Settlement charges
// entry.price ?? model.price, so a pricier fallback entry must be reserved
// against; and OpenAI requests may omit max_tokens, so the completion cap
// must fall back to model.limits.output or a default — not zero.

test("worstCaseActiveEntryPrice: floor = model.price when no entry overrides", () => {
  const m = model();
  const p = worstCaseActiveEntryPrice(m);
  expect(p.inputUnitsPerMillion).toBe(m.price.inputUnitsPerMillion);
  expect(p.outputUnitsPerMillion).toBe(m.price.outputUnitsPerMillion);
});

test("worstCaseActiveEntryPrice: picks max across active entry overrides", () => {
  const m = model({
    price: { inputUnitsPerMillion: 300, outputUnitsPerMillion: 600 },
    entries: [
      entry({ id: "e1", priority: 0, price: { inputUnitsPerMillion: 1000, outputUnitsPerMillion: 2000 } }),
      entry({ id: "e2", priority: 1, price: { inputUnitsPerMillion: 500, outputUnitsPerMillion: 9000 } }),
    ],
  });
  const p = worstCaseActiveEntryPrice(m);
  expect(p.inputUnitsPerMillion).toBe(1000);
  expect(p.outputUnitsPerMillion).toBe(9000);
});

test("worstCaseActiveEntryPrice: ignores inactive entries", () => {
  const m = model({
    price: { inputUnitsPerMillion: 300, outputUnitsPerMillion: 600 },
    entries: [
      entry({ id: "e1", priority: 0 }),
      entry({ id: "e2", priority: 1, active: false, price: { inputUnitsPerMillion: 9999, outputUnitsPerMillion: 9999 } }),
    ],
  });
  const p = worstCaseActiveEntryPrice(m);
  expect(p.inputUnitsPerMillion).toBe(300);
  expect(p.outputUnitsPerMillion).toBe(600);
});

test("resolveCompletionCap: explicit max_tokens wins", () => {
  expect(resolveCompletionCap(2048, model())).toBe(2048);
  expect(resolveCompletionCap(0, model({ limits: { context: 128000, output: 8192 } }))).toBe(0);
});

test("resolveCompletionCap: falls back to model.limits.output when request omits", () => {
  const m = model({ limits: { context: 128000, output: 8192 } });
  expect(resolveCompletionCap(undefined, m)).toBe(8192);
});

test("resolveCompletionCap: falls back to DEFAULT_COMPLETION_CAP when neither set", () => {
  expect(resolveCompletionCap(undefined, model())).toBe(DEFAULT_COMPLETION_CAP);
});