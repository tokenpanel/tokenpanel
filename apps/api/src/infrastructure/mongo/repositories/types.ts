/**
 * Shared repository port types (task 7.2).
 */
import type { ClientSession, ObjectId } from "mongodb";
import type { Effect } from "effect";
import type {
  NotFoundError,
  PersistenceDataError,
  ValidationError,
} from "../../../errors/index.ts";
import type { MongoFailure } from "../try-mongo.ts";
import type { NormalizedPage, PageResult } from "../helpers.ts";

export type RepoError = MongoFailure | PersistenceDataError;
export type RepoNotFoundError = RepoError | NotFoundError;
export type RepoIdError = RepoError | ValidationError | NotFoundError;

export type SessionOpts = {
  readonly session?: ClientSession | undefined;
};

export type OrgScopedId = {
  readonly organizationId: ObjectId;
  readonly id: ObjectId;
};

export type ListByOrgParams = {
  readonly organizationId: ObjectId;
  readonly page?: NormalizedPage | undefined;
  readonly session?: ClientSession | undefined;
};

export type { PageResult, NormalizedPage };

/** Standard Effect return for optional document. */
export type FindEffect<T> = Effect.Effect<T | null, RepoError>;
export type GetEffect<T> = Effect.Effect<T, RepoNotFoundError>;
export type WriteEffect<T> = Effect.Effect<T, RepoError>;
export type PageEffect<T> = Effect.Effect<PageResult<T>, RepoError>;
