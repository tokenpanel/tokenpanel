/**
 * Unit tests for listProviderCatalog + discoverProviderModels.
 */
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { ModelCatalogDoc, ProviderDoc } from "@tokenpanel/db";
import {
  discoverProviderModels,
  listProviderCatalog,
} from "../operations.ts";
import {
  ModelRepository,
  type CatalogUpsertEntry,
  type ModelRepositoryService,
} from "../../ports/model-repository.ts";
import {
  ProviderRepository,
  type ProviderRepositoryService,
} from "../../ports/provider-repository.ts";
import { Crypto, type CryptoService } from "../../../runtime/services/crypto.ts";
import type { DiscoveredModel, ProviderAdapter } from "../../../providers/types.ts";
import { makeProviderError } from "../../../providers/provider-errors.ts";

const orgId = new ObjectId().toHexString();
const providerId = new ObjectId().toHexString();

function providerDoc(over: Partial<ProviderDoc> = {}): ProviderDoc {
  return {
    _id: new ObjectId(providerId),
    organizationId: new ObjectId(orgId),
    name: "OpenAI",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "enc-key",
    baseUrl: "https://api.openai.com/v1",
    providerOrg: null,
    headers: {},
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function catalogDoc(over: Partial<ModelCatalogDoc> = {}): ModelCatalogDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(orgId),
    providerId: new ObjectId(providerId),
    upstreamModelId: "gpt-4o",
    displayName: "GPT-4o",
    reasoning: false,
    toolCall: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limits: { context: 128000 },
    raw: {},
    discoveredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function providerLayer(
  doc: ProviderDoc | null,
): Layer.Layer<ProviderRepository> {
  const service: ProviderRepositoryService = {
    list: () => Effect.succeed([]),
    findById: () => Effect.succeed(doc),
    insert: () => Effect.die("unused"),
    update: () => Effect.succeed(null),
    countModelRefs: () => Effect.succeed(0),
    deleteWithCatalog: () => Effect.succeed(true),
  };
  return Layer.succeed(ProviderRepository, service);
}

function modelLayer(opts: {
  catalog?: readonly ModelCatalogDoc[];
  onUpsert?: (entries: readonly CatalogUpsertEntry[]) => void;
}): Layer.Layer<ModelRepository> {
  const service: ModelRepositoryService = {
    list: () => Effect.succeed([]),
    listActive: () => Effect.succeed([]),
    findById: () => Effect.succeed(null),
    insert: () => Effect.die("unused"),
    update: () => Effect.succeed(null),
    delete: () => Effect.succeed(false),
    setEntries: () => Effect.succeed(null),
    countProviders: () => Effect.succeed(0),
    listCatalog: () => Effect.succeed(opts.catalog ?? []),
    upsertCatalog: (_org, _pid, entries) => {
      opts.onUpsert?.(entries);
      return Effect.void;
    },
  };
  return Layer.succeed(ModelRepository, service);
}

const cryptoLayer = Layer.succeed(Crypto, {
  hashPassword: () => Effect.succeed("x"),
  verifyPassword: () => Effect.succeed(true),
  randomToken: () => Effect.succeed("tok"),
  hashToken: () => Effect.succeed("hash"),
  safeHashEqual: () => Effect.succeed(true),
  signJwt: () => Effect.succeed("jwt"),
  verifyJwt: () =>
    Effect.succeed({
      sub: "u",
      orgId: orgId,
      role: "admin",
      sid: "s1",
      exp: 0,
    }),
  encryptSecret: (p) => Effect.succeed(`enc:${p}`),
  decryptSecret: (e) => Effect.succeed(e.replace(/^enc:/, "") || "plain-key"),
  isDuplicateKeyError: () => false,
} satisfies CryptoService);

test("listProviderCatalog: not found when provider missing", async () => {
  const layer = Layer.merge(providerLayer(null), modelLayer({}));
  const exit = await Effect.runPromiseExit(
    listProviderCatalog({ organizationId: orgId, providerId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(exit._tag).toBe("Failure");
});

test("listProviderCatalog: returns cached items for existing provider", async () => {
  const items = [catalogDoc()];
  const layer = Layer.merge(
    providerLayer(providerDoc()),
    modelLayer({ catalog: items }),
  );
  const res = await Effect.runPromise(
    listProviderCatalog({ organizationId: orgId, providerId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(res.items).toHaveLength(1);
  expect(res.items[0]?.upstreamModelId).toBe("gpt-4o");
});

test("discoverProviderModels: unknown sdkType → ValidationError", async () => {
  const layer = Layer.mergeAll(
    providerLayer(providerDoc({ sdkType: "nope" })),
    modelLayer({}),
    cryptoLayer,
  );
  const exit = await Effect.runPromiseExit(
    discoverProviderModels({
      organizationId: orgId,
      providerId,
      getAdapter: () => undefined,
    }).pipe(Effect.provide(layer)),
  );
  expect(exit._tag).toBe("Failure");
});

test("discoverProviderModels: lists upstream, upserts catalog, returns items", async () => {
  const discovered: DiscoveredModel[] = [
    {
      upstreamModelId: "gpt-4o-mini",
      displayName: "gpt-4o-mini",
      limits: { context: 128000 },
      modalities: { input: ["text"], output: ["text"] },
    },
  ];
  let upserted: readonly CatalogUpsertEntry[] | undefined;
  const adapter: ProviderAdapter = {
    sdkType: "openai-compatible",
    listModels: () => Effect.succeed(discovered),
    chatComplete: () =>
      Effect.fail(
        makeProviderError({
          message: "unused",
          category: "unknown",
          phase: "request",
        }),
      ),
    streamChat: async function* () {
      yield { type: "error", error: { code: "x", message: "unused" } };
    },
  };
  const layer = Layer.mergeAll(
    providerLayer(providerDoc()),
    modelLayer({
      onUpsert: (entries) => {
        upserted = entries;
      },
    }),
    cryptoLayer,
  );
  const res = await Effect.runPromise(
    discoverProviderModels({
      organizationId: orgId,
      providerId,
      getAdapter: () => adapter,
    }).pipe(Effect.provide(layer)),
  );
  expect(res.items).toEqual(discovered);
  expect(upserted).toHaveLength(1);
  expect(upserted?.[0]?.upstreamModelId).toBe("gpt-4o-mini");
});

test("discoverProviderModels: provider httpTimeoutMs overrides globalTimeoutMs", async () => {
  let seenTimeout: number | undefined;
  const adapter: ProviderAdapter = {
    sdkType: "openai-compatible",
    listModels: (ctx) => {
      seenTimeout = ctx.timeoutMs;
      return Effect.succeed([]);
    },
    chatComplete: () =>
      Effect.fail(
        makeProviderError({
          message: "unused",
          category: "unknown",
          phase: "request",
        }),
      ),
    streamChat: async function* () {
      yield { type: "error", error: { code: "x", message: "unused" } };
    },
  };
  const layer = Layer.mergeAll(
    providerLayer(providerDoc({ httpTimeoutMs: 45_000 })),
    modelLayer({}),
    cryptoLayer,
  );
  await Effect.runPromise(
    discoverProviderModels({
      organizationId: orgId,
      providerId,
      getAdapter: () => adapter,
      globalTimeoutMs: 120_000,
    }).pipe(Effect.provide(layer)),
  );
  expect(seenTimeout).toBe(45_000);
});

test("discoverProviderModels: inherits globalTimeoutMs when provider has no override", async () => {
  let seenTimeout: number | undefined;
  const adapter: ProviderAdapter = {
    sdkType: "openai-compatible",
    listModels: (ctx) => {
      seenTimeout = ctx.timeoutMs;
      return Effect.succeed([]);
    },
    chatComplete: () =>
      Effect.fail(
        makeProviderError({
          message: "unused",
          category: "unknown",
          phase: "request",
        }),
      ),
    streamChat: async function* () {
      yield { type: "error", error: { code: "x", message: "unused" } };
    },
  };
  const layer = Layer.mergeAll(
    providerLayer(providerDoc({ httpTimeoutMs: null })),
    modelLayer({}),
    cryptoLayer,
  );
  await Effect.runPromise(
    discoverProviderModels({
      organizationId: orgId,
      providerId,
      getAdapter: () => adapter,
      globalTimeoutMs: 120_000,
    }).pipe(Effect.provide(layer)),
  );
  expect(seenTimeout).toBe(120_000);
});

test("discoverProviderModels: adapter failure classifies to provider app error", async () => {
  const adapter: ProviderAdapter = {
    sdkType: "openai-compatible",
    listModels: () =>
      Effect.fail(
        makeProviderError({
          message: "upstream down",
          category: "http_5xx",
          phase: "request",
          httpStatus: 502,
        }),
      ),
    chatComplete: () =>
      Effect.fail(
        makeProviderError({
          message: "unused",
          category: "unknown",
          phase: "request",
        }),
      ),
    streamChat: async function* () {
      yield { type: "error", error: { code: "x", message: "unused" } };
    },
  };
  const layer = Layer.mergeAll(
    providerLayer(providerDoc()),
    modelLayer({}),
    cryptoLayer,
  );
  const exit = await Effect.runPromiseExit(
    discoverProviderModels({
      organizationId: orgId,
      providerId,
      getAdapter: () => adapter,
    }).pipe(Effect.provide(layer)),
  );
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const failures = exit.cause;
    // Failure should surface a tagged provider error, not an unhandled defect.
    expect(String(failures)).toMatch(/ProviderUnavailableError|ProviderProtocolError|ProviderTimeoutError|ProviderRejectedError/);
  }
});
