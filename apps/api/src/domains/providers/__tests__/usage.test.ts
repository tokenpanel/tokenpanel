/**
 * Unit tests for usage outcome mapping (usage.ts) and provider usage
 * parsing/normalization (providers/provider-usage.ts).
 */
import { describe, expect, test } from "bun:test";
import {
  extractAnthropicUsage,
  extractOpenAIUsage,
  isSettleableUsage,
  toProviderUsage,
  toUsageOutcome,
  usageFromChatResponse,
} from "../usage.ts";
import {
  normalizeProcessedTotalTokens,
  partsSumForProcessedTotal,
  type ProviderUsage,
  type TokenUsage,
} from "../../../providers/provider-usage.ts";

const reportedUsage: TokenUsage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
};

function missingUsage(
  reason: string,
  providerRequestId?: string | undefined,
): ProviderUsage {
  return {
    status: "missing",
    reason,
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
  };
}

describe("toUsageOutcome", () => {
  test("reported passes through with the same usage object", () => {
    const res = toUsageOutcome({ status: "reported", usage: reportedUsage });
    expect(res.status).toBe("reported");
    expect(res).toEqual({ status: "reported", usage: reportedUsage });
  });

  test("usage_overflow reason reclassifies missing → overflow", () => {
    const res = toUsageOutcome(missingUsage("usage_overflow"));
    expect(res).toStrictEqual({ status: "overflow", reason: "usage_overflow" });
    expect("providerRequestId" in res).toBe(false);
  });

  test("usage_malformed reason reclassifies missing → malformed", () => {
    expect(toUsageOutcome(missingUsage("usage_malformed"))).toStrictEqual({
      status: "malformed",
      reason: "usage_malformed",
    });
  });

  test("usage_inconsistent_total reason reclassifies missing → malformed", () => {
    expect(
      toUsageOutcome(missingUsage("usage_inconsistent_total")),
    ).toStrictEqual({
      status: "malformed",
      reason: "usage_inconsistent_total",
    });
  });

  test("other reasons stay missing with reason preserved", () => {
    for (const reason of [
      "usage_absent",
      "usage_empty_object",
      "usage_incomplete",
      "provider_omitted_usage",
    ]) {
      expect(toUsageOutcome(missingUsage(reason))).toStrictEqual({
        status: "missing",
        reason,
      });
    }
  });

  test("providerRequestId spread when defined", () => {
    const res = toUsageOutcome(missingUsage("usage_absent", "req_123"));
    expect("providerRequestId" in res).toBe(true);
    expect(res).toEqual({
      status: "missing",
      reason: "usage_absent",
      providerRequestId: "req_123",
    });
  });

  test("providerRequestId spread when defined on overflow branch", () => {
    const res = toUsageOutcome(missingUsage("usage_overflow", "req_9"));
    expect(res).toEqual({
      status: "overflow",
      reason: "usage_overflow",
      providerRequestId: "req_9",
    });
  });
});

describe("toProviderUsage", () => {
  test("reported passes through with the same usage object", () => {
    const res = toProviderUsage({ status: "reported", usage: reportedUsage });
    expect(res.status).toBe("reported");
    expect(res).toEqual({ status: "reported", usage: reportedUsage });
  });

  test("malformed collapses to missing keeping the reason", () => {
    expect(
      toProviderUsage({
        status: "malformed",
        reason: "usage_malformed",
        providerRequestId: "req_1",
      }),
    ).toStrictEqual({
      status: "missing",
      reason: "usage_malformed",
      providerRequestId: "req_1",
    });
  });

  test("overflow collapses to missing keeping the reason", () => {
    expect(
      toProviderUsage({ status: "overflow", reason: "usage_overflow" }),
    ).toStrictEqual({ status: "missing", reason: "usage_overflow" });
  });

  test("missing passes through unchanged", () => {
    expect(toProviderUsage(missingUsage("usage_absent"))).toStrictEqual({
      status: "missing",
      reason: "usage_absent",
    });
  });

  test("providerRequestId omitted when undefined", () => {
    const res = toProviderUsage({
      status: "malformed",
      reason: "usage_inconsistent_total",
      providerRequestId: undefined,
    });
    expect("providerRequestId" in res).toBe(false);
    expect(res).toStrictEqual({
      status: "missing",
      reason: "usage_inconsistent_total",
    });
  });
});

