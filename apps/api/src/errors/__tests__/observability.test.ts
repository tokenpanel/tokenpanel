/**
 * Observability redaction (task 4.10): secrets never reach structured logs.
 * Pure sync functions — no repos, no DB, no runtime.
 */
import { describe, expect, test } from "bun:test";
import {
  logFieldsForAppError,
  logFieldsForDefect,
  privateDiagnosticOf,
  redactHeaders,
  redactString,
  redactUnknown,
  redactUri,
} from "../observability.ts";
import {
  AuthenticationError,
  PersistenceDataError,
  ProviderRejectedError,
  SystemError,
  ValidationError,
} from "../families.ts";

describe("redactString", () => {
  test("strips bearer tokens, sk- keys, product tokens, and connection strings", () => {
    expect(redactString("Authorization: Bearer abc123.def456-ghi")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(redactString("key=sk-abcdefghij1234")).toBe("key=[REDACTED]");
    expect(redactString("token tp_live_a1b2c3d4 stored")).toBe(
      "token [REDACTED] stored",
    );
    expect(redactString("using tp_mgmt_zz9x8y7w today")).toBe(
      "using [REDACTED] today",
    );
    expect(redactString("dsn mongodb+srv://user:pass@host/db")).toBe(
      "dsn [REDACTED]",
    );
  });

  test("leaves clean text untouched", () => {
    expect(redactString("provider anthropic timed out")).toBe(
      "provider anthropic timed out",
    );
  });

  test("truncates beyond maxLen with an ellipsis marker", () => {
    expect(redactString("a".repeat(600))).toBe(`${"a".repeat(500)}…`);
    expect(redactString("abcdef", 3)).toBe("abc…");
  });
});

describe("redactHeaders", () => {
  test("redacts secret headers regardless of casing", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc123.def456",
        AUTHORIZATION: "Basic dXNlcjpwYXNz",
        "X-Api-Key": "sk-abcdefghij1234",
        Api_Key: "whatever-value",
        Token: "tp_live_a1b2c3d4",
        JWT: "eyJhbGciOi.payload.sig",
        Cookie: "session=abc123",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      AUTHORIZATION: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      Api_Key: "[REDACTED]",
      Token: "[REDACTED]",
      JWT: "[REDACTED]",
      Cookie: "[REDACTED]",
    });
  });

  test("keeps ordinary headers and strips secret-shaped values from them", () => {
    expect(
      redactHeaders({
        "Content-Type": "application/json",
        "X-Request-Id": "req_abc123",
        "X-Upstream-Auth": "Bearer sk-abcdefghij1234",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "X-Request-Id": "req_abc123",
      "X-Upstream-Auth": "[REDACTED]",
    });
  });

  test("drops undefined header values", () => {
    expect(
      redactHeaders({ "X-Present": "yes", "X-Missing": undefined }),
    ).toEqual({ "X-Present": "yes" });
  });
});

describe("redactUri", () => {
  test("masks credentials in the authority while keeping the rest routable", () => {
    expect(redactUri("mongodb://user:pass@host:27017/db?x=1")).toBe(
      "mongodb://[REDACTED]@host:27017/db?x=1",
    );
    expect(redactUri("mongodb+srv://u:p@cluster.example.net/db")).toBe(
      "mongodb+srv://[REDACTED]@cluster.example.net/db",
    );
    expect(redactUri("https://user:secret@api.example.com/v1")).toBe(
      "https://[REDACTED]@api.example.com/v1",
    );
  });

  test("leaves credential-free URIs untouched", () => {
    expect(redactUri("mongodb://host:27017/db")).toBe("mongodb://host:27017/db");
    expect(redactUri("postgres://db.internal/tokenpanel")).toBe(
      "postgres://db.internal/tokenpanel",
    );
  });
});

