import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  toOpenAIModel,
  translateMessage,
  buildOpenAIChatRequest,
  openAICompletionJson,
} from "../public/openai.ts";
import { OpenAIChatCompletionBody, safeParseSchema } from "../../http/validation/index.ts";
import {
  buildChatBody,
  assembleChoice,
} from "../../providers/openai-compatible.ts";
import { toOpenAIFinishReason, toOpenAIToolCallDeltas } from "../../providers/index.ts";
import type { ModelDoc } from "@tokenpanel/db";
import type { GenerationCompleteResult } from "../../domains/providers/generation.ts";

function model(over: Partial<ModelDoc> = {}): ModelDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    aliasId: "my-gpt",
    displayName: "My GPT",
    description: null,
    entries: [{ id: "e1", providerId: new ObjectId(), upstreamModelId: "gpt-4o", priority: 0, active: true }],
    reasoning: false,
    toolCall: false,
    structuredOutput: undefined,
    temperature: undefined,
    attachment: false,
    interleaved: undefined,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    status: undefined,
    price: { inputMicrosPerMillion: 300, outputMicrosPerMillion: 600 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function parseBody(raw: unknown) {
  const parsed = safeParseSchema(OpenAIChatCompletionBody, raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("unreachable");
  return parsed.data;
}

function genResult(over: {
  content?: string | null;
  refusal?: string | null;
  toolCalls?: unknown[];
  finishReason?: string;
  reasoningTokens?: number;
  cacheReadTokens?: number;
}): GenerationCompleteResult {
  return {
    entry: { id: "e1", providerId: new ObjectId(), upstreamModelId: "gpt-4o", priority: 0, active: true },
    provider: { _id: new ObjectId(), sdkType: "openai-compatible" },
    response: {
      id: "chatcmpl-x",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: over.content === undefined ? "hi" : over.content,
            ...(over.refusal !== undefined ? { refusal: over.refusal } : {}),
            ...(over.toolCalls !== undefined ? { toolCalls: over.toolCalls } : {}),
          },
          finishReason: over.finishReason ?? "stop",
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        ...(over.reasoningTokens !== undefined ? { reasoningTokens: over.reasoningTokens } : {}),
        ...(over.cacheReadTokens !== undefined ? { cacheReadTokens: over.cacheReadTokens } : {}),
      },
    },
    settlement: {} as GenerationCompleteResult["settlement"],
    durationMs: 1,
    charges: { costMicros: 0, priceMicros: 0, currency: "USD" },
    gatewayRequestId: "gw_1",
  } as unknown as GenerationCompleteResult;
}

// ---------------------------------------------------------------------------
// /v1/models
// ---------------------------------------------------------------------------

test("toOpenAIModel: maps aliasId → id, object 'model', created from createdAt, owned_by 'tokenpanel'", () => {
  const m = toOpenAIModel(model());
  expect(m.id).toBe("my-gpt");
  expect(m.object).toBe("model");
  expect(m.owned_by).toBe("tokenpanel");
  expect(m.created).toBe(Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000));
});

test("toOpenAIModel: omits model metadata (not exposed on /v1/models)", () => {
  const m = toOpenAIModel(model({ metadata: { tier: "gold", secret: "nope" } }));
  expect("metadata" in m).toBe(false);
  expect(Object.keys(m).sort()).toEqual(["created", "id", "object", "owned_by"]);
});

// ---------------------------------------------------------------------------
// Request schema — OpenAI Chat Completions spec conformance
// ---------------------------------------------------------------------------

test("schema: assistant message with content:null + tool_calls validates (AI SDK canonical tool-call turn)", () => {
  const body = parseBody({
    model: "gpt-4o",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "72F" },
    ],
  });
  expect(body.messages[1]!.content).toBeNull();
  expect(body.messages[1]!.tool_calls?.[0]).toMatchObject({ id: "call_1" });
});

test("schema: assistant message with content omitted entirely validates (lenient gateway)", () => {
  const body = parseBody({
    model: "gpt-4o",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ],
  });
  expect(body.messages[1]!.content).toBeUndefined();
  expect(translateMessage(body.messages[1]!).content).toBeNull();
});

test("schema: developer role accepted (o-series / gpt-4.1 / gpt-5 default)", () => {
  const body = parseBody({
    model: "o3",
    messages: [
      { role: "developer", content: "instructions" },
      { role: "user", content: "hi" },
    ],
  });
  expect(body.messages[0]!.role).toBe("developer");
});

test("schema: file content part accepted", () => {
  const body = parseBody({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "file", file: { file_data: "data:text/plain;base64,aGk=", filename: "a.txt" } },
        ],
      },
    ],
  });
  expect((body.messages[0]!.content as unknown[])![0]).toMatchObject({ type: "file" });
});

