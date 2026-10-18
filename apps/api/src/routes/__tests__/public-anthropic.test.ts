import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  translateAnthropicMessage,
  buildAnthropicChatRequest,
  anthropicMessageJson,
  effectiveAnthropicMaxTokens,
} from "../public/anthropic.ts";
import { AnthropicMessagesBody, safeParseSchema } from "../../http/validation/index.ts";
import {
  splitSystemAndMessages,
  translateTools,
  assembleMessage,
  buildBody,
} from "../../providers/anthropic-compatible.ts";
import {
  toAnthropicStopReason,
  anthropicToolInstructions,
  AnthropicBlockStream,
} from "../../providers/index.ts";
import type { GenerationCompleteResult } from "../../domains/providers/generation.ts";

function parseBody(raw: unknown) {
  const parsed = safeParseSchema(AnthropicMessagesBody, raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("unreachable");
  return parsed.data;
}

function genResult(over: {
  content?: string | null;
  toolCalls?: unknown[];
  finishReason?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): GenerationCompleteResult {
  return {
    entry: { id: "e1", providerId: new ObjectId(), upstreamModelId: "claude-sonnet-5", priority: 0, active: true },
    provider: { _id: new ObjectId(), sdkType: "anthropic-compatible" },
    response: {
      id: "msg_x",
      model: "claude-sonnet-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: over.content === undefined ? "hi" : over.content,
            ...(over.toolCalls !== undefined ? { toolCalls: over.toolCalls } : {}),
          },
          finishReason: over.finishReason ?? "end_turn",
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        ...(over.cacheReadTokens !== undefined ? { cacheReadTokens: over.cacheReadTokens } : {}),
        ...(over.cacheWriteTokens !== undefined ? { cacheWriteTokens: over.cacheWriteTokens } : {}),
      },
    },
    settlement: {} as GenerationCompleteResult["settlement"],
    durationMs: 1,
    charges: { costMicros: 0, priceMicros: 0, currency: "USD" },
    gatewayRequestId: "gw_1",
  } as unknown as GenerationCompleteResult;
}

// ---------------------------------------------------------------------------
// Request schema — Anthropic Messages spec conformance
// ---------------------------------------------------------------------------

test("schema: max_tokens required, 0 allowed (cache pre-warm), negatives rejected", () => {
  const missing = safeParseSchema(AnthropicMessagesBody, {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(missing.success).toBe(false);

  const zero = parseBody({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 0,
  });
  expect(zero.max_tokens).toBe(0);

  const negative = safeParseSchema(AnthropicMessagesBody, {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: -1,
  });
  expect(negative.success).toBe(false);
});

test("schema: tool_use + tool_result + thinking blocks validate for replay", () => {
  const body = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me check", signature: "sig-abc" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "72F", is_error: false }],
      },
    ],
  });
  const assistant = body.messages[1]!.content as unknown as Record<string, unknown>[];
  expect(assistant[0]).toMatchObject({ type: "thinking", signature: "sig-abc" });
  expect(assistant[1]).toMatchObject({ type: "tool_use", id: "toolu_1" });
  const result = (body.messages[2]!.content as unknown as Record<string, unknown>[])![0];
  expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false });
});

test("schema: top_k / thinking / metadata / service_tier accepted", () => {
  const body = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    top_k: 40,
    thinking: { type: "enabled", budget_tokens: 2048 },
    metadata: { user_id: "u1" },
    service_tier: "standard_only",
  });
  expect(body.top_k).toBe(40);
  expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  expect(body.service_tier).toBe("standard_only");
});

// ---------------------------------------------------------------------------
// translateAnthropicMessage — spec request → internal model
// ---------------------------------------------------------------------------

test("translateAnthropicMessage: string content passthrough", () => {
  const m = translateAnthropicMessage({ role: "user", content: "hello" });
  expect(m.role).toBe("user");
  expect(m.content).toBe("hello");
});

test("translateAnthropicMessage: text block → text ContentPart", () => {
  const m = translateAnthropicMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "hi" });
});

