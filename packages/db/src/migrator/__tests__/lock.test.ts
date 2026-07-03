import { test, expect } from "bun:test";
import { createLockHandle, LockLostError } from "../lock.ts";

// A heartbeat interval of ~11.5 days so the auto-heartbeat never fires during
// tests that exercise renew()/assertAlive() manually. (1e9 < 2^31, so it is a
// valid, non-wrapping timer delay under both Node and Bun.)
const NO_AUTO: { heartbeatIntervalMs: number } = { heartbeatIntervalMs: 1_000_000_000 };

test("createLockHandle: fresh handle is alive", async () => {
  const h = createLockHandle("h1", async () => 1, async () => {}, NO_AUTO);
  expect(() => h.assertAlive()).not.toThrow();
  await h.release();
});

test("createLockHandle: holder is exposed on the handle", async () => {
  const h = createLockHandle("host-123", async () => 1, async () => {}, NO_AUTO);
  expect(h.holder).toBe("host-123");
  await h.release();
});

test("createLockHandle: renew with matchedCount > 0 keeps the lock alive", async () => {
  const h = createLockHandle("h1", async () => 1, async () => {}, NO_AUTO);
  await h.renew();
  expect(() => h.assertAlive()).not.toThrow();
  await h.release();
});

test("createLockHandle: renew with matchedCount 0 loses the lock", async () => {
  const h = createLockHandle("h1", async () => 0, async () => {}, NO_AUTO);
  await expect(h.renew()).rejects.toBeInstanceOf(LockLostError);
  expect(() => h.assertAlive()).toThrow(LockLostError);
  await h.release();
});

test("createLockHandle: renew op throwing loses the lock (wrapped in LockLostError)", async () => {
  const h = createLockHandle(
    "h1",
    async () => {
      throw new Error("network down");
    },
    async () => {},
    NO_AUTO,
  );
  await expect(h.renew()).rejects.toBeInstanceOf(LockLostError);
  expect(() => h.assertAlive()).toThrow(/network down/);
  await h.release();
});

test("createLockHandle: once lost, stays lost (further renew is a no-op)", async () => {
  let renewCalls = 0;
  const h = createLockHandle(
    "h1",
    async () => {
      renewCalls++;
      return 0;
    },
    async () => {},
    NO_AUTO,
  );
  await expect(h.renew()).rejects.toBeInstanceOf(LockLostError);
  const before = renewCalls;
  await h.renew(); // no-op because already lost
  expect(renewCalls).toBe(before);
  expect(() => h.assertAlive()).toThrow(LockLostError);
  await h.release();
});

test("createLockHandle: release stops the heartbeat and makes renew a no-op", async () => {
  let renewCalls = 0;
  const h = createLockHandle(
    "h1",
    async () => {
      renewCalls++;
      return 1;
    },
    async () => {},
    NO_AUTO,
  );
  await h.release();
  await h.renew(); // no-op because released
  expect(renewCalls).toBe(0);
  expect(() => h.assertAlive()).not.toThrow();
});

test("createLockHandle: release is idempotent (releaseOp runs once)", async () => {
  let releaseCalls = 0;
  const h = createLockHandle(
    "h1",
    async () => 1,
    async () => {
      releaseCalls++;
    },
    NO_AUTO,
  );
  await h.release();
  await h.release();
  expect(releaseCalls).toBe(1);
});

test("createLockHandle: heartbeat interval renews automatically while held", async () => {
  let renewCalls = 0;
  const h = createLockHandle(
    "h1",
    async () => {
      renewCalls++;
      return 1;
    },
    async () => {},
    { heartbeatIntervalMs: 10 },
  );
  // 10 ms interval → ~6 ticks in 70 ms. Assert at least 2 to stay robust
  // against scheduler jitter.
  await new Promise((r) => setTimeout(r, 70));
  await h.release();
  expect(renewCalls).toBeGreaterThanOrEqual(2);
});
