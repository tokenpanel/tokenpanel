/**
 * Effect Exit → HTTP boundary (task 4.8): per-family status matrix across all
 * four surfaces, body envelopes (code/message/details), defect redaction, and
 * serialization determinism. Pure mapping — no repos, no DB, no runtime.
 */
import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import { renderUnknownThrow, toHttpResponse } from "../boundary.ts";
import {
  AuthenticationError,
  AuthorizationError,
  BudgetExceededError,
  ConflictError,
  ConfigurationError,
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
  type AppError,
} from "../families.ts";
import type { StructuredLogFields } from "../observability.ts";
import { SAFE_MESSAGES } from "../safe-messages.ts";
import type { HttpSurface } from "../variants.ts";

// ---------------------------------------------------------------------------

const SURFACES: readonly HttpSurface[] = [
  "admin",
  "management",
  "openai",
  "anthropic",
];

/** Secret-bearing payload used to prove redaction at the boundary. */
const MONGO_URI_SECRET = "mongodb://root:hunter2@db.internal:27017/admin";

function makeLogger(): {
  readonly fields: StructuredLogFields[];
  readonly log: (fields: StructuredLogFields) => void;
} {
  const fields: StructuredLogFields[] = [];
  return { fields, log: (entry) => fields.push(entry) };
}

/**
 * Run a failing exit through toHttpResponse and require an error outcome,
 * so every envelope test can destructure `response` without union juggling.
 */
