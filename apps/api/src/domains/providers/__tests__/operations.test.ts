/**
 * Unit tests for provider lifecycle ops: createProvider, updateProvider, deleteProvider.
 */
import { test, expect } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { ProviderDoc } from "@tokenpanel/db";
import {
  createProvider,
  deleteProvider,
  updateProvider,
} from "../operations.ts";
import {
  ConflictError,
  NotFoundError,
  PersistenceUnavailableError,
} from "../../../errors/families.ts";
import type { HexId, RepoError } from "../../ports/common.ts";
import {
  ProviderRepository,
  type NewProviderRecord,
  type ProviderRepositoryService,
} from "../../ports/provider-repository.ts";
import { Crypto, type CryptoService } from "../../../runtime/services/crypto.ts";

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

function docFromRecord(rec: NewProviderRecord): ProviderDoc {
  return providerDoc({
    _id: new ObjectId(),
    organizationId: new ObjectId(rec.organizationId),
    name: rec.name,
    // insert record sdkType is any validated string; doc field is the closed union
    sdkType: rec.sdkType as ProviderDoc["sdkType"],
    apiKeyEncrypted: rec.apiKeyEncrypted,
    baseUrl: rec.baseUrl,
    providerOrg: rec.providerOrg,
    headers: { ...rec.headers },
    active: rec.active,
    metadata: { ...rec.metadata },
    ...(rec.httpTimeoutMs !== undefined
      ? { httpTimeoutMs: rec.httpTimeoutMs }
      : {}),
  });
}

type CapturedUpdate = {
  readonly organizationId: HexId;
  readonly providerId: HexId;
  readonly patch: Record<string, unknown>;
};

function providerRepo(
  opts: {
    insertDoc?: ProviderDoc;
    updateDoc?: ProviderDoc | null;
    findByIdDoc?: ProviderDoc | null;
    refCount?: number;
    deleteOk?: boolean;
    failOn?: Partial<
      Record<
        | "insert"
        | "update"
        | "findById"
        | "countModelRefs"
        | "deleteWithCatalog",
        RepoError
      >
    >;
  } = {},
): {
  layer: Layer.Layer<ProviderRepository>;
  events: string[];
  inserts: NewProviderRecord[];
  updates: CapturedUpdate[];
} {
  const events: string[] = [];
  const inserts: NewProviderRecord[] = [];
  const updates: CapturedUpdate[] = [];
  const service: ProviderRepositoryService = {
    list: () => Effect.succeed([]),
    findById: () => {
      events.push("findById");
      if (opts.failOn?.findById) return Effect.fail(opts.failOn.findById);
      return Effect.succeed(opts.findByIdDoc ?? null);
    },
    insert: (record) => {
      events.push("insert");
      if (opts.failOn?.insert) return Effect.fail(opts.failOn.insert);
      inserts.push(record);
      return Effect.succeed(opts.insertDoc ?? docFromRecord(record));
    },
    update: (organizationId, pid, patch) => {
      events.push("update");
      if (opts.failOn?.update) return Effect.fail(opts.failOn.update);
      updates.push({ organizationId, providerId: pid, patch });
      return Effect.succeed(opts.updateDoc ?? null);
    },
    countModelRefs: () => {
      events.push("countModelRefs");
      if (opts.failOn?.countModelRefs) {
        return Effect.fail(opts.failOn.countModelRefs);
      }
      return Effect.succeed(opts.refCount ?? 0);
    },
    deleteWithCatalog: () => {
      events.push("deleteWithCatalog");
      if (opts.failOn?.deleteWithCatalog) {
        return Effect.fail(opts.failOn.deleteWithCatalog);
      }
      return Effect.succeed(opts.deleteOk ?? true);
    },
  };
  return {
    layer: Layer.succeed(ProviderRepository, service),
    events,
    inserts,
    updates,
  };
}

function cryptoFake(
  events?: string[],
): { layer: Layer.Layer<Crypto>; encrypted: string[] } {
  const encrypted: string[] = [];
  const layer = Layer.succeed(Crypto, {
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
    encryptSecret: (p) => {
      events?.push("encrypt");
      encrypted.push(p);
      return Effect.succeed(`enc:${p}`);
    },
    decryptSecret: (e) => Effect.succeed(e.replace(/^enc:/, "") || "plain-key"),
    isDuplicateKeyError: () => false,
  } satisfies CryptoService);
  return { layer, encrypted };
}

async function runOk<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, layer));
}

async function runFail<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>,
): Promise<E> {
  const exit = await Effect.runPromiseExit(Effect.provide(effect, layer));
  if (exit._tag !== "Failure") throw new Error("expected Failure exit");
  return Cause.squash(exit.cause) as E;
}