test("translateAnthropicMessage: base64 image block → image_url data URI", () => {
  const m = translateAnthropicMessage({
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
  });
  expect((m.content as unknown[])[0]).toEqual({
    type: "image_url",
    imageUrl: { url: "data:image/png;base64,abc" },
  });
});

test("translateAnthropicMessage: url image source → image_url with URL", () => {
  const m = translateAnthropicMessage({
    role: "user",
    content: [{ type: "image", source: { type: "url", url: "https://x/a.png" } }],
  });
  expect((m.content as unknown[])[0]).toEqual({
    type: "image_url",
    imageUrl: { url: "https://x/a.png" },
  });
});

test("translateAnthropicMessage: tool_use block → internal tool_use part (not dropped)", () => {
  const m = translateAnthropicMessage({
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "fn", input: { x: 1 } }],
  });
  expect((m.content as unknown[])[0]).toEqual({
    type: "tool_use",
    id: "t1",
    name: "fn",
    input: { x: 1 },
  });
});

test("translateAnthropicMessage: tool_result block → internal tool_result part", () => {
  const m = translateAnthropicMessage({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "done", is_error: true }],
  });
  expect((m.content as unknown[])[0]).toEqual({
    type: "tool_result",
    toolUseId: "t1",
    content: "done",
    isError: true,
  });
});

test("translateAnthropicMessage: thinking block preserved verbatim for replay", () => {
  const m = translateAnthropicMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
  });
  const part = (m.content as { type: string; block: Record<string, unknown> }[])[0]!;
  expect(part.type).toBe("raw");
  expect(part.block).toMatchObject({ type: "thinking", thinking: "hmm", signature: "sig" });
});

// ---------------------------------------------------------------------------
// buildAnthropicChatRequest — system handling + extras
// ---------------------------------------------------------------------------

test("buildAnthropicChatRequest: system carrier keeps text + verbatim blocks (cache_control survives)", () => {
  const body = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 100,
    system: [
      { type: "text", text: "first" },
      { type: "text", text: "second", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  const req = buildAnthropicChatRequest(body, false);
  // Text feeds estimation + OpenAI-shaped upstreams.
  expect(req.system?.text).toBe("first\n\nsecond");
  // Original blocks — cache_control breakpoints intact — go to Anthropic upstreams.
  expect(req.system?.blocks).toEqual([
    { type: "text", text: "first" },
    { type: "text", text: "second", cache_control: { type: "ephemeral" } },
  ]);
  // No synthetic system message pollutes the message list.
  expect(req.messages[0]!.role).toBe("user");
});

test("buildBody: system carrier blocks reach the Anthropic wire verbatim (cache hits)", () => {
  const b = buildBody(
    {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      system: {
        text: "be nice",
        blocks: [{ type: "text", text: "be nice", cache_control: { type: "ephemeral" } }],
      },
    },
    false,
  );
  expect(b["system"]).toEqual([
    { type: "text", text: "be nice", cache_control: { type: "ephemeral" } },
  ]);
});

test("buildAnthropicChatRequest: forwards top_k/thinking/metadata/service_tier via extra", () => {
  const body = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    top_k: 10,
    thinking: { type: "enabled", budget_tokens: 2048 },
    metadata: { user_id: "u" },
    service_tier: "auto",
  });
  const req = buildAnthropicChatRequest(body, false);
  expect(req.extra).toMatchObject({
    top_k: 10,
    thinking: { type: "enabled", budget_tokens: 2048 },
    metadata: { user_id: "u" },
    service_tier: "auto",
  });
});

// ---------------------------------------------------------------------------
// Security: thinking budget must not bypass the preflight reservation
// ---------------------------------------------------------------------------

test("schema: thinking.budget_tokens is bounded (rejects absurd budgets)", () => {
  const huge = safeParseSchema(AnthropicMessagesBody, {
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 10_000_000 },
  });
  expect(huge.success).toBe(false);

  const ok = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 4096 },
  });
  expect(ok.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });

  const disabled = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  expect(disabled.thinking).toEqual({ type: "disabled" });
});

