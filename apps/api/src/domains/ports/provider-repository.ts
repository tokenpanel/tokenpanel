/**
 * Provider persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type { ProviderDoc } from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

export type NewProviderRecord = {
  readonly organizationId: HexId;
  readonly name: string;
  readonly sdkType: string;
  readonly apiKeyEncrypted: string;
  readonly baseUrl: string;
  readonly providerOrg: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly active: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type ProviderRepositoryService = {
  readonly list: (
    organizationId: HexId,
  ) => Effect.Effect<readonly ProviderDoc[], RepoError>;
  readonly findById: (
    organizationId: HexId,
    providerId: HexId,
  ) => Effect.Effect<ProviderDoc | null, RepoError>;
  readonly insert: (
    record: NewProviderRecord,
  ) => Effect.Effect<ProviderDoc, RepoError>;
  readonly update: (
    organizationId: HexId,
    providerId: HexId,
    patch: Record<string, unknown>,
  ) => Effect.Effect<ProviderDoc | null, RepoError>;
  readonly countModelRefs: (
    organizationId: HexId,
    providerId: HexId,
  ) => Effect.Effect<number, RepoError>;
  readonly deleteWithCatalog: (
    organizationId: HexId,
    providerId: HexId,
  ) => Effect.Effect<boolean, RepoError>;
};

export class ProviderRepository extends Context.Tag(
  "tokenpanel/ProviderRepository",
)<ProviderRepository, ProviderRepositoryService>() {}
