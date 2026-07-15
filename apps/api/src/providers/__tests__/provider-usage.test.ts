import { test, expect, describe } from "bun:test";
import {
  parseOpenAIProviderUsage,
  parseAnthropicProviderUsage,
  parseAnthropicStreamUsageFragment,
  mergeAnthropicStreamUsage,
  isAnthropicStreamUsageComplete,
  toTokenUsage,
  normalizeProcessedTotalTokens,
  partsSumForProcessedTotal,
} from "../provider-usage.ts";

describe("parseOpenAIProviderUsage", () => {
  test("reported when both prompt and completion are integers", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.promptTokens).toBe(10);
      expect(r.usage.completionTokens).toBe(5);
      expect(r.usage.totalTokens).toBe(15);
      expect(r.usage.cacheAccounting).toBe("subset");
    }
  });

  test("fractional tokens are malformed (not floored)", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: 1.5,
      completion_tokens: 2,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_malformed");
  });

  test("total_tokens only is incomplete (not free zero report)", () => {
    const r = parseOpenAIProviderUsage({ total_tokens: 100 });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_incomplete");
  });

  test("total_tokens 0 with nonzero parts uses derived sum for accounting", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 0,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.totalTokens).toBe(150);
    }
  });

  test("total below parts is inconsistent", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 10,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_inconsistent_total");
  });

  test("reasoning inside completion does not double-count total", () => {
    // Reproduced: {prompt:10, completion:20, reasoning:5, total:30}
    // Providers include reasoning in completion; sum is 30 not 35.
    const r = parseOpenAIProviderUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      reasoning_tokens: 5,
      total_tokens: 30,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.totalTokens).toBe(30);
      expect(r.usage.reasoningTokens).toBe(5);
    }
  });

  test("absent total with reasoning does not inflate (prompt+completion only)", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      reasoning_tokens: 5,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.totalTokens).toBe(30);
    }
  });

  test("reasoning under completion_tokens_details", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 5 },
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.reasoningTokens).toBe(5);
      expect(r.usage.totalTokens).toBe(30);
    }
  });
});

describe("parseAnthropicProviderUsage", () => {
  test("reported when both input and output present", () => {
    const r = parseAnthropicProviderUsage({
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.promptTokens).toBe(10);
      expect(r.usage.completionTokens).toBe(5);
      expect(r.usage.totalTokens).toBe(15);
      expect(r.usage.cacheAccounting).toBe("additive");
    }
  });

  test("input only is incomplete", () => {
    const r = parseAnthropicProviderUsage({ input_tokens: 100 });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_incomplete");
  });

  test("fractional is malformed", () => {
    const r = parseAnthropicProviderUsage({
      input_tokens: 1.2,
      output_tokens: 3,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_malformed");
  });

  test("reasoning inside output does not inflate total", () => {
    const r = parseAnthropicProviderUsage({
      input_tokens: 10,
      output_tokens: 20,
      reasoning_tokens: 5,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.totalTokens).toBe(30);
      expect(r.usage.reasoningTokens).toBe(5);
    }
  });

  test("additive cache is included in totalTokens (not just input+output)", () => {
    // Probe: input 1000 + output 100 + cache-read 500 → processed total 1600.
    const r = parseAnthropicProviderUsage({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 500,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      expect(r.usage.totalTokens).toBe(1600);
      expect(r.usage.totalTokens).not.toBe(1100);
    }
  });

  test("additive cache write is included; reasoning not added", () => {
    const r = parseAnthropicProviderUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
      reasoning_tokens: 40,
    });
    expect(r.status).toBe("reported");
    if (r.status === "reported") {
      // 100+50+200+30 = 380; reasoning stays inside output
      expect(r.usage.totalTokens).toBe(380);
    }
  });
});

describe("normalizeProcessedTotalTokens", () => {
  test("subset ignores peeling cache into a second addend", () => {
    expect(
      partsSumForProcessedTotal({
        promptTokens: 1000,
        completionTokens: 100,
        cacheReadTokens: 500,
        cacheAccounting: "subset",
      }),
    ).toBe(1100);
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 1000,
        completionTokens: 100,
        cacheReadTokens: 500,
        totalTokens: 1100,
        cacheAccounting: "subset",
      }),
    ).toBe(1100);
  });

  test("additive sums input+output+cacheRead+cacheWrite", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 1000,
        completionTokens: 100,
        cacheReadTokens: 500,
        cacheAccounting: "additive",
      }),
    ).toBe(1600);
  });

  test("retains provider total when it exceeds parts (10+5 with total 20 → 20)", () => {
    // Stream routes must pass chunk.usage.totalTokens into the normalizer.
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 20,
        cacheAccounting: "subset",
      }),
    ).toBe(20);
  });

  test("additive SSE total includes cache (50+10+100+20 → 180 not 60)", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 50,
        completionTokens: 10,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        cacheAccounting: "additive",
      }),
    ).toBe(180);
  });

  test("unsafe integer fields and sum overflow return null (fail-closed)", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1; // not a safe integer
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: unsafe,
        completionTokens: 0,
        cacheAccounting: "subset",
      }),
    ).toBeNull();
    // Sum of two safe ints can overflow MAX_SAFE_INTEGER.
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: Number.MAX_SAFE_INTEGER,
        completionTokens: 1,
        cacheAccounting: "subset",
      }),
    ).toBeNull();
    expect(
      partsSumForProcessedTotal({
        promptTokens: Number.MAX_SAFE_INTEGER - 5,
        completionTokens: 10,
        cacheAccounting: "subset",
      }),
    ).toBeNull();
  });
});