test("effectiveAnthropicMaxTokens: reserves against budget+4096 when it exceeds max_tokens", () => {
  // The exploit shape: tiny max_tokens, large thinking budget. Reservation
  // must cover the effective upstream window, not just max_tokens.
  const body = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 100000 },
  });
  expect(effectiveAnthropicMaxTokens(body)).toBe(100000 + 4096);
});

test("effectiveAnthropicMaxTokens: max_tokens wins when larger; disabled/absent thinking → max_tokens", () => {
  const largeMax = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 50000,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 4096 },
  });
  expect(effectiveAnthropicMaxTokens(largeMax)).toBe(50000);

  const disabled = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  expect(effectiveAnthropicMaxTokens(disabled)).toBe(2048);

  const none = parseBody({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(effectiveAnthropicMaxTokens(none)).toBe(2048);
});

// ---------------------------------------------------------------------------
// Upstream wire serialization (adapter)
// ---------------------------------------------------------------------------

test("adapter wire: assistant toolCalls → tool_use blocks; tool role → tool_result", () => {
  const { system, messages } = splitSystemAndMessages({
    model: "claude-sonnet-5",
    messages: [
      { role: "system", content: "be nice" },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
      },
      { role: "tool", content: "72F", toolCallId: "t1" },
    ],
  });
  expect(system).toBe("be nice");
  const assistant = messages[1]!.content as Record<string, unknown>[];
  expect(assistant[0]).toEqual({
    type: "tool_use",
    id: "t1",
    name: "get_weather",
    input: { city: "SF" },
  });
  const toolResult = messages[2]!.content as Record<string, unknown>[];
  expect(toolResult[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "72F" });
});

test("adapter wire: internal image_url part → Anthropic base64 image block", () => {
  const { messages } = splitSystemAndMessages({
    model: "claude-sonnet-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", imageUrl: { url: "data:image/png;base64,abc" } }],
      },
    ],
  });
  expect((messages[0]!.content as unknown[])![0]).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "abc" },
  });
});

test("adapter wire: raw Anthropic blocks pass through verbatim", () => {
  const { messages } = splitSystemAndMessages({
    model: "claude-sonnet-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "raw", block: { type: "thinking", thinking: "x", signature: "s" } }],
      },
    ],
  });
  expect((messages[0]!.content as unknown[])![0]).toEqual({
    type: "thinking",
    thinking: "x",
    signature: "s",
  });
});