async function errorOutcome(err: AppError, surface: HttpSurface) {
  const outcome = toHttpResponse(await Effect.runPromiseExit(Effect.fail(err)), {
    surface,
  });
  if (outcome.kind !== "error") {
    throw new Error(`expected error outcome for ${err._tag}, got ${outcome.kind}`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------

type SurfaceStatus = Readonly<Record<HttpSurface, number>>;
/** Lockstep status across all four surfaces (≈18 matrix rows share this). */
const same = (n: number): SurfaceStatus => ({
  admin: n,
  management: n,
  openai: n,
  anthropic: n,
});

const STATUS_MATRIX: readonly {
  readonly name: string;
  readonly make: () => AppError;
  readonly status: SurfaceStatus;
}[] = [
  {
    name: "ValidationError default_400",
    make: () =>
      new ValidationError({
        code: "validation_error",
        message: SAFE_MESSAGES.validation_error,
        mode: "default_400",
        issues: [{ path: "name", message: "Required" }],
      }),
    status: same(400),
  },
  {
    name: "ValidationError field_422",
    make: () =>
      new ValidationError({
        code: "validation_error",
        message: SAFE_MESSAGES.validation_error,
        mode: "field_422",
        details: { email: ["must be an email"] },
      }),
    status: { admin: 422, management: 422, openai: 400, anthropic: 400 },
  },
  {
    name: "AuthenticationError",
    make: () =>
      new AuthenticationError({ code: "unauthorized", message: "missing bearer token" }),
    status: same(401),
  },
  {
    name: "AuthorizationError",
    make: () =>
      new AuthorizationError({ code: "forbidden", message: "insufficient role" }),
    status: same(403),
  },
  {
    name: "NotFoundError",
    make: () =>
      new NotFoundError({ code: "not_found", message: "customer missing" }),
    status: same(404),
  },
  {
    name: "ConflictError",
    make: () =>
      new ConflictError({
        code: "duplicate_external_id_or_email",
        message: "customer already exists",
      }),
    status: same(409),
  },
  {
    name: "InvalidStateError",
    make: () =>
      new InvalidStateError({ code: "invalid_state", message: "key already active" }),
    status: same(409),
  },
  {
    name: "InsufficientBalanceError",
    make: () =>
      new InsufficientBalanceError({
        code: "insufficient_balance",
        message: "balance too low",
      }),
    status: same(402),
  },
  {
    name: "BudgetExceededError",
    make: () =>
      new BudgetExceededError({
        code: "budget_exceeded",
        message: "monthly cap reached",
      }),
    status: same(429),
  },
  {
    name: "RateLimitExceededError",
    make: () =>
      new RateLimitExceededError({
        code: "rate_limited",
        message: "too many requests",
        retryAfterSeconds: 42,
      }),
    status: same(429),
  },
  {
    name: "ProviderRejectedError http 4xx",
    make: () =>
      new ProviderRejectedError({
        message: "upstream rejected request",
        category: "http_4xx",
        phase: "headers",
        retryClass: "never",
        fallbackClass: "eligible",
        acceptanceClass: "not_accepted",
        streamCommitClass: "not_committed",
        code: "provider_rejected",
        httpStatus: 403,
      }),
    status: { admin: 403, management: 502, openai: 403, anthropic: 403 },
  },
  {
    name: "ProviderRejectedError http 5xx",
    make: () =>
      new ProviderRejectedError({
        message: "upstream exploded",
        category: "http_5xx",
        phase: "body",
        retryClass: "transient",
        fallbackClass: "eligible",
        acceptanceClass: "maybe_accepted",
        streamCommitClass: "committed",
        code: "upstream_error",
        httpStatus: 503,
      }),
    status: { admin: 400, management: 502, openai: 503, anthropic: 503 },
  },
  {
    name: "ProviderRejectedError without httpStatus",
    make: () =>
      new ProviderRejectedError({
        message: "upstream rejected request",
        category: "validation",
        phase: "request",
        retryClass: "never",
        fallbackClass: "ineligible",
        acceptanceClass: "not_accepted",
        streamCommitClass: "not_committed",
        code: "provider_rejected",
      }),
    status: { admin: 400, management: 502, openai: 400, anthropic: 400 },
  },
  {
    name: "ProviderUnavailableError",
    make: () =>
      new ProviderUnavailableError({
        message: "provider capacity exhausted",
        category: "capacity",
        phase: "request",
        retryClass: "transient",
        fallbackClass: "eligible",
        acceptanceClass: "not_accepted",
        streamCommitClass: "not_committed",
        code: "provider_unavailable",
      }),
    status: same(502),
  },
  {
    name: "ProviderUnavailableError no_active_entries",
    make: () =>
      new ProviderUnavailableError({
        message: "model has no active entries",
        category: "unknown",
        phase: "connect",
        retryClass: "never",
        fallbackClass: "ineligible",
        acceptanceClass: "not_accepted",
        streamCommitClass: "not_committed",
        code: "no_active_entries",
      }),
    status: { admin: 502, management: 502, openai: 503, anthropic: 502 },
  },
  {
    name: "ProviderTimeoutError",
    make: () =>
      new ProviderTimeoutError({
        message: "provider timed out",
        category: "timeout_ambiguous",
        phase: "body",
        retryClass: "transient",
        fallbackClass: "eligible",
        acceptanceClass: "maybe_accepted",
        streamCommitClass: "committed",
        code: "provider_timeout",
        timeoutMs: 30000,
      }),
    status: { admin: 504, management: 502, openai: 504, anthropic: 504 },
  },
  {
    name: "ProviderProtocolError",
    make: () =>
      new ProviderProtocolError({
        message: "malformed upstream json",
        category: "malformed_response",
        phase: "parse",
        retryClass: "never",
        fallbackClass: "ineligible",
        acceptanceClass: "maybe_accepted",
        streamCommitClass: "not_committed",
        code: "provider_protocol",
      }),
    status: same(502),
  },
  {
    name: "PersistenceDuplicateKeyError",
    make: () =>
      new PersistenceDuplicateKeyError({
        code: "persistence_duplicate_key",
        message: "duplicate key",
        retryClass: "never",
      }),
    status: same(409),
  },
  {
    name: "PersistenceConflictError",
    make: () =>
      new PersistenceConflictError({
        code: "persistence_conflict",
        message: "write conflict",
        retryClass: "transient",
      }),
    status: same(409),
  },
  {
    name: "PersistenceUnavailableError",
    make: () =>
      new PersistenceUnavailableError({
        code: "persistence_unavailable",
        message: "connection refused",
        retryClass: "transient",
      }),
    status: same(503),
  },
  {
    name: "PersistenceTimeoutError",
    make: () =>
      new PersistenceTimeoutError({
        code: "persistence_timeout",
        message: "operation timed out",
        retryClass: "transient",
      }),
    status: same(503),
  },
  {
    name: "PersistenceDataError",
    make: () =>
      new PersistenceDataError({
        code: "persistence_data",
        message: "corrupt document",
        retryClass: "never",
      }),
    status: same(500),
  },
  {
    name: "ConfigurationError",
    make: () =>
      new ConfigurationError({
        code: "configuration_error",
        message: "missing DATABASE_URL",
      }),
    status: same(500),
  },
  {
    name: "SystemError",
    make: () =>
      new SystemError({ code: "system_error", message: "unexpected failure" }),
    status: same(500),
  },
];

describe("toHttpResponse status matrix", () => {
  for (const row of STATUS_MATRIX) {
    test(`${row.name} maps to the expected status on every surface`, async () => {
      for (const surface of SURFACES) {
        const { response } = await errorOutcome(row.make(), surface);
        expect(response.status).toBe(row.status[surface]);
      }
    });
  }
});

describe("toHttpResponse body envelopes", () => {
  test("field_422 validation exposes the validation code and field details", async () => {
    const { response } = await errorOutcome(
      new ValidationError({
        code: "validation_error",
        message: SAFE_MESSAGES.validation_error,
        mode: "field_422",
        details: { email: ["must be an email"] },
      }),
      "management",
    );
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "validation_error",
      details: { email: ["must be an email"] },
    });
  });

  test("default_400 validation renders the ParseError issues shape", async () => {
    const { response } = await errorOutcome(
      new ValidationError({
        code: "validation_error",
        message: SAFE_MESSAGES.validation_error,
        mode: "default_400",
        issues: [{ path: "customer.name", message: "Required" }],
      }),
      "management",
    );
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: {
        name: "ParseError",
        issues: [{ path: ["customer", "name"], message: "Required" }],
      },
    });
  });

  test("authentication stays 401 unauthorized without echoing private reasons", async () => {
    const { response } = await errorOutcome(
      new AuthenticationError({
        code: "unauthorized",
        message: "jwt expired",
        privateReason: "signature verification failed",
      }),
      "management",
    );
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
    expect(JSON.stringify(response.body)).not.toContain("signature");
  });

  test("missing_scope renders 403 forbidden + reason, never the scope value", async () => {
    const { response } = await errorOutcome(
      new AuthorizationError({
        code: "missing_scope",
        message: "scope checks failed",
        scope: "customers:write",
      }),
      "management",
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden", reason: "missing_scope" });
    expect(JSON.stringify(response.body)).not.toContain("customers:write");
  });

  test("not found / conflict / invalid state keep stable public codes", async () => {
    const nf = await errorOutcome(
      new NotFoundError({ code: "not_found", message: "customer missing", id: "cus_123" }),
      "management",
    );
    expect(nf.response.status).toBe(404);
    expect(nf.response.body).toEqual({ error: "not_found" });
    expect(JSON.stringify(nf.response.body)).not.toContain("cus_123");

    const cf = await errorOutcome(
      new ConflictError({
        code: "duplicate_external_id_or_email",
        message: "customer exists",
        fields: ["external_id"],
      }),
      "management",
    );
    expect(cf.response.status).toBe(409);
    expect(cf.response.body).toEqual({ error: "duplicate_external_id_or_email" });

    const iv = await errorOutcome(
      new InvalidStateError({ code: "invalid_state", message: "key not active", resource: "api_key" }),
      "management",
    );
    expect(iv.response.status).toBe(409);
    expect(iv.response.body).toEqual({ error: "invalid_state" });
  });

  test("rate limit surfaces message, Retry-After header, and structured log fields", async () => {
    const logger = makeLogger();
    const exit = await Effect.runPromiseExit(
      Effect.fail(
        new RateLimitExceededError({
          code: "rate_limited",
          message: "slow down",
          retryAfterSeconds: 42,
          dimension: "requests",
        }),
      ),
    );
    const outcome = toHttpResponse(exit, {
      surface: "management",
      log: logger.log,
      correlation: { requestId: "req_test", traceId: "trace_test" },
      operation: "chat.completions",
    });
    if (outcome.kind !== "error") {
      throw new Error(`expected error outcome, got ${outcome.kind}`);
    }
    expect(outcome.response.status).toBe(429);
    expect(outcome.response.body).toEqual({
      error: "rate_limited",
      message: "slow down",
      retryAfterSeconds: 42,
    });
    expect(outcome.response.headers).toEqual({ "Retry-After": "42" });
    expect(logger.fields).toHaveLength(1);
    expect(logger.fields[0]).toMatchObject({
      errorTag: "RateLimitExceededError",
      errorCode: "rate_limited",
      surface: "management",
      operation: "chat.completions",
      requestId: "req_test",
      traceId: "trace_test",
    });
  });

  test("raw driver text in messages collapses to the safe public message", async () => {
    const { response } = await errorOutcome(
      new RateLimitExceededError({
        code: "rate_limited",
        message: `ECONNREFUSED ${MONGO_URI_SECRET}`,
        retryAfterSeconds: 5,
      }),
      "management",
    );
    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      error: "rate_limited",
      message: SAFE_MESSAGES.rate_limited,
    });
    expect(JSON.stringify(response.body)).not.toContain("hunter2");
  });

  test("insufficient balance keeps 402 with the product message", async () => {
    const { response } = await errorOutcome(
      new InsufficientBalanceError({
        code: "insufficient_balance",
        message: "balance too low",
        balanceMicros: 500,
        requiredMicros: 1000,
      }),
      "management",
    );
    expect(response.status).toBe(402);
    expect(response.body).toEqual({
      error: "insufficient_balance",
      message: "balance too low",
    });
  });

  test("provider failures render upstream codes without leaking diagnostics", async () => {
    const { response } = await errorOutcome(
      new ProviderUnavailableError({
        message: "provider capacity exhausted",
        category: "capacity",
        phase: "request",
        retryClass: "transient",
        fallbackClass: "eligible",
        acceptanceClass: "not_accepted",
        streamCommitClass: "not_committed",
        code: "provider_unavailable",
        diagnostic: MONGO_URI_SECRET,
      }),
      "management",
    );
    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: "provider_unavailable",
      message: "provider capacity exhausted",
    });
    expect(JSON.stringify(response.body)).not.toContain("hunter2");
  });

  test("persistence unavailability renders 503 dependency_unavailable", async () => {
    const { response } = await errorOutcome(
      new PersistenceUnavailableError({
        code: "persistence_unavailable",
        message: "connection refused",
        retryClass: "transient",
        diagnostic: MONGO_URI_SECRET,
      }),
      "management",
    );
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "dependency_unavailable" });
    expect(response.headers).toEqual({});
    expect(JSON.stringify(response.body)).not.toContain("hunter2");
  });

  test("system / configuration / persistence-data render 500 without diagnostics", async () => {
    const sys = await errorOutcome(
      new SystemError({
        code: "system_error",
        message: "unexpected failure",
        diagnostic: MONGO_URI_SECRET,
      }),
      "management",
    );
    expect(sys.response.status).toBe(500);
    expect(sys.response.body).toEqual({ error: "internal_server_error" });

    const cfg = await errorOutcome(
      new ConfigurationError({
        code: "configuration_error",
        message: "missing DATABASE_URL",
        variable: "DATABASE_URL",
      }),
      "management",
    );
    expect(cfg.response.status).toBe(500);
    expect(cfg.response.body).toEqual({ error: "server_misconfigured" });

    const data = await errorOutcome(
      new PersistenceDataError({
        code: "persistence_data",
        message: "corrupt document",
        retryClass: "never",
        diagnostic: MONGO_URI_SECRET,
      }),
      "management",
    );
    expect(data.response.status).toBe(500);
    expect(data.response.body).toEqual({ error: "internal_server_error" });
  });
});

