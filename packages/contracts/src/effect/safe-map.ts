/**
 * Effect Schema factories for bounded safe maps (Requirements = never).
 *
 * Rejects prototype-pollution keys, Mongo operator keys, control characters,
 * excessive entries, and oversized keys/values.
 */
import { ParseResult, Schema } from "effect";
import type { AST } from "effect/SchemaAST";
import {
  type SafeMapPolicy,
  MODEL_METADATA_POLICY,
  PROVIDER_HEADERS_POLICY,
  CALLER_METADATA_POLICY,
  isValidSafeMapKey,
  isPlainObject,
  isSafeJsonMapValue,
  normalizeMetadataValueNewlines,
} from "../safe-map.ts";

export {
  SAFE_MAP_RESERVED_KEYS,
  MODEL_METADATA_RESERVED_KEYS,
  MODEL_METADATA_POLICY,
  PROVIDER_HEADERS_POLICY,
  CALLER_METADATA_POLICY,
  SAFE_JSON_MAP_MAX_DEPTH,
  SAFE_JSON_MAP_VALUE_MAX_CHARS,
  isValidSafeMapKey,
  isReservedSafeMapKey,
  isValidModelMetadataKey,
  isReservedModelMetadataKey,
  isPlainObject,
  isSafeJsonMapValue,
  normalizeMetadataValueNewlines,
  freezeSafeMapPolicy,
} from "../safe-map.ts";
export type {
  SafeMapPolicy,
  SafeMapReservedKey,
  ModelMetadataPolicy,
  ProviderHeadersPolicy,
  CallerMetadataPolicy,
  ModelMetadataReservedKey,
} from "../safe-map.ts";

// ---------------------------------------------------------------------------
// Null-prototype record helpers (avoid prototype assignment footguns)
// ---------------------------------------------------------------------------

