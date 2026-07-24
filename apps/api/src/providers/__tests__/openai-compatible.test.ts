import { test, expect } from "bun:test";
import { Effect } from "effect";
import {
  createOpenAICompatibleAdapter,
  authHeaders,
  joinUrl,
  buildChatBody,
  parseUsage,
  assembleChoice,
} from "../openai-compatible.ts";
import type { ChatRequest, AdapterContext } from "../types.ts";

const ctx = (over: Partial<AdapterContext> = {}): AdapterContext => ({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  ...over,
});

test("authHeaders: Bearer + Content-Type; adds OpenAI-Organization when providerOrg set; merges custom headers", () => {
  const h1 = authHeaders(ctx());
  expect(h1["Authorization"]).toBe("Bearer sk-test");
  expect(h1["Content-Type"]).toBe("application/json");
  expect("OpenAI-Organization" in h1).toBe(false);

  const h2 = authHeaders(ctx({ providerOrg: "org-123" }));
  expect(h2["OpenAI-Organization"]).toBe("org-123");

  const h3 = authHeaders(ctx({ headers: { "X-Custom": "v", Authorization: "Bearer override" } }));
  expect(h3["X-Custom"]).toBe("v");
  expect(h3["Authorization"]).toBe("Bearer override");
});

test("joinUrl: handles trailing/leading slash combos", () => {
  expect(joinUrl("https://x.com/v1", "/models")).toBe("https://x.com/v1/models");
  expect(joinUrl("https://x.com/v1/", "/models")).toBe("https://x.com/v1/models");
  expect(joinUrl("https://x.com/v1", "models")).toBe("https://x.com/v1/models");
  expect(joinUrl("https://x.com/v1/", "models")).toBe("https://x.com/v1/models");
});

test("buildChatBody: stream false omits stream_options; stream true adds include_usage", () => {
  const req: ChatRequest = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  };
  const b1 = buildChatBody(req, false);
  expect(b1["stream"]).toBe(false);
  expect("stream_options" in b1).toBe(false);

  const b2 = buildChatBody(req, true);
  expect(b2["stream"]).toBe(true);
  expect(b2["stream_options"]).toEqual({ include_usage: true });
});

test("buildChatBody: non-reasoning includes optional fields when present, omits when undefined", () => {
  const req: ChatRequest = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    maxTokens: 100,
    topP: 0.9,
    tools: [{ type: "function" }],
    toolChoice: "auto",
    stop: ["\n"],
    responseFormat: { type: "json_object" },
  };
  const b = buildChatBody(req, false);
  expect(b["temperature"]).toBe(0.7);
  expect(b["max_tokens"]).toBe(100);
  expect(b["top_p"]).toBe(0.9);
  expect(b["tools"]).toEqual([{ type: "function" }]);
  expect(b["tool_choice"]).toBe("auto");
  expect(b["stop"]).toEqual(["\n"]);
  expect(b["response_format"]).toEqual({ type: "json_object" });
  expect("reasoning_effort" in b).toBe(false);
});

test("buildChatBody: reasoning strips temperature/top_p, uses max_completion_tokens, keeps tools/stop/response_format", () => {
  const req: ChatRequest = {
    model: "o3",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    maxTokens: 1000,
    topP: 0.9,
    tools: [{ type: "function" }],
    toolChoice: "auto",
    stop: ["\n"],
    responseFormat: { type: "json_object" },
    reasoning: { effort: "high" },
  };
  const b = buildChatBody(req, false);
  expect(b["reasoning_effort"]).toBe("high");
  expect(b["max_completion_tokens"]).toBe(1000);
  expect("max_tokens" in b).toBe(false);
  expect("temperature" in b).toBe(false);
  expect("top_p" in b).toBe(false);
  // These are still valid for reasoning models
  expect(b["tools"]).toEqual([{ type: "function" }]);
  expect(b["tool_choice"]).toBe("auto");
  expect(b["stop"]).toEqual(["\n"]);
  expect(b["response_format"]).toEqual({ type: "json_object" });
});

test("buildChatBody: reasoning filters frequency_penalty/presence_penalty from extra", () => {
  const b = buildChatBody(
    { model: "o3", messages: [], reasoning: { effort: "medium" }, extra: { frequency_penalty: 0, presence_penalty: 0, seed: 42, top_k: 10 } },
    false,
  );
  expect(b["reasoning_effort"]).toBe("medium");
  expect("frequency_penalty" in b).toBe(false);
  expect("presence_penalty" in b).toBe(false);
  expect(b["seed"]).toBe(42);
  expect(b["top_k"]).toBe(10);
});

