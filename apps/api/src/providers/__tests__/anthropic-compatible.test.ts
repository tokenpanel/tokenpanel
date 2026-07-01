import { test, expect } from "bun:test";
import {
  createAnthropicCompatibleAdapter,
  headers,
  joinUrl,
  stringifyContent,
  splitSystemAndMessages,
  translateTools,
  buildBody,
  mapUsage,
  assembleMessage,
} from "../anthropic-compatible.ts";
import type { ChatRequest, AdapterContext } from "../types.ts";

const ctx = (over: Partial<AdapterContext> = {}): AdapterContext => ({
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant-test",
  ...over,
});

test("headers: x-api-key + anthropic-version + Content-Type; merges custom + extra", () => {
  const h = headers(ctx());
  expect(h["x-api-key"]).toBe("sk-ant-test");
  expect(h["anthropic-version"]).toBe("2023-06-01");
  expect(h["Content-Type"]).toBe("application/json");

  const h2 = headers(ctx({ headers: { "X-Custom": "v" } }));
  expect(h2["X-Custom"]).toBe("v");

  const h3 = headers(ctx(), { "anthropic-beta": "x" });
  expect(h3["anthropic-beta"]).toBe("x");
});

test("joinUrl: handles slash combos", () => {
  expect(joinUrl("https://x.com", "/messages")).toBe("https://x.com/messages");
  expect(joinUrl("https://x.com/", "/messages")).toBe("https://x.com/messages");
  expect(joinUrl("https://x.com", "messages")).toBe("https://x.com/messages");
  expect(joinUrl("https://x.com/", "messages")).toBe("https://x.com/messages");
});

test("stringifyContent: string passthrough; array extracts text parts", () => {
  expect(stringifyContent("hello")).toBe("hello");
  expect(stringifyContent([{ type: "text", text: "a" }, { type: "image_url", imageUrl: { url: "x" } }, { type: "text", text: "b" }])).toBe("ab");
  expect(stringifyContent([])).toBe("");
  expect(stringifyContent([{ type: "image_url", imageUrl: { url: "x" } }])).toBe("");
});

