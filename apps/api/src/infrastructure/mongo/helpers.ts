/**
 * Shared typed Mongo query helpers (task 7.5).
 * No raw collection strings — callers use TypedDb + collections registry.
 */
import { ObjectId, type Filter, type Sort } from "mongodb";
import { Effect, Either, Schema } from "effect";
import {
  PAGINATION_DEFAULT_LIMIT_COUNT,
  PAGINATION_MAX_LIMIT_COUNT,
} from "../../domains/pagination/policy.ts";
import {
  NotFoundError,
  PersistenceDataError,
  SAFE_MESSAGES,
  ValidationError,
} from "../../errors/index.ts";
import { ObjectIdFromString } from "@tokenpanel/db/schemas/effect";
import { persistenceDataError } from "./decode.ts";

// ---------------------------------------------------------------------------
// ObjectId
// ---------------------------------------------------------------------------

/** Parse hex string → ObjectId; ValidationError on bad id (request path). */
export function parseObjectId(
  id: string,
): Effect.Effect<ObjectId, ValidationError> {
  const result = Schema.decodeUnknownEither(ObjectIdFromString)(id);
  if (Either.isRight(result)) {
    return Effect.succeed(result.right);
  }
  return Effect.fail(
    new ValidationError({
      code: "validation_error",
      message: SAFE_MESSAGES.validation_error,
      mode: "field_422",
      details: { id: ["Invalid ObjectId"] },
    }),
  );
}

/**
 * Parse ObjectId for repository filters from trusted internal strings.
 * Bad id → PersistenceDataError (corrupt stored ref), not ValidationError.
 */
export function parseObjectIdStrict(
  id: string,
  collection: string,
): Effect.Effect<ObjectId, PersistenceDataError> {
  if (!ObjectId.isValid(id)) {
    return Effect.fail(
      persistenceDataError(collection, `Invalid ObjectId: ${id}`),
    );
  }
  return Effect.succeed(new ObjectId(id));
}

export function requireFound<A>(
  value: A | null,
  resource: string,
  id?: string,
): Effect.Effect<A, NotFoundError> {
  if (value === null) {
    return Effect.fail(
      new NotFoundError({
        code: "not_found",
        message: SAFE_MESSAGES.not_found,
        resource,
        ...(id !== undefined ? { id } : {}),
      }),
    );
  }
  return Effect.succeed(value);
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export type PageParams = {
  readonly limit?: number | undefined;
  readonly skip?: number | undefined;
};

export type NormalizedPage = {
  readonly limit: number;
  readonly skip: number;
};

export function normalizePage(params: PageParams = {}): NormalizedPage {
  const rawLimit =
    params.limit === undefined ? PAGINATION_DEFAULT_LIMIT_COUNT : params.limit;
  const rawSkip = params.skip === undefined ? 0 : params.skip;
  const limit = Math.min(
    PAGINATION_MAX_LIMIT_COUNT,
    Math.max(1, Math.trunc(rawLimit)),
  );
  const skip = Math.max(0, Math.trunc(rawSkip));
  return { limit, skip };
}

export type PageResult<T> = {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly skip: number;
};

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export type SortDirection = 1 | -1;

/** Whitelist-based sort; unknown fields dropped. */
export function buildSort(
  allowed: ReadonlySet<string> | readonly string[],
  requested?: Readonly<Record<string, SortDirection>> | undefined,
  fallback: Sort = { createdAt: 1 },
): Sort {
  const allow =
    allowed instanceof Set ? allowed : new Set(allowed);
  if (!requested) return fallback;
  const out: Record<string, SortDirection> = {};
  for (const [key, dir] of Object.entries(requested)) {
    if (!allow.has(key)) continue;
    if (dir === 1 || dir === -1) out[key] = dir;
  }
  return Object.keys(out).length > 0 ? out : fallback;
}

// ---------------------------------------------------------------------------
// Safe filter construction
// ---------------------------------------------------------------------------

const FORBIDDEN_FILTER_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "$where",
  "$function",
  "$accumulator",
]);

/**
 * Build an equality filter from plain fields only.
 * Rejects operator injection ($gt etc.) and prototype keys.
 */
export function safeEqualityFilter<T extends Record<string, unknown>>(
  fields: T,
): Filter<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_FILTER_KEYS.has(key)) continue;
    if (key.startsWith("$")) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out as Filter<Record<string, unknown>>;
}

/** Escape a string for safe inclusion in a RegExp source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive substring match on a single field (whitelist call sites). */
export function textSearchFilter(
  field: string,
  query: string,
): Filter<Record<string, unknown>> {
  if (FORBIDDEN_FILTER_KEYS.has(field) || field.startsWith("$")) {
    return {};
  }
  return {
    [field]: { $regex: escapeRegExp(query), $options: "i" },
  } as Filter<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export type ProjectionSpec = Readonly<Record<string, 0 | 1>>;

/** Inclusion/exclusion projection; strips forbidden keys. */
export function buildProjection(
  fields: ReadonlyArray<string> | ProjectionSpec,
  mode: "include" | "exclude" = "include",
): ProjectionSpec {
  if (Array.isArray(fields)) {
    const out: Record<string, 0 | 1> = {};
    for (const f of fields) {
      if (FORBIDDEN_FILTER_KEYS.has(f) || f.startsWith("$")) continue;
      out[f] = mode === "include" ? 1 : 0;
    }
    return out;
  }
  const out: Record<string, 0 | 1> = {};
  for (const [k, v] of Object.entries(fields as ProjectionSpec)) {
    if (FORBIDDEN_FILTER_KEYS.has(k) || k.startsWith("$")) continue;
    if (v === 0 || v === 1) out[k] = v;
  }
  return out;
}
