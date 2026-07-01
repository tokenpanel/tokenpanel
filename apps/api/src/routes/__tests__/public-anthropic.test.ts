import { test, expect } from "bun:test";
import { translateAnthropicMessage, anthropicError } from "../public/anthropic.ts";

test("translateAnthropicMessage: string content passthrough", () => {
  const m = translateAnthropicMessage({ role: "user", content: "hello" });
  expect(m.role).toBe("user");
  expect(m.content).toBe("hello");
});

test("translateAnthropicMessage: text block → text ContentPart", () => {
  const m = translateAnthropicMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
  expect(Array.isArray(m.content)).toBe(true);
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "hi" });
});

test("translateAnthropicMessage: text block with missing text → empty string", () => {
  const m = translateAnthropicMessage({ role: "user", content: [{ type: "text" }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "" });
});

test("translateAnthropicMessage: image block with source → image_url data URI", () => {
  const m = translateAnthropicMessage({
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
  });
  expect((m.content as unknown[])[0]).toEqual({
    type: "image_url",
    imageUrl: { url: "data:image/png;base64,abc" },
  });
});

test("translateAnthropicMessage: image block without source → empty text fallback", () => {
  const m = translateAnthropicMessage({ role: "user", content: [{ type: "image" }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "" });
});

test("translateAnthropicMessage: tool_use/tool_result blocks → empty text fallback", () => {
  const m = translateAnthropicMessage({ role: "user", content: [{ type: "tool_use", id: "t1", name: "fn", input: {} }] });
  expect((m.content as unknown[])[0]).toEqual({ type: "text", text: "" });
});

test("anthropicError: wraps type+message+extra in {type:'error', error:{}}", () => {
  const e = anthropicError("invalid_request_error", "bad input");
  expect(e).toEqual({ type: "error", error: { type: "invalid_request_error", message: "bad input" } });
});

test("anthropicError: merges extra fields into error object", () => {
  const e = anthropicError("rate_limit_error", "too many", { retryAfterSeconds: 60 });
  expect((e.error as Record<string, unknown>).retryAfterSeconds).toBe(60);
});