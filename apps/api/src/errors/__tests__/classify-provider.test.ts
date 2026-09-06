import { expect, test } from "bun:test";
import {
  classifyProviderError,
  isFallbackAllowedForError,
  providerErrorFromCategory,
} from "../classify-provider.ts";
import { isProviderAppError, type ProviderAppError } from "../families.ts";
import { SAFE_MESSAGES } from "../safe-messages.ts";
import { PROVIDER_CATEGORIES } from "../variants.ts";
import {
  isFallbackAllowed,
  makeProviderError,
  publicProviderErrorMessage,
  type ProviderErrorCategory,
  type ProviderErrorPhase,
} from "../../providers/provider-errors.ts";

type ProviderAppTag = "ProviderTimeoutError" | "ProviderUnavailableError" | "ProviderRejectedError" | "ProviderProtocolError";

/**
 * Per-category contract: which tagged family the category must produce, and
 * the legacy ProviderError fixture flags used to drive classifyProviderError.
 */
type CategoryFixture = {
  tag: ProviderAppTag;
  code: ProviderAppError["code"];
  message: string;
  phase: ProviderErrorPhase;
  retryable: boolean;
  fallbackEligible: boolean;
  maybeAcceptedUpstream: boolean;
  httpStatus?: number;
  /** Expected isFallbackAllowedForError(classified, false). */
  fallbackAllowedPreCommit: boolean;
};

const FIXTURES: Record<ProviderErrorCategory, CategoryFixture> = {
  connection: {
    tag: "ProviderUnavailableError",
    code: "provider_unavailable",
    message: "connection reset before response headers",
    phase: "connect",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: false,
    fallbackAllowedPreCommit: true,
  },
  timeout_pre_send: {
    tag: "ProviderTimeoutError",
    code: "provider_timeout",
    message: "request timed out before send",
    phase: "request",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: false,
    fallbackAllowedPreCommit: true,
  },
  timeout_ambiguous: {
    tag: "ProviderTimeoutError",
    code: "provider_timeout",
    message: "request timed out after send; accept state ambiguous",
    phase: "body",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: true,
    fallbackAllowedPreCommit: true,
  },
  http_4xx: {
    tag: "ProviderRejectedError",
    code: "provider_rejected",
    message: "gateway rejected the request",
    phase: "headers",
    retryable: false,
    fallbackEligible: false,
    maybeAcceptedUpstream: false,
    httpStatus: 422,
    fallbackAllowedPreCommit: false,
  },
  http_5xx: {
    tag: "ProviderUnavailableError",
    code: "provider_unavailable",
    message: "gateway returned a server error",
    phase: "headers",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: true,
    httpStatus: 503,
    fallbackAllowedPreCommit: true,
  },
  capacity: {
    tag: "ProviderUnavailableError",
    code: "provider_unavailable",
    message: "provider at capacity",
    phase: "headers",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: false,
    httpStatus: 429,
    fallbackAllowedPreCommit: true,
  },
  validation: {
    tag: "ProviderRejectedError",
    code: "provider_rejected",
    message: "request failed upstream validation",
    phase: "request",
    retryable: false,
    fallbackEligible: false,
    maybeAcceptedUpstream: false,
    fallbackAllowedPreCommit: false,
  },
  auth: {
    tag: "ProviderRejectedError",
    code: "provider_rejected",
    message: "upstream rejected credentials",
    phase: "headers",
    retryable: false,
    fallbackEligible: false,
    maybeAcceptedUpstream: false,
    httpStatus: 401,
    fallbackAllowedPreCommit: false,
  },
  malformed_response: {
    tag: "ProviderProtocolError",
    code: "provider_protocol",
    message: "response body was not valid json",
    phase: "parse",
    retryable: false,
    fallbackEligible: false,
    maybeAcceptedUpstream: false,
    fallbackAllowedPreCommit: false,
  },
  missing_usage: {
    tag: "ProviderProtocolError",
    code: "provider_protocol",
    message: "usage missing from response",
    phase: "parse",
    retryable: false,
    fallbackEligible: false,
    maybeAcceptedUpstream: false,
    fallbackAllowedPreCommit: false,
  },
  abort: {
    tag: "ProviderRejectedError",
    code: "provider_rejected",
    message: "request aborted upstream",
    phase: "request",
    retryable: false,
    fallbackEligible: false,
    maybeAcceptedUpstream: false,
    fallbackAllowedPreCommit: false,
  },
  unknown: {
    tag: "ProviderProtocolError",
    code: "provider_protocol",
    message: "unknown failure mode",
    phase: "parse",
    retryable: false,
    fallbackEligible: false,
    maybeAcceptedUpstream: false,
    fallbackAllowedPreCommit: false,
  },
};

