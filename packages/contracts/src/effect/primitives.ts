/**
 * Shared Effect Schema primitives (browser-safe, Requirements = never).
 *
 * Used by contracts product schemas and as the base for API wire schemas.
 * DB package may extend with BSON ObjectId/Date transforms — not here.
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Bounded strings
// ---------------------------------------------------------------------------

/** Non-empty string after no trim (length ≥ 1). */
export const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

/** Non-empty, edge-trimmed string. */
export const NonEmptyTrimmedString = Schema.NonEmptyTrimmedString;

/** Bounded string length [min, max] inclusive. */
export const boundedString = (
  min: number,
  max: number,
): Schema.Schema<string> =>
  Schema.String.pipe(Schema.minLength(min), Schema.maxLength(max));

export const maxString = (max: number): Schema.Schema<string> =>
  Schema.String.pipe(Schema.maxLength(max));

// ---------------------------------------------------------------------------
// Safe integers
// ---------------------------------------------------------------------------

/** Finite integer (no range). */
export const SafeInt = Schema.Number.pipe(Schema.int(), Schema.finite());

/** Non-negative safe integer ≤ Number.MAX_SAFE_INTEGER. */
export const NonNegativeSafeInt = SafeInt.pipe(
  Schema.nonNegative(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

/** Positive safe integer ( > 0 ). */
export const PositiveSafeInt = SafeInt.pipe(
  Schema.positive(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

/** Integer in inclusive [min, max]. */
export const intBetween = (
  min: number,
  max: number,
): Schema.Schema<number> =>
  SafeInt.pipe(Schema.between(min, max));

// ---------------------------------------------------------------------------
// Money / currency
// ---------------------------------------------------------------------------

/**
 * ISO 4217 currency code — 3 uppercase letters.
 * Reject lowercase; uppercase transform is identity on accept.
 */
export const CurrencyCode = Schema.String.pipe(
  Schema.length(3),
  Schema.pattern(/^[A-Z]{3}$/),
);

export type CurrencyCode = Schema.Schema.Type<typeof CurrencyCode>;

/** Non-negative integer minor units (cents, etc.). */
export const MoneyMinor = SafeInt.pipe(Schema.nonNegative());

export type MoneyMinor = Schema.Schema.Type<typeof MoneyMinor>;

export const Money = Schema.Struct({
  amountMinor: MoneyMinor,
  currency: CurrencyCode,
});

export type Money = Schema.Schema.Type<typeof Money>;

// ---------------------------------------------------------------------------
// Token counts
// ---------------------------------------------------------------------------

/** Non-negative token/counter counts bounded to MAX_SAFE_INTEGER. */
export const TokenCount = NonNegativeSafeInt;

export type TokenCount = Schema.Schema.Type<typeof TokenCount>;

// ---------------------------------------------------------------------------
// Identifiers (JSON-safe string forms — no BSON)
// ---------------------------------------------------------------------------

/** Mongo ObjectId hex string (24 hex chars). Encoded form only in contracts. */
export const ObjectIdHex = Schema.String.pipe(
  Schema.pattern(/^[a-fA-F0-9]{24}$/),
);

export type ObjectIdHex = Schema.Schema.Type<typeof ObjectIdHex>;

/** Generic external / opaque id string with length bound. */
export const ExternalId = Schema.String.pipe(Schema.maxLength(128));

/** Username: 3–60 alnum + _.- */
export const Username = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(60),
  Schema.pattern(/^[a-zA-Z0-9_.-]+$/),
);

/** Org/model slug-like: lowercase hyphenated. */
export const Slug = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(60),
  Schema.pattern(/^[a-z0-9-]+$/),
);

/** Model alias id. */
export const ModelAliasId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(80),
  Schema.pattern(/^[a-z0-9_-]+$/),
);

// ---------------------------------------------------------------------------
// Email / password
// ---------------------------------------------------------------------------

/**
 * Email wire string (max 254). Pattern accepts product cases (tests + admin forms).
 */
export const Email = Schema.String.pipe(
  Schema.maxLength(254),
  Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);

export type Email = Schema.Schema.Type<typeof Email>;

/** Lowercased email (decode transforms). */
export const LowercaseEmail = Schema.transform(Email, Schema.String, {
  strict: true,
  decode: (s) => s.toLowerCase(),
  encode: (s) => s,
});

export type LowercaseEmail = Schema.Schema.Type<typeof LowercaseEmail>;

/** Login password length bound (plain text wire, never stored). */
export const Password = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(256),
);

/** Auth credential length for login (min 1). */
export const CredentialString = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
);

// ---------------------------------------------------------------------------
// Dates (JSON-safe encoded forms)
// ---------------------------------------------------------------------------

/** ISO-8601 date-time string (non-empty parseable minimum). */
export const IsoDateTimeString = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter(
    (s): s is string => {
      const t = Date.parse(s);
      return Number.isFinite(t);
    },
    { message: () => "Invalid ISO date-time string" },
  ),
);

export type IsoDateTimeString = Schema.Schema.Type<typeof IsoDateTimeString>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Coerce string|number → int for query params. */
export const CoercedInt = Schema.Union(
  Schema.Number,
  Schema.NumberFromString,
).pipe(Schema.int(), Schema.finite());

export const PaginationLimit = Schema.optionalWith(
  CoercedInt.pipe(Schema.positive(), Schema.lessThanOrEqualTo(500)),
  { default: () => 50 },
);

export const PaginationSkip = Schema.optionalWith(
  CoercedInt.pipe(Schema.nonNegative()),
  { default: () => 0 },
);

export const PaginationQuery = Schema.Struct({
  limit: PaginationLimit,
  skip: PaginationSkip,
});

export type PaginationQuery = Schema.Schema.Type<typeof PaginationQuery>;

// ---------------------------------------------------------------------------
// Safe records / unknown maps
// ---------------------------------------------------------------------------

/** Open string→unknown record. */
export const UnknownRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

export type UnknownRecord = Schema.Schema.Type<typeof UnknownRecord>;

/** String→string record (headers, simple maps). */
export const StringRecord = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});

export type StringRecord = Schema.Schema.Type<typeof StringRecord>;

/** Empty-default unknown record (metadata maps). */
export const UnknownRecordDefaultEmpty = Schema.optionalWith(UnknownRecord, {
  default: () => ({} as Record<string, unknown>),
});

// ---------------------------------------------------------------------------
// URL (string form — not URL object)
// ---------------------------------------------------------------------------

/** HTTP(S) URL kept as string. */
export const UrlString = Schema.String.pipe(
  Schema.maxLength(400),
  Schema.filter(
    (s): s is string => {
      try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: () => "Invalid URL" },
  ),
);

export type UrlString = Schema.Schema.Type<typeof UrlString>;

// ---------------------------------------------------------------------------
// Helpers: optional / nullish with exactOptionalPropertyTypes
// ---------------------------------------------------------------------------

/** Optional property (absent ≠ undefined); exact for TS exactOptionalPropertyTypes. */
export const exactOptional = <S extends Schema.Schema.Any>(
  self: S,
): Schema.optionalWith<S, { exact: true }> =>
  Schema.optionalWith(self, { exact: true });

/** Optional + null (nullish). */
export const exactNullish = <S extends Schema.Schema.Any>(
  self: S,
): Schema.optionalWith<Schema.NullOr<S>, { exact: true }> =>
  Schema.optionalWith(Schema.NullOr(self), { exact: true });
