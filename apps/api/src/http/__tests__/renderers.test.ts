/**
 * HTTP protocol renderer tests (admin / management / openai / anthropic).
 * Covers: envelope shapes, status mapping, header propagation
 * (Retry-After, x-request-id / x-trace-id), byte-exact body serialization,
 * and undefined/optional field omission.
 */
import { describe, expect, test } from "bun:test";
import {
  renderAdminDefect,
  renderAdminError,
  renderAdminMessage,
} from "../renderers/admin.ts";
import {
  renderManagementDefect,
  renderManagementError,
} from "../renderers/management.ts";
import {
  formatOpenAIErrorBody,
  openAISseTerminalError,
  openAISseTerminalFromAppError,
  renderOpenAIDefect,
  renderOpenAIError,
} from "../renderers/openai.ts";
import {
  anthropicSseTerminalError,
  anthropicSseTerminalFromAppError,
  anthropicTypeFromBillingCode,
  formatAnthropicErrorBody,
  renderAnthropicDefect,
  renderAnthropicError,
} from "../renderers/anthropic.ts";
import {
  renderValidationError,
  sanitizeFieldErrors,
  statusForValidationMode,
  validationError400,
  validationError422,
} from "../renderers/validation.ts";
import {
  emptyHeaders,
  withRetryAfter,
  type RenderedHttpError,
} from "../renderers/types.ts";
import { jsonSuccess, renderedToResponse } from "../adapters/boundary.ts";
import {
  AuthenticationError,
  AuthorizationError,
  BudgetExceededError,
  ConfigurationError,
  ConflictError,
  InsufficientBalanceError,
  InvalidStateError,
  NotFoundError,
  PersistenceConflictError,
  PersistenceDataError,
  PersistenceDuplicateKeyError,
  PersistenceTimeoutError,
  PersistenceUnavailableError,
  ProviderProtocolError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitExceededError,
  SystemError,
  ValidationError,
} from "../../errors/families.ts";

/** Satisfies the shared ProviderMeta props on provider tagged errors. */
const providerBase = {
  message: "upstream said no",
  category: "http_4xx",
  phase: "body",
  retryClass: "never",
  fallbackClass: "eligible",
  acceptanceClass: "not_accepted",
  streamCommitClass: "not_committed",
} as const;