function providerErrorFor(category: ProviderErrorCategory) {
  const fx = FIXTURES[category];
  return makeProviderError({
    message: fx.message,
    category,
    phase: fx.phase,
    retryable: fx.retryable,
    fallbackEligible: fx.fallbackEligible,
    maybeAcceptedUpstream: fx.maybeAcceptedUpstream,
    ...(fx.httpStatus !== undefined ? { httpStatus: fx.httpStatus } : {}),
    diagnostic: "raw upstream body: do not leak",
  });
}

test("fixture table covers the source's exact category set", () => {
  expect(Object.keys(FIXTURES).sort()).toEqual([...PROVIDER_CATEGORIES].sort());
});

test("classifyProviderError maps each ProviderError category to its tagged family", () => {
  for (const category of PROVIDER_CATEGORIES) {
    const fx = FIXTURES[category];
    const got = classifyProviderError(providerErrorFor(category));
    if (!isProviderAppError(got)) {
      throw new Error(`expected tagged provider error for category ${category}, got ${got._tag}`);
    }
    expect(got._tag).toBe(fx.tag);
    expect(got.code).toBe(fx.code);
    expect(got.category).toBe(category);
    expect(got.phase).toBe(fx.phase);
    expect(got.message).toBe(fx.message);
    expect(got.retryClass).toBe(fx.retryable ? "transient" : "never");
    expect(got.fallbackClass).toBe(fx.fallbackEligible ? "eligible" : "ineligible");
    expect(got.acceptanceClass).toBe(
      fx.maybeAcceptedUpstream ? "maybe_accepted" : "not_accepted",
    );
    expect(got.streamCommitClass).toBe("not_committed");
    expect(got.diagnostic).toBe("raw upstream body: do not leak");
    expect("httpStatus" in got).toBe(fx.httpStatus !== undefined);
    expect(got.httpStatus).toBe(fx.httpStatus);
  }
});

test("classifyProviderError preserves provider/model/operation opts and request metadata", () => {
  const err = makeProviderError({
    message: "gateway returned a server error",
    category: "http_5xx",
    phase: "headers",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: true,
    httpStatus: 503,
    providerRequestId: "req-123",
    diagnostic: "raw body",
  });
  const got = classifyProviderError(err, {
    provider: "openai",
    model: "gpt-x",
    operation: "chat",
  });
  if (!isProviderAppError(got)) throw new Error("expected tagged provider error");
  expect(got.provider).toBe("openai");
  expect(got.model).toBe("gpt-x");
  expect(got.operation).toBe("chat");
  expect(got.providerRequestId).toBe("req-123");
  expect(got.httpStatus).toBe(503);
  expect(got.diagnostic).toBe("raw body");

  const bare = classifyProviderError(err);
  if (!isProviderAppError(bare)) throw new Error("expected tagged provider error");
  expect("provider" in bare).toBe(false);
  expect("model" in bare).toBe(false);
  expect("operation" in bare).toBe(false);
});

