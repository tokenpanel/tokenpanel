/**
 * Map Mongo try/Promise failures into classified tagged errors.
 */
import { Effect } from "effect";
import { classifyMongoError } from "../../../errors/classify-mongo.ts";
import type { RepoError } from "../../../domains/ports/common.ts";

export function tryMongo<A>(
  tryFn: () => Promise<A>,
): Effect.Effect<A, RepoError> {
  return Effect.tryPromise({
    try: tryFn,
    catch: (e) => classifyMongoError(e),
  });
}

export function tryMongoSync<A>(tryFn: () => A): Effect.Effect<A, RepoError> {
  return Effect.try({
    try: tryFn,
    catch: (e) => classifyMongoError(e),
  });
}
