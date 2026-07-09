import { test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { apiKeyThrottle } from "../../lib/throttle.ts";
import {
  CUSTOMER_KEY_PREFIX,
  MANAGEMENT_KEY_PREFIX,
  PREFIX_LENGTH,
  requirePublicPrincipal,
} from "../public-auth.ts";

test("CUSTOMER_KEY_PREFIX is 'tp_live_' and MANAGEMENT_KEY_PREFIX is 'tp_mgmt_'", () => {
  expect(CUSTOMER_KEY_PREFIX).toBe("tp_live_");
  expect(MANAGEMENT_KEY_PREFIX).toBe("tp_mgmt_");
});

test("PREFIX_LENGTH is 16 (8 literal + 8 random hex ≈ 4.3B combos)", () => {
  expect(PREFIX_LENGTH).toBe(16);
  expect(PREFIX_LENGTH).toBeGreaterThanOrEqual(CUSTOMER_KEY_PREFIX.length);
  expect(PREFIX_LENGTH).toBeGreaterThanOrEqual(MANAGEMENT_KEY_PREFIX.length);
});

test("prefix literals are mutually exclusive — a real key cannot satisfy both startWith checks", () => {
  const customerKey = `${CUSTOMER_KEY_PREFIX}abc123`;
  const mgmtKey = `${MANAGEMENT_KEY_PREFIX}abc123`;
  expect(customerKey.startsWith(CUSTOMER_KEY_PREFIX)).toBe(true);
  expect(customerKey.startsWith(MANAGEMENT_KEY_PREFIX)).toBe(false);
  expect(mgmtKey.startsWith(MANAGEMENT_KEY_PREFIX)).toBe(true);
  expect(mgmtKey.startsWith(CUSTOMER_KEY_PREFIX)).toBe(false);
});

test("prefix slice keeps the literal + 8 hex chars of entropy", () => {
  expect(`${CUSTOMER_KEY_PREFIX}0123456789abcdef`.slice(0, PREFIX_LENGTH)).toBe("tp_live_01234567");
  expect(`${MANAGEMENT_KEY_PREFIX}0123456789abcdef`.slice(0, PREFIX_LENGTH)).toBe("tp_mgmt_01234567");
});

// ---------------------------------------------------------------------------
// Middleware throttle-gate flow. These mount requirePublicPrincipal on a real
// Hono app and drive it with HTTP requests so the check() gating logic is
// exercised end-to-end (not just the FailureThrottle unit in isolation).
//
// Tests pre-seed the throttle singleton to a locked state for a chosen
// prefix, then confirm the middleware denies at the gate — BEFORE reaching
// getDb(). Denial at the gate is asserted via 401 + a Retry-After header; if
// the gate were bypassed (regression), the middleware would proceed to getDb,
// which throws in this environment (no MONGODB_URI) and surfaces as a 500, so
// the assertion cleanly distinguishes a gate denial from a pass-through.
// ---------------------------------------------------------------------------

function buildGatedApp(): Hono {
  const app = new Hono();
  app.use("/v1/*", requirePublicPrincipal);
  app.all("/v1/*", (c) => c.json({ ok: true }, 200));
  return app;
}

beforeEach(() => apiKeyThrottle.clear());

test("middleware: 16-char prefix lockout is enforced at the gate (401 + Retry-After)", async () => {
  const locked16 = "tp_live_abcd1234"; // 16-char slice
  // Pre-lock the 16-char bucket (maxAttempts = 10).
  for (let i = 0; i < 10; i++) apiKeyThrottle.recordFailure(locked16);

  const app = buildGatedApp();
  const res = await app.request("/v1/chat", {
    headers: { authorization: `Bearer ${locked16}secretpad` },
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("retry-after")).not.toBeNull();
});
