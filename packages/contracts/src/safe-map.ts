/**
 * Bounded safe-map policy for caller-controlled string-keyed records
 * (metadata, provider headers, similar maps).
 *
 * Policy version: 2026-07-15
 * Owned by @tokenpanel/contracts. Effect schemas live under
 * `@tokenpanel/contracts/effect`. Migrations MUST NOT import this module.
 */

// ---------------------------------------------------------------------------
// Reserved keys (prototype pollution)
// ---------------------------------------------------------------------------

/** Reserved keys that would mutate object prototypes if assigned naively. */
export const SAFE_MAP_RESERVED_KEYS = [
  "__proto__",
  "prototype",
  "constructor",
] as const;

export type SafeMapReservedKey = (typeof SAFE_MAP_RESERVED_KEYS)[number];

const reservedKeyLookup: ReadonlySet<string> = new Set(SAFE_MAP_RESERVED_KEYS);

/** True when `key` is a reserved prototype-pollution key. */
export function isReservedSafeMapKey(key: string): boolean {
  return reservedKeyLookup.has(key);
}

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

/**
 * Immutable write-policy limits for a safe map family.
 * Change only with coordinated DB/admin/API tests; bump policy version comment.
 */
export type SafeMapPolicy = Readonly<{
  maxEntries: number;
  keyMaxLen: number;
  /** Max length for string values (and string leaves in JSON maps). */
  valueMaxLen: number;
  reservedKeys: readonly SafeMapReservedKey[];
}>;

export function freezeSafeMapPolicy<P extends SafeMapPolicy>(policy: P): P {
  return Object.freeze({ ...policy, reservedKeys: policy.reservedKeys }) as P;
}

// ---------------------------------------------------------------------------
// Domain policies (single source of truth)
// ---------------------------------------------------------------------------

/** Model product metadata (admin write path). */
export const MODEL_METADATA_POLICY = freezeSafeMapPolicy({
  maxEntries: 50,
  keyMaxLen: 80,
  valueMaxLen: 2000,
  reservedKeys: SAFE_MAP_RESERVED_KEYS,
});

export type ModelMetadataPolicy = typeof MODEL_METADATA_POLICY;

/**
 * Provider custom HTTP headers (caller-controlled on create/update).
 * Header names are short; values may carry longer auth/context tokens.
 */
export const PROVIDER_HEADERS_POLICY = freezeSafeMapPolicy({
  maxEntries: 40,
  keyMaxLen: 64,
  valueMaxLen: 4096,
  reservedKeys: SAFE_MAP_RESERVED_KEYS,
});

export type ProviderHeadersPolicy = typeof PROVIDER_HEADERS_POLICY;

/**
 * Generic caller metadata (customer + provider metadata write paths).
 * Values may be JSON scalars; string leaves use valueMaxLen.
 */
export const CALLER_METADATA_POLICY = freezeSafeMapPolicy({
  maxEntries: 50,
  keyMaxLen: 80,
  valueMaxLen: 2000,
  reservedKeys: SAFE_MAP_RESERVED_KEYS,
});

export type CallerMetadataPolicy = typeof CALLER_METADATA_POLICY;

/** Max JSON nesting depth for unknown-value safe maps (root = 0). */
export const SAFE_JSON_MAP_MAX_DEPTH = 3;

/** Max serialized JSON size (bytes, UTF-16 length approx) per map value. */
export const SAFE_JSON_MAP_VALUE_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

/**
 * Control characters forbidden in keys: C0 (U+0000–U+001F) + DEL (U+007F).
 * Rejects NUL, CR/LF, tabs, and other non-printable controls that break logs
 * or enable injection into storage/query paths.
 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate a single already-trimmed map key against a write policy.
 * Rejects empty, overlong, control chars, leading `$` (Mongo operators),
 * and reserved prototype keys.
 */
export function isValidSafeMapKey(
  key: string,
  policy: SafeMapPolicy = MODEL_METADATA_POLICY,
): boolean {
  if (key.length < 1 || key.length > policy.keyMaxLen) {
    return false;
  }
  if (CONTROL_CHAR_RE.test(key)) return false;
  if (key.startsWith("$")) return false;
  if (isReservedSafeMapKey(key)) return false;
  return true;
}

/**
 * Model-metadata key helper (same policy as {@link MODEL_METADATA_POLICY}).
 * Kept for stable public API used by admin/DB.
 */
export function isValidModelMetadataKey(key: string): boolean {
  return isValidSafeMapKey(key, MODEL_METADATA_POLICY);
}

/** @deprecated Prefer {@link isReservedSafeMapKey}; alias for model API. */
export function isReservedModelMetadataKey(key: string): boolean {
  return isReservedSafeMapKey(key);
}

/** Alias used by model.ts re-exports. */
export const MODEL_METADATA_RESERVED_KEYS = SAFE_MAP_RESERVED_KEYS;
export type ModelMetadataReservedKey = SafeMapReservedKey;

/**
 * Contract-wide value newline normalization: `\r\n` / `\r` → `\n`.
 * Matches browser `<textarea>` behavior so UI round-trips are stable.
 */
export function normalizeMetadataValueNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ---------------------------------------------------------------------------
// Value helpers (JSON-safe maps)
// ---------------------------------------------------------------------------

export function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively validate a JSON-safe leaf/tree under safe-map policy.
 * Allows null, boolean, finite number, length-capped string, arrays, and
 * plain objects with safe keys. Rejects functions, symbols, undefined, Date,
 * Map, etc.
 */
export function isSafeJsonMapValue(
  value: unknown,
  policy: SafeMapPolicy,
  depth = 0,
): boolean {
  if (depth > SAFE_JSON_MAP_MAX_DEPTH) return false;
  if (value === null) return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return value.length <= policy.valueMaxLen;
  }
  if (Array.isArray(value)) {
    if (value.length > policy.maxEntries) return false;
    return value.every((v) => isSafeJsonMapValue(v, policy, depth + 1));
  }
  if (typeof value === "object") {
    if (!isPlainObject(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((k) => typeof k === "symbol")) return false;
    const stringKeys = keys.filter((k): k is string => typeof k === "string");
    if (stringKeys.length > policy.maxEntries) return false;
    for (const k of stringKeys) {
      if (!isValidSafeMapKey(k, policy)) return false;
      const child = (value as Record<string, unknown>)[k];
      if (!isSafeJsonMapValue(child, policy, depth + 1)) return false;
    }
    // Bound serialized size roughly via JSON.stringify length.
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length > SAFE_JSON_MAP_VALUE_MAX_CHARS) return false;
    } catch {
      return false;
    }
    return true;
  }
  return false;
}
