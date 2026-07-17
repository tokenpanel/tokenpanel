/**
 * Invite persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type { InviteDoc, UserRole } from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

export type NewInviteRecord = {
  readonly organizationId: HexId;
  readonly invitedBy: HexId;
  readonly email: string;
  readonly role: UserRole;
  readonly tokenHash: string;
  readonly expiresAt: Date;
};

export type InviteRepositoryService = {
  readonly listByOrg: (
    organizationId: HexId,
  ) => Effect.Effect<readonly InviteDoc[], RepoError>;
  readonly insert: (
    record: NewInviteRecord,
  ) => Effect.Effect<InviteDoc, RepoError>;
  readonly findPendingByTokenHash: (
    tokenHash: string,
  ) => Effect.Effect<InviteDoc | null, RepoError>;
  readonly revokePending: (
    inviteId: HexId,
    organizationId: HexId,
  ) => Effect.Effect<boolean, RepoError>;
  readonly markAccepted: (inviteId: HexId) => Effect.Effect<void, RepoError>;
  readonly deleteByOrg: (organizationId: HexId) => Effect.Effect<void, RepoError>;
};

export class InviteRepository extends Context.Tag("tokenpanel/InviteRepository")<
  InviteRepository,
  InviteRepositoryService
>() {}
