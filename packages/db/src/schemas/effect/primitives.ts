/**
 * DB Effect Schema primitives — BSON ObjectId/Date + shared money/token leaves.
 * Contracts stay JSON-safe; BSON lives here.
 */
import { ObjectId } from "mongodb";
import { ParseResult, Schema } from "effect";
import {
  CurrencyCode,
  MoneyUnits,
  Money,
  TokenCount,
  SafeInt,
  NonNegativeSafeInt,
  PositiveSafeInt,
  exactOptional,
  exactNullish,
  UnknownRecord,
  UnknownRecordDefaultEmpty,
  StringRecord,
  Email,
  LowercaseEmail,
  Username,
  Slug,
  ModelAliasId,
  UrlString,
  NonEmptyString,
  maxString,
  boundedString,
} from "@tokenpanel/contracts/effect";
import {
  ModelModalitySchema,
  ModelModalitiesSchema,
  ModelStatusSchema,
} from "@tokenpanel/contracts/effect";

export {
  CurrencyCode,
  MoneyUnits,
  Money,
  TokenCount,
  SafeInt,
  NonNegativeSafeInt,
  PositiveSafeInt,
  exactOptional,
  exactNullish,
  UnknownRecord,
  UnknownRecordDefaultEmpty,
  StringRecord,
  Email,
  LowercaseEmail,
  Username,
  Slug,
  ModelAliasId,
  UrlString,
  NonEmptyString,
  maxString,
  boundedString,
};

/** Product enums (Effect Schema) — aliases match re-export names in common. */
export const ModelModality = ModelModalitySchema;
export const ModelModalities = ModelModalitiesSchema;
export const ModelStatus = ModelStatusSchema;

// ---------------------------------------------------------------------------
// ObjectId
// ---------------------------------------------------------------------------

/** Stored BSON ObjectId instance. */
export const ObjectIdFromSelf = Schema.instanceOf(ObjectId);

export type ObjectIdFromSelf = Schema.Schema.Type<typeof ObjectIdFromSelf>;

/** Wire/create input: 24-hex string → ObjectId. */
export const ObjectIdFromString = Schema.transformOrFail(
  Schema.String.pipe(Schema.pattern(/^[0-9a-fA-F]{24}$/)),
  ObjectIdFromSelf,
  {
    strict: true,
    decode: (value, _opts, ast) => {
      if (!ObjectId.isValid(value)) {
        return ParseResult.fail(
          new ParseResult.Type(ast, value, `Invalid ObjectId: ${value}`),
        );
      }
      return ParseResult.succeed(new ObjectId(value));
    },
    encode: (id) => ParseResult.succeed(id.toHexString()),
  },
);

export type ObjectIdFromString = Schema.Schema.Type<typeof ObjectIdFromString>;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Stored Date instance (valid finite). */
export const DateFromSelf = Schema.ValidDateFromSelf;

/** Coerce string | number | Date → Date (input boundaries). */
export const DateFromUnknown = Schema.Union(
  Schema.ValidDateFromSelf,
  Schema.DateFromString,
  Schema.transformOrFail(Schema.Number, Schema.ValidDateFromSelf, {
    strict: true,
    decode: (n, _opts, ast) => {
      const d = new Date(n);
      if (!Number.isFinite(d.getTime())) {
        return ParseResult.fail(
          new ParseResult.Type(ast, n, "Invalid date number"),
        );
      }
      return ParseResult.succeed(d);
    },
    encode: (d) => ParseResult.succeed(d.getTime()),
  }),
);

export const TimestampFields = {
  createdAt: DateFromSelf,
  updatedAt: DateFromSelf,
} as const;

// ---------------------------------------------------------------------------
// Customer balance / pricing shared blocks
// ---------------------------------------------------------------------------

export const CustomerBalance = Schema.Struct({
  amountUnits: MoneyUnits,
  reservedUnits: Schema.optionalWith(MoneyUnits, { default: () => 0 }),
  currency: CurrencyCode,
});

export type CustomerBalance = Schema.Schema.Type<typeof CustomerBalance>;

export const TokenPriceSchedule = Schema.Struct({
  inputUnitsPerMillion: MoneyUnits,
  outputUnitsPerMillion: MoneyUnits,
  reasoningUnitsPerMillion: exactOptional(MoneyUnits),
  cacheReadUnitsPerMillion: exactOptional(MoneyUnits),
  cacheWriteUnitsPerMillion: exactOptional(MoneyUnits),
  inputAudioUnitsPerMillion: exactOptional(MoneyUnits),
  outputAudioUnitsPerMillion: exactOptional(MoneyUnits),
});

export type TokenPriceSchedule = Schema.Schema.Type<typeof TokenPriceSchedule>;

export const TokenLimits = Schema.Struct({
  context: exactOptional(PositiveSafeInt),
  input: exactOptional(PositiveSafeInt),
  output: exactOptional(PositiveSafeInt),
});

export type TokenLimits = Schema.Schema.Type<typeof TokenLimits>;

export const Interleaved = Schema.Struct({
  field: Schema.Literal("reasoning_content", "reasoning_details"),
});

export type Interleaved = Schema.Schema.Type<typeof Interleaved>;

export const ModelCapabilities = Schema.Struct({
  reasoning: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  toolCall: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  structuredOutput: exactOptional(Schema.Boolean),
  temperature: exactOptional(Schema.Boolean),
  attachment: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  interleaved: exactNullish(Interleaved),
});

export type ModelCapabilities = Schema.Schema.Type<typeof ModelCapabilities>;

/** HTTP status code 100–599. */
export const HttpStatusCode = SafeInt.pipe(Schema.between(100, 599));
