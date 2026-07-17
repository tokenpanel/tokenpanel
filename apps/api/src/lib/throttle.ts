/**
 * In-memory failure-rate throttle for credential endpoints (login, invite
 * acceptance, public API-key auth). Limits brute-force / credential-stuffing by
 * locking a key out for `lockoutMs` after `maxAttempts` failures within a
 * sliding `windowMs` window.
 *
 * Callers key **by client IP only** (see `getRequestClientIp`). Separate
 * process singletons (`loginThrottle`, `apiKeyThrottle`, `inviteThrottle`) keep
 * per-surface budgets and limits independent — login fails do not consume the
 * API-key budget and vice versa. Identity (username / key prefix) is never
 * part of the map key, so attackers cannot grow the store via unique strings
 * or lock out a victim account from another IP.
 *
 * Store hard-cap: `store.size` never exceeds `maxStoreSize`. When full, fully
 * stale entries are dropped first; if still over, oldest entries are evicted
 * (unlocked first, then any). Map insertion order approximates recency.
 *
 * State is per-process (single Bun.serve instance). A restart resets counters —
 * acceptable for throttling; the constant-time hash comparison (crypto.ts) is
 * the durable protection against offline guessing. `now` is injectable so tests
 * can drive the clock deterministically without sleeping.
 *
 * Policy values: config/security-policy.ts.
 */
import {
  THROTTLE_API_KEY_MAX_ATTEMPTS_COUNT,
  THROTTLE_INVITE_MAX_ATTEMPTS_COUNT,
  THROTTLE_LOCKOUT_MS,
  THROTTLE_LOGIN_MAX_ATTEMPTS_COUNT,
  THROTTLE_MAX_STORE_SIZE_COUNT,
  THROTTLE_WINDOW_MS,
} from "../config/security-policy.ts";

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
    this.maxStoreSize = opts.maxStoreSize ?? THROTTLE_MAX_STORE_SIZE_COUNT;
  }

  private purge(key: string, now: number): void {
    const e = this.store.get(key);
    if (!e) return;
    e.failures = e.failures.filter((t) => now - t < this.opts.windowMs);
    if (e.failures.length === 0 && e.lockedUntil <= now) this.store.delete(key);
  }

  /** Drop entries with no in-window failures and no active lockout. */
  private purgeStale(now: number): void {
    for (const [k, e] of this.store) {
      const fresh = e.failures.filter((t) => now - t < this.opts.windowMs);
      if (fresh.length === 0 && e.lockedUntil <= now) this.store.delete(k);
      else e.failures = fresh;
    }
  }

  /**
   * Evict until `store.size <= targetSize`. Prefer unlocked (or expired-lock)
   * entries in insertion order, then any remaining oldest keys.
   */
  private hardEvictUntil(targetSize: number, now: number): void {
    if (targetSize < 0) targetSize = 0;
    if (this.store.size <= targetSize) return;

    for (const [k, e] of this.store) {
      if (this.store.size <= targetSize) return;
      if (e.lockedUntil <= now) this.store.delete(k);
    }
    for (const k of this.store.keys()) {
      if (this.store.size <= targetSize) return;
      this.store.delete(k);
    }
  }

  /**
   * Guarantee `store.size <= maxStoreSize`: stale purge, then hard eviction.
   */
  private enforceStoreCap(now: number): void {
    if (this.store.size <= this.maxStoreSize) return;
    this.purgeStale(now);
    this.hardEvictUntil(this.maxStoreSize, now);
  }

  /**
   * Free a slot before inserting a new key. No-op if the key already exists
   * or the store is under capacity.
   */
  private ensureRoomForNewKey(now: number): void {
    if (this.store.size < this.maxStoreSize) return;
    this.purgeStale(now);
    if (this.store.size < this.maxStoreSize) return;
    // Leave one free slot for the incoming key (cap is exclusive of the new set).
    this.hardEvictUntil(Math.max(0, this.maxStoreSize - 1), now);
  }

  /** Call before processing a credential check. Returns allowed + retry hint. */
  check(key: string): ThrottleCheckResult {
    const now = this.now();
    this.enforceStoreCap(now);
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
    this.purge(key, now);
    let e = this.store.get(key);
    if (!e) {
      if (this.maxStoreSize <= 0) return;
      this.ensureRoomForNewKey(now);
      e = { failures: [], lockedUntil: 0 };
      this.store.set(key, e);
    }
    e.failures.push(now);
    if (e.failures.length >= this.opts.maxAttempts) {
      e.lockedUntil = now + this.opts.lockoutMs;
      e.failures = [];
    }
    // Safety net if maxStoreSize was reduced or invariants slip.
    this.enforceStoreCap(now);
  }

  /** Call when a credential check SUCCEEDS — clears the failure history. */
  recordSuccess(key: string): void {
    this.store.delete(key);
  }

  /** Test/reset hook. */
  clear(): void {
    this.store.clear();
  }

  /** Test hook: current number of tracked keys. */
  size(): number {
    return this.store.size;
  }
}

/** Admin login failures. Key = client IP. */
export const loginThrottle = new FailureThrottle({
  maxAttempts: THROTTLE_LOGIN_MAX_ATTEMPTS_COUNT,
  windowMs: THROTTLE_WINDOW_MS,
  lockoutMs: THROTTLE_LOCKOUT_MS,
});

/** Invite accept failures. Key = client IP. */
export const inviteThrottle = new FailureThrottle({
  maxAttempts: THROTTLE_INVITE_MAX_ATTEMPTS_COUNT,
  windowMs: THROTTLE_WINDOW_MS,
  lockoutMs: THROTTLE_LOCKOUT_MS,
});

/** Public API-key auth failures. Key = client IP. */
export const apiKeyThrottle = new FailureThrottle({
  maxAttempts: THROTTLE_API_KEY_MAX_ATTEMPTS_COUNT,
  windowMs: THROTTLE_WINDOW_MS,
  lockoutMs: THROTTLE_LOCKOUT_MS,
});
