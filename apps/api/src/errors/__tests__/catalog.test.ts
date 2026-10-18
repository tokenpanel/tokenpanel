import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DOMAIN_CODE_ALIASES,
  ERROR_CATALOG,
  isPublicErrorCode,
  toPublicError,
} from "../catalog.ts";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  InsufficientBalanceError,
  InvalidStateError,
  NotFoundError,
  PersistenceUnavailableError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitExceededError,
  SystemError,
  ValidationError,
} from "../families.ts";

const providerBase = {
  message: "openai streamChat failed (HTTP 400)",
  category: "http_4xx" as const,
  phase: "headers" as const,
  retryClass: "never" as const,
  fallbackClass: "ineligible" as const,
  acceptanceClass: "not_accepted" as const,
  streamCommitClass: "not_committed" as const,
};

describe("ERROR_CATALOG", () => {
  test("every entry has a client-facing status and a sentence message", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(entry.status >= 400 && entry.status < 600).toBe(true);
      expect(entry.message).toMatch(/^[A-Z].*\.$/);
    }
  });

  test("aliases point at catalogue codes", () => {
    for (const target of Object.values(DOMAIN_CODE_ALIASES)) {
      expect(isPublicErrorCode(target)).toBe(true);
    }
  });
});

describe("toPublicError", () => {
  test("provider failures use catalogue text and status, never upstream detail", () => {
    const err = new ProviderRejectedError({
      ...providerBase,
      code: "provider_rejected",
      httpStatus: 401,
      diagnostic: '{"error":{"message":"Incorrect API key sk-abcdefghijklmnop"}}',
    });
    expect(toPublicError(err)).toEqual({
      code: "provider_rejected",
      status: 502,
      message: "The model provider rejected the request.",
    });
  });

  test("debug (admin) adds the classified message and redacted upstream detail", () => {
    const err = new ProviderRejectedError({
      ...providerBase,
      message: "openai streamChat failed (HTTP 401)",
      code: "provider_rejected",
      httpStatus: 401,
      diagnostic: '{"error":{"message":"Incorrect API key sk-abcdefghijklmnop"}}',
    });
    expect(toPublicError(err, { debug: true })).toEqual({
      code: "provider_rejected",
      status: 502,
      message: "openai streamChat failed (HTTP 401)",
      upstream: {
        status: 401,
        detail: '{"error":{"message":"Incorrect API key [REDACTED]"}}',
      },
    });
  });

  test("provider code aliases: no_active_entries, adapter_missing, upstream_error", () => {
    const unavailable = (code: "no_active_entries" | "adapter_missing") =>
      toPublicError(new ProviderUnavailableError({ ...providerBase, code })).code;
    expect(unavailable("no_active_entries")).toBe("no_active_providers");
    expect(unavailable("adapter_missing")).toBe("provider_not_supported");
    expect(
      toPublicError(
        new ProviderTimeoutError({
          ...providerBase,
          category: "timeout_ambiguous",
          code: "provider_timeout",
        }),
      ),
    ).toMatchObject({ code: "provider_timeout", status: 504 });
  });

  test("curated domain messages pass; unsafe ones fall back to the catalogue", () => {
    expect(
      toPublicError(new NotFoundError({ code: "not_found", message: "Plan not found" })),
    ).toEqual({ code: "not_found", status: 404, message: "Plan not found" });
    expect(
      toPublicError(
        new NotFoundError({ code: "not_found", message: "MongoServerError: at x (y:1:1)" }),
      ).message,
    ).toBe(ERROR_CATALOG.not_found.message);
  });

  test("codes without domainMessage always use catalogue text", () => {
    expect(
      toPublicError(
        new ConflictError({ code: "slug_taken", message: "slug taken (raw)" }),
      ),
    ).toEqual({ code: "slug_taken", status: 409, message: ERROR_CATALOG.slug_taken.message });
  });

  test("authorization reasons: catalogued reasons become the code, others stay in details", () => {
    expect(
      toPublicError(
        new AuthorizationError({ code: "forbidden", message: "x", reason: "customer_inactive" }),
      ),
    ).toMatchObject({ code: "customer_inactive", status: 403 });
    expect(
      toPublicError(
        new AuthorizationError({
          code: "forbidden",
          message: "Only the owner can delete this organization",
          reason: "not_owner",
        }),
      ),
    ).toEqual({
      code: "forbidden",
      status: 403,
      message: "Only the owner can delete this organization",
      details: { reason: "not_owner" },
    });
    expect(
      toPublicError(
        new AuthorizationError({
          code: "missing_scope",
          message: "Missing required scope",
          scope: "balances:write",
        }),
      ),
    ).toMatchObject({ code: "missing_scope", details: { scope: "balances:write" } });
  });

  test("invite aliases keep their distinct statuses (404 vs 410)", () => {
    expect(
      toPublicError(new NotFoundError({ code: "invalid_or_expired", message: "x" })),
    ).toMatchObject({ code: "invite_not_found", status: 404 });
    expect(
      toPublicError(new InvalidStateError({ code: "expired", message: "x" })),
    ).toMatchObject({ code: "invite_expired", status: 410 });
  });

  test("validation issues and rate-limit/balance details", () => {
    expect(
      toPublicError(
        new ValidationError({
          code: "validation_error",
          message: "Provider not found",
          mode: "default_400",
          issues: [{ path: "entries.providerId", message: "Provider not found" }],
        }),
      ),
    ).toEqual({
      code: "validation_error",
      status: 400,
      message: "Provider not found",
      details: { issues: [{ path: "entries.providerId", message: "Provider not found" }] },
    });
    expect(
      toPublicError(
        new RateLimitExceededError({
          code: "rate_limited",
          message: "Rate limit exceeded",
          retryAfterSeconds: 30,
          dimension: "tokens",
          cap: 1000,
        }),
      ),
    ).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 30,
      details: { retryAfterSeconds: 30, dimension: "tokens", cap: 1000 },
    });
    expect(
      toPublicError(
        new InsufficientBalanceError({
          code: "insufficient_balance",
          message: "low",
          balanceMicros: 5,
          requiredMicros: 10,
          currency: "USD",
        }),
      ),
    ).toMatchObject({
      code: "insufficient_balance",
      status: 402,
      details: { balanceMicros: 5, requiredMicros: 10, currency: "USD" },
    });
  });

  test("infrastructure failures never expose their message", () => {
    expect(
      toPublicError(
        new SystemError({ code: "system_error", message: "boom at db (x:1:1)", diagnostic: "d" }),
      ),
    ).toEqual({ code: "internal_error", status: 500, message: ERROR_CATALOG.internal_error.message });
    expect(
      toPublicError(
        new PersistenceUnavailableError({
          code: "persistence_unavailable",
          message: "Mongo down",
          retryClass: "transient",
        }),
      ),
    ).toMatchObject({ code: "service_unavailable", status: 503 });
    expect(
      toPublicError(new AuthenticationError({ code: "unauthorized", message: "jwt expired" })),
    ).toEqual({ code: "unauthorized", status: 401, message: ERROR_CATALOG.unauthorized.message });
  });
});

/**
 * Guard: every specific code thrown for an open-coded family must be in the
 * catalogue (or aliased), otherwise clients silently get a generic code.
 */
describe("catalogue covers domain codes", () => {
  const srcRoot = join(import.meta.dir, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "__tests__" || name === "test-support") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) files.push(p);
    }
  };
  walk(srcRoot);

  test("NotFound/Conflict/InvalidState/Authorization codes are catalogued", () => {
    const ctor =
      /new (NotFoundError|ConflictError|InvalidStateError|AuthorizationError)\(\{\s*code:\s*"([a-z_]+)"/g;
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(ctor)) {
        const code = m[2]!;
        if (!isPublicErrorCode(code) && DOMAIN_CODE_ALIASES[code] === undefined) {
          missing.push(`${m[1]}:${code} (${file.slice(srcRoot.length + 1)})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
