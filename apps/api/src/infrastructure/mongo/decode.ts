/**
 * Effect Schema decode at Mongo repository boundaries (tasks 7.3–7.4).
 * Corrupt/legacy docs → PersistenceDataError; never trusted casts.
 */
import { Effect, Either, ParseResult, Schema } from "effect";
import {
  PersistenceDataError,
  SAFE_MESSAGES,
} from "../../errors/index.ts";

function formatParseIssue(err: ParseResult.ParseError): string {
  try {
    const issues = ParseResult.ArrayFormatter.formatErrorSync(err);
    return issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
      .slice(0, 500);
  } catch {
    return "schema decode failed";
  }
}

export function persistenceDataError(
  collection: string,
  diagnostic?: string,
): PersistenceDataError {
  return new PersistenceDataError({
    code: "persistence_data",
    message: SAFE_MESSAGES.persistence_data,
    collection,
    retryClass: "never",
    ...(diagnostic !== undefined ? { diagnostic: diagnostic.slice(0, 500) } : {}),
  });
}

/**
 * Decode a document / aggregation row leaving MongoDB.
 */
export function decodeDocument<A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
  collection: string,
): Effect.Effect<A, PersistenceDataError> {
  return Effect.suspend(() => {
    const result = Schema.decodeUnknownEither(schema)(value);
    if (Either.isRight(result)) {
      return Effect.succeed(result.right);
    }
    return Effect.fail(
      persistenceDataError(collection, formatParseIssue(result.left)),
    );
  });
}

/**
 * Decode an insert/update payload before Mongo mutation.
 * Same PersistenceDataError family (write-side corrupt/invalid input).
 */
export function decodeWriteInput<A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
  collection: string,
): Effect.Effect<A, PersistenceDataError> {
  return decodeDocument(schema, value, collection);
}

/** Decode many rows; fail-fast on first corrupt document. */
export function decodeDocuments<A, I>(
  schema: Schema.Schema<A, I, never>,
  values: readonly unknown[],
  collection: string,
): Effect.Effect<readonly A[], PersistenceDataError> {
  return Effect.gen(function* () {
    const out: A[] = [];
    for (const value of values) {
      out.push(yield* decodeDocument(schema, value, collection));
    }
    return out;
  });
}

/** Nullable findOne result: null stays null; present value is decoded. */
export function decodeOptionalDocument<A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown | null,
  collection: string,
): Effect.Effect<A | null, PersistenceDataError> {
  if (value === null || value === undefined) {
    return Effect.succeed(null);
  }
  return decodeDocument(schema, value, collection);
}