describe("renderAdminError", () => {
  test("ValidationError default_400 renders ParseError-shaped 400", () => {
    const err = new ValidationError({
      code: "validation_error",
      message: "Validation failed",
      mode: "default_400",
      issues: [{ path: "user.name", message: "expected string" }],
    });
    const r = renderAdminError(err);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      success: false,
      error: {
        name: "ParseError",
        issues: [{ path: ["user", "name"], message: "expected string" }],
      },
    });
  });

  test("AuthenticationError with reason surfaces the reason", () => {
    const r = renderAdminError(
      new AuthenticationError({
        code: "unauthorized",
        message: "no session",
        reason: "no_active_org_membership",
      }),
    );
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      error: "unauthorized",
      reason: "no_active_org_membership",
    });
  });

  test("AuthenticationError invalid_credentials renders its own error string", () => {
    const r = renderAdminError(
      new AuthenticationError({ code: "invalid_credentials", message: "bad" }),
    );
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "invalid_credentials" });
  });

  test("AuthenticationError Retry-After header rides the rendered headers", () => {
    const r = renderAdminError(
      new AuthenticationError({
        code: "unauthorized",
        message: "slow",
        retryAfterSeconds: 3,
      }),
    );
    expect(r.status).toBe(401);
    expect(r.headers).toEqual({ "Retry-After": "3" });
  });

  test("AuthorizationError user_disabled wins over other reasons", () => {
    const r = renderAdminError(
      new AuthorizationError({
        code: "user_disabled",
        message: "disabled",
        reason: "missing_scope",
      }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "forbidden", reason: "user_disabled" });
  });

  test("AuthorizationError missing_scope renders forbidden + reason", () => {
    const r = renderAdminError(
      new AuthorizationError({
        code: "missing_scope",
        message: "needs scope",
        scope: "balances:read",
      }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "forbidden", reason: "missing_scope" });
  });

  test("AuthorizationError privilege_escalation keeps the product message", () => {
    const r = renderAdminError(
      new AuthorizationError({
        code: "forbidden",
        message: "cannot elevate own role",
        reason: "privilege_escalation",
      }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: "forbidden",
      reason: "privilege_escalation",
      message: "cannot elevate own role",
    });
  });

  test("plain AuthorizationError omits optional keys entirely", () => {
    const r = renderAdminError(
      new AuthorizationError({ code: "forbidden", message: "no" }),
    );
    expect(r).toEqual({ status: 403, body: { error: "forbidden" }, headers: {} });
  });

  test("NotFoundError maps not_found code, passes others through", () => {
    expect(
      renderAdminError(new NotFoundError({ code: "not_found", message: "nope" })),
    ).toEqual({ status: 404, body: { error: "not_found" }, headers: {} });
    expect(
      renderAdminError(new NotFoundError({ code: "model_not_found", message: "m" })),
    ).toEqual({ status: 404, body: { error: "model_not_found" }, headers: {} });
  });

  test("ConflictError and InvalidStateError both render 409 with their code", () => {
    expect(
      renderAdminError(
        new ConflictError({ code: "duplicate_external_id_or_email", message: "dup" }),
      ),
    ).toEqual({
      status: 409,
      body: { error: "duplicate_external_id_or_email" },
      headers: {},
    });
    expect(
      renderAdminError(
        new InvalidStateError({ code: "org_already_active", message: "active" }),
      ),
    ).toEqual({ status: 409, body: { error: "org_already_active" }, headers: {} });
  });

  test("billing failures keep safe public messages", () => {
    expect(
      renderAdminError(
        new InsufficientBalanceError({
          code: "insufficient_balance",
          message: "balance too low",
        }),
      ),
    ).toEqual({
      status: 402,
      body: { error: "insufficient_balance", message: "balance too low" },
      headers: {},
    });
    expect(
      renderAdminError(
        new BudgetExceededError({ code: "budget_exceeded", message: "over budget" }),
      ),
    ).toEqual({
      status: 429,
      body: { error: "budget_exceeded", message: "over budget" },
      headers: {},
    });
  });

  test("RateLimitExceededError renders body + Retry-After header", () => {
    const r = renderAdminError(
      new RateLimitExceededError({
        code: "rate_limited",
        message: "slow down",
        retryAfterSeconds: 9,
      }),
    );
    expect(r.status).toBe(429);
    expect(r.body).toEqual({
      error: "rate_limited",
      message: "slow down",
      retryAfterSeconds: 9,
    });
    expect(r.headers).toEqual({ "Retry-After": "9" });
  });

  test("ProviderRejectedError passes 4xx httpStatus through, clamps 5xx to 400", () => {
    expect(
      renderAdminError(
        new ProviderRejectedError({
          ...providerBase,
          code: "provider_rejected",
          httpStatus: 429,
        }),
      ).status,
    ).toBe(429);
    expect(
      renderAdminError(
        new ProviderRejectedError({
          ...providerBase,
          code: "provider_rejected",
          httpStatus: 529,
        }),
      ).status,
    ).toBe(400);
    expect(
      renderAdminError(
        new ProviderRejectedError({ ...providerBase, code: "provider_rejected" }),
      ).status,
    ).toBe(400);
  });

  test("provider availability family maps to 502/504/502", () => {
    expect(
      renderAdminError(
        new ProviderUnavailableError({ ...providerBase, code: "provider_unavailable" }),
      ),
    ).toEqual({
      status: 502,
      body: { error: "provider_unavailable", message: "upstream said no" },
      headers: {},
    });
    expect(
      renderAdminError(
        new ProviderTimeoutError({
          ...providerBase,
          code: "provider_timeout",
          category: "timeout_ambiguous",
        }),
      ).status,
    ).toBe(504);
    expect(
      renderAdminError(
        new ProviderProtocolError({
          ...providerBase,
          code: "provider_protocol",
          category: "malformed_response",
        }),
      ).status,
    ).toBe(502);
  });

  test("persistence failures render generic shapes without field leakage", () => {
    expect(
      renderAdminError(
        new PersistenceDuplicateKeyError({
          code: "persistence_duplicate_key",
          message: "E11000",
          fields: ["email"],
          retryClass: "never",
        }),
      ),
    ).toEqual({ status: 409, body: { error: "conflict" }, headers: {} });
    expect(
      renderAdminError(
        new PersistenceConflictError({
          code: "persistence_conflict",
          message: "write conflict",
          retryClass: "transient",
        }),
      ),
    ).toEqual({ status: 409, body: { error: "conflict" }, headers: {} });
    expect(
      renderAdminError(
        new PersistenceUnavailableError({
          code: "persistence_unavailable",
          message: "down",
          retryClass: "transient",
        }),
      ).body,
    ).toEqual({ error: "dependency_unavailable" });
    expect(
      renderAdminError(
        new PersistenceTimeoutError({
          code: "persistence_timeout",
          message: "slow",
          retryClass: "transient",
        }),
      ).body,
    ).toEqual({ error: "dependency_unavailable" });
    expect(
      renderAdminError(
        new PersistenceDataError({
          code: "persistence_data",
          message: "bad doc",
          retryClass: "never",
        }),
      ).body,
    ).toEqual({ error: "internal_server_error" });
  });

  test("configuration and system failures render sanitized 500s", () => {
    expect(
      renderAdminError(
        new ConfigurationError({
          code: "server_misconfigured",
          message: "missing OPENAI_KEY",
        }),
      ),
    ).toEqual({ status: 500, body: { error: "server_misconfigured" }, headers: {} });
    expect(
      renderAdminError(new SystemError({ code: "system_error", message: "boom" })),
    ).toEqual({ status: 500, body: { error: "internal_server_error" }, headers: {} });
  });

  test("defect renderer is a sanitized 500 with no headers", () => {
    expect(renderAdminDefect()).toEqual({
      status: 500,
      body: { error: "internal_server_error" },
      headers: {},
    });
  });

  test("renderAdminMessage passes status/error/extra through", () => {
    expect(renderAdminMessage(503, "paused", { retryAfter: 30 })).toEqual({
      status: 503,
      body: { error: "paused", retryAfter: 30 },
      headers: {},
    });
    expect(renderAdminMessage(200, "ok")).toEqual({
      status: 200,
      body: { error: "ok" },
      headers: {},
    });
  });
});