describe("usageFromChatResponse", () => {
  test("reported status yields reported outcome", () => {
    const res = usageFromChatResponse({
      usageStatus: "reported",
      usage: reportedUsage,
    });
    expect(res).toEqual({ status: "reported", usage: reportedUsage });
  });

  test("missing status without reason defaults to usage_missing", () => {
    expect(
      usageFromChatResponse({ usageStatus: "missing", usage: reportedUsage }),
    ).toStrictEqual({ status: "missing", reason: "usage_missing" });
  });

  test("unspecified status without reason defaults to usage_status_unspecified", () => {
    expect(usageFromChatResponse({ usage: reportedUsage })).toStrictEqual({
      status: "missing",
      reason: "usage_status_unspecified",
    });
  });

  test("explicit missing reason is preserved", () => {
    expect(
      usageFromChatResponse({
        usageStatus: "missing",
        usage: reportedUsage,
        usageMissingReason: "usage_absent",
      }),
    ).toStrictEqual({ status: "missing", reason: "usage_absent" });
  });

  test("reason reclassification applies to chat-response reasons", () => {
    const base = { usage: reportedUsage };
    expect(
      usageFromChatResponse({
        ...base,
        usageMissingReason: "usage_malformed",
      }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
    expect(
      usageFromChatResponse({
        ...base,
        usageMissingReason: "usage_inconsistent_total",
      }),
    ).toStrictEqual({
      status: "malformed",
      reason: "usage_inconsistent_total",
    });
    expect(
      usageFromChatResponse({ ...base, usageMissingReason: "usage_overflow" }),
    ).toStrictEqual({ status: "overflow", reason: "usage_overflow" });
  });

  test("providerRequestId propagates into the missing outcome", () => {
    const res = usageFromChatResponse({
      usage: reportedUsage,
      providerRequestId: "req_77",
    });
    expect("providerRequestId" in res).toBe(true);
    expect(res).toEqual({
      status: "missing",
      reason: "usage_status_unspecified",
      providerRequestId: "req_77",
    });
  });
});

describe("isSettleableUsage", () => {
  test("only reported is settleable and narrows to usage", () => {
    const o = toUsageOutcome({ status: "reported", usage: reportedUsage });
    if (isSettleableUsage(o)) {
      expect(o.usage.totalTokens).toBe(15);
    } else {
      throw new Error("expected reported outcome to be settleable");
    }
  });

  test("missing, malformed, overflow are never settleable", () => {
    expect(
      isSettleableUsage(toUsageOutcome(missingUsage("usage_absent"))),
    ).toBe(false);
    expect(
      isSettleableUsage(toUsageOutcome(missingUsage("usage_malformed"))),
    ).toBe(false);
    expect(
      isSettleableUsage(toUsageOutcome(missingUsage("usage_overflow"))),
    ).toBe(false);
  });
});

describe("extractOpenAIUsage", () => {
  test("non-object input → missing usage_absent", () => {
    for (const u of [null, undefined, 42, "usage", true]) {
      expect(extractOpenAIUsage(u)).toStrictEqual({
        status: "missing",
        reason: "usage_absent",
      });
    }
  });

  test("object without usage keys → missing usage_empty_object", () => {
    expect(extractOpenAIUsage({})).toStrictEqual({
      status: "missing",
      reason: "usage_empty_object",
    });
  });

  test("incomplete objects → missing usage_incomplete", () => {
    expect(extractOpenAIUsage({ total_tokens: 100 })).toStrictEqual({
      status: "missing",
      reason: "usage_incomplete",
    });
    expect(extractOpenAIUsage({ prompt_tokens: 10 })).toStrictEqual({
      status: "missing",
      reason: "usage_incomplete",
    });
    expect(
      extractOpenAIUsage({ prompt_tokens: undefined, completion_tokens: 5 }),
    ).toStrictEqual({ status: "missing", reason: "usage_incomplete" });
  });

  test("malformed token fields → malformed usage_malformed", () => {
    expect(
      extractOpenAIUsage({ prompt_tokens: 1.5, completion_tokens: 2 }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
    expect(
      extractOpenAIUsage({ prompt_tokens: 10, completion_tokens: -2 }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
    expect(
      extractOpenAIUsage({ prompt_tokens: "10", completion_tokens: 5 }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
    expect(
      extractOpenAIUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        reasoning_tokens: -1,
      }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
  });

  test("total below prompt+completion → malformed usage_inconsistent_total", () => {
    expect(
      extractOpenAIUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 14,
      }),
    ).toStrictEqual({
      status: "malformed",
      reason: "usage_inconsistent_total",
    });
  });

  test("zero total with nonzero parts falls back to parts sum", () => {
    const res = extractOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 0,
    });
    expect(res.status).toBe("reported");
    expect(res).toEqual({
      status: "reported",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheAccounting: "subset",
      },
    });
  });
  test("unsafe or negative provider total fails as malformed (numField)", () => {
    expect(
      extractOpenAIUsage({
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
    expect(
      extractOpenAIUsage({
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: -5,
      }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
  });

  test("parts sum overflow → overflow", () => {
    expect(
      extractOpenAIUsage({
        prompt_tokens: Number.MAX_SAFE_INTEGER,
        completion_tokens: 1,
      }),
    ).toStrictEqual({ status: "overflow", reason: "usage_overflow" });
  });

  test("happy path reports subset accounting", () => {
    const res = extractOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(res.status).toBe("reported");
    if (res.status !== "reported") throw new Error("expected reported");
    expect(res.usage.promptTokens).toBe(10);
    expect(res.usage.completionTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(15);
    expect(res.usage.reasoningTokens).toBeUndefined();
    expect(res.usage.cacheReadTokens).toBeUndefined();
    expect(res.usage.cacheWriteTokens).toBeUndefined();
    expect(res.usage.cacheAccounting).toBe("subset");
  });

  test("reasoning tokens from top level or completion details", () => {
    const top = extractOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      reasoning_tokens: 3,
    });
    expect(top.status).toBe("reported");
    if (top.status !== "reported") throw new Error("expected reported");
    expect(top.usage.reasoningTokens).toBe(3);
    expect(top.usage.totalTokens).toBe(15);

    const details = extractOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 4 },
    });
    expect(details.status).toBe("reported");
    if (details.status !== "reported") throw new Error("expected reported");
    expect(details.usage.reasoningTokens).toBe(4);
    expect(details.usage.totalTokens).toBe(15);
  });

  test("cached tokens are subset of prompt; provider total above parts wins", () => {
    const res = extractOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4 },
      cache_creation_tokens: 0,
    });
    expect(res.status).toBe("reported");
    if (res.status !== "reported") throw new Error("expected reported");
    expect(res.usage.cacheReadTokens).toBe(4);
    expect(res.usage.cacheWriteTokens).toBe(0);
    expect(res.usage.totalTokens).toBe(20);
    expect(res.usage.cacheAccounting).toBe("subset");
  });
});

describe("extractAnthropicUsage", () => {
  test("non-object input → missing usage_absent", () => {
    for (const u of [null, undefined, "usage", 7]) {
      expect(extractAnthropicUsage(u)).toStrictEqual({
        status: "missing",
        reason: "usage_absent",
      });
    }
  });

  test("object without token keys → missing usage_empty_object", () => {
    expect(extractAnthropicUsage({})).toStrictEqual({
      status: "missing",
      reason: "usage_empty_object",
    });
  });

  test("requires both input_tokens and output_tokens", () => {
    expect(extractAnthropicUsage({ input_tokens: 5 })).toStrictEqual({
      status: "missing",
      reason: "usage_incomplete",
    });
    expect(extractAnthropicUsage({ output_tokens: 5 })).toStrictEqual({
      status: "missing",
      reason: "usage_incomplete",
    });
    expect(
      extractAnthropicUsage({ input_tokens: undefined, output_tokens: 5 }),
    ).toStrictEqual({ status: "missing", reason: "usage_incomplete" });
  });

  test("malformed token fields → malformed usage_malformed", () => {
    expect(
      extractAnthropicUsage({ input_tokens: 1.5, output_tokens: 2 }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
    expect(
      extractAnthropicUsage({
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: -1,
      }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
    expect(
      extractAnthropicUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: "5",
      }),
    ).toStrictEqual({ status: "malformed", reason: "usage_malformed" });
  });

  test("happy path reports additive accounting with cache-inclusive total", () => {
    const res = extractAnthropicUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 20,
      reasoning_tokens: 10,
    });
    expect(res.status).toBe("reported");
    if (res.status !== "reported") throw new Error("expected reported");
    expect(res.usage.promptTokens).toBe(100);
    expect(res.usage.completionTokens).toBe(50);
    expect(res.usage.cacheReadTokens).toBe(30);
    expect(res.usage.cacheWriteTokens).toBe(20);
    expect(res.usage.reasoningTokens).toBe(10);
    // total_input = input + cache_read + cache_write; reasoning never added.
    expect(res.usage.totalTokens).toBe(200);
    expect(res.usage.cacheAccounting).toBe("additive");
  });

  test("alternate cache field names are honored", () => {
    const res = extractAnthropicUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 7,
      cache_creation_tokens: 8,
    });
    expect(res.status).toBe("reported");
    if (res.status !== "reported") throw new Error("expected reported");
    expect(res.usage.cacheReadTokens).toBe(7);
    expect(res.usage.cacheWriteTokens).toBe(8);
    expect(res.usage.totalTokens).toBe(165);
  });

  test("parts overflow → overflow", () => {
    expect(
      extractAnthropicUsage({
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 1,
      }),
    ).toStrictEqual({ status: "overflow", reason: "usage_overflow" });
  });
});