describe("toHttpResponse non-error outcomes", () => {
  test("success passes the value through untouched", async () => {
    const exit = await Effect.runPromiseExit(Effect.succeed({ ok: true }));
    expect(toHttpResponse(exit, { surface: "admin" })).toEqual({
      kind: "success",
      value: { ok: true },
    });
  });

  test("interruption is control flow: no response, one info log", async () => {
    const logger = makeLogger();
    const exit = await Effect.runPromiseExit(Effect.interrupt);
    const outcome = toHttpResponse(exit, { surface: "openai", log: logger.log });
    expect(outcome).toEqual({ kind: "interruption" });
    expect(logger.fields).toEqual([
      { level: "info", message: "Request interrupted", interrupted: true, surface: "openai" },
    ]);
  });
});

describe("toHttpResponse defect boundary", () => {
  test("died effects render a sanitized 500 on every surface; secrets never reach the body", async () => {
    for (const surface of SURFACES) {
      const exit = await Effect.runPromiseExit(
        Effect.die(new Error(`query failed: ${MONGO_URI_SECRET}`)),
      );
      const outcome = toHttpResponse(exit, { surface });
      if (outcome.kind !== "defect") {
        throw new Error(`expected defect outcome, got ${outcome.kind}`);
      }
      expect(outcome.response.status).toBe(500);
      expect(outcome.response.headers).toEqual({});
      const wire = JSON.stringify(outcome.response.body);
      expect(wire).not.toContain("hunter2");
      expect(wire).not.toContain("mongodb://");
      expect(outcome.privateLog).toMatchObject({ defect: true, level: "error", surface });
    }
  });

  test("responsePossible=false still returns the sanitized response and private log", async () => {
    const exit = await Effect.runPromiseExit(Effect.die(new Error("stream died mid-flight")));
    const outcome = toHttpResponse(exit, { surface: "anthropic", responsePossible: false });
    if (outcome.kind !== "defect") {
      throw new Error(`expected defect outcome, got ${outcome.kind}`);
    }
    expect(outcome.response.status).toBe(500);
    expect(outcome.response.body).toEqual({
      type: "error",
      error: { type: "api_error", message: SAFE_MESSAGES.internal_server_error },
    });
    expect(outcome.privateLog).toMatchObject({ defect: true });
  });

  test("each defect object is logged exactly once across repeated boundary hits", async () => {
    const logger = makeLogger();
    const exit = await Effect.runPromiseExit(Effect.die(new Error("one defect")));
    for (let i = 0; i < 2; i++) {
      const outcome = toHttpResponse(exit, { surface: "admin", log: logger.log });
      expect(outcome.kind).toBe("defect");
    }
    expect(logger.fields).toHaveLength(1);
  });

  test("untyped failures fall through to the defect path", async () => {
    const logger = makeLogger();
    const boom = new Error(`sk-liveabcd1234 query failed: ${MONGO_URI_SECRET}`);
    const exit = await Effect.runPromiseExit(Effect.fail(boom));
    const outcome = toHttpResponse(exit, { surface: "management", log: logger.log });
    if (outcome.kind !== "defect") {
      throw new Error(`expected defect outcome, got ${outcome.kind}`);
    }
    expect(outcome.response.status).toBe(500);
    expect(JSON.stringify(outcome.response.body)).not.toContain("hunter2");
    // Cause.squash still extracts the original thrown value from the cause.
    if (exit._tag !== "Failure") throw new Error("expected failure exit");
    expect(Cause.squash(exit.cause)).toBe(boom);
    expect(logger.fields).toHaveLength(1);
    const diagnostic = String(logger.fields[0]?.privateDiagnostic ?? "");
    expect(diagnostic).not.toContain("sk-liveabcd1234");
    expect(diagnostic).not.toContain("hunter2");
  });
});