describe("renderManagementError", () => {
  test("any AuthenticationError stays enumeration-safe unauthorized", () => {
    for (const err of [
      new AuthenticationError({ code: "invalid_credentials", message: "bad" }),
      new AuthenticationError({
        code: "unauthorized",
        message: "x",
        reason: "no_active_org_membership",
      }),
    ]) {
      const r = renderManagementError(err);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "unauthorized" });
    }
  });

  test("AuthenticationError Retry-After still propagates", () => {
    const r = renderManagementError(
      new AuthenticationError({
        code: "unauthorized",
        message: "x",
        retryAfterSeconds: 7,
      }),
    );
    expect(r.headers).toEqual({ "Retry-After": "7" });
  });

  test("AuthorizationError renders forbidden variants", () => {
    expect(
      renderManagementError(
        new AuthorizationError({ code: "missing_scope", message: "scope" }),
      ),
    ).toEqual({
      status: 403,
      body: { error: "forbidden", reason: "missing_scope" },
      headers: {},
    });
    expect(
      renderManagementError(
        new AuthorizationError({ code: "user_disabled", message: "disabled" }),
      ),
    ).toEqual({
      status: 403,
      body: { error: "forbidden", reason: "user_disabled" },
      headers: {},
    });
    expect(
      renderManagementError(new AuthorizationError({ code: "forbidden", message: "no" })),
    ).toEqual({ status: 403, body: { error: "forbidden" }, headers: {} });
  });

  test("resource failures mirror admin statuses", () => {
    expect(
      renderManagementError(new NotFoundError({ code: "not_found", message: "n" })),
    ).toEqual({ status: 404, body: { error: "not_found" }, headers: {} });
    expect(
      renderManagementError(
        new ConflictError({ code: "duplicate_external_id_or_email", message: "d" }),
      ),
    ).toEqual({
      status: 409,
      body: { error: "duplicate_external_id_or_email" },
      headers: {},
    });
    expect(
      renderManagementError(new InvalidStateError({ code: "org_suspended", message: "s" })),
    ).toEqual({ status: 409, body: { error: "org_suspended" }, headers: {} });
  });

  test("billing failures keep 402/429 with safe messages", () => {
    expect(
      renderManagementError(
        new InsufficientBalanceError({ code: "insufficient_balance", message: "low" }),
      ),
    ).toEqual({
      status: 402,
      body: { error: "insufficient_balance", message: "low" },
      headers: {},
    });
    expect(
      renderManagementError(
        new BudgetExceededError({ code: "budget_exceeded", message: "over" }),
      ),
    ).toEqual({
      status: 429,
      body: { error: "budget_exceeded", message: "over" },
      headers: {},
    });
    const rl = renderManagementError(
      new RateLimitExceededError({
        code: "rate_limited",
        message: "slow",
        retryAfterSeconds: 12,
      }),
    );
    expect(rl.status).toBe(429);
    expect(rl.body).toEqual({
      error: "rate_limited",
      message: "slow",
      retryAfterSeconds: 12,
    });
    expect(rl.headers).toEqual({ "Retry-After": "12" });
  });

  test("every provider failure collapses to 502 (even timeouts)", () => {
    expect(
      renderManagementError(
        new ProviderRejectedError({
          ...providerBase,
          code: "provider_rejected",
          httpStatus: 418,
        }),
      ).status,
    ).toBe(502);
    expect(
      renderManagementError(
        new ProviderUnavailableError({ ...providerBase, code: "provider_unavailable" }),
      ).status,
    ).toBe(502);
    expect(
      renderManagementError(
        new ProviderTimeoutError({
          ...providerBase,
          code: "provider_timeout",
          category: "timeout_pre_send",
        }),
      ).status,
    ).toBe(502);
    expect(
      renderManagementError(
        new ProviderProtocolError({
          ...providerBase,
          code: "provider_protocol",
          category: "malformed_response",
        }),
      ).status,
    ).toBe(502);
  });

  test("persistence + system failures render generic sanitized bodies", () => {
    expect(
      renderManagementError(
        new PersistenceDuplicateKeyError({
          code: "persistence_duplicate_key",
          message: "dup",
          retryClass: "never",
        }),
      ),
    ).toEqual({ status: 409, body: { error: "conflict" }, headers: {} });
    expect(
      renderManagementError(
        new PersistenceConflictError({
          code: "persistence_conflict",
          message: "c",
          retryClass: "transient",
        }),
      ),
    ).toEqual({ status: 409, body: { error: "conflict" }, headers: {} });
    expect(
      renderManagementError(
        new PersistenceUnavailableError({
          code: "persistence_unavailable",
          message: "u",
          retryClass: "transient",
        }),
      ),
    ).toEqual({ status: 503, body: { error: "dependency_unavailable" }, headers: {} });
    expect(
      renderManagementError(
        new PersistenceTimeoutError({
          code: "persistence_timeout",
          message: "t",
          retryClass: "transient",
        }),
      ),
    ).toEqual({ status: 503, body: { error: "dependency_unavailable" }, headers: {} });
    expect(
      renderManagementError(
        new PersistenceDataError({
          code: "persistence_data",
          message: "d",
          retryClass: "never",
        }),
      ),
    ).toEqual({ status: 500, body: { error: "internal_server_error" }, headers: {} });
    expect(
      renderManagementError(new SystemError({ code: "system_error", message: "s" })),
    ).toEqual({ status: 500, body: { error: "internal_server_error" }, headers: {} });
    expect(
      renderManagementError(
        new ConfigurationError({ code: "configuration_error", message: "cfg" }),
      ),
    ).toEqual({ status: 500, body: { error: "server_misconfigured" }, headers: {} });
  });

  test("defect renderer is a sanitized 500", () => {
    expect(renderManagementDefect()).toEqual({
      status: 500,
      body: { error: "internal_server_error" },
      headers: {},
    });
  });
});

