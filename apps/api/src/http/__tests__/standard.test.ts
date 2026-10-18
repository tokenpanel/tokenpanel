import { describe, expect, test } from "bun:test";
import { publicError } from "../../errors/catalog.ts";
import {
  anthropicStandardType,
  renderPublicError,
  renderStandardValidation,
} from "../renderers/standard.ts";

/**
 * /v1 must satisfy the OpenAI and Anthropic error contracts: SDKs choose the
 * exception class from the status and the retry decision from
 * `x-should-retry` (then 408/409/429/5xx). Verified against openai-python
 * `_client._make_status_error` / `_base_client._should_retry` and
 * platform.claude.com/docs/en/api/errors (2026-10-13).
 */
describe("OpenAI-compatible errors", () => {
  const render = (e: Parameters<typeof renderPublicError>[1]) =>
    renderPublicError("openai", e);

  test("body is { error: { message, type, param, code } }", () => {
    const r = render(publicError("model_not_found", { message: "Model 'x' not found or inactive" }));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: {
        message: "Model 'x' not found or inactive",
        type: "invalid_request_error",
        param: null,
        code: "model_not_found",
      },
    });
    expect(r.headers["x-should-retry"]).toBe("false");
  });

  test("auth failure uses OpenAI's invalid_api_key code", () => {
    const r = render(publicError("unauthorized"));
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({
      error: { type: "invalid_request_error", code: "invalid_api_key" },
    });
  });

  test("no 402: insufficient balance is 429 insufficient_quota and not retried", () => {
    const r = render(publicError("insufficient_balance"));
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({
      error: { type: "insufficient_quota", code: "insufficient_quota" },
    });
    expect(r.headers["x-should-retry"]).toBe("false");
    expect(render(publicError("currency_mismatch")).status).toBe(400);
  });

  test("rate limit: rate_limit_exceeded, Retry-After, retryable", () => {
    const r = render(publicError("rate_limited", { retryAfterSeconds: 12 }));
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
    expect(r.headers["Retry-After"]).toBe("12");
    expect(r.headers["x-should-retry"]).toBe("true");
  });

  test("validation: param is the first failing field", () => {
    const r = renderStandardValidation("openai", [{ path: "messages.0.role", message: "is missing" }]);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: {
        message: "Invalid request: messages.0.role: is missing",
        type: "invalid_request_error",
        param: "messages.0.role",
        code: "validation_error",
        details: { issues: [{ path: "messages.0.role", message: "is missing" }] },
      },
    });
  });

  test("server-side types: 503 service_unavailable_error, other 5xx server_error", () => {
    expect(render(publicError("no_active_providers")).body).toMatchObject({
      error: { type: "service_unavailable_error" },
    });
    const transient = render(publicError("provider_unavailable"));
    expect(transient.body).toMatchObject({ error: { type: "server_error" } });
    expect(transient.headers["x-should-retry"]).toBe("true");
    expect(render(publicError("provider_rejected")).headers["x-should-retry"]).toBe("false");
  });
});

describe("Anthropic-compatible errors", () => {
  test("type follows the documented status table", () => {
    expect(anthropicStandardType(400)).toBe("invalid_request_error");
    expect(anthropicStandardType(401)).toBe("authentication_error");
    expect(anthropicStandardType(402)).toBe("billing_error");
    expect(anthropicStandardType(403)).toBe("permission_error");
    expect(anthropicStandardType(404)).toBe("not_found_error");
    expect(anthropicStandardType(409)).toBe("conflict_error");
    expect(anthropicStandardType(413)).toBe("request_too_large");
    expect(anthropicStandardType(429)).toBe("rate_limit_error");
    expect(anthropicStandardType(500)).toBe("api_error");
    expect(anthropicStandardType(504)).toBe("timeout_error");
    expect(anthropicStandardType(529)).toBe("overloaded_error");
  });

  test("body is { type: 'error', error: { type, code, message } }; 402 kept", () => {
    const r = renderPublicError("anthropic", publicError("insufficient_balance"));
    expect(r.status).toBe(402);
    expect(r.body).toEqual({
      type: "error",
      error: {
        type: "billing_error",
        code: "insufficient_balance",
        message: "Insufficient balance to complete the request.",
      },
    });
    expect(r.headers["x-should-retry"]).toBe("false");
  });
});
