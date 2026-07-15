/**
 * Phase 1 characterization tests for known P0 billing/usage behaviors.
 * These document CURRENT behavior so later correctness work can change it
 * deliberately. Do not "fix" production code to make these green in a
 * different way — update assertions when intentional behavior changes.
 */
import { test, expect, describe } from "bun:test";
import {
  estimatePromptTokens,
  DEFAULT_COMPLETION_CAP,
  resolveCompletionCap,
} from "../billing.ts";
import type { ChatMessage } from "../../providers/index.ts";
import {
  parseUsage as parseOpenAIUsage,
  parseOpenAIUsageResult,
} from "../../providers/openai-compatible.ts";
import {
  mapUsage as parseAnthropicUsage,
  parseAnthropicUsageResult,
} from "../../providers/anthropic-compatible.ts";

describe("characterization: token estimation heuristics (P0 — known unsafe)", () => {
  test("text uses chars/4 ceiling", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "abcd" }, // 4 chars → 1 token
    ];
    expect(estimatePromptTokens(messages)).toBe(1);
  });

  test("non-text parts use fixed 768 token overhead each", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "image_url", imageUrl: { url: "https://example.com/x.png" } },
        ],
      },
    ];
    // empty text → 0 chars; one non-text → 768; max(1, 768) = 768
    expect(estimatePromptTokens(messages)).toBe(768);
  });

  test("DEFAULT_COMPLETION_CAP is fabricated 4096", () => {
    expect(DEFAULT_COMPLETION_CAP).toBe(4096);
  });

  test("resolveCompletionCap falls back to DEFAULT when model has no output limit", () => {
    expect(
      resolveCompletionCap(undefined, {
        limits: { context: 128_000 },
      } as never),
    ).toBe(DEFAULT_COMPLETION_CAP);
  });
});

describe("provider usage: missing is explicit (settlement must not free-bill)", () => {
  test("OpenAI parseUsage still returns zeros for absent (compat); result API is missing", () => {
    expect(parseOpenAIUsage(null)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(parseOpenAIUsageResult(null).status).toBe("missing");
    expect(parseOpenAIUsageResult({}).status).toBe("missing");
    expect(parseOpenAIUsageResult({ prompt_tokens: 1, completion_tokens: 2 }).status).toBe(
      "reported",
    );
  });

  test("OpenAI malformed token fields are missing, not zero-reported", () => {
    const r = parseOpenAIUsageResult({
      prompt_tokens: "ten",
      completion_tokens: 2,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_malformed");
  });

  test("OpenAI incomplete (total only) is missing", () => {
    expect(parseOpenAIUsageResult({ total_tokens: 100 }).status).toBe("missing");
  });

  test("Anthropic mapUsage zeros for absent; result API is missing", () => {
    expect(parseAnthropicUsage(null)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(parseAnthropicUsageResult(null).status).toBe("missing");
  });

  test("Anthropic malformed token fields are missing, not zero-reported", () => {
    const r = parseAnthropicUsageResult({
      input_tokens: -1,
      output_tokens: 5,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_malformed");
  });

  test("Anthropic incomplete (input only) is missing", () => {
    expect(parseAnthropicUsageResult({ input_tokens: 100 }).status).toBe("missing");
  });
});
