/**
 * Schema-decode helpers for domain-port repository adapters (task 13.1).
 * Every document leaving/entering Mongo crosses declared Effect Schema.
 */
import { Effect, type Schema } from "effect";
import {
  decodeDocuments,
  decodeOptionalDocument,
  decodeWriteInput,
} from "../decode.ts";
import type { PersistenceDataError } from "../../../errors/index.ts";
import type { RepoError } from "../../../domains/ports/common.ts";

export type DecodeError = RepoError | PersistenceDataError;

/** Decode a findOne result (null stays null). */
export function readOne<A, I>(
  schema: Schema.Schema<A, I, never>,
  collection: string,
  raw: unknown | null,
): Effect.Effect<A | null, PersistenceDataError> {
  return decodeOptionalDocument(schema, raw, collection);
}

/** Decode a find/list result array. */
export function readMany<A, I>(
  schema: Schema.Schema<A, I, never>,
  collection: string,
  raws: readonly unknown[],
): Effect.Effect<readonly A[], PersistenceDataError> {
  return decodeDocuments(schema, raws, collection);
}

/** Validate insert/replace payload before Mongo write. */
export function writeOne<A, I>(
  schema: Schema.Schema<A, I, never>,
  collection: string,
  value: unknown,
): Effect.Effect<A, PersistenceDataError> {
  return decodeWriteInput(schema, value, collection);
}

/** Decode after a mutating findOneAndUpdate-style read-back. */
export function readAfterWrite<A, I>(
  schema: Schema.Schema<A, I, never>,
  collection: string,
  raw: unknown | null,
): Effect.Effect<A | null, PersistenceDataError> {
  return decodeOptionalDocument(schema, raw, collection);
}

/** Pipe a tryMongo promise through optional-document decode. */
export function mongoReadOne<A, I>(
  schema: Schema.Schema<A, I, never>,
  collection: string,
  tryFn: () => Promise<unknown | null>,
  tryMongo: <T>(fn: () => Promise<T>) => Effect.Effect<T, RepoError>,
): Effect.Effect<A | null, DecodeError> {
  return Effect.gen(function* () {
    const raw = yield* tryMongo(tryFn);
    return yield* readOne(schema, collection, raw);
  });
}

/** Pipe a tryMongo array promise through document decode. */
export function mongoReadMany<A, I>(
  schema: Schema.Schema<A, I, never>,
  collection: string,
  tryFn: () => Promise<unknown[]>,
  tryMongo: <T>(fn: () => Promise<T>) => Effect.Effect<T, RepoError>,
): Effect.Effect<readonly A[], DecodeError> {
  return Effect.gen(function* () {
    const raws = yield* tryMongo(tryFn);
    return yield* readMany(schema, collection, raws);
  });
}