describe("renderOpenAIError", () => {
  test("AuthenticationError renders 401 authentication_error", () => {
    const r = renderOpenAIError(
      new AuthenticationError({ code: "unauthorized", message: "no key" }),
    );
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      error: { message: "no key", type: "authentication_error", code: "unauthorized" },
    });
    expect(r.headers).toEqual({});
  });

  test("missing_scope maps to permission_error with its code", () => {
    const r = renderOpenAIError(
      new AuthorizationError({ code: "missing_scope", message: "scope" }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: { message: "scope", type: "permission_error", code: "missing_scope" },
    });
  });

  test("ValidationError renders 400 invalid_request_error", () => {
    const r = renderOpenAIError(
      new ValidationError({
        code: "validation_error",
        message: "Validation failed",
        mode: "default_400",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: {
        message: "Validation failed",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
  });

  test("NotFoundError renders 404 not_found_error", () => {
    const r = renderOpenAIError(new NotFoundError({ code: "not_found", message: "nope" }));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: { message: "nope", type: "not_found_error", code: "not_found" },
    });
  });

  test("RateLimitExceededError adds Retry-After and retry extras", () => {
    const r = renderOpenAIError(
      new RateLimitExceededError({
        code: "rate_limited",
        message: "slow down",
        retryAfterSeconds: 9,
        dimension: "requests",
        cap: 100,
        current: 100,
        windowSeconds: 60,
      }),
    );
    expect(r.status).toBe(429);
    expect(r.body).toEqual({
      error: {
        message: "slow down",
        type: "rate_limit_error",
        code: "rate_limited",
        retryAfterSeconds: 9,
        dimension: "requests",
        cap: 100,
        current: 100,
        windowSeconds: 60,
      },
    });
    expect(r.headers).toEqual({ "Retry-After": "9" });
  });

  test("RateLimitExceededError omits unset optional extras", () => {
    const r = renderOpenAIError(
      new RateLimitExceededError({
        code: "rate_limited",
        message: "slow down",
        retryAfterSeconds: 5,
      }),
    );
    expect(r.body).toEqual({
      error: { message: "slow down", type: "rate_limit_error", code: "rate_limited", retryAfterSeconds: 5 },
    });
  });

  test("InsufficientBalanceError rides invalid_request_error with balance extras", () => {
    const r = renderOpenAIError(
      new InsufficientBalanceError({
        code: "insufficient_balance",
        message: "balance too low",
        balanceMicros: 500,
        requiredMicros: 1000,
        currency: "USD",
      }),
    );
    expect(r.status).toBe(402);
    expect(r.body).toEqual({
      error: {
        message: "balance too low",
        type: "invalid_request_error",
        code: "insufficient_balance",
        balanceMicros: 500,
        requiredMicros: 1000,
        currency: "USD",
      },
    });
  });

  test("InsufficientBalanceError without details has no extra keys", () => {
    const r = renderOpenAIError(
      new InsufficientBalanceError({ code: "insufficient_balance", message: "low" }),
    );
    expect(r.body).toEqual({
      error: { message: "low", type: "invalid_request_error", code: "insufficient_balance" },
    });
  });

  test("no_active_entries special-cases to 503 overloaded_error", () => {
    const r = renderOpenAIError(
      new ProviderUnavailableError({ ...providerBase, code: "no_active_entries" }),
    );
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      error: {
        message: "upstream said no",
        type: "overloaded_error",
        code: "no_active_entries",
      },
    });
  });

  test("provider failures map to api_error with upstream codes", () => {
    const timeout = renderOpenAIError(
      new ProviderTimeoutError({
        ...providerBase,
        code: "provider_timeout",
        category: "timeout_ambiguous",
      }),
    );
    expect(timeout.status).toBe(504);
    expect(timeout.body).toEqual({
      error: {
        message: "upstream said no",
        type: "api_error",
        code: "upstream_error",
      },
    });
    const rejected = renderOpenAIError(
      new ProviderRejectedError({
        ...providerBase,
        code: "provider_rejected",
        httpStatus: 529,
      }),
    );
    expect(rejected.status).toBe(529);
    const protocol = renderOpenAIError(
      new ProviderProtocolError({
        ...providerBase,
        code: "provider_protocol",
        category: "malformed_response",
      }),
    );
    expect(protocol.status).toBe(502);
    expect(protocol.body).toEqual({
      error: { message: "upstream said no", type: "api_error", code: "upstream_error" },
    });
  });

  test("server-side failures render 500 internal_error with kept candidates", () => {
    const cases: readonly [SystemError | ConfigurationError | PersistenceDataError, string][] = [
      [new SystemError({ code: "system_error", message: "internal failure" }), "internal failure"],
      [new ConfigurationError({ code: "configuration_error", message: "cfg" }), "cfg"],
      [
        new PersistenceDataError({ code: "persistence_data", message: "d", retryClass: "never" }),
        "d",
      ],
    ];
    for (const [err, message] of cases) {
      const r = renderOpenAIError(err);
      expect(r.status).toBe(500);
      expect(r.body).toEqual({
        error: { message, type: "api_error", code: "internal_error" },
      });
    }
  });

  test("conflict + persistence failures map statuses without extra type cases", () => {
    expect(
      renderOpenAIError(
        new ConflictError({ code: "duplicate_external_id_or_email", message: "dup" }),
      ),
    ).toEqual({
      status: 409,
      body: {
        error: {
          message: "dup",
          type: "api_error",
          code: "duplicate_external_id_or_email",
        },
      },
      headers: {},
    });
    expect(
      renderOpenAIError(
        new PersistenceDuplicateKeyError({
          code: "persistence_duplicate_key",
          message: "dup",
          retryClass: "never",
        }),
      ).status,
    ).toBe(409);
    expect(
      renderOpenAIError(
        new PersistenceUnavailableError({
          code: "persistence_unavailable",
          message: "u",
          retryClass: "transient",
        }),
      ).status,
    ).toBe(503);
  });

  test("defect renderer is a sanitized OpenAI 500", () => {
    expect(renderOpenAIDefect()).toEqual({
      status: 500,
      body: {
        error: {
          message: "Internal server error",
          type: "api_error",
          code: "internal_error",
        },
      },
      headers: {},
    });
  });
});

