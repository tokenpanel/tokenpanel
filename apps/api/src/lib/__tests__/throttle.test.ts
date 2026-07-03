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