test("schema: input_audio requires format (wav|mp3)", () => {
  const bad = safeParseSchema(OpenAIChatCompletionBody, {
    model: "gpt-4o",
    messages: [
      { role: "user", content: [{ type: "input_audio", input_audio: { data: "AAA" } }] },
    ],
  });
  expect(bad.success).toBe(false);
  const ok = parseBody({
    model: "gpt-4o",
    messages: [
      { role: "user", content: [{ type: "input_audio", input_audio: { data: "AAA", format: "wav" } }] },
    ],
  });
  expect((ok.messages[0]!.content as unknown[])![0]).toMatchObject({
    type: "input_audio",
    input_audio: { format: "wav" },
  });
});

test("schema: reasoning_effort accepts full spec enum incl. none/minimal/xhigh/max", () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const body = parseBody({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: effort,
    });
    expect(body.reasoning_effort).toBe(effort);
  }
});

test("schema: nullable params accepted (stream/temperature/max_tokens/stop null)", () => {
  const body = parseBody({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    stream: null,
    temperature: null,
    max_tokens: null,
    stop: null,
    reasoning_effort: null,
  });
  expect(body.stream).toBeNull();
  expect(body.stop).toBeNull();
});

// ---------------------------------------------------------------------------
// translateMessage — spec request → internal model
// ---------------------------------------------------------------------------

test("translateMessage: string content passthrough", () => {
  const m = translateMessage({ role: "user", content: "hello" });
  expect(m.role).toBe("user");
  expect(m.content).toBe("hello");
});

test("translateMessage: null content preserved (canonical assistant tool-call turn)", () => {
  const m = translateMessage({ role: "assistant", content: null });
  expect(m.content).toBeNull();
});

test("translateMessage: text part → text ContentPart", () => {
  const m = translateMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "hi" });
});

test("translateMessage: image_url part keeps url + detail", () => {
  const m = translateMessage({
    role: "user",
    content: [{ type: "image_url", image_url: { url: "https://x.com/a.png", detail: "low" } }],
  });
  expect((m.content as unknown[])[0]).toEqual({
    type: "image_url",
    imageUrl: { url: "https://x.com/a.png", detail: "low" },
  });
});

test("translateMessage: image_url part with missing image_url object → dropped", () => {
  const m = translateMessage({ role: "user", content: [{ type: "image_url" }] });
  expect(m.content).toEqual([]);
});

test("translateMessage: input_audio part keeps data + format", () => {
  const m = translateMessage({
    role: "user",
    content: [{ type: "input_audio", input_audio: { data: "base64...", format: "mp3" } }],
  });
  expect((m.content as unknown[])[0]).toEqual({
    type: "input_audio",
    inputData: { data: "base64...", format: "mp3" },
  });
});

test("translateMessage: file part mapped with internal field names", () => {
  const m = translateMessage({
    role: "user",
    content: [{ type: "file", file: { file_id: "file-1" } }],
  });
  expect((m.content as unknown[])[0]).toEqual({ type: "file", file: { fileId: "file-1" } });
});

test("translateMessage: passes tool_call_id + tool_calls through", () => {
  const m = translateMessage({
    role: "tool",
    content: "result",
    tool_call_id: "t1",
    tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }],
  });
  expect(m.toolCallId).toBe("t1");
  expect(m.toolCalls).toEqual([{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }]);
});

test("translateMessage: refusal + name + audio carried for assistant", () => {
  const m = translateMessage({
    role: "assistant",
    content: null,
    refusal: "cannot help",
    name: "bot",
    audio: { id: "audio_1" },
  });
  expect(m.refusal).toBe("cannot help");
  expect(m.name).toBe("bot");
  expect(m.audio).toEqual({ id: "audio_1" });
});

// ---------------------------------------------------------------------------
// buildOpenAIChatRequest — extras forwarding
// ---------------------------------------------------------------------------

test("buildOpenAIChatRequest: forwards spec params via extra (n, penalties, seed, parallel_tool_calls, metadata, user)", () => {
  const body = parseBody({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    n: 2,
    frequency_penalty: 0.5,
    presence_penalty: 0.3,
    seed: 42,
    parallel_tool_calls: false,
    metadata: { trace: "t1" },
    user: "u-1",
  });
  const req = buildOpenAIChatRequest(body, false);
  expect(req.extra).toMatchObject({
    n: 2,
    frequency_penalty: 0.5,
    presence_penalty: 0.3,
    seed: 42,
    parallel_tool_calls: false,
    metadata: { trace: "t1" },
    user: "u-1",
  });
});

test("buildOpenAIChatRequest: max_completion_tokens preferred fallback for maxTokens", () => {
  const body = parseBody({
    model: "o3",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 900,
  });
  expect(buildOpenAIChatRequest(body, false).maxTokens).toBe(900);
});

// ---------------------------------------------------------------------------
// Upstream wire serialization (adapter) — the historical silent-drop bugs
// ---------------------------------------------------------------------------

test("adapter wire: assistant tool_calls + null content serialized for upstream", () => {
  const body = buildChatBody(
    {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
        },
        { role: "tool", content: "72F", toolCallId: "c1" },
      ],
    },
    false,
  );
  const msgs = body.messages as Record<string, unknown>[];
  expect(msgs[1]!.content).toBeNull();
  expect(msgs[1]!.tool_calls).toEqual([
    { id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } },
  ]);
  expect(msgs[2]!.tool_call_id).toBe("c1");
});

