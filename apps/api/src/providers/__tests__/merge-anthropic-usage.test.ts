import { test, expect } from "bun:test";
import {
  mergeAnthropicStreamUsage,
  isAnthropicStreamUsageComplete,
} from "../anthropic-compatible.ts";

test("mergeAnthropicStreamUsage: message_delta output does not wipe input", () => {
  const start = mergeAnthropicStreamUsage(undefined, {
    promptTokens: 100,
  });
  const merged = mergeAnthropicStreamUsage(start, {
    completionTokens: 50,
  });
  expect(merged.promptTokens).toBe(100);
  expect(merged.completionTokens).toBe(50);
  expect(merged.totalTokens).toBe(150);
  expect(isAnthropicStreamUsageComplete(merged)).toBe(true);
});

test("mergeAnthropicStreamUsage: takes max of each field", () => {
  const a = mergeAnthropicStreamUsage(undefined, {
    promptTokens: 10,
    completionTokens: 5,
  });
  const m = mergeAnthropicStreamUsage(a, {
    promptTokens: 12,
    completionTokens: 3,
  });
  expect(m.promptTokens).toBe(12);
  expect(m.completionTokens).toBe(5);
});

test("mergeAnthropicStreamUsage: zero on missing side does not mark presence", () => {
  // Explicit zero IS presence (provider reported 0); undefined is not.
  const onlyOut = mergeAnthropicStreamUsage(undefined, {
    completionTokens: 0,
  });
  expect(onlyOut.hasInput).toBe(false);
  expect(onlyOut.hasOutput).toBe(true);
  expect(isAnthropicStreamUsageComplete(onlyOut)).toBe(false);
});