test("translateTools: OpenAI function tools → Anthropic input_schema tools", () => {
  const tools = translateTools([
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "gets weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ]);
  expect(tools).toEqual([
    {
      name: "get_weather",
      description: "gets weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
  ]);
});

test("translateTools: Anthropic-shaped tools pass through", () => {
  const native = { name: "t", input_schema: { type: "object" } };
  expect(translateTools([native])).toEqual([native]);
});

test("buildBody: thinking extra from route wins; max_tokens bumped above budget", () => {
  const body = buildBody(
    {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      extra: { thinking: { type: "enabled", budget_tokens: 2048 } },
    },
    false,
  );
  expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  expect(body.max_tokens).toBeGreaterThan(2048);
});

// ---------------------------------------------------------------------------
// Response shape — Anthropic Messages response spec
// ---------------------------------------------------------------------------

test("response: tool-call turn → tool_use blocks, no phantom empty text block", () => {
  const json = anthropicMessageJson(
    genResult({
      content: null,
      toolCalls: [{ id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
      finishReason: "tool_use",
    }),
    "claude-alias",
  );
  expect(json.type).toBe("message");
  expect(json.role).toBe("assistant");
  expect(json.content).toEqual([
    { type: "tool_use", id: "t1", name: "get_weather", input: { city: "SF" } },
  ]);
  expect(json.stop_reason).toBe("tool_use");
  expect(json.stop_sequence).toBeNull();
});

test("response: text turn keeps text block + end_turn", () => {
  const json = anthropicMessageJson(genResult({ content: "hello", finishReason: "end_turn" }), "m");
  expect(json.content).toEqual([{ type: "text", text: "hello" }]);
  expect(json.stop_reason).toBe("end_turn");
});

test("response: empty content falls back to single empty text block", () => {
  const json = anthropicMessageJson(genResult({ content: "" }), "m");
  expect(json.content).toEqual([{ type: "text", text: "" }]);
});

test("response: stop_reason normalized to Anthropic enum for OpenAI-backed models", () => {
  expect(anthropicMessageJson(genResult({ finishReason: "stop" }), "m").stop_reason).toBe("end_turn");
  expect(anthropicMessageJson(genResult({ finishReason: "length" }), "m").stop_reason).toBe("max_tokens");
  expect(anthropicMessageJson(genResult({ finishReason: "tool_calls" }), "m").stop_reason).toBe("tool_use");
  expect(anthropicMessageJson(genResult({ finishReason: "content_filter" }), "m").stop_reason).toBe("refusal");
});

test("response: usage carries cache fields when reported", () => {
  const json = anthropicMessageJson(genResult({ cacheReadTokens: 3, cacheWriteTokens: 2 }), "m");
  expect(json.usage).toMatchObject({
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  });
});

test("assembleMessage: tool-only turn → null content; thinking → reasoning, not text", () => {
  const m = assembleMessage({
    content: [
      { type: "thinking", thinking: "ponder" },
      { type: "tool_use", id: "t1", name: "fn", input: { x: 1 } },
    ],
  });
  expect(m.content).toBeNull();
  expect(m.reasoning).toBe("ponder");
  expect(m.toolCalls).toEqual([
    { id: "t1", type: "function", function: { name: "fn", arguments: '{"x":1}' } },
  ]);
});

// ---------------------------------------------------------------------------
// Stream normalization helpers
// ---------------------------------------------------------------------------

test("toAnthropicStopReason: unknown reasons map to end_turn, never leak foreign values", () => {
  expect(toAnthropicStopReason("stop")).toBe("end_turn");
  expect(toAnthropicStopReason("length")).toBe("max_tokens");
  expect(toAnthropicStopReason("tool_calls")).toBe("tool_use");
  expect(toAnthropicStopReason("weird_future_reason")).toBe("end_turn");
  expect(toAnthropicStopReason(undefined)).toBe("end_turn");
});

test("AnthropicBlockStream: kind change closes previous block, indexes increment", () => {
  const blocks = new AnthropicBlockStream();
  const t1 = blocks.transition("text");
  expect(t1).toMatchObject({ close: [], start: [{ index: 0, kind: "text" }] });
  const t2 = blocks.transition("text");
  expect(t2.close).toEqual([]);
  expect(t2.index).toBe(0);
  const t3 = blocks.transition("tool_use");
  expect(t3.close).toEqual([0]);
  expect(t3.start).toEqual([{ index: 1, kind: "tool_use" }]);
  expect(blocks.closeOpen()).toBe(1);
  expect(blocks.closeOpen()).toBeNull();
  expect(blocks.openedCount()).toBe(2);
});

test("anthropicToolInstructions: OpenAI-shaped deltas → block start + json deltas", () => {
  const blocks = new AnthropicBlockStream();
  const first = anthropicToolInstructions(blocks, [
    { index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "" } },
  ]);
  expect(first.close).toEqual([]);
  expect(first.start).toEqual([{ index: 0, id: "c1", name: "get_weather" }]);
  const second = anthropicToolInstructions(blocks, [
    { index: 0, function: { arguments: '{"city":' } },
  ]);
  expect(second.start).toEqual([]);
  expect(second.json).toEqual([{ index: 0, partial: '{"city":' }]);
});


test("anthropicToolInstructions: consecutive parallel tool calls each get their own block", () => {
  const blocks = new AnthropicBlockStream();
  // Two tool calls back-to-back (no interleaved text) — e.g. parallel calls.
  const instr = anthropicToolInstructions(blocks, [
    { index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "" } },
    { index: 1, id: "c2", type: "function", function: { name: "get_time", arguments: "" } },
  ]);
  // First call closes nothing, opens index 0; second closes index 0, opens index 1.
  expect(instr.close).toEqual([0]);
  expect(instr.start).toEqual([
    { index: 0, id: "c1", name: "get_weather" },
    { index: 1, id: "c2", name: "get_time" },
  ]);
});
