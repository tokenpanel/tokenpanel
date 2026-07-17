import { test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { apiKeyThrottle } from "../../lib/throttle.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../../config/security-policy.ts";
import { UNKNOWN_CLIENT_IP } from "../../lib/client-ip.ts";
import { requirePublicPrincipal } from "../public-auth.ts";

test("key prefixes match security-policy literals", () => {
  expect(CUSTOMER_KEY_PREFIX_LITERAL).toBe("tp_live_");
  expect(MANAGEMENT_KEY_PREFIX_LITERAL).toBe("tp_mgmt_");
});

test("API_KEY_LOOKUP_PREFIX_CHARS is 16 (8 literal + 8 random hex ≈ 4.3B combos)", () => {
  expect(API_KEY_LOOKUP_PREFIX_CHARS).toBe(16);
  expect(API_KEY_LOOKUP_PREFIX_CHARS).toBeGreaterThanOrEqual(
    CUSTOMER_KEY_PREFIX_LITERAL.length,
  );
  expect(API_KEY_LOOKUP_PREFIX_CHARS).toBeGreaterThanOrEqual(
    MANAGEMENT_KEY_PREFIX_LITERAL.length,
  );
});

test("prefix literals are mutually exclusive — a real key cannot satisfy both startWith checks", () => {
  const customerKey = `${CUSTOMER_KEY_PREFIX_LITERAL}abc123`;
  const mgmtKey = `${MANAGEMENT_KEY_PREFIX_LITERAL}abc123`;
  expect(customerKey.startsWith(CUSTOMER_KEY_PREFIX_LITERAL)).toBe(true);
  expect(customerKey.startsWith(MANAGEMENT_KEY_PREFIX_LITERAL)).toBe(false);
  expect(mgmtKey.startsWith(MANAGEMENT_KEY_PREFIX_LITERAL)).toBe(true);
  expect(mgmtKey.startsWith(CUSTOMER_KEY_PREFIX_LITERAL)).toBe(false);
});

test("prefix slice keeps the literal + 8 hex chars of entropy", () => {
  expect(
    `${CUSTOMER_KEY_PREFIX_LITERAL}0123456789abcdef`.slice(
      0,
      API_KEY_LOOKUP_PREFIX_CHARS,
    ),
  ).toBe("tp_live_01234567");
  expect(
    `${MANAGEMENT_KEY_PREFIX_LITERAL}0123456789abcdef`.slice(
      0,
      API_KEY_LOOKUP_PREFIX_CHARS,
    ),
  ).toBe("tp_mgmt_01234567");
});

// ---------------------------------------------------------------------------
// Middleware throttle-gate flow. Mount requirePublicPrincipal and drive with
// HTTP so check() gating is exercised end-to-end. Buckets are client IP only
// (separate FailureThrottle singleton per surface).
//
// Pre-seed the IP bucket to locked, then confirm 401 + Retry-After before DB.
// ---------------------------------------------------------------------------

function buildGatedApp(): Hono {
  const app = new Hono();
  app.use("/v1/*", requirePublicPrincipal);
  app.all("/v1/*", (c) => c.json({ ok: true }, 200));
  return app;
}

beforeEach(() => apiKeyThrottle.clear());

test("middleware: IP lockout is enforced at the gate (401 + Retry-After)", async () => {
  // app.request has no socket peer → getRequestClientIp uses UNKNOWN_CLIENT_IP.
  for (let i = 0; i < 10; i++) {
    apiKeyThrottle.recordFailure(UNKNOWN_CLIENT_IP);
  }

  const app = buildGatedApp();
  const res = await app.request("/v1/chat", {
    headers: {
      authorization: `Bearer ${CUSTOMER_KEY_PREFIX_LITERAL}abcd1234secretpad`,
    },
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("retry-after")).not.toBeNull();
});

test("middleware: lockout is scoped to IP (other IP not locked)", async () => {
  for (let i = 0; i < 10; i++) {
    apiKeyThrottle.recordFailure("203.0.113.1");
  }

  const app = buildGatedApp();
  // Request uses UNKNOWN_CLIENT_IP — different bucket → gate open.
  const res = await app.request("/v1/chat", {
    headers: {
      authorization: `Bearer ${CUSTOMER_KEY_PREFIX_LITERAL}abcd1234secretpad`,
    },
  });
  expect(res.headers.get("retry-after")).toBeNull();
  expect(res.status).not.toBe(401);
});

test("middleware: key prefix is not part of the throttle bucket", async () => {
  for (let i = 0; i < 10; i++) {
    apiKeyThrottle.recordFailure(UNKNOWN_CLIENT_IP);
  }

  const app = buildGatedApp();
  // Different key still blocked — same client IP bucket.
  const res = await app.request("/v1/chat", {
    headers: {
      authorization: `Bearer ${CUSTOMER_KEY_PREFIX_LITERAL}zzzz9999otherpad`,
    },
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("retry-after")).not.toBeNull();
});