test("providerErrorFromCategory round-trips every category to the same tagged family", () => {
  for (const category of PROVIDER_CATEGORIES) {
    const fx = FIXTURES[category];
    const got = providerErrorFromCategory(category, {
      message: fx.message,
      phase: fx.phase,
      retryable: fx.retryable,
      fallbackEligible: fx.fallbackEligible,
      maybeAcceptedUpstream: fx.maybeAcceptedUpstream,
      streamCommitted: false,
      ...(fx.httpStatus !== undefined ? { httpStatus: fx.httpStatus } : {}),
    });
    expect(got._tag).toBe(fx.tag);
    expect(got.code).toBe(fx.code);
    expect(got.category).toBe(category);
    expect(got.phase).toBe(fx.phase);
    expect(got.message).toBe(fx.message);
    expect(got.retryClass).toBe(fx.retryable ? "transient" : "never");
    expect(got.fallbackClass).toBe(fx.fallbackEligible ? "eligible" : "ineligible");
    expect(got.acceptanceClass).toBe(
      fx.maybeAcceptedUpstream ? "maybe_accepted" : "not_accepted",
    );
    expect(got.streamCommitClass).toBe("not_committed");
  }
});

test("providerErrorFromCategory propagates optional fields and omits absent ones", () => {
  const full = providerErrorFromCategory("timeout_ambiguous", {
    message: "ambiguous timeout",
    phase: "body",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: true,
    streamCommitted: true,
    provider: "openai",
    model: "gpt-x",
    operation: "chat",
    providerRequestId: "req-9",
    diagnostic: "raw",
  });
  expect(full._tag).toBe("ProviderTimeoutError");
  expect(full.code).toBe("provider_timeout");
  expect(full.provider).toBe("openai");
  expect(full.model).toBe("gpt-x");
  expect(full.operation).toBe("chat");
  expect(full.providerRequestId).toBe("req-9");
  expect(full.diagnostic).toBe("raw");
  expect(full.streamCommitClass).toBe("committed");
  // Commit beats classes: no fallback even though fallbackClass is eligible.
  expect(isFallbackAllowedForError(full, false)).toBe(false);

  const minimal = providerErrorFromCategory("connection", {
    message: "connect failed",
    phase: "connect",
    retryable: true,
    fallbackEligible: true,
    maybeAcceptedUpstream: false,
    streamCommitted: false,
  });
  expect("provider" in minimal).toBe(false);
  expect("model" in minimal).toBe(false);
  expect("operation" in minimal).toBe(false);
  expect("httpStatus" in minimal).toBe(false);
  expect("providerRequestId" in minimal).toBe(false);
  expect("diagnostic" in minimal).toBe(false);
});

test("isFallbackAllowedForError: transient categories fall back pre-commit, never after commit", () => {
  for (const category of PROVIDER_CATEGORIES) {
    const classified = classifyProviderError(providerErrorFor(category));
    expect(isFallbackAllowedForError(classified, false)).toBe(
      FIXTURES[category].fallbackAllowedPreCommit,
    );
    // Stream committed: fallback is terminal for every category.
    expect(isFallbackAllowedForError(classified, true)).toBe(false);
  }
  // Explicit auth fixture: rejected credentials never fail over.
  const auth = classifyProviderError(providerErrorFor("auth"));
  expect(isFallbackAllowedForError(auth, false)).toBe(false);
});

