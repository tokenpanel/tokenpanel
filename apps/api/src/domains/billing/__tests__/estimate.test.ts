/**
 * Unit tests for pure billing estimation (estimate.ts):
 * estimatePromptTokens, worstCaseActiveEntryPrice, resolveCompletionCap,
 * estimatePreFlightSpend. Exact integer arithmetic — no I/O, no Effect.
 */
import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { ModelDoc, ModelEntryDoc } from "@tokenpanel/db";
import {
  estimatePreFlightSpend,
  estimatePromptTokens,
  resolveCompletionCap,
  worstCaseActiveEntryPrice,
} from "../estimate.ts";

const ORG_ID = new ObjectId();
const PROVIDER_ID = new ObjectId();

function entryFixture(over: Partial<ModelEntryDoc> = {}): ModelEntryDoc {
  return {
    id: "e1",
    providerId: PROVIDER_ID,
    upstreamModelId: "gpt-test-upstream",
    priority: 0,
    active: true,
    ...over,
  };
}

function modelFixture(over: Partial<ModelDoc> = {}): ModelDoc {
  const now = new Date("2026-01-15T12:00:00.000Z");
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    aliasId: "gpt-test",
    displayName: "GPT Test",
    description: null,
    entries: [entryFixture()],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 128_000 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 2_000 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: Object.create(null) as Record<string, string>,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

test("estimatePromptTokens: string content ceil(chars/4), rounding up", () => {
  // 11 chars → ceil(11/4) = 3
  expect(
    estimatePromptTokens([{ role: "user", content: "hello world" }]),
  ).toBe(3);
  // exact division: 8 chars → 2
  expect(estimatePromptTokens([{ role: "user", content: "abcdefgh" }])).toBe(2);
});

test("estimatePromptTokens: sums chars across messages and systemText", () => {
  // 2 + 3 = 5 chars → ceil(5/4) = 2
  expect(
    estimatePromptTokens([
      { role: "user", content: "ab" },
      { role: "assistant", content: "cde" },
    ]),
  ).toBe(2);
  // systemText prepends: 4 + 3 = 7 chars → ceil(7/4) = 2
  expect(
    estimatePromptTokens([{ role: "user", content: "abc" }], "abcd"),
  ).toBe(2);
  // systemText alone: 4 chars → 1
  expect(estimatePromptTokens([], "abcd")).toBe(1);
});

test("estimatePromptTokens: array text parts count chars, non-text parts add 768 each", () => {
  // two text parts: 5 + 3 = 8 chars → 2
  expect(
    estimatePromptTokens([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }, { type: "text", text: " wo" }],
      },
    ]),
  ).toBe(2);
  // two non-text parts → 2 * 768 = 1536
  expect(
    estimatePromptTokens([
      {
        role: "user",
        content: [
          { type: "image_url", imageUrl: { url: "https://x/y.png" } },
          { type: "raw", block: {} },
        ],
      },
    ]),
  ).toBe(1536);
  // mixed: system 2 chars + text part 2 chars → ceil(4/4)=1, plus one image 768 → 769
  expect(
    estimatePromptTokens(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", imageUrl: { url: "https://x/y.png" } },
          ],
        },
      ],
      "ab",
    ),
  ).toBe(769);
});

test("estimatePromptTokens: null content contributes nothing, floor is 1", () => {
  expect(estimatePromptTokens([{ role: "assistant", content: null }])).toBe(1);
  // null message between text: 4 chars → 1
  expect(
    estimatePromptTokens([
      { role: "user", content: null },
      { role: "user", content: "abcd" },
      { role: "assistant", content: null },
    ]),
  ).toBe(1);
  // empty string everywhere → max(1, 0) = 1
  expect(estimatePromptTokens([{ role: "user", content: "" }])).toBe(1);
  expect(estimatePromptTokens([], "")).toBe(1);
});

test("worstCaseActiveEntryPrice: entries without price fall back to model price", () => {
  const model = modelFixture({
    price: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 2_000 },
    entries: [entryFixture({ id: "e1" }), entryFixture({ id: "e2" })],
  });
  expect(worstCaseActiveEntryPrice(model)).toEqual({
    inputMicrosPerMillion: 1_000,
    outputMicrosPerMillion: 2_000,
  });
});

test("worstCaseActiveEntryPrice: active entry price wins when higher", () => {
  const model = modelFixture({
    price: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 2_000 },
    entries: [
      entryFixture({
        id: "e1",
        price: { inputMicrosPerMillion: 5_000, outputMicrosPerMillion: 9_000 },
      }),
    ],
  });
  expect(worstCaseActiveEntryPrice(model)).toEqual({
    inputMicrosPerMillion: 5_000,
    outputMicrosPerMillion: 9_000,
  });
});

test("worstCaseActiveEntryPrice: inactive entries are ignored", () => {
  const model = modelFixture({
    price: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 2_000 },
    entries: [
      entryFixture({
        id: "inactive",
        active: false,
        price: {
          inputMicrosPerMillion: 999_999,
          outputMicrosPerMillion: 999_999,
        },
      }),
    ],
  });
  expect(worstCaseActiveEntryPrice(model)).toEqual({
    inputMicrosPerMillion: 1_000,
    outputMicrosPerMillion: 2_000,
  });
});

