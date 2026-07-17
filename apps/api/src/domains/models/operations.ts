/**
 * Model alias / entry / catalog operations (task 8.4).
 */
import { Effect } from "effect";
import type { ModelDoc, ModelEntryDoc, ModelCatalogDoc } from "@tokenpanel/db";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../errors/families.ts";
import type { HexId, RepoError } from "../ports/common.ts";
import { ModelRepository } from "../ports/model-repository.ts";
import { Crypto } from "../../runtime/services/crypto.ts";

export type ModelDomainError =
  | ConflictError
  | NotFoundError
  | ValidationError
  | RepoError;

export type ModelEntryInput = {
  readonly id?: string | undefined;
  readonly providerId: HexId | { toHexString: () => string };
  readonly upstreamModelId: string;
  readonly cost: ModelEntryDoc["cost"];
  readonly price: ModelEntryDoc["price"];
  readonly priority?: number | undefined;
  readonly active?: boolean | undefined;
};

function providerIdHex(
  id: HexId | { toHexString: () => string },
): string {
  return typeof id === "string" ? id : id.toHexString();
}

export function genEntryIdFromToken(hex: string): string {
  return hex.slice(0, 12);
}

export function normalizeEntries(
  entries: readonly ModelEntryInput[],
  genId: (index: number) => string,
): ModelEntryDoc[] {
  return entries
    .map((e, i) => {
      const entry: ModelEntryDoc = {
        id: e.id ?? genId(i),
        providerId: e.providerId as ModelEntryDoc["providerId"],
        upstreamModelId: e.upstreamModelId,
        priority: e.priority ?? i,
        active: e.active ?? true,
      };
      if (e.cost !== undefined) entry.cost = e.cost;
      if (e.price !== undefined) entry.price = e.price;
      return entry;
    })
    .sort((a, b) => a.priority - b.priority);
}

export const listModels = (
  organizationId: HexId,
): Effect.Effect<readonly ModelDoc[], RepoError, ModelRepository> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    return yield* models.list(organizationId);
  });

export const listActiveModels = (
  organizationId: HexId,
): Effect.Effect<readonly ModelDoc[], RepoError, ModelRepository> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    return yield* models.listActive(organizationId);
  });

export const getModel = (input: {
  readonly organizationId: HexId;
  readonly modelId: HexId;
}): Effect.Effect<ModelDoc, ModelDomainError, ModelRepository> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    const doc = yield* models.findById(input.organizationId, input.modelId);
    if (!doc) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    return doc;
  });

async function assertProvidersExist(
  models: {
    countProviders: (
      organizationId: HexId,
      providerIds: readonly HexId[],
    ) => Effect.Effect<number, RepoError>;
  },
  organizationId: HexId,
  providerIds: readonly HexId[],
): Promise<void> {
  void models;
  void organizationId;
  void providerIds;
}

export const createModel = (input: {
  readonly organizationId: HexId;
  readonly aliasId: string;
  readonly displayName: string;
  readonly description?: string | null | undefined;
  readonly entries: readonly ModelEntryInput[];
  readonly reasoning?: boolean | undefined;
  readonly toolCall?: boolean | undefined;
  readonly structuredOutput?: boolean | undefined;
  readonly temperature?: boolean | undefined;
  readonly attachment?: boolean | undefined;
  readonly limits: ModelDoc["limits"];
  readonly modalities: ModelDoc["modalities"];
  readonly status: ModelDoc["status"];
  readonly price: ModelDoc["price"];
  readonly marginBps?: number | undefined;
  readonly currency: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}): Effect.Effect<
  ModelDoc,
  ModelDomainError,
  ModelRepository | Crypto
> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    const crypto = yield* Crypto;
    const providerIds = input.entries.map((e) => providerIdHex(e.providerId));
    const found = yield* models.countProviders(
      input.organizationId,
      providerIds,
    );
    if (found !== providerIds.length) {
      return yield* Effect.fail(
        new ValidationError({
          code: "validation_error",
          message: "provider_not_found",
          mode: "default_400",
        }),
      );
    }

    const entries: ModelEntryDoc[] = [];
    for (let i = 0; i < input.entries.length; i++) {
      const e = input.entries[i]!;
      const id =
        e.id ?? genEntryIdFromToken(yield* crypto.randomToken(6));
      entries.push({
        id,
        providerId: e.providerId as ModelEntryDoc["providerId"],
        upstreamModelId: e.upstreamModelId,
        cost: e.cost,
        price: e.price,
        priority: e.priority ?? i,
        active: e.active ?? true,
      });
    }
    entries.sort((a, b) => a.priority - b.priority);

    return yield* models.insert({
      organizationId: input.organizationId,
      aliasId: input.aliasId,
      displayName: input.displayName,
      description: input.description ?? null,
      entries,
      reasoning: input.reasoning ?? false,
      toolCall: input.toolCall ?? false,
      ...(input.structuredOutput !== undefined
        ? { structuredOutput: input.structuredOutput }
        : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      attachment: input.attachment ?? false,
      limits: input.limits,
      modalities: input.modalities,
      status: input.status,
      price: input.price,
      marginBps: input.marginBps ?? 0,
      currency: input.currency,
      active: true,
      metadata: input.metadata ?? {},
    });
  });

export const updateModel = (input: {
  readonly organizationId: HexId;
  readonly modelId: HexId;
  readonly patch: Record<string, unknown>;
  readonly entries?: readonly ModelEntryInput[] | undefined;
}): Effect.Effect<
  ModelDoc,
  ModelDomainError,
  ModelRepository | Crypto
> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    const crypto = yield* Crypto;
    const existing = yield* models.findById(
      input.organizationId,
      input.modelId,
    );
    if (!existing) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    const $set: Record<string, unknown> = { ...input.patch };
    if (input.entries) {
      const providerIds = input.entries.map((e) =>
        providerIdHex(e.providerId),
      );
      const found = yield* models.countProviders(
        input.organizationId,
        providerIds,
      );
      if (found !== providerIds.length) {
        return yield* Effect.fail(
          new ValidationError({
            code: "validation_error",
            message: "provider_not_found",
            mode: "default_400",
          }),
        );
      }
      const entries: ModelEntryDoc[] = [];
      for (let i = 0; i < input.entries.length; i++) {
        const e = input.entries[i]!;
        const id =
          e.id ?? genEntryIdFromToken(yield* crypto.randomToken(6));
        entries.push({
          id,
          providerId: e.providerId as ModelEntryDoc["providerId"],
          upstreamModelId: e.upstreamModelId,
          cost: e.cost,
          price: e.price,
          priority: e.priority ?? i,
          active: e.active ?? true,
        });
      }
      entries.sort((a, b) => a.priority - b.priority);
      $set.entries = entries;
    }
    const updated = yield* models.update(
      input.organizationId,
      input.modelId,
      $set,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    return updated;
  });

export const deleteModel = (input: {
  readonly organizationId: HexId;
  readonly modelId: HexId;
}): Effect.Effect<{ ok: true }, ModelDomainError, ModelRepository> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    const ok = yield* models.delete(input.organizationId, input.modelId);
    if (!ok) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    return { ok: true as const };
  });

export const reorderFallbacks = (input: {
  readonly organizationId: HexId;
  readonly modelId: HexId;
  readonly entries: readonly { readonly id: string; readonly priority: number }[];
}): Effect.Effect<ModelDoc, ModelDomainError, ModelRepository> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    const existing = yield* models.findById(
      input.organizationId,
      input.modelId,
    );
    if (!existing) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    const priorityMap = new Map(input.entries.map((e) => [e.id, e.priority]));
    const validIds = new Set(existing.entries.map((e) => e.id));
    for (const e of input.entries) {
      if (!validIds.has(e.id)) {
        return yield* Effect.fail(
          new ValidationError({
            code: "validation_error",
            message: `entry_not_found: ${e.id}`,
            mode: "default_400",
          }),
        );
      }
    }
    const newEntries = existing.entries
      .map((e) => ({ ...e, priority: priorityMap.get(e.id) ?? e.priority }))
      .sort((a, b) => a.priority - b.priority);
    const updated = yield* models.setEntries(
      input.organizationId,
      input.modelId,
      newEntries,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    return updated;
  });

