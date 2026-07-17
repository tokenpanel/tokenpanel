/**
 * Customer + management API key persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type {
  ApiKeyDoc,
  ManagementApiKeyDoc,
  ManagementScope,
} from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

export type NewCustomerKeyRecord = {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly name: string;
  readonly prefix: string;
  readonly keyHash: string;
  readonly modelWhitelist: readonly string[];
  readonly status: "active";
};

export type NewManagementKeyRecord = {
  readonly organizationId: HexId;
  readonly name: string;
  readonly prefix: string;
  readonly keyHash: string;
  readonly scopes: readonly ManagementScope[];
  readonly status: "active";
};

export type KeyRepositoryService = {
  readonly listCustomerKeys: (
    organizationId: HexId,
    customerId?: HexId,
  ) => Effect.Effect<readonly ApiKeyDoc[], RepoError>;
  readonly findCustomerKey: (
    organizationId: HexId,
    keyId: HexId,
  ) => Effect.Effect<ApiKeyDoc | null, RepoError>;
  /** Lookup by key prefix (public auth). Prefix is unique. */
  readonly findCustomerKeyByPrefix: (
    prefix: string,
  ) => Effect.Effect<ApiKeyDoc | null, RepoError>;
  readonly insertCustomerKey: (
    record: NewCustomerKeyRecord,
  ) => Effect.Effect<ApiKeyDoc, RepoError>;
  readonly updateCustomerKey: (
    organizationId: HexId,
    keyId: HexId,
    patch: Record<string, unknown>,
  ) => Effect.Effect<ApiKeyDoc | null, RepoError>;
  readonly revokeCustomerKey: (
    organizationId: HexId,
    keyId: HexId,
  ) => Effect.Effect<ApiKeyDoc | null, RepoError>;
  /** Best-effort lastUsedAt touch (fire-and-forget from middleware). */
  readonly touchCustomerKeyLastUsed: (
    prefix: string,
  ) => Effect.Effect<void, RepoError>;
  readonly listManagementKeys: (
    organizationId: HexId,
    status?: "active" | "revoked",
  ) => Effect.Effect<readonly ManagementApiKeyDoc[], RepoError>;
  readonly findManagementKey: (
    organizationId: HexId,
    keyId: HexId,
  ) => Effect.Effect<ManagementApiKeyDoc | null, RepoError>;
  readonly findManagementKeyByPrefix: (
    prefix: string,
  ) => Effect.Effect<ManagementApiKeyDoc | null, RepoError>;
  readonly insertManagementKey: (
    record: NewManagementKeyRecord,
  ) => Effect.Effect<ManagementApiKeyDoc, RepoError>;
  readonly updateManagementKey: (
    organizationId: HexId,
    keyId: HexId,
    patch: Record<string, unknown>,
  ) => Effect.Effect<ManagementApiKeyDoc | null, RepoError>;
  readonly revokeManagementKey: (
    organizationId: HexId,
    keyId: HexId,
  ) => Effect.Effect<ManagementApiKeyDoc | null, RepoError>;
  readonly touchManagementKeyLastUsed: (
    prefix: string,
  ) => Effect.Effect<void, RepoError>;
  /** Cascade cleanup when an organization is deleted. */
  readonly deleteManagementKeysByOrg: (
    organizationId: HexId,
  ) => Effect.Effect<void, RepoError>;
};

export class KeyRepository extends Context.Tag("tokenpanel/KeyRepository")<
  KeyRepository,
  KeyRepositoryService
>() {}