test("adapter wire: image_url + input_audio serialized with spec snake_case fields", () => {
  const body = buildChatBody(
    {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", imageUrl: { url: "https://x/a.png", detail: "high" } },
            { type: "input_audio", inputData: { data: "AAA", format: "wav" } },
          ],
        },
      ],
    },
    false,
  );
  const parts = (body.messages as { content: unknown[] }[])![0]!.content;
  expect(parts[0]).toEqual({ type: "image_url", image_url: { url: "https://x/a.png", detail: "high" } });
  expect(parts[1]).toEqual({ type: "input_audio", input_audio: { data: "AAA", format: "wav" } });
});

test("adapter wire: system role rewritten to developer for upstream", () => {
  const body = buildChatBody(
    {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
    },
    false,
  );
  expect((body.messages as { role: string }[])![0]!.role).toBe("developer");
});

test("adapter wire: assistant refusal serialized as refusal field, not content", () => {
  const body = buildChatBody(
    {
      model: "gpt-4o",
      messages: [{ role: "assistant", content: null, refusal: "no" }],
    },
    false,
  );
  const msg = (body.messages as Record<string, unknown>[])![0]!;
  expect(msg.refusal).toBe("no");
  expect(msg.content).toBeNull();
});

// ---------------------------------------------------------------------------
// Response shape — OpenAI Chat Completions response spec
// ---------------------------------------------------------------------------

test("response: message.content is null (not '') on tool-call turns; refusal present", () => {
  const json = openAICompletionJson(
    genResult({
      content: null,
      toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      finishReason: "tool_calls",
    }),
    "my-gpt",
  );
  const choice = json.choices[0] as { message: Record<string, unknown>; finish_reason: string };
  expect(choice.message.content).toBeNull();
  expect(choice.message.refusal).toBeNull();
  expect(choice.message.tool_calls).toHaveLength(1);
  expect(choice.finish_reason).toBe("tool_calls");
});

test("response: finish_reason normalized to OpenAI enum for Anthropic-backed models", () => {
  expect(
    (openAICompletionJson(genResult({ finishReason: "end_turn" }), "m").choices[0] as { finish_reason: string }).finish_reason,
  ).toBe("stop");
  expect(
    (openAICompletionJson(genResult({ finishReason: "max_tokens" }), "m").choices[0] as { finish_reason: string }).finish_reason,
  ).toBe("length");
  expect(
    (openAICompletionJson(genResult({ finishReason: "tool_use" }), "m").choices[0] as { finish_reason: string }).finish_reason,
  ).toBe("tool_calls");
});

test("response: reasoning tokens under completion_tokens_details (spec location)", () => {
  const json = openAICompletionJson(genResult({ reasoningTokens: 7, cacheReadTokens: 3 }), "m");
  const usage = json.usage as Record<string, unknown>;
  expect(usage.completion_tokens_details).toEqual({ reasoning_tokens: 7 });
  expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 3 });
  expect("reasoning_tokens" in usage).toBe(false);
});

test("assembleChoice: preserves null content + separate refusal field", () => {
  const c = assembleChoice(
    { message: { role: "assistant", content: null, refusal: "blocked", tool_calls: [{ id: "t1" }] }, finish_reason: "stop" },
    0,
  );
  expect(c?.message.content).toBeNull();
  expect(c?.message.refusal).toBe("blocked");
  expect(c?.message.toolCalls).toEqual([{ id: "t1" }]);
});

// ---------------------------------------------------------------------------
// Stream normalization helpers
// ---------------------------------------------------------------------------

test("toOpenAIToolCallDeltas: Anthropic block-start → OpenAI first delta with id+name", () => {
  const out = toOpenAIToolCallDeltas([
    { index: 0, type: "tool_use", id: "toolu_1", name: "get_weather" },
  ]);
  expect(out).toEqual([
    { index: 0, id: "toolu_1", type: "function", function: { name: "get_weather", arguments: "" } },
  ]);
});

test("toOpenAIToolCallDeltas: Anthropic partial_json → arguments fragment", () => {
  const out = toOpenAIToolCallDeltas([{ index: 0, partial_json: '{"city":' }]);
  expect(out).toEqual([{ index: 0, function: { arguments: '{"city":' } }]);
});

test("toOpenAIToolCallDeltas: OpenAI-shaped deltas pass through", () => {
  const out = toOpenAIToolCallDeltas([
    { index: 1, id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
  ]);
  expect(out).toEqual([
    { index: 1, id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
  ]);
});

test("toOpenAIFinishReason: unknown reasons map to stop, never leak foreign values", () => {
  expect(toOpenAIFinishReason("pause_turn")).toBe("stop");
  expect(toOpenAIFinishReason("model_context_window_exceeded")).toBe("length");
  expect(toOpenAIFinishReason("refusal")).toBe("content_filter");
  expect(toOpenAIFinishReason("weird_future_reason")).toBe("stop");
  expect(toOpenAIFinishReason(undefined)).toBe("stop");
});