describe("normalizeProcessedTotalTokens", () => {
  test("parts sum default (subset): prompt + completion, cache ignored", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10,
        completionTokens: 5,
        cacheAccounting: "subset",
      }),
    ).toBe(15);
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10,
        completionTokens: 5,
        cacheReadTokens: 4,
        cacheAccounting: "subset",
      }),
    ).toBe(15);
    expect(
      normalizeProcessedTotalTokens({ promptTokens: 10, completionTokens: 5 }),
    ).toBe(15);
  });

  test("parts sum default (additive): caches included, reasoning excluded", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 10,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        cacheAccounting: "additive",
      }),
    ).toBe(200);
  });

  test("reported > 0 never undercounts parts", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 100,
        completionTokens: 50,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        totalTokens: 100,
        cacheAccounting: "additive",
      }),
    ).toBe(200);
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 100,
        completionTokens: 50,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        totalTokens: 300,
        cacheAccounting: "additive",
      }),
    ).toBe(300);
  });

  test("reported === 0 falls through to parts sum", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 0,
      }),
    ).toBe(15);
  });

  test("unsafe reported total → null", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: -1,
      }),
    ).toBeNull();
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 1.5,
      }),
    ).toBeNull();
  });

  test("unsafe parts → null", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10.5,
        completionTokens: 5,
      }),
    ).toBeNull();
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: 10,
        completionTokens: 5,
        cacheWriteTokens: -3,
        cacheAccounting: "additive",
      }),
    ).toBeNull();
  });

  test("parts overflow → null", () => {
    expect(
      normalizeProcessedTotalTokens({
        promptTokens: Number.MAX_SAFE_INTEGER,
        completionTokens: 1,
      }),
    ).toBeNull();
  });
});

describe("partsSumForProcessedTotal", () => {
  test("subset ignores cache fields", () => {
    expect(
      partsSumForProcessedTotal({
        promptTokens: 10,
        completionTokens: 5,
        cacheReadTokens: 4,
        cacheAccounting: "subset",
      }),
    ).toBe(15);
  });

  test("additive includes cache read and write", () => {
    expect(
      partsSumForProcessedTotal({
        promptTokens: 100,
        completionTokens: 50,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        cacheAccounting: "additive",
      }),
    ).toBe(200);
  });

  test("unsafe or overflowing parts → null", () => {
    expect(
      partsSumForProcessedTotal({
        promptTokens: -1,
        completionTokens: 5,
      }),
    ).toBeNull();
    expect(
      partsSumForProcessedTotal({
        promptTokens: Number.MAX_SAFE_INTEGER,
        completionTokens: 1,
        cacheAccounting: "subset",
      }),
    ).toBeNull();
  });
});