describe("formatOpenAIErrorBody", () => {
  test("status drives the error type", () => {
    expect(formatOpenAIErrorBody("x", "m", undefined, 401).error.type).toBe(
      "authentication_error",
    );
    expect(formatOpenAIErrorBody("x", "m", undefined, 403).error.type).toBe(
      "permission_error",
    );
    expect(formatOpenAIErrorBody("x", "m", undefined, 404).error.type).toBe(
      "not_found_error",
    );
    expect(formatOpenAIErrorBody("x", "m", undefined, 429).error.type).toBe(
      "rate_limit_error",
    );
    expect(formatOpenAIErrorBody("x", "m", undefined, 503).error.type).toBe("api_error");
    expect(formatOpenAIErrorBody("x", "m").error.type).toBe("invalid_request_error");
    expect(formatOpenAIErrorBody("rate_limited", "m").error.type).toBe("rate_limit_error");
  });

  test("extra fields are merged into the error object", () => {
    expect(formatOpenAIErrorBody("x", "m", { seg: "chat" })).toEqual({
      error: { message: "m", type: "invalid_request_error", code: "x", seg: "chat" },
    });
  });
});

describe("openai SSE terminal errors", () => {
  test("openAISseTerminalError serializes byte-exact data frames", () => {
    expect(openAISseTerminalError("rate_limited", "slow down")).toBe(
      `data: ${JSON.stringify({
        error: { message: "slow down", type: "rate_limit_error", code: "rate_limited" },
      })}\n\n`,
    );
  });

  test("openAISseTerminalFromAppError matches the rendered body", () => {
    const err = new NotFoundError({ code: "not_found", message: "nope" });
    expect(openAISseTerminalFromAppError(err)).toBe(
      'data: {"error":{"message":"nope","type":"not_found_error","code":"not_found"}}\n\n',
    );
  });
});