test("createProvider: encrypts apiKey, stores defaults, returns masked view", async () => {
  const repo = providerRepo();
  const crypto = cryptoFake(repo.events);
  const view = await runOk(
    createProvider({
      organizationId: orgId,
      name: "Anthropic",
      sdkType: "openai-compatible",
      apiKey: "sk-plain-123",
      baseUrl: "https://api.anthropic.com/v1",
      isKnownSdkType: () => true,
    }),
    Layer.mergeAll(repo.layer, crypto.layer),
  );

  // encrypt sees the plaintext and runs before insert
  expect(repo.events).toEqual(["encrypt", "insert"]);
  expect(crypto.encrypted).toEqual(["sk-plain-123"]);

  // stored record: ciphertext, never plaintext; lifecycle defaults
  expect(repo.inserts).toHaveLength(1);
  const record = repo.inserts[0]!;
  expect(record.apiKeyEncrypted).toBe("enc:sk-plain-123");
  expect(record.apiKeyEncrypted).not.toBe("sk-plain-123");
  expect(record.active).toBe(true);
  expect(record.providerOrg).toBeNull();
  expect(record.headers).toEqual({});
  expect(record.metadata).toEqual({});
  expect("httpTimeoutMs" in record).toBe(false);
  expect(record.organizationId).toBe(orgId);
  expect(record.name).toBe("Anthropic");
  expect(record.baseUrl).toBe("https://api.anthropic.com/v1");

  // masked result: ciphertext stripped, key presence flag
  expect("apiKeyEncrypted" in view).toBe(false);
  expect(view.hasApiKey).toBe(true);
  expect(view.headers).toEqual({});
  expect(view.name).toBe("Anthropic");
});

test("createProvider: explicit fields stored verbatim, header names masked", async () => {
  const repo = providerRepo();
  const crypto = cryptoFake();
  const view = await runOk(
    createProvider({
      organizationId: orgId,
      name: "Bedrock",
      sdkType: "openai-compatible",
      apiKey: "sk-2",
      baseUrl: "https://bedrock.aws",
      providerOrg: "acme",
      headers: { Authorization: "Bearer sk-2", "X-Api-Key": "raw" },
      httpTimeoutMs: 5000,
      metadata: { team: "platform" },
      isKnownSdkType: () => true,
    }),
    Layer.mergeAll(repo.layer, crypto.layer),
  );

  const record = repo.inserts[0]!;
  expect(record.providerOrg).toBe("acme");
  expect(record.headers).toEqual({
    Authorization: "Bearer sk-2",
    "X-Api-Key": "raw",
  });
  expect(record.httpTimeoutMs).toBe(5000);

  // view maps header values to `true`, keeps the rest
  expect(view.headers).toEqual({ Authorization: true, "X-Api-Key": true });
  expect(view.metadata).toEqual({ team: "platform" });
  expect(view.httpTimeoutMs).toBe(5000);
  expect(view.hasApiKey).toBe(true);
  expect("apiKeyEncrypted" in view).toBe(false);
});

test("createProvider: repository failure passes through unmodified", async () => {
  const repoErr = new PersistenceUnavailableError({
    code: "persistence_unavailable",
    message: "db down",
    retryClass: "transient",
  });
  const repo = providerRepo({ failOn: { insert: repoErr } });
  const crypto = cryptoFake(repo.events);
  const err = await runFail(
    createProvider({
      organizationId: orgId,
      name: "X",
      sdkType: "openai-compatible",
      apiKey: "sk-3",
      baseUrl: "https://x.example.com",
      isKnownSdkType: () => true,
    }),
    Layer.mergeAll(repo.layer, crypto.layer),
  );
  expect(err).toBe(repoErr);
  expect(err).toBeInstanceOf(PersistenceUnavailableError);
  expect(repo.events).toEqual(["encrypt", "insert"]);
});

test("updateProvider: re-encrypts apiKey, never persists plaintext", async () => {
  const repo = providerRepo({
    updateDoc: providerDoc({ apiKeyEncrypted: "enc:sk-rotated" }),
  });
  const crypto = cryptoFake(repo.events);
  const view = await runOk(
    updateProvider({
      organizationId: orgId,
      providerId,
      patch: { apiKey: "sk-rotated" },
      isKnownSdkType: () => true,
    }),
    Layer.mergeAll(repo.layer, crypto.layer),
  );

  expect(crypto.encrypted).toEqual(["sk-rotated"]);
  expect(repo.events).toEqual(["encrypt", "update"]);
  expect(repo.updates).toHaveLength(1);
  const { organizationId, providerId: pid, patch } = repo.updates[0]!;
  expect(organizationId).toBe(orgId);
  expect(pid).toBe(providerId);
  expect(patch).toEqual({ apiKeyEncrypted: "enc:sk-rotated" });
  expect("apiKey" in patch).toBe(false);
  expect(view.hasApiKey).toBe(true);
  expect("apiKeyEncrypted" in view).toBe(false);
});