export function createStringRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export function setStringRecordEntry(
  target: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function createUnknownRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function setUnknownRecordEntry(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Shared decode plumbing
// ---------------------------------------------------------------------------

type StringMapLabel = string;

function ownStringKeys(
  val: object,
  ast: AST,
  label: string,
):
  | { ok: true; keys: string[] }
  | { ok: false; issue: ParseResult.Type } {
  if (Reflect.ownKeys(val).some((k) => typeof k === "symbol")) {
    return {
      ok: false,
      issue: new ParseResult.Type(ast, val, `${label} keys must be strings`),
    };
  }
  return {
    ok: true,
    keys: Reflect.ownKeys(val).filter((k): k is string => typeof k === "string"),
  };
}

function assertPlainObject(
  val: unknown,
  ast: AST,
  label: string,
):
  | { ok: true; obj: object }
  | { ok: false; issue: ParseResult.Type } {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    return {
      ok: false,
      issue: new ParseResult.Type(
        ast,
        val,
        `${label} must be an object of key/value pairs`,
      ),
    };
  }
  if (!isPlainObject(val)) {
    const kind =
      val instanceof Date
        ? "Date"
        : (val as { constructor?: { name?: string } }).constructor?.name ??
          typeof val;
    return {
      ok: false,
      issue: new ParseResult.Type(
        ast,
        val,
        `${label} must be a plain object (got ${kind})`,
      ),
    };
  }
  return { ok: true, obj: val };
}

/**
 * Bounded string→string map for write paths (metadata, headers).
 * Builds a null-prototype record via defineProperty (safe own-key set).
 */
export function createSafeStringMapSchema(
  policy: SafeMapPolicy,
  label: StringMapLabel = "map",
): Schema.Schema<Record<string, string>, unknown> {
  return Schema.transformOrFail(
    Schema.Unknown,
    Schema.Record({ key: Schema.String, value: Schema.String }),
    {
      strict: true,
      decode: (val, _opts, ast) => {
        if (val === undefined) {
          return ParseResult.succeed(createStringRecord());
        }
        const plain = assertPlainObject(val, ast, label);
        if (!plain.ok) return ParseResult.fail(plain.issue);
        const keysR = ownStringKeys(plain.obj, ast, label);
        if (!keysR.ok) return ParseResult.fail(keysR.issue);
        if (keysR.keys.length > policy.maxEntries) {
          return ParseResult.fail(
            new ParseResult.Type(
              ast,
              val,
              `${label} may have at most ${policy.maxEntries} entries`,
            ),
          );
        }
        const record = plain.obj as Record<string, unknown>;
        const out = createStringRecord();
        const seen = new Set<string>();
        for (const rawKey of keysR.keys) {
          const value = record[rawKey];
          if (typeof value !== "string") {
            return ParseResult.fail(
              new ParseResult.Pointer(
                [rawKey],
                val,
                new ParseResult.Type(
                  ast,
                  value,
                  `${label} values must be strings`,
                ),
              ),
            );
          }
          const normalized = normalizeMetadataValueNewlines(value);
          if (normalized.length > policy.valueMaxLen) {
            return ParseResult.fail(
              new ParseResult.Pointer(
                [rawKey],
                val,
                new ParseResult.Type(
                  ast,
                  value,
                  `${label} value must be at most ${policy.valueMaxLen} characters`,
                ),
              ),
            );
          }
          const key = rawKey.trim();
          if (!isValidSafeMapKey(key, policy)) {
            return ParseResult.fail(
              new ParseResult.Pointer(
                [rawKey],
                val,
                new ParseResult.Type(
                  ast,
                  rawKey,
                  `${label} key must be 1–${policy.keyMaxLen} chars after trim, no control characters, no leading $, and not a reserved key (__proto__/prototype/constructor)`,
                ),
              ),
            );
          }
          if (seen.has(key)) {
            return ParseResult.fail(
              new ParseResult.Pointer(
                [rawKey],
                val,
                new ParseResult.Type(
                  ast,
                  rawKey,
                  `duplicate ${label} key after trim: ${key}`,
                ),
              ),
            );
          }
          seen.add(key);
          setStringRecordEntry(out, key, normalized);
        }
        return ParseResult.succeed(out);
      },
      encode: (out) => ParseResult.succeed(out as unknown),
    },
  );
}

/**
 * Bounded string→JSON-safe-unknown map for customer/provider metadata writes.
 * Values: null | boolean | finite number | length-capped string | nested
 * plain arrays/objects (depth-capped, safe keys).
 */
export function createSafeJsonMapSchema(
  policy: SafeMapPolicy,
  label: StringMapLabel = "metadata",
): Schema.Schema<Record<string, unknown>, unknown> {
  return Schema.transformOrFail(
    Schema.Unknown,
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    {
      strict: true,
      decode: (val, _opts, ast) => {
        if (val === undefined) {
          return ParseResult.succeed(createUnknownRecord());
        }
        const plain = assertPlainObject(val, ast, label);
        if (!plain.ok) return ParseResult.fail(plain.issue);
        const keysR = ownStringKeys(plain.obj, ast, label);
        if (!keysR.ok) return ParseResult.fail(keysR.issue);
        if (keysR.keys.length > policy.maxEntries) {
          return ParseResult.fail(
            new ParseResult.Type(
              ast,
              val,
              `${label} may have at most ${policy.maxEntries} entries`,
            ),
          );
        }
        const record = plain.obj as Record<string, unknown>;
        const out = createUnknownRecord();
        const seen = new Set<string>();
        for (const rawKey of keysR.keys) {
          const value = record[rawKey];
          const key = rawKey.trim();
          if (!isValidSafeMapKey(key, policy)) {
            return ParseResult.fail(
              new ParseResult.Pointer(
                [rawKey],
                val,
                new ParseResult.Type(
                  ast,
                  rawKey,
                  `${label} key must be 1–${policy.keyMaxLen} chars after trim, no control characters, no leading $, and not a reserved key (__proto__/prototype/constructor)`,
                ),
              ),
            );
          }
          if (seen.has(key)) {
            return ParseResult.fail(
              new ParseResult.Pointer(
                [rawKey],
                val,
                new ParseResult.Type(
                  ast,
                  rawKey,
                  `duplicate ${label} key after trim: ${key}`,
                ),
              ),
            );
          }
          // Normalize string leaves
          let next: unknown = value;
          if (typeof value === "string") {
            next = normalizeMetadataValueNewlines(value);
            if ((next as string).length > policy.valueMaxLen) {
              return ParseResult.fail(
                new ParseResult.Pointer(
                  [rawKey],
                  val,
                  new ParseResult.Type(
                    ast,
                    value,
                    `${label} value must be at most ${policy.valueMaxLen} characters`,
                  ),
                ),
              );
            }
          } else if (!isSafeJsonMapValue(value, policy, 0)) {
            return ParseResult.fail(
              new ParseResult.Pointer(
                [rawKey],
                val,
                new ParseResult.Type(
                  ast,
                  value,
                  `${label} values must be JSON-safe (null/boolean/number/string/array/plain object) within depth and size limits`,
                ),
              ),
            );
          }
          seen.add(key);
          setUnknownRecordEntry(out, key, next);
        }
        return ParseResult.succeed(out);
      },
      encode: (out) => ParseResult.succeed(out as unknown),
    },
  );
}

// ---------------------------------------------------------------------------
// Pre-built domain schemas
// ---------------------------------------------------------------------------

/** Model metadata write path (string→string). */
export const ModelMetadataWrite: Schema.Schema<Record<string, string>, unknown> =
  createSafeStringMapSchema(MODEL_METADATA_POLICY, "metadata");

/** Provider custom headers write path (string→string). */
export const ProviderHeadersWrite: Schema.Schema<
  Record<string, string>,
  unknown
> = createSafeStringMapSchema(PROVIDER_HEADERS_POLICY, "headers");

/** Customer metadata write path (string→JSON-safe). */
export const CustomerMetadataWrite: Schema.Schema<
  Record<string, unknown>,
  unknown
> = createSafeJsonMapSchema(CALLER_METADATA_POLICY, "metadata");

/** Provider metadata write path (string→JSON-safe). */
export const ProviderMetadataWrite: Schema.Schema<
  Record<string, unknown>,
  unknown
> = createSafeJsonMapSchema(CALLER_METADATA_POLICY, "metadata");

/** Empty-default variants for stored docs / optional fields. */
export const ProviderHeadersDefaultEmpty = Schema.optionalWith(
  ProviderHeadersWrite,
  { default: () => createStringRecord() },
);

export const CustomerMetadataDefaultEmpty = Schema.optionalWith(
  CustomerMetadataWrite,
  { default: () => createUnknownRecord() },
);

export const ProviderMetadataDefaultEmpty = Schema.optionalWith(
  ProviderMetadataWrite,
  { default: () => createUnknownRecord() },
);
