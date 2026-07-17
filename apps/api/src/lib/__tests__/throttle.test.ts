import { test, expect } from "bun:test";
import { FailureThrottle } from "../throttle.ts";

// Injectable clock so lockout/window behaviour is deterministic without sleeps.
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

test("check: allowed when no history", () => {
  const th = new FailureThrottle({ maxAttempts: 3, windowMs: 1000, lockoutMs: 2000 });
  expect(th.check("k").allowed).toBe(true);
});

test("recordFailure: does not lock before maxAttempts", () => {
  const c = clock();
  const th = new FailureThrottle({ maxAttempts: 3, windowMs: 1000, lockoutMs: 2000, now: c.now });
  th.recordFailure("k");
  th.recordFailure("k");
  expect(th.check("k").allowed).toBe(true);
});

test("recordFailure: locks out exactly at maxAttempts", () => {
  const c = clock();
  const th = new FailureThrottle({ maxAttempts: 3, windowMs: 1000, lockoutMs: 2000, now: c.now });
  th.recordFailure("k");
  th.recordFailure("k");
  th.recordFailure("k");
  const gate = th.check("k");
  expect(gate.allowed).toBe(false);
  expect(gate.retryAfterSeconds).toBeGreaterThanOrEqual(1);
});

test("check: lockout clears after lockoutMs elapses", () => {
  const c = clock();
  const th = new FailureThrottle({ maxAttempts: 2, windowMs: 1000, lockoutMs: 2000, now: c.now });
  th.recordFailure("k");
  th.recordFailure("k");
  expect(th.check("k").allowed).toBe(false);
  c.advance(2000);
  expect(th.check("k").allowed).toBe(true);
});

test("check: old failures age out of the window", () => {
  const c = clock();
  const th = new FailureThrottle({ maxAttempts: 2, windowMs: 1000, lockoutMs: 5000, now: c.now });
  th.recordFailure("k");
  c.advance(1001); // first failure now outside the window
  th.recordFailure("k");
  // Only one fresh failure → not locked.
  expect(th.check("k").allowed).toBe(true);
});

test("recordSuccess: clears failure history for the key", () => {
  const c = clock();
  const th = new FailureThrottle({ maxAttempts: 2, windowMs: 1000, lockoutMs: 2000, now: c.now });
  th.recordFailure("k");
  th.recordSuccess("k");
  th.recordFailure("k");
  expect(th.check("k").allowed).toBe(true);
});

test("keys are independent", () => {
  const c = clock();
  const th = new FailureThrottle({ maxAttempts: 2, windowMs: 1000, lockoutMs: 2000, now: c.now });
  th.recordFailure("a");
  th.recordFailure("a");
  expect(th.check("a").allowed).toBe(false);
  expect(th.check("b").allowed).toBe(true);
});

test("retryAfterSeconds reflects remaining lockout time", () => {
  const c = clock();
  const th = new FailureThrottle({ maxAttempts: 1, windowMs: 1000, lockoutMs: 10000, now: c.now });
  th.recordFailure("k");
  c.advance(3000);
  const gate = th.check("k");
  expect(gate.allowed).toBe(false);
  expect(gate.retryAfterSeconds).toBe(7); // 10000 - 3000 = 7000ms → 7s
});

// Surfaces key by client IP only. Distinct IPs must not share lockout state.
test("distinct client IPs accumulate lockout independently", () => {
  const c = clock();
  const th = new FailureThrottle({
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    lockoutMs: 15 * 60 * 1000,
    now: c.now,
  });
  const locked = "203.0.113.10";
  const other = "203.0.113.11";

  for (let i = 0; i < 10; i++) th.recordFailure(locked);

  expect(th.check(locked).allowed).toBe(false);
  expect(th.check(other).allowed).toBe(true);
});

// Hard cap: fresh keys must not grow the store past maxStoreSize.
test("maxStoreSize: four fresh IPs never exceed cap of 2", () => {
  const c = clock();
  const th = new FailureThrottle({
    maxAttempts: 5,
    windowMs: 60_000,
    lockoutMs: 60_000,
    maxStoreSize: 2,
    now: c.now,
  });

  th.recordFailure("203.0.113.1");
  th.recordFailure("203.0.113.2");
  th.recordFailure("203.0.113.3");
  th.recordFailure("203.0.113.4");

  expect(th.size()).toBeLessThanOrEqual(2);
  expect(th.size()).toBe(2);
});

// Under pressure, unlocked oldest entries leave first so active lockouts survive.
test("maxStoreSize: prefers evicting unlocked over locked entries", () => {
  const c = clock();
  const th = new FailureThrottle({
    maxAttempts: 2,
    windowMs: 60_000,
    lockoutMs: 60_000,
    maxStoreSize: 2,
    now: c.now,
  });

  // Lock ip-locked into the store.
  th.recordFailure("ip-locked");
  th.recordFailure("ip-locked");
  expect(th.check("ip-locked").allowed).toBe(false);

  // One unlocked neighbour fills the cap.
  th.recordFailure("ip-open");
  expect(th.size()).toBe(2);

  // New IP must take a slot; unlocked neighbour should go, lockout retained.
  th.recordFailure("ip-new");
  expect(th.size()).toBeLessThanOrEqual(2);
  expect(th.check("ip-locked").allowed).toBe(false);
  expect(th.check("ip-open").allowed).toBe(true); // state gone → allowed
});

// Stale entries free capacity before any hard eviction of live keys.
test("maxStoreSize: purges stale before hard-evicting live keys", () => {
  const c = clock();
  const th = new FailureThrottle({
    maxAttempts: 5,
    windowMs: 1000,
    lockoutMs: 500,
    maxStoreSize: 2,
    now: c.now,
  });

  th.recordFailure("stale-a");
  th.recordFailure("stale-b");
  expect(th.size()).toBe(2);

  // Age failures past window and past any lockout; both entries become stale.
  c.advance(2000);

  th.recordFailure("fresh-a");
  th.recordFailure("fresh-b");
  expect(th.size()).toBe(2);

  // Live keys kept; stale ones replaced without needing a third slot.
  // Lock fresh-a to prove it was retained after the second insert.
  for (let i = 0; i < 4; i++) th.recordFailure("fresh-a");
  expect(th.check("fresh-a").allowed).toBe(false);
});