describe("renderUnknownThrow", () => {
  test("known AppErrors render through the family mapping", () => {
    const res = renderUnknownThrow(
      new NotFoundError({ code: "not_found", message: "customer missing" }),
      "admin",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  test("unknown Errors render the safe defect message; secrets never reach the body", () => {
    const logger = makeLogger();
    const res = renderUnknownThrow(
      new Error(`vault password=${MONGO_URI_SECRET}`),
      "management",
      { log: logger.log, operation: "legacy.handler" },
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_server_error" });
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(MONGO_URI_SECRET);
    expect(wire).not.toContain("hunter2");
    expect(logger.fields).toHaveLength(1);
    expect(logger.fields[0]).toMatchObject({
      defect: true,
      level: "error",
      surface: "management",
      operation: "legacy.handler",
    });
  });

  test("non-Error throwables render the sanitized 500 too", () => {
    const res = renderUnknownThrow(
      `raw upstream body {"api_key":"sk-liveabcd1234"}`,
      "openai",
    );
    expect(res.status).toBe(500);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain("sk-liveabcd1234");
    expect(wire).not.toContain("raw upstream body");
  });
});

describe("serialization determinism", () => {
  test("repeated family renders serialize identically", async () => {
    const make = () =>
      new RateLimitExceededError({
        code: "rate_limited",
        message: "slow down",
        retryAfterSeconds: 42,
        dimension: "requests",
        cap: 100,
        current: 100,
        windowSeconds: 60,
      });
    const first = await errorOutcome(make(), "management");
    const second = await errorOutcome(make(), "management");
    expect(JSON.stringify(first.response)).toBe(JSON.stringify(second.response));
    expect(first.response).toEqual(second.response);
  });

  test("defect responses serialize identically across surfaces and calls", async () => {
    for (const surface of SURFACES) {
      const renderOnce = async () => {
        const exit = await Effect.runPromiseExit(Effect.die(new Error("determinism probe")));
        const outcome = toHttpResponse(exit, { surface });
        if (outcome.kind !== "defect") {
          throw new Error(`expected defect outcome, got ${outcome.kind}`);
        }
        return outcome.response;
      };
      const [a, b] = await Promise.all([renderOnce(), renderOnce()]);
      expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
      expect(a).toEqual(b);
    }
  });

  test("repeated validation renders serialize identically", async () => {
    const make = () =>
      new ValidationError({
        code: "validation_error",
        message: SAFE_MESSAGES.validation_error,
        mode: "field_422",
        details: { email: ["must be an email"], name: ["Required", "too short"] },
      });
    const a = await errorOutcome(make(), "management");
    const b = await errorOutcome(make(), "management");
    expect(JSON.stringify(a.response.body)).toBe(JSON.stringify(b.response.body));
    expect(a.response.body).toEqual(b.response.body);
  });
});
