/**
 * Admin session allowlist persistence port.
 * JWT `sid` maps to `_id`; absence or expiry ⇒ unauthorized.
 * Tenant context is stored on the session row (`organizationId`).
 */
import { Context, type Effect } from "effect";
import type { AdminSessionDoc } from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

export type NewAdminSessionRecord = {
  /** Optional pre-generated session id (must be valid ObjectId hex). */
  readonly id?: HexId | undefined;
  readonly userId: HexId;
  /** Active organization for this session only. */
  readonly organizationId: HexId;
  readonly expiresAt: Date;
};

export type SessionRepositoryService = {
  readonly insert: (
    record: NewAdminSessionRecord,
  ) => Effect.Effect<AdminSessionDoc, RepoError>;
  readonly findById: (
    sessionId: HexId,
  ) => Effect.Effect<AdminSessionDoc | null, RepoError>;
  /**
   * Refresh expiry and optionally rebind organization (org switch / re-issue).
   * Returns null if session missing or not owned by userId.
   */
  readonly touchExpiry: (
    sessionId: HexId,
    userId: HexId,
    expiresAt: Date,
    organizationId?: HexId,
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
  /**
   * Delete every session for a user EXCEPT the one identified by
   * `keepSessionId`. Used when a security-sensitive action (e.g. email
   * change) should revoke other devices without logging out the requester.
   * Returns the number of sessions deleted.
   */
  readonly deleteAllForUserExcept: (
    userId: HexId,
    keepSessionId: HexId,
  ) => Effect.Effect<number, RepoError>;
};

export class SessionRepository extends Context.Tag(
  "tokenpanel/SessionRepository",
)<SessionRepository, SessionRepositoryService>() {}