test("worstCaseActiveEntryPrice: per-side max across entries and model price", () => {
  const model = modelFixture({
    price: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 2_000 },
    entries: [
      entryFixture({
        id: "hi-in",
        price: { inputMicrosPerMillion: 3_000, outputMicrosPerMillion: 500 },
      }),
      entryFixture({
        id: "hi-out",
        price: { inputMicrosPerMillion: 500, outputMicrosPerMillion: 8_000 },
      }),
    ],
  });
  expect(worstCaseActiveEntryPrice(model)).toEqual({
    inputMicrosPerMillion: 3_000,
    outputMicrosPerMillion: 8_000,
  });
});

test("worstCaseActiveEntryPrice: entry cheaper on one side keeps model price there", () => {
  const model = modelFixture({
    price: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 2_000 },
    entries: [
      entryFixture({
        id: "e1",
        price: { inputMicrosPerMillion: 500, outputMicrosPerMillion: 3_000 },
      }),
    ],
  });
  expect(worstCaseActiveEntryPrice(model)).toEqual({
    inputMicrosPerMillion: 1_000,
    outputMicrosPerMillion: 3_000,
  });
});

test("resolveCompletionCap: explicit request beats model.limits.output", () => {
  const model = modelFixture({ limits: { context: 128_000, output: 1_024 } });
  expect(resolveCompletionCap(5_000, model)).toBe(5_000);
});

test("resolveCompletionCap: falls back to model.limits.output", () => {
  const model = modelFixture({ limits: { context: 128_000, output: 2_048 } });
  expect(resolveCompletionCap(undefined, model)).toBe(2_048);
});

test("resolveCompletionCap: falls back to 4096 default when model has no output limit", () => {
  expect(resolveCompletionCap(undefined, modelFixture())).toBe(4_096);
  expect(
    resolveCompletionCap(undefined, modelFixture({ limits: {} })),
  ).toBe(4_096);
});

test("resolveCompletionCap: explicit 0 means no completion; negative clamps to 0", () => {
  expect(resolveCompletionCap(0, modelFixture())).toBe(0);
  expect(resolveCompletionCap(-1, modelFixture())).toBe(0);
});

test("estimatePreFlightSpend: exact micros math per bucket over a million tokens", () => {
  const model = modelFixture({
    price: { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 2_000_000 },
  });
  expect(
    estimatePreFlightSpend({
      model,
      estimatedPromptTokens: 1_000_000,
      maxCompletionTokens: 500_000,
    }),
  ).toEqual({
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    estimatedTokens: 1_500_000,
    estimatedSpendMicros: 4_000_000, // 3_000_000 + 1_000_000
    currency: "USD",
    price: { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 2_000_000 },
  });
});

test("estimatePreFlightSpend: ceils each bucket independently", () => {
  // 1 token @ 1 micro per million → ceil(1/1e6) = 1 per bucket; two buckets → 2
  const model = modelFixture({
    price: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 },
  });
  const out = estimatePreFlightSpend({
    model,
    estimatedPromptTokens: 1,
    maxCompletionTokens: 1,
  });
  expect(out.estimatedSpendMicros).toBe(2);
  // fractional: 4096 tokens @ 1000 micros → ceil(4.096) = 5
  const capped = estimatePreFlightSpend({
    model: modelFixture({
      price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 1_000 },
    }),
    estimatedPromptTokens: 0,
  });
  expect(capped.completionTokens).toBe(4_096);
  expect(capped.estimatedSpendMicros).toBe(5);
  expect(capped.estimatedTokens).toBe(4_096);
});

test("estimatePreFlightSpend: zero estimate bills nothing; negative prompt clamps to 0", () => {
  const model = modelFixture();
  expect(
    estimatePreFlightSpend({
      model,
      estimatedPromptTokens: 0,
      maxCompletionTokens: 0,
    }).estimatedSpendMicros,
  ).toBe(0);
  const clamped = estimatePreFlightSpend({
    model,
    estimatedPromptTokens: -10,
    maxCompletionTokens: 0,
  });
  expect(clamped.promptTokens).toBe(0);
  expect(clamped.estimatedSpendMicros).toBe(0);
});

test("estimatePreFlightSpend: reserves against worst-case ACTIVE entry price", () => {
  const model = modelFixture({
    price: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 },
    entries: [
      entryFixture({
        id: "cheap-active",
        price: {
          inputMicrosPerMillion: 1_000_000,
          outputMicrosPerMillion: 1_000_000,
        },
      }),
      entryFixture({
        id: "expensive-active",
        price: {
          inputMicrosPerMillion: 2_000_000,
          outputMicrosPerMillion: 2_000_000,
        },
      }),
      entryFixture({
        id: "inactive-huge",
        active: false,
        price: {
          inputMicrosPerMillion: 9_000_000,
          outputMicrosPerMillion: 9_000_000,
        },
      }),
    ],
  });
  const out = estimatePreFlightSpend({
    model,
    estimatedPromptTokens: 1_000_000,
    maxCompletionTokens: 1_000_000,
  });
  expect(out.price).toEqual({
    inputMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 2_000_000,
  });
  expect(out.estimatedSpendMicros).toBe(4_000_000);
});

test("estimatePreFlightSpend: currency passes through from model", () => {
  const model = modelFixture({ currency: "EUR" });
  expect(
    estimatePreFlightSpend({ model, estimatedPromptTokens: 1_000 }).currency,
  ).toBe("EUR");
});