describe("renderAnthropicError", () => {
  test("auth + permission + not_found type mapping", () => {
    expect(
      renderAnthropicError(
        new AuthenticationError({ code: "unauthorized", message: "no key" }),
      ),
    ).toEqual({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "no key" } },
      headers: {},
    });
    expect(
      renderAnthropicError(
        new AuthorizationError({ code: "missing_scope", message: "scope" }),
      ),
    ).toEqual({
      status: 403,
      body: { type: "error", error: { type: "permission_error", message: "scope" } },
      headers: {},
    });
    expect(
      renderAnthropicError(new NotFoundError({ code: "not_found", message: "nope" })),
    ).toEqual({
      status: 404,
      body: { type: "error", error: { type: "not_found_error", message: "nope" } },
      headers: {},
    });
  });

  test("ValidationError renders invalid_request_error 400", () => {
    const r = renderAnthropicError(
      new ValidationError({
        code: "validation_error",
        message: "Validation failed",
        mode: "default_400",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Validation failed" },
    });
  });

  test("rate limit + budget map to rate_limit_error with Retry-After", () => {
    const rl = renderAnthropicError(
      new RateLimitExceededError({
        code: "rate_limited",
        message: "slow down",
        retryAfterSeconds: 9,
      }),
    );
    expect(rl.status).toBe(429);
    expect(rl.body).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "slow down", retryAfterSeconds: 9 },
    });
    expect(rl.headers).toEqual({ "Retry-After": "9" });
    const budget = renderAnthropicError(
      new BudgetExceededError({ code: "budget_exceeded", message: "over" }),
    );
    expect(budget.status).toBe(429);
    expect(budget.body).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "over" },
    });
    expect(budget.headers).toEqual({});
  });

  test("InsufficientBalanceError maps to billing_error 402", () => {
    const r = renderAnthropicError(
      new InsufficientBalanceError({ code: "insufficient_balance", message: "low" }),
    );
    expect(r.status).toBe(402);
    expect(r.body).toEqual({
      type: "error",
      error: { type: "billing_error", message: "low" },
    });
  });

  test("provider family maps to api_error with 502/504 statuses", () => {
    expect(
      renderAnthropicError(
        new ProviderUnavailableError({ ...providerBase, code: "provider_unavailable" }),
      ).status,
    ).toBe(502);
    expect(
      renderAnthropicError(
        new ProviderTimeoutError({
          ...providerBase,
          code: "provider_timeout",
          category: "timeout_ambiguous",
        }),
      ),
    ).toEqual({
      status: 504,
      body: { type: "error", error: { type: "api_error", message: "upstream said no" } },
      headers: {},
    });
  });

  test("persistence timeouts render api_error 503", () => {
    const r = renderAnthropicError(
      new PersistenceTimeoutError({
        code: "persistence_timeout",
        message: "t",
        retryClass: "transient",
      }),
    );
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      type: "error",
      error: { type: "api_error", message: "t" },
    });
  });

  test("server-side failures default to api_error 500 with kept candidates", () => {
    const cases: readonly [SystemError | ConfigurationError | PersistenceDataError, string][] = [
      [new SystemError({ code: "system_error", message: "internal failure" }), "internal failure"],
      [new ConfigurationError({ code: "configuration_error", message: "cfg" }), "cfg"],
      [
        new PersistenceDataError({ code: "persistence_data", message: "d", retryClass: "never" }),
        "d",
      ],
    ];
    for (const [err, message] of cases) {
      const r = renderAnthropicError(err);
      expect(r.status).toBe(500);
      expect(r.body).toEqual({
        type: "error",
        error: { type: "api_error", message },
      });
    }
  });

  test("conflict + persistence statuses mirror admin", () => {
    expect(
      renderAnthropicError(
        new ConflictError({ code: "duplicate_external_id_or_email", message: "dup" }),
      ).status,
    ).toBe(409);
    expect(
      renderAnthropicError(
        new PersistenceDuplicateKeyError({
          code: "persistence_duplicate_key",
          message: "dup",
          retryClass: "never",
        }),
      ).status,
    ).toBe(409);
    expect(
      renderAnthropicError(
        new PersistenceUnavailableError({
          code: "persistence_unavailable",
          message: "u",
          retryClass: "transient",
        }),
      ).status,
    ).toBe(503);
  });

  test("AuthenticationError Retry-After propagates when present", () => {
    const r = renderAnthropicError(
      new AuthenticationError({
        code: "unauthorized",
        message: "x",
        retryAfterSeconds: 4,
      }),
    );
    expect(r.headers).toEqual({ "Retry-After": "4" });
  });

  test("defect renderer is a sanitized Anthropic 500", () => {
    expect(renderAnthropicDefect()).toEqual({
      status: 500,
      body: {
        type: "error",
        error: { type: "api_error", message: "Internal server error" },
      },
      headers: {},
    });
  });
});

