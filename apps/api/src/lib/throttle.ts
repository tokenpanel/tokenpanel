/**
 * In-memory failure-rate throttle for credential endpoints (login, invite
 * acceptance, public API-key auth). Limits brute-force / credential-stuffing by
 * locking a key out for `lockoutMs` after `maxAttempts` failures within a
 * sliding `windowMs` window.
 *
 * State is per-process (single Bun.serve instance). A restart resets counters —
 * acceptable for throttling; the constant-time hash comparison (crypto.ts) is
 * the durable protection against offline guessing. `now` is injectable so tests
 * can drive the clock deterministically without sleeping.
 */
export type ThrottleCheckResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type Entry = {
  failures: number[];
  lockedUntil: number;
};

type ThrottleOpts = {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
  maxStoreSize?: number;
  now?: () => number;
};

export class FailureThrottle {
  private store = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxStoreSize: number;
  private readonly opts: ThrottleOpts;

  constructor(opts: ThrottleOpts) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.maxStoreSize = opts.maxStoreSize ?? 50_000;
  }

  private purge(key: string, now: number): void {
    const e = this.store.get(key);
    if (!e) return;
    e.failures = e.failures.filter((t) => now - t < this.opts.windowMs);
    if (e.failures.length === 0 && e.lockedUntil <= now) this.store.delete(key);
  }

  private maybeGlobalPurge(now: number): void {
    if (this.store.size <= this.maxStoreSize) return;
    for (const [k, e] of this.store) {
      const fresh = e.failures.filter((t) => now - t < this.opts.windowMs);
      if (fresh.length === 0 && e.lockedUntil <= now) this.store.delete(k);
      else e.failures = fresh;
    }
  }

  /** Call before processing a credential check. Returns allowed + retry hint. */
  check(key: string): ThrottleCheckResult {
    const now = this.now();
    this.maybeGlobalPurge(now);
    this.purge(key, now);
    const e = this.store.get(key);
    if (e && e.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((e.lockedUntil - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Call when a credential check FAILS. Locks out once maxAttempts is hit. */
  recordFailure(key: string): void {
    const now = this.now();
    this.maybeGlobalPurge(now);
    this.purge(key, now);
    let e = this.store.get(key);
    if (!e) {
      e = { failures: [], lockedUntil: 0 };
      this.store.set(key, e);
    }
    e.failures.push(now);
    if (e.failures.length >= this.opts.maxAttempts) {
      e.lockedUntil = now + this.opts.lockoutMs;
      e.failures = [];
    }
  }

  /** Call when a credential check SUCCEEDS — clears the failure history. */
  recordSuccess(key: string): void {
    this.store.delete(key);
  }

  /** Test/reset hook. */
  clear(): void {
    this.store.clear();
  }
}

const FIFTEEN_MIN = 15 * 60 * 1000;

/** Throttle for admin login attempts, keyed by username. */
export const loginThrottle = new FailureThrottle({
  maxAttempts: 5,
  windowMs: FIFTEEN_MIN,
  lockoutMs: FIFTEEN_MIN,
});

/** Throttle for invite-token acceptance, keyed by the invite token. */
export const inviteThrottle = new FailureThrottle({
  maxAttempts: 5,
  windowMs: FIFTEEN_MIN,
  lockoutMs: FIFTEEN_MIN,
});

/** Throttle for public API-key auth failures, keyed by key prefix. */
export const apiKeyThrottle = new FailureThrottle({
  maxAttempts: 10,
  windowMs: FIFTEEN_MIN,
  lockoutMs: FIFTEEN_MIN,
});