test("buildChatBody: non-reasoning keeps frequency_penalty/presence_penalty from extra", () => {
  const b = buildChatBody(
    { model: "gpt-4o", messages: [], extra: { frequency_penalty: 0.5, presence_penalty: 0.3 } },
    false,
  );
  expect(b["frequency_penalty"]).toBe(0.5);
  expect(b["presence_penalty"]).toBe(0.3);
});

test("buildChatBody: omits reasoning_effort when reasoning is not object-with-effort", () => {
  const b = buildChatBody({ model: "x", messages: [], reasoning: true }, false);
  expect("reasoning_effort" in b).toBe(false);
});

test("buildChatBody: merges extra fields via Object.assign", () => {
  const b = buildChatBody({ model: "x", messages: [], extra: { custom_field: 42 } }, false);
  expect(b["custom_field"]).toBe(42);
});

test("parseUsage: maps OpenAI usage fields, defaults to 0, sums total", () => {
  expect(parseUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  expect(parseUsage({})).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const u = parseUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  expect(u.promptTokens).toBe(100);
  expect(u.completionTokens).toBe(50);
  expect(u.totalTokens).toBe(150);
  // Adapter stamps subset mode for OpenAI-compatible billing.
  expect(u.cacheAccounting).toBe("subset");
});

test("parseUsage: extracts cache tokens from prompt_tokens_details.cached_tokens", () => {
  const u = parseUsage({
    prompt_tokens: 100,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 30 },
    cache_creation_tokens: 10,
  });
  expect(u.cacheReadTokens).toBe(30);
  expect(u.cacheWriteTokens).toBe(10);
});

test("parseUsage: extracts reasoning_tokens when present", () => {
  const u = parseUsage({ prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 200 });
  expect(u.reasoningTokens).toBe(200);
});

test("parseUsage: total falls back to prompt+completion when total_tokens missing", () => {
  const u = parseUsage({ prompt_tokens: 100, completion_tokens: 50 });
  expect(u.totalTokens).toBe(150);
});

test("parseUsage: ignores non-finite numbers", () => {
  const u = parseUsage({ prompt_tokens: Infinity, completion_tokens: NaN, total_tokens: "bad" });
  expect(u.promptTokens).toBe(0);
  expect(u.completionTokens).toBe(0);
  expect(u.totalTokens).toBe(0);
});

test("assembleChoice: maps message content + role + finishReason defaults to stop", () => {
  const c = assembleChoice({ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }, 0);
  expect(c).not.toBeNull();
  expect(c?.index).toBe(0);
  expect(c?.message.content).toBe("hi");
  expect(c?.finishReason).toBe("stop");
});

test("assembleChoice: finishReason defaults to 'stop' when missing", () => {
  const c = assembleChoice({ message: { role: "assistant", content: "hi" } }, 0);
  expect(c?.finishReason).toBe("stop");
});

test("assembleChoice: role defaults to assistant when missing", () => {
  const c = assembleChoice({ message: { content: "hi" } }, 0);
  expect(c?.message.role).toBe("assistant");
});

test("assembleChoice: includes toolCalls when present, refusal overrides content", () => {
  const c = assembleChoice({ message: { role: "assistant", content: "orig", tool_calls: [{ id: "t1" }], refusal: "blocked" } }, 0);
  expect(c?.message.toolCalls).toEqual([{ id: "t1" }]);
  expect(c?.message.content).toBe("blocked");
});

test("assembleChoice: returns null on missing/invalid raw or message", () => {
  expect(assembleChoice(null, 0)).toBeNull();
  expect(assembleChoice("bad", 0)).toBeNull();
  expect(assembleChoice({}, 0)).toBeNull();
  expect(assembleChoice({ message: null }, 0)).toBeNull();
});

test("adapter.sdkType is 'openai-compatible'", () => {
  expect(createOpenAICompatibleAdapter().sdkType).toBe("openai-compatible");
});