describe("safe-integer rejection in parsers", () => {
  test("OpenAI rejects unsafe integer prompt_tokens as malformed", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
      completion_tokens: 1,
      total_tokens: Number.MAX_SAFE_INTEGER + 2,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_malformed");
  });

  test("OpenAI rejects parts that overflow when summed", () => {
    const r = parseOpenAIProviderUsage({
      prompt_tokens: Number.MAX_SAFE_INTEGER,
      completion_tokens: 1,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_overflow");
  });

  test("Anthropic rejects unsafe integer input as malformed", () => {
    const r = parseAnthropicProviderUsage({
      input_tokens: Number.MAX_SAFE_INTEGER + 1,
      output_tokens: 1,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_malformed");
  });

  test("Anthropic additive cache overflow fails closed", () => {
    const r = parseAnthropicProviderUsage({
      input_tokens: Number.MAX_SAFE_INTEGER - 10,
      output_tokens: 0,
      cache_read_input_tokens: 20,
    });
    expect(r.status).toBe("missing");
    if (r.status === "missing") expect(r.reason).toBe("usage_overflow");
  });

  test("stream fragment with unsafe field is discarded", () => {
    expect(
      parseAnthropicStreamUsageFragment({
        input_tokens: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBeNull();
  });

  test("stream merge overflow is incomplete for settlement", () => {
    const a = mergeAnthropicStreamUsage(undefined, {
      promptTokens: Number.MAX_SAFE_INTEGER - 1,
    });
    const b = mergeAnthropicStreamUsage(a, {
      completionTokens: 5,
    });
    expect(b.overflow).toBe(true);
    expect(isAnthropicStreamUsageComplete(b)).toBe(false);
  });
});

describe("parseAnthropicStreamUsageFragment + merge", () => {
  test("missing side stays undefined (not zero)", () => {
    const frag = parseAnthropicStreamUsageFragment({ input_tokens: 100 });
    expect(frag).not.toBeNull();
    expect(frag?.promptTokens).toBe(100);
    expect(frag?.completionTokens).toBeUndefined();
  });

  test("output-only fragment does not invent input zero", () => {
    const frag = parseAnthropicStreamUsageFragment({ output_tokens: 50 });
    expect(frag).not.toBeNull();
    expect(frag?.promptTokens).toBeUndefined();
    expect(frag?.completionTokens).toBe(50);
  });

  test("merge tracks presence; incomplete until both sides", () => {
    const start = parseAnthropicStreamUsageFragment({ input_tokens: 100 })!;
    const a = mergeAnthropicStreamUsage(undefined, start);
    expect(a.hasInput).toBe(true);
    expect(a.hasOutput).toBe(false);
    expect(isAnthropicStreamUsageComplete(a)).toBe(false);

    const delta = parseAnthropicStreamUsageFragment({ output_tokens: 50 })!;
    const b = mergeAnthropicStreamUsage(a, delta);
    expect(b.hasInput).toBe(true);
    expect(b.hasOutput).toBe(true);
    expect(b.promptTokens).toBe(100);
    expect(b.completionTokens).toBe(50);
    expect(b.totalTokens).toBe(150);
    expect(isAnthropicStreamUsageComplete(b)).toBe(true);
    expect(toTokenUsage(b).totalTokens).toBe(150);
  });

  test("merge includes additive cache in totalTokens", () => {
    const start = parseAnthropicStreamUsageFragment({
      input_tokens: 1000,
      cache_read_input_tokens: 500,
    })!;
    const delta = parseAnthropicStreamUsageFragment({ output_tokens: 100 })!;
    const merged = mergeAnthropicStreamUsage(
      mergeAnthropicStreamUsage(undefined, start),
      delta,
    );
    expect(merged.totalTokens).toBe(1600);
    expect(toTokenUsage(merged).totalTokens).toBe(1600);
  });

  test("input-only stream never completes for settlement", () => {
    const a = mergeAnthropicStreamUsage(
      undefined,
      parseAnthropicStreamUsageFragment({ input_tokens: 42 })!,
    );
    // Even with nonzero tokens, incomplete without output side.
    expect(a.promptTokens).toBe(42);
    expect(a.completionTokens).toBe(0);
    expect(isAnthropicStreamUsageComplete(a)).toBe(false);
  });

  test("malformed present field discards fragment", () => {
    expect(
      parseAnthropicStreamUsageFragment({
        input_tokens: 1.5,
        output_tokens: 2,
      }),
    ).toBeNull();
  });
});