test("updateProvider: passes patch through, skips undefined + crypto without apiKey", async () => {
  const repo = providerRepo({
    updateDoc: providerDoc({
      name: "Renamed",
      active: false,
      headers: { "X-Env": "prod" },
      metadata: { owner: "infra" },
    }),
  });
  const crypto = cryptoFake(repo.events);
  const view = await runOk(
    updateProvider({
      organizationId: orgId,
      providerId,
      patch: {
        name: "Renamed",
        active: false,
        baseUrl: "https://new.example.com",
        providerOrg: null,
        headers: { "X-Env": "prod" },
        metadata: { owner: "infra" },
        httpTimeoutMs: null,
        sdkType: undefined,
      },
      isKnownSdkType: () => true,
    }),
    Layer.mergeAll(repo.layer, crypto.layer),
  );

  expect(crypto.encrypted).toEqual([]);
  expect(repo.events).toEqual(["update"]);
  expect(repo.updates[0]!.patch).toEqual({
    name: "Renamed",
    active: false,
    baseUrl: "https://new.example.com",
    providerOrg: null,
    headers: { "X-Env": "prod" },
    metadata: { owner: "infra" },
    httpTimeoutMs: null,
  });
  expect("sdkType" in repo.updates[0]!.patch).toBe(false);
  expect("apiKey" in repo.updates[0]!.patch).toBe(false);

  // masked view reflects the repository result
  expect(view.name).toBe("Renamed");
  expect(view.active).toBe(false);
  expect(view.headers).toEqual({ "X-Env": true });
  expect(view.metadata).toEqual({ owner: "infra" });
});

test("updateProvider: NotFoundError when repository update misses", async () => {
  const repo = providerRepo(); // update → null
  const crypto = cryptoFake();
  const err = await runFail(
    updateProvider({
      organizationId: orgId,
      providerId,
      patch: { name: "Nope" },
      isKnownSdkType: () => true,
    }),
    Layer.mergeAll(repo.layer, crypto.layer),
  );
  if (!(err instanceof NotFoundError)) {
    throw new Error(`expected NotFoundError, got ${String(err)}`);
  }
  expect(err.message).toBe("Provider not found");
  expect(err.resource).toBe("provider");
  expect(err.id).toBe(providerId);
  expect(repo.events).toEqual(["update"]);
});

test("updateProvider: repository failure passes through unmodified", async () => {
  const repoErr = new PersistenceUnavailableError({
    code: "persistence_unavailable",
    message: "db down",
    retryClass: "transient",
  });
  const repo = providerRepo({ failOn: { update: repoErr } });
  const crypto = cryptoFake();
  const err = await runFail(
    updateProvider({
      organizationId: orgId,
      providerId,
      patch: { name: "X" },
      isKnownSdkType: () => true,
    }),
    Layer.mergeAll(repo.layer, crypto.layer),
  );
  expect(err).toBe(repoErr);
});

test("deleteProvider: deletes unreferenced provider and returns {ok:true}", async () => {
  const repo = providerRepo({
    findByIdDoc: providerDoc(),
    refCount: 0,
    deleteOk: true,
  });
  const res = await runOk(
    deleteProvider({ organizationId: orgId, providerId }),
    repo.layer,
  );
  expect(res).toEqual({ ok: true });
  expect(repo.events).toEqual([
    "findById",
    "countModelRefs",
    "deleteWithCatalog",
  ]);
});

test("deleteProvider: NotFoundError when provider missing, no delete attempted", async () => {
  const repo = providerRepo(); // findById → null
  const err = await runFail(
    deleteProvider({ organizationId: orgId, providerId }),
    repo.layer,
  );
  if (!(err instanceof NotFoundError)) {
    throw new Error(`expected NotFoundError, got ${String(err)}`);
  }
  expect(err.resource).toBe("provider");
  expect(err.id).toBe(providerId);
  expect(repo.events).toEqual(["findById"]);
});

test("deleteProvider: ConflictError when models still reference the provider", async () => {
  const repo = providerRepo({ findByIdDoc: providerDoc(), refCount: 2 });
  const err = await runFail(
    deleteProvider({ organizationId: orgId, providerId }),
    repo.layer,
  );
  if (!(err instanceof ConflictError)) {
    throw new Error(`expected ConflictError, got ${String(err)}`);
  }
  expect(err.code).toBe("provider_in_use");
  expect(err.message).toContain("2 model(s)");
  expect(repo.events).toEqual(["findById", "countModelRefs"]);
});

test("deleteProvider: NotFoundError when deleteWithCatalog reports false", async () => {
  const repo = providerRepo({ findByIdDoc: providerDoc(), deleteOk: false });
  const err = await runFail(
    deleteProvider({ organizationId: orgId, providerId }),
    repo.layer,
  );
  if (!(err instanceof NotFoundError)) {
    throw new Error(`expected NotFoundError, got ${String(err)}`);
  }
  expect(repo.events).toEqual([
    "findById",
    "countModelRefs",
    "deleteWithCatalog",
  ]);
});

test("deleteProvider: repository failure passes through unmodified", async () => {
  const repoErr = new PersistenceUnavailableError({
    code: "persistence_unavailable",
    message: "db down",
    retryClass: "transient",
  });
  const repo = providerRepo({ failOn: { findById: repoErr } });
  const err = await runFail(
    deleteProvider({ organizationId: orgId, providerId }),
    repo.layer,
  );
  expect(err).toBe(repoErr);
});