describe("formatAnthropicErrorBody + billing-code mapping", () => {
  test("envelope wraps type/message/extra under type:error", () => {
    expect(formatAnthropicErrorBody("api_error", "m", { seg: "x" })).toEqual({
      type: "error",
      error: { type: "api_error", message: "m", seg: "x" },
    });
  });

  test("anthropicTypeFromBillingCode maps rate/balance codes", () => {
    expect(anthropicTypeFromBillingCode("rate_limited")).toBe("rate_limit_error");
    expect(anthropicTypeFromBillingCode("insufficient_balance")).toBe("billing_error");
    expect(anthropicTypeFromBillingCode("anything_else")).toBe("invalid_request_error");
  });
});

describe("anthropic SSE terminal errors", () => {
  test("anthropicSseTerminalError serializes event+data frames", () => {
    expect(anthropicSseTerminalError("rate_limit_error", "slow down")).toBe(
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
      })}\n\n`,
    );
  });

  test("anthropicSseTerminalFromAppError matches the rendered body", () => {
    const err = new RateLimitExceededError({
      code: "rate_limited",
      message: "slow down",
      retryAfterSeconds: 9,
    });
    expect(anthropicSseTerminalFromAppError(err)).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down","retryAfterSeconds":9}}\n\n',
    );
  });
});

describe("validation renderers", () => {
  test("field_422 renders details envelope", () => {
    const err = new ValidationError({
      code: "validation_error",
      message: "Validation failed",
      mode: "field_422",
      details: { email: ["is required"], name: undefined },
    });
    expect(renderValidationError(err)).toEqual({
      status: 422,
      body: { error: "validation_error", details: { email: ["is required"] } },
      headers: {},
    });
  });

  test("default_400 renders ParseError-shaped body with split paths", () => {
    const err = new ValidationError({
      code: "validation_error",
      message: "Validation failed",
      mode: "default_400",
      issues: [
        { path: "user.name", message: "expected string" },
        { path: "", message: "root level failure" },
      ],
    });
    expect(renderValidationError(err)).toEqual({
      status: 400,
      body: {
        success: false,
        error: {
          name: "ParseError",
          issues: [
            { path: ["user", "name"], message: "expected string" },
            { path: [], message: "root level failure" },
          ],
        },
      },
      headers: {},
    });
  });

  test("sanitizeFieldErrors redacts secrets, drops empty fields", () => {
    const out = sanitizeFieldErrors({
      password: ["expected 'hunter2'"],
      apiKeyPath: ["long message"],
      note: ["token bearer sk-abcdef12345678 leaked"],
      empty: [],
      skipped: undefined,
      keep: ["plain failure"],
    });
    expect(out).toEqual({
      password: ["Invalid value"],
      apiKeyPath: ["Invalid value"],
      note: ["token [REDACTED] leaked"],
      keep: ["plain failure"],
    });
  });

  test("over-length messages are capped at 200 chars with ellipsis", () => {
    const out = sanitizeFieldErrors({ note: ["a".repeat(250)] });
    const capped = out["note"]?.[0] ?? "";
    expect(capped.length).toBe(201);
    expect(capped.endsWith("…")).toBe(true);
  });

  test("builders sanitize issues and lock the mode", () => {
    const e422 = validationError422({ password: ["expected 'x'"] });
    expect(e422.mode).toBe("field_422");
    expect(e422.details).toEqual({ password: ["Invalid value"] });

    const e400 = validationError400([{ path: "user.age", message: "expected number" }]);
    expect(e400.mode).toBe("default_400");
    expect(e400.issues).toEqual([{ path: "user.age", message: "expected number" }]);
  });

  test("statusForValidationMode maps modes to 400/422", () => {
    expect(statusForValidationMode("field_422")).toBe(422);
    expect(statusForValidationMode("default_400")).toBe(400);
  });
});

describe("Response construction", () => {
  const correlation = { requestId: "req_fixed123", traceId: "trace_fixed123" };

  test("renderedToResponse passes status through verbatim", async () => {
    for (const status of [400, 402, 429, 503, 529]) {
      const rendered: RenderedHttpError = {
        status,
        body: { error: "x" },
        headers: {},
      };
      const res = renderedToResponse(rendered);
      expect(res.status).toBe(status);
    }
  });

  test("renderedToResponse sets Content-Type application/json", () => {
    const res = renderedToResponse({
      status: 404,
      body: { error: "not_found" },
      headers: {},
    });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  test("renderedToResponse serializes the body byte-exact", async () => {
    const body = {
      ok: false,
      error: { code: "rate_limited", message: "slöwer ☕", details: ["a", "b"] },
    };
    const res = renderedToResponse({ status: 429, body, headers: {} });
    expect(await res.text()).toBe(JSON.stringify(body));
  });

  test("renderedToResponse merges rendered headers (Retry-After)", async () => {
    const res = renderedToResponse({
      status: 429,
      body: { error: "rate_limited" },
      headers: withRetryAfter(emptyHeaders(), 9),
    });
    expect(res.headers.get("Retry-After")).toBe("9");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe('{"error":"rate_limited"}');
  });

  test("renderedToResponse propagates x-request-id / x-trace-id only when correlated", () => {
    const rendered: RenderedHttpError = {
      status: 403,
      body: { error: "forbidden" },
      headers: {},
    };
    const correlated = renderedToResponse(rendered, correlation);
    expect(correlated.headers.get("X-Request-Id")).toBe("req_fixed123");
    expect(correlated.headers.get("X-Trace-Id")).toBe("trace_fixed123");

    const bare = renderedToResponse(rendered);
    expect(bare.headers.get("X-Request-Id")).toBeNull();
    expect(bare.headers.get("X-Trace-Id")).toBeNull();
  });

  test("jsonSuccess defaults to 200 and serializes byte-exact", async () => {
    const res = jsonSuccess({ ok: true, items: [1, 2, 3] });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe('{"ok":true,"items":[1,2,3]}');
    expect(res.headers.get("X-Request-Id")).toBeNull();
  });

  test("jsonSuccess honors explicit status and correlation headers", async () => {
    const res = jsonSuccess({ created: true }, 201, correlation);
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Request-Id")).toBe("req_fixed123");
    expect(res.headers.get("X-Trace-Id")).toBe("trace_fixed123");
    expect(await res.text()).toBe('{"created":true}');
  });

  test("error responses travel rendered headers + correlation together", async () => {
    const rendered = renderAdminError(
      new RateLimitExceededError({
        code: "rate_limited",
        message: "slow down",
        retryAfterSeconds: 9,
      }),
    );
    const res = renderedToResponse(rendered, correlation);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
    expect(res.headers.get("X-Request-Id")).toBe("req_fixed123");
    expect(await res.text()).toBe(
      JSON.stringify({ error: "rate_limited", message: "slow down", retryAfterSeconds: 9 }),
    );
  });
});

describe("withRetryAfter", () => {
  test("omits the header for undefined and non-positive values", () => {
    expect(withRetryAfter(emptyHeaders(), undefined)).toEqual({});
    expect(withRetryAfter(emptyHeaders(), 0)).toEqual({});
    expect(withRetryAfter(emptyHeaders(), -3)).toEqual({});
  });

  test("stringifies positive seconds", () => {
    expect(withRetryAfter(emptyHeaders(), 120)).toEqual({ "Retry-After": "120" });
  });
});