describe("redactUnknown", () => {
  test("passes primitives and whitelisted fields through untouched", () => {
    expect(redactUnknown(42)).toBe(42);
    expect(redactUnknown(false)).toBe(false);
    expect(redactUnknown(null)).toBe(null);
    expect(
      redactUnknown({
        model: "gpt-4o",
        provider: "anthropic",
        count: 3,
        flag: true,
        nil: null,
      }),
    ).toEqual({
      model: "gpt-4o",
      provider: "anthropic",
      count: 3,
      flag: true,
      nil: null,
    });
  });

  test("redacts secret keys in nested objects regardless of key casing", () => {
    const out = redactUnknown({
      apiKey: "sk-abcdefghij1234",
      token: "tp_live_a1b2c3d4",
      JWT: "eyJhbGciOi.payload.sig",
      nested: {
        Password: "hunter2",
        Authorization: "Bearer abc.def",
        keep: "visible",
      },
    }) as {
      apiKey: unknown;
      token: unknown;
      JWT: unknown;
      nested: {
        Password: unknown;
        Authorization: unknown;
        keep: unknown;
      };
    };
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.JWT).toBe("[REDACTED]");
    expect(out.nested.Password).toBe("[REDACTED]");
    expect(out.nested.Authorization).toBe("[REDACTED]");
    expect(out.nested.keep).toBe("visible");
  });

  test("walks arrays and redacts secret-shaped strings inside them", () => {
    const out = redactUnknown({
      steps: ["plain", "Bearer abc123.def456", { credential: "leak-me", n: 1 }],
    }) as { steps: unknown[] };
    expect(out.steps[0]).toBe("plain");
    expect(out.steps[1]).toBe("[REDACTED]");
    expect(out.steps[2]).toEqual({ credential: "[REDACTED]", n: 1 });
  });

  test("still redacts secret keys deep in nested trees", () => {
    const out = redactUnknown({
      a: { b: { c: { apiKey: "sk-abcdefghij1234" } } },
    }) as Record<string, any>;
    expect(out.a.b.c.apiKey).toBe("[REDACTED]");
  });

  test("marks scalars beyond the depth bound as truncated", () => {
    const out = redactUnknown({
      a: { b: { c: { d: { e: "bottom" } } } },
    }) as Record<string, any>;
    expect(out.a.b.c.d.e).toBe("[truncated]");
  });
});

describe("logFieldsForDefect", () => {
  test("flattens Error causes (message and stack) into safe redacted text", () => {
    const cause = new Error(
      "upstream blew up: Bearer abc123.def456 with sk-abcdefghij1234",
    );
    const fields = logFieldsForDefect(cause, { operation: "ingest" });
    expect(fields.level).toBe("error");
    expect(fields.message).toBe("Unhandled defect");
    expect(fields.defect).toBe(true);
    expect(fields.operation).toBe("ingest");
    expect(fields.privateDiagnostic).toMatch(/^Error: upstream blew up:/);
    // Secrets are stripped from both the message and the embedded stack copy.
    expect(fields.privateDiagnostic).not.toContain("abc123.def456");
    expect(fields.privateDiagnostic).not.toContain("sk-abcdefghij1234");
    expect(fields.privateDiagnostic).toContain("[REDACTED]");
  });

  test("string causes pass through redacted; non-error causes collapse to a marker", () => {
    const fromString = logFieldsForDefect(
      "connection refused for Bearer abc123.def456",
      {},
    );
    expect(fromString.privateDiagnostic).toBe(
      "connection refused for [REDACTED]",
    );
    expect(fromString.defect).toBe(true);

    const fromObject = logFieldsForDefect({ not: "an error" }, {});
    expect(fromObject.privateDiagnostic).toBe("defect");
    expect(fromObject.message).toBe("Unhandled defect");
    expect(fromObject.defect).toBe(true);
  });

  test("attaches correlation, surface, and operation context", () => {
    const fields = logFieldsForDefect(new Error("boom"), {
      correlation: { requestId: "req_abc", traceId: "trace123" },
      surface: "admin",
      operation: "chat",
    });
    expect(fields.requestId).toBe("req_abc");
    expect(fields.traceId).toBe("trace123");
    expect(fields.surface).toBe("admin");
    expect(fields.operation).toBe("chat");
  });
});

