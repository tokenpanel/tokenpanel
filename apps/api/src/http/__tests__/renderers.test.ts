/**
 * Legacy native renderer tests (admin / management version 1). The standard
 * and OpenAI/Anthropic-compatible renderers are covered by standard.test.ts.
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
