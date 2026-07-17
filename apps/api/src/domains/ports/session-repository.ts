/**
 * Admin session allowlist persistence port.
 * JWT `sid` maps to `_id`; absence or expiry ⇒ unauthorized.
 */
import { Context, type Effect } from "effect";
import type { AdminSessionDoc } from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

export type NewAdminSessionRecord = {
  /** Optional pre-generated session id (must be valid ObjectId hex). */
  readonly id?: HexId | undefined;
  readonly userId: HexId;
  readonly expiresAt: Date;
};

export type SessionRepositoryService = {
  readonly insert: (
    record: NewAdminSessionRecord,
  ) => Effect.Effect<AdminSessionDoc, RepoError>;
  readonly findById: (
    sessionId: HexId,
  ) => Effect.Effect<AdminSessionDoc | null, RepoError>;
  /** Refresh expiry (e.g. org switch re-issue). Returns null if missing. */
  readonly touchExpiry: (
    sessionId: HexId,
    userId: HexId,
    expiresAt: Date,
  ) => Effect.Effect<AdminSessionDoc | null, RepoError>;
  readonly deleteById: (
    sessionId: HexId,
  ) => Effect.Effect<boolean, RepoError>;
  /** True only when session existed and belonged to userId. */
  readonly deleteByIdForUser: (
    sessionId: HexId,
    userId: HexId,
  ) => Effect.Effect<boolean, RepoError>;
  readonly deleteAllForUser: (
    userId: HexId,
  ) => Effect.Effect<number, RepoError>;
};

export class SessionRepository extends Context.Tag(
  "tokenpanel/SessionRepository",
)<SessionRepository, SessionRepositoryService>() {}