test("adapter.listModels: mocks fetch, parses data array, skips entries missing id", async () => {
  const origFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(typeof url === "string" ? url : url.toString());
    void init;
    return new Response(
      JSON.stringify({
        data: [
          { id: "gpt-4o", context_window: 128000, max_output_tokens: 4096 },
          { id: "gpt-4o-mini", max_input_tokens: 128000 },
          { id: "no-ctx-model" },
          { id: "", context_window: 1000 },
          { context_window: 1000 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    const models = await Effect.runPromise(adapter.listModels(ctx()));
    expect(models).toHaveLength(3);
    expect(models[0]?.upstreamModelId).toBe("gpt-4o");
    expect(models[0]?.limits.context).toBe(128000);
    expect(models[0]?.limits.output).toBe(4096);
    expect(models[1]?.limits.context).toBe(128000);
    expect(models[2]?.limits.context).toBeUndefined();
    expect(calls[0]).toContain("/models");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.listModels: throws on non-2xx", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream error", { status: 500 })) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    await expect(Effect.runPromise(adapter.listModels(ctx()))).rejects.toThrow(
      /500/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.chatComplete: maps response, parses usage, returns choices", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    void url;
    const body = JSON.parse(init?.body as string);
    expect(body["model"]).toBe("gpt-4o");
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-123" } },
    );
  }) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    const res = await Effect.runPromise(
      adapter.chatComplete(ctx(), {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.id).toBe("chatcmpl-1");
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0]?.message.content).toBe("hello");
    expect(res.usage.promptTokens).toBe(5);
    expect(res.providerRequestId).toBe("req-123");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.chatComplete: empty choices → default empty assistant choice", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: "x", model: "x", choices: [] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    const res = await Effect.runPromise(
      adapter.chatComplete(ctx(), {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0]?.message.content).toBe("");
    expect(res.choices[0]?.finishReason).toBe("stop");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.chatComplete: throws on non-2xx", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("err", { status: 429 })) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    await expect(
      Effect.runPromise(
        adapter.chatComplete(ctx(), { model: "x", messages: [] }),
      ),
    ).rejects.toThrow(/429/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: parses SSE data lines, yields deltas + done chunk", async () => {
  const sse = [
    `data: {"id":"1","choices":[{"delta":{"content":"hel"}}]}`,
    `data: {"id":"1","choices":[{"delta":{"content":"lo"}}]}`,
    `data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}`,
    `data: {"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}`,
    `data: [DONE]`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    const chunks: unknown[] = [];
    for await (const c of adapter.streamChat(ctx(), { model: "x", messages: [] })) {
      chunks.push(c);
    }
    const types = chunks.map((c) => (c as { type: string }).type);
    expect(types.filter((t) => t === "delta")).toHaveLength(2);
    expect(types[types.length - 1]).toBe("done");
    const done = chunks[chunks.length - 1] as {
      type: string;
      finishReason?: string;
      usage?: { promptTokens: number };
      streamComplete?: boolean;
    };
    expect(done.finishReason).toBe("stop");
    expect(done.streamComplete).toBe(true);
    expect(done.usage?.promptTokens).toBe(2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: EOF without [DONE] is streamComplete false and drops usage", async () => {
  const sse = [
    `data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}`,
    `data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  try {
    const chunks: Array<{ type: string; streamComplete?: boolean; usage?: unknown }> = [];
    for await (const c of createOpenAICompatibleAdapter().streamChat(ctx(), {
      model: "x",
      messages: [],
    })) {
      chunks.push(c as { type: string; streamComplete?: boolean; usage?: unknown });
    }
    const done = chunks[chunks.length - 1];
    expect(done?.type).toBe("done");
    expect(done?.streamComplete).toBe(false);
    expect(done?.usage).toBeUndefined();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: usage:null after reported invalidates (no stale 10/5)", async () => {
  // Valid 10/5 then usage:null then [DONE] must not settle stale usage.
  const sse = [
    `data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}`,
    `data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
    `data: {"usage":null,"choices":[{"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  try {
    const chunks: Array<{
      type: string;
      streamComplete?: boolean;
      usage?: unknown;
    }> = [];
    for await (const c of createOpenAICompatibleAdapter().streamChat(ctx(), {
      model: "x",
      messages: [],
    })) {
      chunks.push(c as { type: string; streamComplete?: boolean; usage?: unknown });
    }
    const done = chunks[chunks.length - 1];
    expect(done?.type).toBe("done");
    expect(done?.streamComplete).toBe(false);
    expect(done?.usage).toBeUndefined();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: pre-final usage:null does not clear later report", async () => {
  const sse = [
    `data: {"id":"1","choices":[{"delta":{"content":"hi"}}],"usage":null}`,
    `data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15},"choices":[{"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  try {
    let done: { streamComplete?: boolean; usage?: { promptTokens?: number } } | undefined;
    for await (const c of createOpenAICompatibleAdapter().streamChat(ctx(), {
      model: "x",
      messages: [],
    })) {
      if ((c as { type: string }).type === "done") {
        done = c as { streamComplete?: boolean; usage?: { promptTokens?: number } };
      }
    }
    expect(done?.streamComplete).toBe(true);
    expect(done?.usage?.promptTokens).toBe(10);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: malformed usage after report invalidates", async () => {
  const sse = [
    `data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
    `data: {"usage":{"prompt_tokens":1.5,"completion_tokens":2,"total_tokens":3.5}}`,
    `data: [DONE]`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  try {
    let done: { streamComplete?: boolean; usage?: unknown } | undefined;
    for await (const c of createOpenAICompatibleAdapter().streamChat(ctx(), {
      model: "x",
      messages: [],
    })) {
      if ((c as { type: string }).type === "done") {
        done = c as { streamComplete?: boolean; usage?: unknown };
      }
    }
    expect(done?.streamComplete).toBe(false);
    expect(done?.usage).toBeUndefined();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: malformed SSE JSON fails closed (not complete, no usage)", async () => {
  const sse = [
    `data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}`,
    `data: {not-valid-json`,
    `data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`,
    `data: [DONE]`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  try {
    const chunks: Array<{
      type: string;
      streamComplete?: boolean;
      usage?: unknown;
      error?: { code?: string };
    }> = [];
    for await (const c of createOpenAICompatibleAdapter().streamChat(ctx(), {
      model: "x",
      messages: [],
    })) {
      chunks.push(
        c as {
          type: string;
          streamComplete?: boolean;
          usage?: unknown;
          error?: { code?: string };
        },
      );
    }
    const err = chunks.find((c) => c.type === "error");
    expect(err?.error?.code).toBe("malformed_sse");
    const done = chunks[chunks.length - 1];
    expect(done?.type).toBe("done");
    expect(done?.streamComplete).toBe(false);
    expect(done?.usage).toBeUndefined();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: throws ProviderError on non-2xx (pre-stream)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    let threw: unknown;
    try {
      for await (const _c of adapter.streamChat(ctx(), { model: "x", messages: [] })) {
        /* should not yield */
      }
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).name).toBe("ProviderError");
    expect((threw as { httpStatus?: number }).httpStatus).toBe(500);
    expect((threw as { fallbackEligible?: boolean }).fallbackEligible).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: captures reasoning_content deltas (DeepSeek style)", async () => {
  const sse = [
    `data: {"id":"1","choices":[{"delta":{"reasoning_content":"thinking..."}}]}`,
    `data: {"id":"1","choices":[{"delta":{"reasoning_content":" more"}}]}`,
    `data: {"id":"1","choices":[{"delta":{"content":"answer"}}]}`,
    `data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    const chunks: unknown[] = [];
    for await (const c of adapter.streamChat(ctx(), { model: "x", messages: [] })) {
      chunks.push(c);
    }
    const reasoningDeltas = chunks.filter(
      (c) => (c as { type: string; delta?: { reasoning?: string } }).delta?.reasoning,
    ) as Array<{ delta: { reasoning: string } }>;
    expect(reasoningDeltas).toHaveLength(2);
    expect(reasoningDeltas[0]?.delta.reasoning).toBe("thinking...");
    expect(reasoningDeltas[1]?.delta.reasoning).toBe(" more");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("adapter.streamChat: captures reasoning as direct string + thinking field", async () => {
  const sse = [
    `data: {"id":"1","choices":[{"delta":{"reasoning":"step 1"}}]}`,
    `data: {"id":"1","choices":[{"delta":{"thinking":"step 2"}}]}`,
    `data: [DONE]`,
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  try {
    const adapter = createOpenAICompatibleAdapter();
    const chunks: unknown[] = [];
    for await (const c of adapter.streamChat(ctx(), { model: "x", messages: [] })) {
      chunks.push(c);
    }
    const reasoningDeltas = chunks.filter(
      (c) => (c as { delta?: { reasoning?: string } }).delta?.reasoning,
    ) as Array<{ delta: { reasoning: string } }>;
    expect(reasoningDeltas).toHaveLength(2);
    expect(reasoningDeltas[0]?.delta.reasoning).toBe("step 1");
    expect(reasoningDeltas[1]?.delta.reasoning).toBe("step 2");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("assembleChoice: captures reasoning_content from non-streaming message", () => {
  const c = assembleChoice({
    message: { role: "assistant", content: "answer", reasoning_content: "because" },
    finish_reason: "stop",
  }, 0);
  expect(c?.message.reasoning).toBe("because");
  expect(c?.message.content).toBe("answer");
});

test("assembleChoice: captures reasoning as string from non-streaming message", () => {
  const c = assembleChoice({
    message: { role: "assistant", content: "answer", reasoning: "deduced" },
    finish_reason: "stop",
  }, 0);
  expect(c?.message.reasoning).toBe("deduced");
});