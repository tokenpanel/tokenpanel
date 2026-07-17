/**
 * Organization persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type { OrganizationDoc } from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

export type NewOrganizationRecord = {
  /** Optional pre-generated id (coordinated signup). */
  readonly id?: HexId | undefined;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: HexId;
  readonly defaultCurrency: string;
};

export type OrganizationCounts = {
  readonly providers: number;
  readonly customers: number;
  readonly models: number;
  readonly plans: number;
  readonly apiKeys: number;
};

export type OrganizationRepositoryService = {
  readonly findById: (
    id: HexId,
  ) => Effect.Effect<OrganizationDoc | null, RepoError>;
  readonly findByIds: (
    ids: readonly HexId[],
  ) => Effect.Effect<readonly OrganizationDoc[], RepoError>;
  readonly findBySlug: (
    slug: string,
  ) => Effect.Effect<OrganizationDoc | null, RepoError>;
  readonly slugTaken: (
    slug: string,
    excludeId?: HexId,
  ) => Effect.Effect<boolean, RepoError>;
  readonly insert: (
    record: NewOrganizationRecord,
  ) => Effect.Effect<OrganizationDoc, RepoError>;
  readonly update: (
    id: HexId,
    patch: {
      readonly name?: string | undefined;
      readonly slug?: string | undefined;
      readonly defaultCurrency?: string | undefined;
    },
  ) => Effect.Effect<OrganizationDoc | null, RepoError>;
  readonly delete: (id: HexId) => Effect.Effect<void, RepoError>;
  readonly countBusinessData: (
    organizationId: HexId,
  ) => Effect.Effect<OrganizationCounts, RepoError>;
};

export class OrganizationRepository extends Context.Tag(
  "tokenpanel/OrganizationRepository",
)<OrganizationRepository, OrganizationRepositoryService>() {}