test("splitSystemAndMessages: extracts system, converts tool→user tool_result, passes others", () => {
  const req: ChatRequest = {
    model: "x",
    messages: [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
      { role: "user", content: "hi" },
      { role: "tool", content: "result", toolCallId: "t1" },
      { role: "assistant", content: "ok" },
    ],
  };
  const { system, messages } = splitSystemAndMessages(req);
  expect(system).toBe("sys1\n\nsys2");
  expect(messages).toHaveLength(3);
  expect(messages[0]?.role).toBe("user");
  expect(messages[1]?.role).toBe("user");
  expect((messages[1]?.content as unknown[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
  expect(messages[2]?.role).toBe("assistant");
});

test("translateTools: returns undefined for empty/missing; passes function tools, wraps others", () => {
  expect(translateTools(undefined)).toBeUndefined();
  expect(translateTools([])).toBeUndefined();
  const out = translateTools([{ type: "function", function: { name: "f" } }, { type: "other" }]);
  expect(out).toHaveLength(2);
  expect(out?.[0]).toMatchObject({ type: "function" });
  expect(out?.[1]).toMatchObject({ name: "tool" });
});

test("buildBody: default max_tokens 4096, includes system, maps stop→stop_sequences, thinking budget per effort", () => {
  const req: ChatRequest = {
    model: "claude-3",
    messages: [{ role: "user", content: "hi" }, { role: "system", content: "sys" }],
    maxTokens: 1024,
    temperature: 0.5,
    stop: ["\n"],
    tools: [{ type: "function", function: { name: "f" } }],
    toolChoice: "auto",
  };
  const b = buildBody(req, false);
  expect(b["max_tokens"]).toBe(1024);
  expect(b["system"]).toBe("sys");
  expect(b["temperature"]).toBe(0.5);
  expect(b["stop_sequences"]).toEqual(["\n"]);
  expect(b["tools"]).toHaveLength(1);
  expect(b["tool_choice"]).toBe("auto");
  expect(b["stream"]).toBe(false);
});

test("buildBody: defaults max_tokens to 4096 when missing", () => {
  const b = buildBody({ model: "x", messages: [] }, false);
  expect(b["max_tokens"]).toBe(4096);
});

test("buildBody: thinking budget low=2048 medium=8192 high=16384", () => {
  const low = buildBody({ model: "x", messages: [], reasoning: { effort: "low" } }, false);
  expect((low["thinking"] as { budget_tokens: number }).budget_tokens).toBe(2048);
  const med = buildBody({ model: "x", messages: [], reasoning: { effort: "medium" } }, false);
  expect((med["thinking"] as { budget_tokens: number }).budget_tokens).toBe(8192);
  const hi = buildBody({ model: "x", messages: [], reasoning: { effort: "high" } }, false);
  expect((hi["thinking"] as { budget_tokens: number }).budget_tokens).toBe(16384);
});

test("buildBody: thinking bumps max_tokens above budget + drops temperature/top_p/stop", () => {
  const hi = buildBody({ model: "x", messages: [], reasoning: { effort: "high" }, maxTokens: 1024, temperature: 0.7, topP: 0.9, stop: ["x"] }, false);
  expect((hi["thinking"] as { budget_tokens: number }).budget_tokens).toBe(16384);
  expect(hi["max_tokens"]).toBe(16384 + 4096);
  expect(hi["temperature"]).toBeUndefined();
  expect(hi["top_p"]).toBeUndefined();
  expect(hi["stop_sequences"]).toBeUndefined();
});

test("buildBody: thinking respects caller max_tokens when already > budget", () => {
  const med = buildBody({ model: "x", messages: [], reasoning: { effort: "medium" }, maxTokens: 20000 }, false);
  expect((med["thinking"] as { budget_tokens: number }).budget_tokens).toBe(8192);
  expect(med["max_tokens"]).toBe(20000);
});

test("buildBody: merges extra fields", () => {
  const b = buildBody({ model: "x", messages: [], extra: { custom: 1 } }, false);
  expect(b["custom"]).toBe(1);
});

test("mapUsage: maps anthropic fields, defaults 0, sums total", () => {
  expect(mapUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  expect(mapUsage({})).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const u = mapUsage({ input_tokens: 100, output_tokens: 50 });
  expect(u.promptTokens).toBe(100);
  expect(u.completionTokens).toBe(50);
  expect(u.totalTokens).toBe(150);
});

test("mapUsage: extracts cache + reasoning tokens", () => {
  const u = mapUsage({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
    reasoning_tokens: 200,
  });
  expect(u.cacheReadTokens).toBe(30);
  expect(u.cacheWriteTokens).toBe(10);
  expect(u.reasoningTokens).toBe(200);
});

test("assembleMessage: text blocks concatenated into content", () => {
  const m = assembleMessage({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
  expect(m.role).toBe("assistant");
  expect(m.content).toBe("ab");
});

test("assembleMessage: tool_use blocks → toolCalls with JSON-stringified input", () => {
  const m = assembleMessage({ content: [{ type: "tool_use", id: "t1", name: "fn", input: { x: 1 } }] });
  expect(m.toolCalls).toEqual([{ id: "t1", type: "function", function: { name: "fn", arguments: '{"x":1}' } }]);
});

test("assembleMessage: thinking blocks appended to text", () => {
  const m = assembleMessage({ content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }] });
  expect(m.content).toBe("reasoninganswer");
});

test("assembleMessage: empty/invalid → empty assistant", () => {
  expect(assembleMessage(null)).toEqual({ role: "assistant", content: "" });
  expect(assembleMessage("bad")).toEqual({ role: "assistant", content: "" });
  expect(assembleMessage({})).toEqual({ role: "assistant", content: "" });
});

test("adapter.sdkType is 'anthropic-compatible'", () => {
  expect(createAnthropicCompatibleAdapter().sdkType).toBe("anthropic-compatible");
});

test("adapter.listModels: mocks fetch, parses data, uses display_name fallback to id", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ id: "claude-3", display_name: "Claude 3" }, { id: "claude-4" }, { id: "" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
  try {
    const adapter = createAnthropicCompatibleAdapter();
    const models = await adapter.listModels(ctx());
    expect(models).toHaveLength(2);
    expect(models[0]?.displayName).toBe("Claude 3");
    expect(models[1]?.displayName).toBe("claude-4");
    expect(models[0]?.limits.context).toBe(200_000);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.listModels: throws on non-2xx", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
  try {
    await expect(createAnthropicCompatibleAdapter().listModels(ctx())).rejects.toThrow(/500/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.chatComplete: maps response with message + usage + stop_reason", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    expect(body["model"]).toBe("claude-3");
    expect(body["max_tokens"]).toBe(1024);
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect(body["system"]).toBe("sys");
    return new Response(
      JSON.stringify({
        id: "msg_1",
        model: "claude-3",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req-1" } },
    );
  }) as unknown as typeof fetch;
  try {
    const adapter = createAnthropicCompatibleAdapter();
    const res = await adapter.chatComplete(ctx(), {
      model: "claude-3",
      messages: [{ role: "user", content: "hi" }, { role: "system", content: "sys" }],
      maxTokens: 1024,
    });
    expect(res.id).toBe("msg_1");
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0]?.message.content).toBe("hello");
    expect(res.choices[0]?.finishReason).toBe("end_turn");
    expect(res.usage.promptTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(8);
    expect(res.providerRequestId).toBe("req-1");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: parses anthropic SSE events (message_start, content_block_delta, message_delta, message_stop)", async () => {
  const sse = [
    `event: message_start`,
    `data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}`,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}`,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}`,
    `event: message_delta`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`,
    `event: message_stop`,
    `data: {"type":"message_stop"}`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  try {
    const adapter = createAnthropicCompatibleAdapter();
    const chunks: unknown[] = [];
    for await (const c of adapter.streamChat(ctx(), { model: "x", messages: [] })) {
      chunks.push(c);
    }
    const deltas = chunks.filter((c) => (c as { type: string }).type === "delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0] as { delta?: { content?: string } }).delta?.content).toBe("hel");
    const done = chunks[chunks.length - 1] as { type: string; finishReason?: string; usage?: { promptTokens: number; completionTokens: number } };
    expect(done.type).toBe("done");
    expect(done.finishReason).toBe("end_turn");
    expect(done.usage?.completionTokens).toBe(5);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: yields error chunk on non-2xx", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("err", { status: 429 })) as unknown as typeof fetch;
  try {
    const chunks: unknown[] = [];
    for await (const c of createAnthropicCompatibleAdapter().streamChat(ctx(), { model: "x", messages: [] })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { type: string }).type).toBe("error");
    expect((chunks[0] as { error?: { code?: string } }).error?.code).toBe("http_429");
  } finally {
    globalThis.fetch = origFetch;
  }
});