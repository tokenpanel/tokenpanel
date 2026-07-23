import { test, expect } from "bun:test";
import {
  applyEventToState,
  round,
  formatUnits,
  type StreamPanelState,
} from "../stream-utils.ts";

/**
 * Unit coverage for the playground stream reducer.
 *
 * The E2E suite asserts the streamed reply renders but deliberately does NOT
 * assert the transient in-stream "done" badge / usage line (the StreamPanel is
 * cleared and folded into the chat on completion). This file is the coverage
 * the gateway E2E spec points at: it pins the pure event→state mapping so a
 * regression that drops content, usage, cost, or the error terminal state is
 * caught here.
 *
 * Boundary note: `done` is set by the page's read loop (reader `done` / abort /
 * error), NOT by `applyEventToState` — a `finish_reason:"stop"` chunk does not
 * flip `done` here. The error path is the one terminal state this reducer owns.
 */

function baseState(): StreamPanelState {
  return {
    content: "",
    reasoning: "",
    done: false,
    error: null,
    provider: null,
    cost: null,
    billed: false,
    usage: null,
  };
}

test("chat.completion.chunk accumulates content across deltas", () => {
  let st = baseState();
  st = applyEventToState(st, {
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "Hello from the " }, finish_reason: null }],
  });
  st = applyEventToState(st, {
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "mock provider!" }, finish_reason: null }],
  });
  expect(st.content).toBe("Hello from the mock provider!");
  expect(st.done).toBe(false);
});

test("chat.completion.chunk accumulates reasoning_content separately", () => {
  let st = baseState();
  st = applyEventToState(st, {
    object: "chat.completion.chunk",
    choices: [{ delta: { reasoning_content: "thinking… " } }],
  });
  st = applyEventToState(st, {
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "answer" } }],
  });
  expect(st.reasoning).toBe("thinking… ");
  expect(st.content).toBe("answer");
});

test("chat.completion.chunk maps usage tokens (incl. reasoning_tokens)", () => {
  const st = applyEventToState(baseState(), {
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 2000,
      total_tokens: 3000,
      reasoning_tokens: 42,
    },
  });
  expect(st.usage).toEqual({
    promptTokens: 1000,
    completionTokens: 2000,
    totalTokens: 3000,
    reasoningTokens: 42,
  });
});

test("chat.completion.chunk without usage preserves prior usage", () => {
  let st = applyEventToState(baseState(), {
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  });
  st = applyEventToState(st, {
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "x" } }],
  });
  expect(st.usage?.totalTokens).toBe(11);
  expect(st.content).toBe("x");
});

test("playground.cost sets cost, provider and billed flag", () => {
  const st = applyEventToState(baseState(), {
    object: "playground.cost",
    cost: { costUnits: 123, priceUnits: 456, currency: "USD" },
    provider: { providerId: "p1", upstreamModelId: "mock-gpt", sdkType: "openai-compatible" },
    billed: true,
  });
  expect(st.cost).toEqual({ costUnits: 123, priceUnits: 456, currency: "USD" });
  expect(st.provider).toEqual({
    providerId: "p1",
    upstreamModelId: "mock-gpt",
    sdkType: "openai-compatible",
  });
  expect(st.billed).toBe(true);
});

test("playground.cost without billed defaults billed=false and clears cost when absent", () => {
  const st = applyEventToState(baseState(), { object: "playground.cost" });
  expect(st.cost).toBeNull();
  expect(st.billed).toBe(false);
});

test("error event sets the terminal done+error state", () => {
  const st = applyEventToState(baseState(), {
    object: "error",
    error: { message: "upstream exploded" },
  });
  expect(st.done).toBe(true);
  expect(st.error).toBe("upstream exploded");
});

test("error object without message falls back to 'error'", () => {
  const st = applyEventToState(baseState(), { error: {} });
  expect(st.done).toBe(true);
  expect(st.error).toBe("error");
});

test("playground.meta is ignored (state unchanged)", () => {
  const before = baseState();
  const st = applyEventToState(before, { object: "playground.meta", foo: 1 });
  expect(st).toEqual(before);
});

test("finish_reason stop does NOT flip done (page loop owns done)", () => {
  const st = applyEventToState(baseState(), {
    object: "chat.completion.chunk",
    choices: [{ delta: {}, finish_reason: "stop" }],
  });
  expect(st.done).toBe(false);
});

test("round rounds to the given decimal places", () => {
  expect(round(1.005, 2)).toBe(1);
  expect(round(1.2345, 2)).toBe(1.23);
  expect(round(10, 0)).toBe(10);
});

test("formatUnits respects ISO currency exponent", () => {
  // USD exponent 2 → 12345 minor units = 123.45, padded to 4 decimals.
  expect(formatUnits(12345, "usd")).toBe("USD 123.4500");
});