describe("logFieldsForAppError", () => {
  test("never carries upstream bodies for provider errors — only bounded metadata", () => {
    const err = new ProviderRejectedError({
      code: "provider_rejected",
      message: "upstream rejected the request",
      category: "auth",
      phase: "parse",
      retryClass: "never",
      fallbackClass: "eligible",
      acceptanceClass: "not_accepted",
      streamCommitClass: "not_committed",
      provider: "anthropic",
      model: "claude-3",
      httpStatus: 401,
      diagnostic: "response body: Bearer abc123.def456 sk-abcdefghij1234",
    });
    const fields = logFieldsForAppError(err, { level: "error", operation: "chat" });
    expect(fields.level).toBe("error");
    expect(fields.errorTag).toBe("ProviderRejectedError");
    expect(fields.errorCode).toBe("provider_rejected");
    expect(fields.retryClass).toBe("never");
    expect(fields.fallbackClass).toBe("eligible");
    expect(fields.provider).toBe("anthropic");
    expect(fields.model).toBe("claude-3");
    expect(fields.httpStatus).toBe(401);
    expect(fields.privateDiagnostic).toMatch(
      /^\[upstream_body_omitted chars=\d+\]$/,
    );
    const dumped = JSON.stringify(fields);
    expect(dumped).not.toContain("abc123.def456");
    expect(dumped).not.toContain("sk-abcdefghij1234");
  });

  test("redacts persistence, auth, and system diagnostics instead of echoing them", () => {
    const persistence = logFieldsForAppError(
      new PersistenceDataError({
        code: "persistence_data",
        message: "document failed validation",
        retryClass: "never",
        diagnostic: "matcher failed on Bearer abc123.def456",
      }),
      { level: "error" },
    );
    expect(persistence.privateDiagnostic).toBe("matcher failed on [REDACTED]");
    expect(persistence.retryClass).toBe("never");

    const auth = logFieldsForAppError(
      new AuthenticationError({
        code: "invalid_credentials",
        message: "invalid credentials",
        privateReason: "jwt signature mismatch for Bearer abc123.def456",
      }),
      { level: "warn" },
    );
    expect(auth.privateDiagnostic).toBe(
      "jwt signature mismatch for [REDACTED]",
    );
    expect(auth.errorTag).toBe("AuthenticationError");

    const system = logFieldsForAppError(
      new SystemError({
        code: "internal_server_error",
        message: "cache write failed",
        diagnostic: "Redis timeout: sk-abcdefghij1234",
      }),
      { level: "error" },
    );
    expect(system.privateDiagnostic).toBe("Redis timeout: [REDACTED]");
    expect(system.defect).toBe(false);
  });

  test("carries correlation, surface, and operation onto app error fields", () => {
    const fields = logFieldsForAppError(
      new ValidationError({
        code: "validation_error",
        message: "bad request",
        mode: "default_400",
      }),
      {
        level: "info",
        correlation: { requestId: "req_xyz", traceId: "trace789" },
        surface: "openai",
        operation: "completions",
      },
    );
    expect(fields.level).toBe("info");
    expect(fields.errorTag).toBe("ValidationError");
    expect(fields.errorCode).toBe("validation_error");
    expect(fields.requestId).toBe("req_xyz");
    expect(fields.traceId).toBe("trace789");
    expect(fields.surface).toBe("openai");
    expect(fields.operation).toBe("completions");
  });
});

describe("privateDiagnosticOf", () => {
  test("extracts redacted diagnostics from app errors", () => {
    expect(
      privateDiagnosticOf(
        new PersistenceDataError({
          code: "persistence_data",
          message: "bad doc",
          retryClass: "transient",
          diagnostic: "E11000 dup for sk-abcdefghij1234",
        }),
      ),
    ).toBe("E11000 dup for [REDACTED]");
    expect(
      privateDiagnosticOf(
        new AuthenticationError({
          code: "unauthorized",
          message: "unauthorized",
          privateReason: "expired jwt issued to Bearer abc123.def456",
        }),
      ),
    ).toBe("expired jwt issued to [REDACTED]");
  });

  test("redacts plain error messages; returns undefined for non-errors and clean app errors", () => {
    expect(
      privateDiagnosticOf(new Error("failed for Bearer abc123.def456")),
    ).toBe("failed for [REDACTED]");
    expect(privateDiagnosticOf("not an error")).toBeUndefined();
    expect(privateDiagnosticOf(undefined)).toBeUndefined();
    expect(privateDiagnosticOf(null)).toBeUndefined();
    expect(
      privateDiagnosticOf(
        new ValidationError({
          code: "validation_error",
          message: "bad",
          mode: "field_422",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("non-serializable input never throws", () => {
  test("circular object structures terminate with the fallback marker", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    let out: unknown;
    expect(() => {
      out = redactUnknown(node);
    }).not.toThrow();
    let cur: unknown = out;
    for (let i = 0; i < 5; i++) {
      expect(cur !== null && typeof cur === "object").toBe(true);
      cur = (cur as Record<string, unknown>).self;
    }
    expect(cur).toBe("[truncated]");
  });

  test("circular array structures terminate with the fallback marker", () => {
    const arr: unknown[] = ["ok"];
    arr.push(arr);
    let out: unknown;
    expect(() => {
      out = redactUnknown(arr);
    }).not.toThrow();
    let cur = out as unknown[];
    for (let i = 0; i < 4; i++) {
      expect(Array.isArray(cur)).toBe(true);
      expect(cur[0]).toBe("ok");
      cur = cur[1] as unknown[];
    }
    expect(cur[0]).toBe("[truncated]");
  });
});
