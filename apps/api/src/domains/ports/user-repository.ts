/**
 * User + membership persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type {
  UserDoc,
  UserRole,
  MembershipDoc,
} from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import type { HexId, RepoError } from "./common.ts";

export type NewUserRecord = {
  /** Optional pre-generated id (coordinated signup / invite). */
  readonly id?: HexId | undefined;
  readonly username: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly memberships: readonly MembershipDoc[];
  readonly activeOrganizationId: HexId;
  readonly status: "active" | "disabled";
};

export type UserRepositoryService = {
  readonly countUsers: () => Effect.Effect<number, RepoError>;
  /**
   * Atomically claim first-run signup (unique lock doc).
   * Returns true if this caller owns the claim; false if already claimed.
   * Release with `releaseBootstrapClaim` if signup fails after claim.
   */
  readonly claimBootstrap: () => Effect.Effect<boolean, RepoError>;
  /** Drop first-run claim so a failed signup can be retried. */
  readonly releaseBootstrapClaim: () => Effect.Effect<void, RepoError>;
  readonly findById: (id: HexId) => Effect.Effect<UserDoc | null, RepoError>;
  readonly findByUsername: (
    username: string,
  ) => Effect.Effect<UserDoc | null, RepoError>;
  readonly findByEmail: (
    email: string,
  ) => Effect.Effect<UserDoc | null, RepoError>;
  readonly findByUsernameOrEmail: (
    username: string,
    email: string,
  ) => Effect.Effect<UserDoc | null, RepoError>;
  readonly emailTaken: (
    email: string,
    excludeUserId?: HexId,
  ) => Effect.Effect<boolean, RepoError>;
  readonly insertUser: (
    record: NewUserRecord,
  ) => Effect.Effect<UserDoc, RepoError>;
  readonly updateEmail: (
    userId: HexId,
    email: string,
  ) => Effect.Effect<UserDoc | null, RepoError>;
  readonly updatePasswordHash: (
    userId: HexId,
    passwordHash: string,
  ) => Effect.Effect<void, RepoError>;
  readonly setActiveOrganization: (
    userId: HexId,
    organizationId: HexId,
  ) => Effect.Effect<void, RepoError>;
  readonly addMembership: (
    userId: HexId,
    organizationId: HexId,
    role: UserRole,
    setActive: boolean,
    permissions?: readonly PanelPermission[],
  ) => Effect.Effect<UserDoc | null, RepoError>;
  /**
   * Update an EXISTING membership's role + permissions (REPLACE semantics)
   * for the given org. Returns the updated user doc, or null if no user/match.
   */
  readonly updateMembership: (
    userId: HexId,
    organizationId: HexId,
    role: UserRole,
    permissions: readonly PanelPermission[],
  ) => Effect.Effect<UserDoc | null, RepoError>;
  readonly findMembersOfOrg: (
    organizationId: HexId,
  ) => Effect.Effect<readonly UserDoc[], RepoError>;
  readonly pullMembershipAndRepoint: (
    userId: HexId,
    organizationId: HexId,
    nextActiveOrganizationId: HexId,
  ) => Effect.Effect<void, RepoError>;
};

export class UserRepository extends Context.Tag("tokenpanel/UserRepository")<
  UserRepository,
  UserRepositoryService
>() {}