test("isFallbackAllowedForError delegates non-tagged values to isFallbackAllowed", () => {
  const typeErr = new TypeError("Cannot read properties of undefined");
  expect(isFallbackAllowedForError(typeErr, false)).toBe(
    isFallbackAllowed(typeErr, false),
  );
  expect(isFallbackAllowedForError(typeErr, false)).toBe(true);

  const fetchErr = new Error("fetch failed");
  expect(isFallbackAllowedForError(fetchErr, false)).toBe(true);

  const legacyEligible = makeProviderError({
    message: "provider at capacity",
    category: "capacity",
    phase: "headers",
    retryable: true,
    fallbackEligible: true,
  });
  expect(isFallbackAllowedForError(legacyEligible, false)).toBe(
    isFallbackAllowed(legacyEligible, false),
  );
  expect(isFallbackAllowedForError(legacyEligible, false)).toBe(true);

  const legacyIneligible = makeProviderError({
    message: "upstream rejected credentials",
    category: "auth",
    phase: "headers",
    retryable: false,
    fallbackEligible: false,
  });
  expect(isFallbackAllowedForError(legacyIneligible, false)).toBe(false);

  expect(isFallbackAllowedForError(legacyEligible, true)).toBe(false);
});

test("classifyProviderError: streamCommitted on the legacy error commits the result", () => {
  const err = makeProviderError({
    message: "connection reset before response headers",
    category: "connection",
    phase: "connect",
    retryable: true,
    fallbackEligible: true,
    streamCommitted: true,
  });
  const got = classifyProviderError(err);
  if (!isProviderAppError(got)) throw new Error("expected tagged provider error");
  expect(got.streamCommitClass).toBe("committed");
  expect(got.fallbackClass).toBe("ineligible");
  expect(isFallbackAllowedForError(got, false)).toBe(false);
});

test("classifyProviderError: opts.streamCommitted forces committed and ineligible", () => {
  const err = makeProviderError({
    message: "connection reset before response headers",
    category: "connection",
    phase: "connect",
    retryable: true,
    fallbackEligible: true,
  });
  const got = classifyProviderError(err, { streamCommitted: true });
  if (!isProviderAppError(got)) throw new Error("expected tagged provider error");
  expect(got.streamCommitClass).toBe("committed");
  expect(got.fallbackClass).toBe("ineligible");
  expect(isFallbackAllowedForError(got, false)).toBe(false);
});

test("classifyProviderError: TypeError becomes safe connection failure", () => {
  const got = classifyProviderError(
    new TypeError("Cannot read properties of undefined (reading 'map')"),
    { provider: "openai" },
  );
  if (!isProviderAppError(got)) throw new Error("expected tagged provider error");
  expect(got._tag).toBe("ProviderUnavailableError");
  expect(got.code).toBe("provider_unavailable");
  expect(got.category).toBe("connection");
  expect(got.phase).toBe("connect");
  expect(got.retryClass).toBe("transient");
  expect(got.fallbackClass).toBe("eligible");
  expect(got.streamCommitClass).toBe("not_committed");
  expect(got.message).toBe(SAFE_MESSAGES.provider_unavailable);
  // Raw driver text stays private; only the stable safe message is public.
  expect(got.message).not.toContain("Cannot read properties");
  expect(got.diagnostic).toContain("Cannot read properties");
  expect(isFallbackAllowedForError(got, false)).toBe(true);

  const committed = classifyProviderError(new TypeError("boom"), {
    streamCommitted: true,
  });
  if (!isProviderAppError(committed)) throw new Error("expected tagged provider error");
  expect(committed.fallbackClass).toBe("ineligible");
  expect(isFallbackAllowedForError(committed, false)).toBe(false);
});

test("classifyProviderError: fetch failures map to connection, other Errors do not", () => {
  for (const raw of [
    "fetch failed",
    "connect ECONNREFUSED 10.0.0.1:443",
    "getaddrinfo ENOTFOUND api.example.com",
  ]) {
    const got = classifyProviderError(new Error(raw));
    if (!isProviderAppError(got)) throw new Error("expected tagged provider error");
    expect(got._tag).toBe("ProviderUnavailableError");
    expect(got.category).toBe("connection");
    expect(got.phase).toBe("connect");
    expect(got.message).toBe(SAFE_MESSAGES.provider_unavailable);
    expect(got.diagnostic).toBe(raw);
  }

  const unrelated = classifyProviderError(new Error("connect ECONNRESET mid-body"));
  expect(unrelated._tag).toBe("SystemError");
});

