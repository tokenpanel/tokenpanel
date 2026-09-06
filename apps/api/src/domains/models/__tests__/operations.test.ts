/**
 * Unit tests for model domain operations: createModel, updateModel, deleteModel,
 * reorderFallbacks, addModelEntry, removeModelEntry, listCatalog.
 * Fake repos via Layer.succeed + deterministic 12-hex Crypto fake — no DB.
 */
import { test, expect } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { ModelDoc, ModelEntryDoc, ModelCatalogDoc } from "@tokenpanel/db";
import {
  addModelEntry,
  createModel,
  deleteModel,
  listCatalog,
  removeModelEntry,
  reorderFallbacks,
  updateModel,
  type ModelEntryInput,
} from "../operations.ts";
import {
  ModelRepository,
  type ModelRepositoryService,
  type NewModelRecord,
} from "../../ports/model-repository.ts";
import type { HexId, RepoError } from "../../ports/common.ts";
import {
  ConflictError,
  NotFoundError,
  PersistenceUnavailableError,
  ValidationError,
} from "../../../errors/families.ts";
import { Crypto, type CryptoService } from "../../../runtime/services/crypto.ts";

const orgId = new ObjectId().toHexString();
const providerIdA = new ObjectId().toHexString();
const providerIdB = new ObjectId().toHexString();

function entryDoc(over: Partial<ModelEntryDoc> = {}): ModelEntryDoc {
  return {
    id: "entry-1",
    providerId: new ObjectId(providerIdA),
    upstreamModelId: "gpt-4o",
    priority: 0,
    active: true,
    ...over,
  };
}