export const addModelEntry = (input: {
  readonly organizationId: HexId;
  readonly modelId: HexId;
  readonly entry: ModelEntryInput;
}): Effect.Effect<
  ModelDoc,
  ModelDomainError,
  ModelRepository | Crypto
> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    const crypto = yield* Crypto;
    const existing = yield* models.findById(
      input.organizationId,
      input.modelId,
    );
    if (!existing) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    const providerId = providerIdHex(input.entry.providerId);
    const found = yield* models.countProviders(input.organizationId, [
      providerId,
    ]);
    if (found !== 1) {
      return yield* Effect.fail(
        new ValidationError({
          code: "validation_error",
          message: "provider_not_found",
          mode: "default_400",
        }),
      );
    }
    const maxPriority = existing.entries.reduce(
      (m, e) => Math.max(m, e.priority),
      -1,
    );
    const id =
      input.entry.id ?? genEntryIdFromToken(yield* crypto.randomToken(6));
    const newEntry: ModelEntryDoc = {
      id,
      providerId: input.entry.providerId as ModelEntryDoc["providerId"],
      upstreamModelId: input.entry.upstreamModelId,
      cost: input.entry.cost,
      price: input.entry.price,
      priority: input.entry.priority ?? maxPriority + 1,
      active: input.entry.active ?? true,
    };
    const entries = [...existing.entries, newEntry].sort(
      (a, b) => a.priority - b.priority,
    );
    const updated = yield* models.setEntries(
      input.organizationId,
      input.modelId,
      entries,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    return updated;
  });

export const removeModelEntry = (input: {
  readonly organizationId: HexId;
  readonly modelId: HexId;
  readonly entryId: string;
}): Effect.Effect<ModelDoc, ModelDomainError, ModelRepository> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    const existing = yield* models.findById(
      input.organizationId,
      input.modelId,
    );
    if (!existing) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    if (existing.entries.length <= 1) {
      return yield* Effect.fail(
        new ConflictError({
          code: "last_entry",
          message: "Cannot remove the last model entry",
        }),
      );
    }
    if (!existing.entries.some((e) => e.id === input.entryId)) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Entry not found",
          resource: "model_entry",
          id: input.entryId,
        }),
      );
    }
    const entries = existing.entries.filter((e) => e.id !== input.entryId);
    const updated = yield* models.setEntries(
      input.organizationId,
      input.modelId,
      entries,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Model not found",
          resource: "model",
          id: input.modelId,
        }),
      );
    }
    return updated;
  });

/** Public management model DTO — omits metadata (shared admin/management read). */
export function toModelCapability(m: ModelDoc) {
  return {
    aliasId: m.aliasId,
    displayName: m.displayName,
    description: m.description,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    structuredOutput: m.structuredOutput,
    temperature: m.temperature,
    attachment: m.attachment,
    limits: m.limits,
    modalities: m.modalities,
    status: m.status,
    price: m.price,
    currency: m.currency,
    active: m.active,
  };
}

export const listCatalog = (input: {
  readonly organizationId: HexId;
  readonly providerId?: HexId | undefined;
}): Effect.Effect<readonly ModelCatalogDoc[], RepoError, ModelRepository> =>
  Effect.gen(function* () {
    const models = yield* ModelRepository;
    return yield* models.listCatalog(
      input.organizationId,
      input.providerId,
    );
  });

// silence unused helper (kept for future pure path)
void assertProvidersExist;
