/**
 * Wrap Mongo driver promises → Effect with classifyMongoError.
 */
import { Effect } from "effect";
import type { ClientSession, Document, Filter, UpdateFilter } from "mongodb";
import {
  classifyMongoError,
  type PersistenceAppError,
  type SystemError,
} from "../../errors/index.ts";

export type MongoFailure = PersistenceAppError | SystemError;

export function tryMongo<A>(
  tryFn: () => Promise<A>,
): Effect.Effect<A, MongoFailure> {
  return Effect.tryPromise({
    try: tryFn,
    catch: (err) => classifyMongoError(err),
  });
}

export type SessionOption = {
  readonly session?: ClientSession | undefined;
};

/**
 * Bridge Effect Schema (readonly) decoded values → Mongo Collection write types.
 * Runtime shape is identical; mutability variance is type-only during dual-path.
 */
export function toMongoDoc<T extends Document>(doc: unknown): T {
  return doc as T;
}

export function toMongoFilter<T extends Document>(
  filter: unknown,
): Filter<T> {
  return filter as Filter<T>;
}

export function toMongoUpdate<T extends Document>(
  update: unknown,
): UpdateFilter<T> {
  return update as UpdateFilter<T>;
}