function modelDoc(over: Partial<ModelDoc> = {}): ModelDoc {
  const now = new Date("2026-01-15T12:00:00.000Z");
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(orgId),
    aliasId: "fast-chat",
    displayName: "Fast Chat",
    description: null,
    entries: [entryDoc()],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function catalogDoc(over: Partial<ModelCatalogDoc> = {}): ModelCatalogDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(orgId),
    providerId: new ObjectId(providerIdA),
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

type RepoCalls = {
  inserts: NewModelRecord[];
  updates: { org: HexId; id: HexId; patch: Record<string, unknown> }[];
  deletes: { org: HexId; id: HexId }[];
  setEntries: { org: HexId; id: HexId; entries: readonly ModelEntryDoc[] }[];
  countProviders: { org: HexId; ids: readonly HexId[] }[];
  listCatalog: { org: HexId; providerId: HexId | undefined }[];
};

function modelLayer(
  opts: {
    doc?: ModelDoc | null;
    updateDoc?: ModelDoc | null;
    setEntriesDoc?: ModelDoc | null;
    deleteOk?: boolean;
    providerCount?: number;
    insertError?: RepoError;
    catalog?: readonly ModelCatalogDoc[];
  } = {},
): { layer: Layer.Layer<ModelRepository>; calls: RepoCalls } {
  const calls: RepoCalls = {
    inserts: [],
    updates: [],
    deletes: [],
    setEntries: [],
    countProviders: [],
    listCatalog: [],
  };
  const service: ModelRepositoryService = {
    list: () => Effect.succeed([]),
    listActive: () => Effect.succeed([]),
    findById: () => Effect.succeed(opts.doc ?? null),
    insert: (record) => {
      calls.inserts.push(record);
      return opts.insertError
        ? Effect.fail(opts.insertError)
        : Effect.succeed(modelDoc());
    },
    update: (org, id, patch) => {
      calls.updates.push({ org, id, patch });
      return Effect.succeed(opts.updateDoc ?? null);
    },
    delete: (org, id) => {
      calls.deletes.push({ org, id });
      return Effect.succeed(opts.deleteOk ?? false);
    },
    setEntries: (org, id, entries) => {
      calls.setEntries.push({ org, id, entries });
      return Effect.succeed(opts.setEntriesDoc ?? null);
    },
    countProviders: (org, ids) => {
      calls.countProviders.push({ org, ids });
      return Effect.succeed(opts.providerCount ?? 0);
    },
    listCatalog: (org, providerId) => {
      calls.listCatalog.push({ org, providerId });
      return Effect.succeed(opts.catalog ?? []);
    },
    upsertCatalog: () => Effect.void,
  };
  return { layer: Layer.succeed(ModelRepository, service), calls };
}

function cryptoLayer(
  opts: { onToken?: (bytes: number | undefined) => void } = {},
): Layer.Layer<Crypto> {
  let counter = 0;
  return Layer.succeed(Crypto, {
    hashPassword: () => Effect.succeed("x"),
    verifyPassword: () => Effect.succeed(true),
    randomToken: (bytes) => {
      opts.onToken?.(bytes);
      return Effect.succeed((counter++).toString(16).padStart(12, "0"));
    },
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
}

function entryInput(
  over: {
    providerId: HexId;
    upstreamModelId: string;
    id?: string | undefined;
    priority?: number | undefined;
    active?: boolean | undefined;
    cost?: ModelEntryDoc["cost"] | undefined;
    price?: ModelEntryDoc["price"] | undefined;
  },
): ModelEntryInput {
  return {
    cost: undefined,
    price: undefined,
    ...over,
  };
}

function expectError<A, E, X>(
  exit: Exit.Exit<A, E>,
  ctor: abstract new (...args: never[]) => X,
): X {
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") throw new Error("expected failure exit");
  const err = Cause.squash(exit.cause);
  expect(err).toBeInstanceOf(ctor);
  if (!(err instanceof ctor)) throw new Error("unexpected error type");
  return err;
}

// ---------------------------------------------------------------------------
// createModel
// ---------------------------------------------------------------------------

test("createModel: fails ValidationError when a referenced provider is missing", async () => {
  const { layer, calls } = modelLayer({ providerCount: 1 });
  const exit = await Effect.runPromiseExit(
    createModel({
      organizationId: orgId,
      aliasId: "fast-chat",
      displayName: "Fast Chat",
      entries: [
        entryInput({ providerId: providerIdA, upstreamModelId: "m-a" }),
        entryInput({ providerId: providerIdB, upstreamModelId: "m-b" }),
      ],
      limits: {},
      modalities: { input: ["text"], output: ["text"] },
      status: "ga",
      price: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 2 },
      currency: "USD",
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  const err = expectError(exit, ValidationError);
  expect(err.message).toBe("provider_not_found");
  expect(calls.inserts).toHaveLength(0);
});

test("createModel: checks deduped provider ids then inserts record with explicit passthrough", async () => {
  const { layer, calls } = modelLayer({ providerCount: 2 });
  const res = await Effect.runPromise(
    createModel({
      organizationId: orgId,
      aliasId: "fast-chat",
      displayName: "Fast Chat",
      description: "hello",
      entries: [
        entryInput({ providerId: providerIdA, upstreamModelId: "m-a" }),
        entryInput({ providerId: providerIdB, upstreamModelId: "m-b" }),
        entryInput({ providerId: providerIdA, upstreamModelId: "m-a2" }),
      ],
      reasoning: true,
      toolCall: true,
      structuredOutput: true,
      temperature: false,
      attachment: true,
      limits: { context: 64000 },
      modalities: { input: ["text"], output: ["text"] },
      status: "ga",
      price: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 2 },
      marginBps: 250,
      currency: "USD",
      metadata: { team: "x" },
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  expect(res.aliasId).toBe("fast-chat");
  expect(calls.countProviders).toHaveLength(1);
  expect(calls.countProviders[0]!.org).toBe(orgId);
  expect(calls.countProviders[0]!.ids).toEqual([providerIdA, providerIdB]);
  expect(calls.inserts).toHaveLength(1);
  const rec = calls.inserts[0]!;
  expect(rec.organizationId).toBe(orgId);
  expect(rec.aliasId).toBe("fast-chat");
  expect(rec.displayName).toBe("Fast Chat");
  expect(rec.description).toBe("hello");
  expect(rec.reasoning).toBe(true);
  expect(rec.toolCall).toBe(true);
  expect(rec.structuredOutput).toBe(true);
  expect(rec.temperature).toBe(false);
  expect(rec.attachment).toBe(true);
  expect(rec.marginBps).toBe(250);
  expect(rec.currency).toBe("USD");
  expect(rec.metadata).toEqual({ team: "x" });
  expect(rec.active).toBe(true);
});

test("createModel: defaults — generated 12-hex entry ids, priority=index, active=true, sorted asc", async () => {
  const tokenBytes: (number | undefined)[] = [];
  const { layer, calls } = modelLayer({ providerCount: 1 });
  const exit = await Effect.runPromiseExit(
    createModel({
      organizationId: orgId,
      aliasId: "fast-chat",
      displayName: "Fast Chat",
      entries: [
        entryInput({
          providerId: providerIdA,
          upstreamModelId: "m-0",
          priority: 3,
        }),
        entryInput({ providerId: providerIdA, upstreamModelId: "m-1" }),
        entryInput({
          providerId: providerIdA,
          upstreamModelId: "m-2",
          id: "custom-entry",
          priority: 2,
          active: false,
          cost: { inputMicrosPerMillion: 5, outputMicrosPerMillion: 6 },
        }),
      ],
      limits: {},
      modalities: { input: ["text"], output: ["text"] },
      status: "ga",
      price: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 2 },
      currency: "USD",
    }).pipe(
      Effect.provide(
        Layer.merge(layer, cryptoLayer({ onToken: (b) => tokenBytes.push(b) })),
      ),
    ),
  );
  expect(exit._tag).toBe("Success");
  expect(tokenBytes).toEqual([6, 6]);
  const entries = calls.inserts[0]!.entries;
  expect(entries.map((e) => e.id)).toEqual([
    "000000000001",
    "custom-entry",
    "000000000000",
  ]);
  for (const e of entries) {
    if (e.id !== "custom-entry") expect(e.id).toMatch(/^[0-9a-f]{12}$/);
  }
  expect(entries.map((e) => e.priority)).toEqual([1, 2, 3]);
  expect(entries.map((e) => e.active)).toEqual([true, false, true]);
  const custom = entries.find((e) => e.id === "custom-entry")!;
  expect(custom.cost).toEqual({ inputMicrosPerMillion: 5, outputMicrosPerMillion: 6 });
});

test("createModel: applies defaults — marginBps 0, capabilities off, description null, empty metadata", async () => {
  const { layer, calls } = modelLayer({ providerCount: 1 });
  await Effect.runPromise(
    createModel({
      organizationId: orgId,
      aliasId: "fast-chat",
      displayName: "Fast Chat",
      entries: [
        entryInput({
          providerId: providerIdA,
          upstreamModelId: "m-a",
          id: "e1",
        }),
      ],
      limits: {},
      modalities: { input: ["text"], output: ["text"] },
      status: "ga",
      price: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 2 },
      currency: "USD",
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  const rec = calls.inserts[0]!;
  expect(rec.marginBps).toBe(0);
  expect(rec.reasoning).toBe(false);
  expect(rec.toolCall).toBe(false);
  expect(rec.attachment).toBe(false);
  expect(rec.description).toBeNull();
  expect(rec.metadata).toEqual({});
  expect("structuredOutput" in rec).toBe(false);
  expect("temperature" in rec).toBe(false);
});

test("createModel: propagates RepoError from insert unchanged", async () => {
  const repoErr = new PersistenceUnavailableError({
    code: "persistence_unavailable",
    message: "db down",
    retryClass: "transient",
  });
  const { layer } = modelLayer({ providerCount: 1, insertError: repoErr });
  const exit = await Effect.runPromiseExit(
    createModel({
      organizationId: orgId,
      aliasId: "fast-chat",
      displayName: "Fast Chat",
      entries: [
        entryInput({
          providerId: providerIdA,
          upstreamModelId: "m-a",
          id: "e1",
        }),
      ],
      limits: {},
      modalities: { input: ["text"], output: ["text"] },
      status: "ga",
      price: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 2 },
      currency: "USD",
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  const err = expectError(exit, PersistenceUnavailableError);
  expect(err).toBe(repoErr);
});

// ---------------------------------------------------------------------------
// updateModel
// ---------------------------------------------------------------------------

test("updateModel: NotFoundError when model missing — before provider check or update", async () => {
  const { layer, calls } = modelLayer({ doc: null });
  const modelId = new ObjectId().toHexString();
  const exit = await Effect.runPromiseExit(
    updateModel({
      organizationId: orgId,
      modelId,
      patch: { displayName: "X" },
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  const err = expectError(exit, NotFoundError);
  expect(err.code).toBe("not_found");
  expect(err.resource).toBe("model");
  expect(err.id).toBe(modelId);
  expect(calls.updates).toHaveLength(0);
  expect(calls.countProviders).toHaveLength(0);
});

test("updateModel: $set passthrough — patch fields forwarded verbatim, update result returned", async () => {
  const doc = modelDoc();
  const { layer, calls } = modelLayer({ doc, updateDoc: modelDoc({ aliasId: "renamed" }) });
  const modelId = new ObjectId().toHexString();
  const res = await Effect.runPromise(
    updateModel({
      organizationId: orgId,
      modelId,
      patch: { displayName: "Renamed", marginBps: 300 },
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  expect(res.aliasId).toBe("renamed");
  expect(calls.updates).toHaveLength(1);
  expect(calls.updates[0]!.org).toBe(orgId);
  expect(calls.updates[0]!.id).toBe(modelId);
  expect(calls.updates[0]!.patch).toEqual({ displayName: "Renamed", marginBps: 300 });
});

test("updateModel: entries wholesale replace — provider check, normalized sorted entries in $set", async () => {
  const doc = modelDoc({
    entries: [
      entryDoc({ id: "old-a", priority: 0 }),
      entryDoc({ id: "old-b", providerId: new ObjectId(providerIdB), priority: 1 }),
    ],
  });
  const { layer, calls } = modelLayer({
    doc,
    providerCount: 2,
    updateDoc: modelDoc({ aliasId: "ok" }),
  });
  const modelId = new ObjectId().toHexString();
  const res = await Effect.runPromise(
    updateModel({
      organizationId: orgId,
      modelId,
      patch: { displayName: "X" },
      entries: [
        entryInput({
          providerId: providerIdB,
          upstreamModelId: "m-b",
          id: "n2",
          priority: 2,
        }),
        entryInput({
          providerId: providerIdA,
          upstreamModelId: "m-a",
          id: "n1",
          priority: 1,
        }),
      ],
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  expect(res.aliasId).toBe("ok");
  expect(calls.countProviders[0]!.ids).toEqual([providerIdB, providerIdA]);
  const patch = calls.updates[0]!.patch;
  expect(patch.entries).toEqual([
    {
      id: "n1",
      providerId: providerIdA,
      upstreamModelId: "m-a",
      priority: 1,
      active: true,
    },
    {
      id: "n2",
      providerId: providerIdB,
      upstreamModelId: "m-b",
      priority: 2,
      active: true,
    },
  ]);
  expect(calls.setEntries).toHaveLength(0);
});

test("updateModel: ValidationError when replacement entries reference unknown provider", async () => {
  const { layer, calls } = modelLayer({ doc: modelDoc(), providerCount: 0 });
  const exit = await Effect.runPromiseExit(
    updateModel({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      patch: {},
      entries: [
        entryInput({ providerId: providerIdB, upstreamModelId: "m-b", id: "n1" }),
      ],
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  const err = expectError(exit, ValidationError);
  expect(err.message).toBe("provider_not_found");
  expect(calls.updates).toHaveLength(0);
});

test("updateModel: NotFoundError when update finds nothing (deleted concurrently)", async () => {
  const { layer, calls } = modelLayer({ doc: modelDoc(), updateDoc: null });
  const modelId = new ObjectId().toHexString();
  const exit = await Effect.runPromiseExit(
    updateModel({ organizationId: orgId, modelId, patch: {} }).pipe(
      Effect.provide(Layer.merge(layer, cryptoLayer())),
    ),
  );
  const err = expectError(exit, NotFoundError);
  expect(err.resource).toBe("model");
  expect(err.id).toBe(modelId);
  expect(calls.updates).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// deleteModel
// ---------------------------------------------------------------------------

test("deleteModel: NotFoundError when nothing was deleted", async () => {
  const { layer, calls } = modelLayer({ deleteOk: false });
  const modelId = new ObjectId().toHexString();
  const exit = await Effect.runPromiseExit(
    deleteModel({ organizationId: orgId, modelId }).pipe(
      Effect.provide(layer),
    ),
  );
  const err = expectError(exit, NotFoundError);
  expect(err.code).toBe("not_found");
  expect(err.resource).toBe("model");
  expect(err.id).toBe(modelId);
  expect(calls.deletes).toEqual([{ org: orgId, id: modelId }]);
});

test("deleteModel: returns { ok: true } when repo deleted the model", async () => {
  const { layer, calls } = modelLayer({ deleteOk: true });
  const modelId = new ObjectId().toHexString();
  const res = await Effect.runPromise(
    deleteModel({ organizationId: orgId, modelId }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(res).toEqual({ ok: true });
  expect(calls.deletes).toEqual([{ org: orgId, id: modelId }]);
});

// ---------------------------------------------------------------------------
// reorderFallbacks
// ---------------------------------------------------------------------------

test("reorderFallbacks: ValidationError entry_not_found for unknown entry id", async () => {
  const { layer, calls } = modelLayer({
    doc: modelDoc({ entries: [entryDoc({ id: "a" }), entryDoc({ id: "b", priority: 1 })] }),
  });
  const exit = await Effect.runPromiseExit(
    reorderFallbacks({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entries: [{ id: "ghost", priority: 0 }],
    }).pipe(Effect.provide(layer)),
  );
  const err = expectError(exit, ValidationError);
  expect(err.message).toBe("entry_not_found: ghost");
  expect(calls.setEntries).toHaveLength(0);
});

test("reorderFallbacks: unmentioned entries keep priority, re-sorted ascending", async () => {
  const ea = entryDoc({ id: "a", priority: 10 });
  const eb = entryDoc({ id: "b", priority: 20 });
  const ec = entryDoc({ id: "c", priority: 30 });
  const { layer, calls } = modelLayer({
    doc: modelDoc({ entries: [ea, eb, ec] }),
    setEntriesDoc: modelDoc({ entries: [ec, ea, eb] }),
  });
  const res = await Effect.runPromise(
    reorderFallbacks({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entries: [{ id: "c", priority: 5 }],
    }).pipe(Effect.provide(layer)),
  );
  expect(res.aliasId).toBe("fast-chat");
  const entries = calls.setEntries[0]!.entries;
  expect(entries.map((e) => [e.id, e.priority])).toEqual([
    ["c", 5],
    ["a", 10],
    ["b", 20],
  ]);
  expect(entries[0]).toEqual({ ...ec, priority: 5 });
});

test("reorderFallbacks: duplicate mentions last-win, equal priorities not deduped", async () => {
  const { layer, calls } = modelLayer({
    doc: modelDoc({
      entries: [
        entryDoc({ id: "a" }),
        entryDoc({ id: "b", priority: 1 }),
        entryDoc({ id: "c", priority: 2 }),
      ],
    }),
    setEntriesDoc: modelDoc(),
  });
  await Effect.runPromise(
    reorderFallbacks({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entries: [
        { id: "a", priority: 7 },
        { id: "a", priority: 2 },
        { id: "b", priority: 2 },
      ],
    }).pipe(Effect.provide(layer)),
  );
  const entries = calls.setEntries[0]!.entries;
  expect(entries).toHaveLength(3);
  expect(entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
  expect(entries.map((e) => e.priority)).toEqual([2, 2, 2]);
});

// ---------------------------------------------------------------------------
// addModelEntry
// ---------------------------------------------------------------------------

test("addModelEntry: NotFoundError when model missing", async () => {
  const { layer, calls } = modelLayer({ doc: null });
  const exit = await Effect.runPromiseExit(
    addModelEntry({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entry: entryInput({ providerId: providerIdA, upstreamModelId: "m-x" }),
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  expectError(exit, NotFoundError);
  expect(calls.countProviders).toHaveLength(0);
  expect(calls.setEntries).toHaveLength(0);
});

test("addModelEntry: ValidationError when the entry provider is unknown", async () => {
  const { layer, calls } = modelLayer({
    doc: modelDoc({
      entries: [entryDoc({ id: "a" }), entryDoc({ id: "b", priority: 1 })],
    }),
    providerCount: 0,
  });
  const exit = await Effect.runPromiseExit(
    addModelEntry({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entry: entryInput({ providerId: providerIdB, upstreamModelId: "m-x" }),
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  const err = expectError(exit, ValidationError);
  expect(err.message).toBe("provider_not_found");
  expect(calls.countProviders[0]!.ids).toEqual([providerIdB]);
  expect(calls.setEntries).toHaveLength(0);
});

test("addModelEntry: appends with priority=max+1 and generated 12-hex id, re-sorted ascending", async () => {
  const { layer, calls } = modelLayer({
    doc: modelDoc({
      entries: [
        entryDoc({ id: "a", priority: 0 }),
        entryDoc({ id: "b", providerId: new ObjectId(providerIdB), priority: 5 }),
      ],
    }),
    providerCount: 1,
    setEntriesDoc: modelDoc(),
  });
  const res = await Effect.runPromise(
    addModelEntry({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entry: entryInput({ providerId: providerIdB, upstreamModelId: "m-x" }),
    }).pipe(Effect.provide(Layer.merge(layer, cryptoLayer()))),
  );
  expect(res.aliasId).toBe("fast-chat");
  const entries = calls.setEntries[0]!.entries;
  expect(entries.map((e) => [e.id, e.priority])).toEqual([
    ["a", 0],
    ["b", 5],
    ["000000000000", 6],
  ]);
  expect(entries[2]!.id).toMatch(/^[0-9a-f]{12}$/);
  expect(entries[2]!.active).toBe(true);
});

test("addModelEntry: explicit id and priority win — no token generated, placed by priority", async () => {
  const tokens: (number | undefined)[] = [];
  const { layer, calls } = modelLayer({
    doc: modelDoc({
      entries: [
        entryDoc({ id: "a", priority: 1 }),
        entryDoc({ id: "b", priority: 2 }),
      ],
    }),
    providerCount: 1,
    setEntriesDoc: modelDoc(),
  });
  await Effect.runPromise(
    addModelEntry({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entry: entryInput({
        providerId: providerIdA,
        upstreamModelId: "m-x",
        id: "fixed",
        priority: 0,
      }),
    }).pipe(
      Effect.provide(
        Layer.merge(layer, cryptoLayer({ onToken: (b) => tokens.push(b) })),
      ),
    ),
  );
  expect(tokens).toEqual([]);
  const entries = calls.setEntries[0]!.entries;
  expect(entries.map((e) => [e.id, e.priority])).toEqual([
    ["fixed", 0],
    ["a", 1],
    ["b", 2],
  ]);
});

// ---------------------------------------------------------------------------
// removeModelEntry
// ---------------------------------------------------------------------------

test("removeModelEntry: ConflictError last_entry when model has a single entry", async () => {
  const { layer, calls } = modelLayer({
    doc: modelDoc({ entries: [entryDoc({ id: "only" })] }),
  });
  const exit = await Effect.runPromiseExit(
    removeModelEntry({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entryId: "only",
    }).pipe(Effect.provide(layer)),
  );
  const err = expectError(exit, ConflictError);
  expect(err.code).toBe("last_entry");
  expect(err.message).toBe("Cannot remove the last model entry");
  expect(calls.setEntries).toHaveLength(0);
});

test("removeModelEntry: NotFoundError model_entry for unknown entry id", async () => {
  const { layer, calls } = modelLayer({
    doc: modelDoc({
      entries: [entryDoc({ id: "a" }), entryDoc({ id: "b", priority: 1 })],
    }),
  });
  const exit = await Effect.runPromiseExit(
    removeModelEntry({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entryId: "ghost",
    }).pipe(Effect.provide(layer)),
  );
  const err = expectError(exit, NotFoundError);
  expect(err.resource).toBe("model_entry");
  expect(err.id).toBe("ghost");
  expect(err.message).toBe("Entry not found");
  expect(calls.setEntries).toHaveLength(0);
});

test("removeModelEntry: filters out the entry without resorting remaining entries", async () => {
  const ea = entryDoc({ id: "a", priority: 20 });
  const eb = entryDoc({ id: "b", priority: 5 });
  const ec = entryDoc({ id: "c", priority: 10 });
  const { layer, calls } = modelLayer({
    doc: modelDoc({ entries: [ea, eb, ec] }),
    setEntriesDoc: modelDoc({ entries: [ea, ec] }),
  });
  const res = await Effect.runPromise(
    removeModelEntry({
      organizationId: orgId,
      modelId: new ObjectId().toHexString(),
      entryId: "b",
    }).pipe(Effect.provide(layer)),
  );
  expect(res.aliasId).toBe("fast-chat");
  expect(calls.setEntries[0]!.entries).toEqual([ea, ec]);
});

// ---------------------------------------------------------------------------
// listCatalog
// ---------------------------------------------------------------------------

test("listCatalog: forwards providerId filter and returns repo items", async () => {
  const items = [catalogDoc(), catalogDoc({ upstreamModelId: "m2" })];
  const { layer, calls } = modelLayer({ catalog: items });
  const res = await Effect.runPromise(
    listCatalog({ organizationId: orgId, providerId: providerIdA }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(res).toBe(items);
  expect(calls.listCatalog).toEqual([
    { org: orgId, providerId: providerIdA },
  ]);
});

test("listCatalog: providerId undefined is forwarded when not provided", async () => {
  const { layer, calls } = modelLayer({ catalog: [] });
  await Effect.runPromise(
    listCatalog({ organizationId: orgId }).pipe(Effect.provide(layer)),
  );
  expect(calls.listCatalog).toHaveLength(1);
  expect(calls.listCatalog[0]!.org).toBe(orgId);
  expect(calls.listCatalog[0]!.providerId).toBeUndefined();
});
