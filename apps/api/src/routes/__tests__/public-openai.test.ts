import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { toOpenAIModel, translateMessage, formatOpenAIError } from "../public/openai.ts";
import type { ModelDoc } from "@tokenpanel/db";

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
    price: { inputUnitsPerMillion: 300, outputUnitsPerMillion: 600 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

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

test("translateMessage: string content passthrough", () => {
  const m = translateMessage({ role: "user", content: "hello" });
  expect(m.role).toBe("user");
  expect(m.content).toBe("hello");
});

test("translateMessage: text part → text ContentPart", () => {
  const m = translateMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
  expect(Array.isArray(m.content)).toBe(true);
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "hi" });
});

test("translateMessage: image_url part → image_url ContentPart", () => {
  const m = translateMessage({ role: "user", content: [{ type: "image_url", image_url: { url: "https://x.com/a.png" } }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "image_url", imageUrl: { url: "https://x.com/a.png" } });
});

test("translateMessage: image_url with missing image_url → empty url", () => {
  const m = translateMessage({ role: "user", content: [{ type: "image_url" }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "image_url", imageUrl: { url: "" } });
});

test("translateMessage: input_audio part → input_audio ContentPart with data", () => {
  const m = translateMessage({ role: "user", content: [{ type: "input_audio", input_audio: { data: "base64..." } }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "input_audio", inputData: "base64..." });
});

test("translateMessage: input_audio with missing data → empty string", () => {
  const m = translateMessage({ role: "user", content: [{ type: "input_audio" }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "input_audio", inputData: "" });
});

test("translateMessage: passes tool_call_id + tool_calls through", () => {
  const m = translateMessage({ role: "tool", content: "result", tool_call_id: "t1", tool_calls: [{ id: "t1" }] });
  expect(m.toolCallId).toBe("t1");
  expect(m.toolCalls).toEqual([{ id: "t1" }]);
});

test("translateMessage: text part with missing text → empty string", () => {
  const m = translateMessage({ role: "user", content: [{ type: "text" }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "" });
});

test("formatOpenAIError: rate_limited → rate_limit_error type", () => {
  const e = formatOpenAIError("rate_limited", "too many");
  expect(e.error.type).toBe("rate_limit_error");
  expect(e.error.code).toBe("rate_limited");
  expect(e.error.message).toBe("too many");
});

test("formatOpenAIError: insufficient_balance → billing_error type", () => {
  const e = formatOpenAIError("insufficient_balance", "no funds");
  expect(e.error.type).toBe("billing_error");
});

test("formatOpenAIError: other codes → invalid_request_error type", () => {
  const e = formatOpenAIError("model_not_found", "missing");
  expect(e.error.type).toBe("invalid_request_error");
  expect(e.error.code).toBe("model_not_found");
});

test("formatOpenAIError: merges extra fields into error object", () => {
  const e = formatOpenAIError("rate_limited", "too many", { retryAfterSeconds: 60 });
  expect((e.error as Record<string, unknown>).retryAfterSeconds).toBe(60);
});