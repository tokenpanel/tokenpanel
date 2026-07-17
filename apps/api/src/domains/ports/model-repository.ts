/**
 * Model catalog + alias persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type {
  ModelDoc,
  ModelEntryDoc,
  ModelCatalogDoc,
} from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

/** Fields required to insert a model alias (mirrors route create body + defaults). */
export type NewModelRecord = {
  readonly organizationId: HexId;
  readonly aliasId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly entries: readonly ModelEntryDoc[];
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly structuredOutput?: boolean | undefined;
  readonly temperature?: boolean | undefined;
  readonly attachment: boolean;
  readonly limits: ModelDoc["limits"];
  readonly modalities: ModelDoc["modalities"];
  readonly status: ModelDoc["status"];
  readonly price: ModelDoc["price"];
  readonly marginBps: number;
  readonly currency: string;
  readonly active: boolean;
  readonly metadata: Readonly<Record<string, string>>;
};

export type ModelRepositoryService = {
  readonly list: (
    organizationId: HexId,
  ) => Effect.Effect<readonly ModelDoc[], RepoError>;
  readonly listActive: (
    organizationId: HexId,
  ) => Effect.Effect<readonly ModelDoc[], RepoError>;
  readonly findById: (
    organizationId: HexId,
    modelId: HexId,
  ) => Effect.Effect<ModelDoc | null, RepoError>;
  readonly insert: (
    record: NewModelRecord,
  ) => Effect.Effect<ModelDoc, RepoError>;
  readonly update: (
    organizationId: HexId,
    modelId: HexId,
    patch: Record<string, unknown>,
  ) => Effect.Effect<ModelDoc | null, RepoError>;
  readonly delete: (
    organizationId: HexId,
    modelId: HexId,
  ) => Effect.Effect<boolean, RepoError>;
  readonly setEntries: (
    organizationId: HexId,
    modelId: HexId,
    entries: readonly ModelEntryDoc[],
  ) => Effect.Effect<ModelDoc | null, RepoError>;
  readonly countProviders: (
    organizationId: HexId,
    providerIds: readonly HexId[],
  ) => Effect.Effect<number, RepoError>;
  readonly listCatalog: (
    organizationId: HexId,
    providerId?: HexId,
  ) => Effect.Effect<readonly ModelCatalogDoc[], RepoError>;
};

export class ModelRepository extends Context.Tag("tokenpanel/ModelRepository")<
  ModelRepository,
  ModelRepositoryService
>() {}
