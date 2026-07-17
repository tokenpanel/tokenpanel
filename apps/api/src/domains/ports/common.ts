/**
 * Shared port contracts for domain repository interfaces.
 * Live Layers decode every document via Effect Schema (task 13.1).
 */

import type { Effect } from "effect";
import type { PersistenceAppError, SystemError } from "../../errors/families.ts";

/** Hex ObjectId string (24 hex chars). Domain ops prefer this over raw ObjectId. */
export type HexId = string;

/** Persistence failure channel for repository ports. */
export type RepoError = PersistenceAppError | SystemError;

/** Effect that only fails with classified persistence/system errors. */
export type RepoEffect<A> = Effect.Effect<A, RepoError>;

/** Shared list pagination (bounds enforced by domain/pagination policy). */
export type PageQuery = {
  readonly limit: number;
  readonly skip: number;
};

export type PageResult<T> = {
  readonly items: readonly T[];
  readonly total: number;
};

/** Inclusive date range for analytics / usage reads. */
export type DateRange = {
  readonly from: Date;
  readonly to: Date;
};