test("classifyProviderError: abort errors become rejected abort failures", () => {
  const named = new Error("postBody failed");
  named.name = "AbortError";
  const got = classifyProviderError(named);
  if (!isProviderAppError(got)) throw new Error("expected tagged provider error");
  expect(got._tag).toBe("ProviderRejectedError");
  expect(got.code).toBe("provider_rejected");
  expect(got.category).toBe("abort");
  expect(got.phase).toBe("request");
  expect(got.retryClass).toBe("never");
  expect(got.fallbackClass).toBe("ineligible");
  expect(got.message).toBe(SAFE_MESSAGES.provider_rejected);
  expect(got.message).not.toContain("postBody");
  expect(got.diagnostic).toContain("postBody");
  expect(isFallbackAllowedForError(got, false)).toBe(false);

  const viaMessage = classifyProviderError(new Error("The operation was aborted"));
  if (!isProviderAppError(viaMessage)) throw new Error("expected tagged provider error");
  expect(viaMessage.category).toBe("abort");
});

test("classifyProviderError: unsafe legacy messages are replaced with public-safe text", () => {
  const leaky = makeProviderError({
    message: "upstream said: api_key=sk-proj-SUPERSECRET",
    category: "http_5xx",
    phase: "headers",
    retryable: true,
    fallbackEligible: true,
    httpStatus: 502,
  });
  const got = classifyProviderError(leaky);
  if (!isProviderAppError(got)) throw new Error("expected tagged provider error");
  expect(got.message).toBe("upstream failed (HTTP 502)");
  expect(got.message).toBe(publicProviderErrorMessage("upstream", 502));
  expect(got.message).not.toContain("SUPERSECRET");

  const labeled = classifyProviderError(leaky, { label: "openai-primary" });
  if (!isProviderAppError(labeled)) throw new Error("expected tagged provider error");
  expect(labeled.message).toBe("openai-primary failed (HTTP 502)");

  const passwordLeak = classifyProviderError(
    makeProviderError({
      message: "db password=hunter2 was rejected",
      category: "validation",
      phase: "request",
      retryable: false,
      fallbackEligible: false,
    }),
  );
  if (!isProviderAppError(passwordLeak)) throw new Error("expected tagged provider error");
  expect(passwordLeak.message).toBe("upstream failed");

  const longMessage = classifyProviderError(
    makeProviderError({
      message: "x".repeat(301),
      category: "malformed_response",
      phase: "parse",
      retryable: false,
      fallbackEligible: false,
    }),
  );
  if (!isProviderAppError(longMessage)) throw new Error("expected tagged provider error");
  expect(longMessage.message).toBe("upstream failed");

  const safe = classifyProviderError(providerErrorFor("capacity"));
  if (!isProviderAppError(safe)) throw new Error("expected tagged provider error");
  expect(safe.message).toBe("provider at capacity");
});

test("classifyProviderError: unknown failures become SystemError without leaking raw text", () => {
  const got = classifyProviderError(new Error("warp coil exploded: sk-live-abc123"));
  expect(got._tag).toBe("SystemError");
  expect(got.code).toBe("system_error");
  expect(got.message).toBe(SAFE_MESSAGES.internal_server_error);
  expect(got.message).not.toContain("sk-live");
  expect(got.diagnostic).toContain("sk-live-abc123");

  for (const raw of ["raw provider body sk-abc", 42, { boom: true }, null, undefined]) {
    const fallback = classifyProviderError(raw);
    expect(fallback._tag).toBe("SystemError");
    expect(fallback.code).toBe("system_error");
    expect(fallback.message).toBe(SAFE_MESSAGES.internal_server_error);
  }

  const long = "y".repeat(600);
  const bounded = classifyProviderError(new Error(long));
  expect(bounded._tag).toBe("SystemError");
  expect(bounded.diagnostic).toBe(long.slice(0, 500));
});
