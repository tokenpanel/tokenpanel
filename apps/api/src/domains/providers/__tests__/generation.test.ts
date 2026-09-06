/**
 * Unit tests for generation.ts pure helpers + completeGeneration workflow.
 * Fake deps injection throughout (never default liveLoadProviderDeps).
 */
import { test, expect } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import {
  ObjectId,
  type ClientSession,
  type Db,
  type MongoClient,
} from "mongodb";
import type {
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  TypedDb,
  UsageRecordDoc,
} from "@tokenpanel/db";
import {
  applyDoneUsage,
  classifyGenerationFailure,
  completeGeneration,
  emptyStreamUsage,
  gateReasoningForModel,
  streamUsageAuthority,
  type GenerationSessionParams,
  type StreamUsageAccumulator,
} from "../generation.ts";
import type { LoadProviderDeps } from "../selection.ts";
import type { BalanceReservation } from "../../billing/workflow.ts";
import type { SettlementActor } from "../../settlement/settle.ts";
import type { LimitReservation } from "../../../lib/rate-limits.ts";
import {
  ProviderRejectedError,
  ProviderUnavailableError,
  SystemError,
} from "../../../errors/families.ts";
import { SAFE_MESSAGES } from "../../../errors/safe-messages.ts";
import { makeProviderError } from "../../../providers/provider-errors.ts";
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
} from "../../../providers/types.ts";
import {
  CustomersRepo,
  type CustomersRepoService,
} from "../../../infrastructure/mongo/repositories/customers.ts";
import {
  UsageRepo,
  type UsageRepoService,
} from "../../../infrastructure/mongo/repositories/usage.ts";
import {
  SettlementOutboxRepo,
  type SettlementOutboxRepoService,
} from "../../../infrastructure/mongo/repositories/settlement-outbox.ts";
import {
  MongoDb,
  type MongoDbService,
} from "../../../runtime/services/mongo-db.ts";

const orgId = new ObjectId().toHexString();
const providerId = new ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function providerDoc(over: Partial<ProviderDoc> = {}): ProviderDoc {
  return {
    _id: new ObjectId(providerId),
    organizationId: new ObjectId(orgId),
    name: "OpenAI",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "enc:sk-live-abc",
    baseUrl: "https://api.openai.test/v1",
    providerOrg: null,
    headers: {},
    active: true,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function entryDoc(over: Partial<ModelEntryDoc> = {}): ModelEntryDoc {
  return {
    id: "entry-1",
    providerId: new ObjectId(providerId),
    upstreamModelId: "gpt-4o",
    priority: 0,
    active: true,
    ...over,
  };
}

function modelDoc(over: Partial<ModelDoc> = {}): ModelDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(orgId),
    aliasId: "gpt-test",
    displayName: "Test model",
    description: null,
    entries: [entryDoc()],
    reasoning: false,
    toolCall: false,
    attachment: false,
    interleaved: null,
    limits: { context: 128000 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function chatResponse(over: Partial<ChatResponse> = {}): ChatResponse {
  return {
    id: "resp_1",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello" },
        finishReason: "stop",
      },
    ],
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      totalTokens: 150,
      cacheAccounting: "subset",
    },
    usageStatus: "reported",
    providerRequestId: "prov_req_1",
    ...over,
  };
}

const playgroundActor: SettlementActor = {
  actorKind: "playground",
  customerId: null,
};

function okAdapter(
  seen: { ctx?: AdapterContext; req?: ChatRequest },
  response: ChatResponse = chatResponse(),
): ProviderAdapter {
  return {
    sdkType: "openai-compatible",
    listModels: () => Effect.die("unused"),
    chatComplete: (ctx, req) => {
      seen.ctx = ctx;
      seen.req = req;
      return Effect.succeed(response);
    },
    streamChat: async function* () {
      yield { type: "error", error: { code: "unused", message: "unused" } };
    },
  };
}

function makeDeps(over: { adapter?: ProviderAdapter } = {}): LoadProviderDeps {
  const seen: { ctx?: AdapterContext; req?: ChatRequest } = {};
  const adapter = over.adapter ?? okAdapter(seen);
  return {
    loadProvider: async (loadedOrg, loadedProvider) =>
      providerDoc({ _id: new ObjectId(loadedProvider.toHexString()), organizationId: new ObjectId(loadedOrg.toHexString()) }),
    getAdapter: () => adapter,
    decryptApiKey: (encrypted) => encrypted.replace(/^enc:/, ""),
    buildAdapterContext: (p) => {
      seen.ctx = p as AdapterContext;
      return p as AdapterContext;
    },
  };
}

function genParams(
  over: Partial<GenerationSessionParams> = {},
): GenerationSessionParams {
  return {
    orgId: new ObjectId(orgId),
    model: modelDoc(),
    request: {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    },
    actor: playgroundActor,
    rules: [],
    protocol: "openai",
    reservation: null,
    reservedMicros: 0,
    gatewayRequestId: "gw_test_1",
    startedAtMs: 1_700_000_000_000,
    priceMicrosOverride: 0,
    deps: makeDeps(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Fake services
// ---------------------------------------------------------------------------

function usageRepoFake(opts: {
  onInsert?: (doc: UsageRecordDoc) => void;
  onBulkUpsert?: (params: BulkUpsertCountersParams) => void;
} = {}): UsageRepoService {
  return {
    findById: () => Effect.die("unused"),
    findByGatewayRequestId: () => Effect.succeed(null),
    list: () => Effect.die("unused"),
    insert: (doc) => {
      opts.onInsert?.(doc);
      return Effect.succeed(doc);
    },
    findCounter: () => Effect.die("unused"),
    insertCounter: () => Effect.die("unused"),
    replaceCounter: () => Effect.die("unused"),
    findWindowCounters: () => Effect.succeed([]),
    bulkUpsertCounters: (params) => {
      opts.onBulkUpsert?.(params);
      return Effect.void;
    },
  };
}

type ReleaseReservedParams = Parameters<
  CustomersRepoService["releaseReserved"]
>[0];
type BulkUpsertCountersParams = Parameters<
  UsageRepoService["bulkUpsertCounters"]
>[0];

function customersRepoFake(opts: {
  onRelease?: (params: ReleaseReservedParams) => void;
} = {}): CustomersRepoService {
  return {
    findById: () => Effect.die("unused"),
    findByIdAnyOrg: () => Effect.succeed(null),
    findByOrgEmail: () => Effect.succeed(null),
    list: () => Effect.die("unused"),
    insert: () => Effect.die("unused"),
    updateById: () => Effect.die("unused"),
    replace: () => Effect.die("unused"),
    insertAdjustment: () => Effect.die("unused"),
    listAdjustments: () => Effect.die("unused"),
    reserveBalance: () => Effect.die("unused"),
    releaseReserved: (params) => {
      opts.onRelease?.(params);
      return Effect.succeed(true);
    },
    settleWithReservation: () => Effect.succeed(true),
    debitBalance: () => Effect.succeed(true),
  };
}

function outboxRepoFake(): SettlementOutboxRepoService {
  return {
    findById: () => Effect.die("unused"),
    findByGatewayRequestId: () => Effect.die("unused"),
    insert: () => Effect.die("unused"),
    insertOrGetByGatewayRequestId: () => Effect.die("unused"),
    listDueCandidates: () => Effect.die("unused"),
    updateById: () => Effect.die("unused"),
    claimOne: () => Effect.die("unused"),
    claimDue: () => Effect.die("unused"),
    renewClaim: () => Effect.die("unused"),
    markReconciled: () => Effect.die("unused"),
    markFailed: () => Effect.die("unused"),
    markAbandoned: () => Effect.die("unused"),
    releaseAfterFailure: () => Effect.die("unused"),
  };
}

const fakeSession = {
  startTransaction: () => {},
  commitTransaction: async () => {},
  abortTransaction: async () => {},
  inTransaction: () => false,
  endSession: () => {},
} as unknown as ClientSession;

const mongoLayer = Layer.succeed(MongoDb, {
  db: {} as TypedDb,
  client: { startSession: () => fakeSession } as unknown as MongoClient,
  rawDb: {} as Db,
  close: async () => {},
} satisfies MongoDbService);

function testLayer(opts: {
  onInsert?: (doc: UsageRecordDoc) => void;
  onBulkUpsert?: (params: BulkUpsertCountersParams) => void;
  onRelease?: (params: ReleaseReservedParams) => void;
}): Layer.Layer<UsageRepo | CustomersRepo | SettlementOutboxRepo | MongoDb> {
  return Layer.mergeAll(
    Layer.succeed(UsageRepo, usageRepoFake(opts)),
    Layer.succeed(CustomersRepo, customersRepoFake(opts)),
    Layer.succeed(SettlementOutboxRepo, outboxRepoFake()),
    mongoLayer,
  );
}

// ---------------------------------------------------------------------------
// gateReasoningForModel
// ---------------------------------------------------------------------------

test("gateReasoningForModel: strips request.reasoning when model is not reasoning-capable", () => {
  const request: ChatRequest = {
    model: "gpt-test",
    messages: [],
    reasoning: { effort: "high" },
  };
  const gated = gateReasoningForModel(request, modelDoc({ reasoning: false }));
  expect(gated).not.toBe(request);
  expect(gated.reasoning).toBeUndefined();
  // Boolean false effort is present too — still stripped on a non-reasoning model.
  const boolGated = gateReasoningForModel(
    { model: "gpt-test", messages: [], reasoning: false },
    modelDoc({ reasoning: false }),
  );
  expect(boolGated.reasoning).toBeUndefined();
});

test("gateReasoningForModel: keeps reasoning effort for reasoning-capable models and when absent", () => {
  const request: ChatRequest = {
    model: "o-test",
    messages: [],
    reasoning: { effort: "low" },
  };
  const kept = gateReasoningForModel(request, modelDoc({ reasoning: true }));
  expect(kept).toBe(request);
  expect(kept.reasoning).toEqual({ effort: "low" });

  const plain: ChatRequest = { model: "o-test", messages: [] };
  expect(gateReasoningForModel(plain, modelDoc({ reasoning: false }))).toBe(
    plain,
  );
});

// ---------------------------------------------------------------------------
// streamUsageAuthority
// ---------------------------------------------------------------------------

function acc(over: Partial<StreamUsageAccumulator> = {}): StreamUsageAccumulator {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedTotalTokens: undefined,
    cacheAccounting: "subset",
    finishReason: "stop",
    streamComplete: false,
    ...over,
  };
}

test("streamUsageAuthority: complete stream with reported usage is authoritative and echoes normalized total", () => {
  const usage = acc({
    streamComplete: true,
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    reportedTotalTokens: 150,
  });
  const result = streamUsageAuthority(usage);
  expect(result.hasAuthoritativeUsage).toBe(true);
  expect(result.normalizedTotal).toBe(150);
  expect(result.usageOutcome).toEqual({
    status: "reported",
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      totalTokens: 150,
      cacheAccounting: "subset",
    },
  });
});

test("streamUsageAuthority: never undercounts additive cache tokens below the parts sum", () => {
  const result = streamUsageAuthority(
    acc({
      streamComplete: true,
      cacheAccounting: "additive",
      promptTokens: 100,
      completionTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      reportedTotalTokens: 150,
    }),
  );
  expect(result.hasAuthoritativeUsage).toBe(true);
  expect(result.normalizedTotal).toBe(175);
  if (result.usageOutcome.status === "reported") {
    expect(result.usageOutcome.usage.totalTokens).toBe(175);
    expect(result.usageOutcome.usage.cacheAccounting).toBe("additive");
  } else {
    throw new Error("expected reported outcome");
  }
});

test("streamUsageAuthority: truncated stream is never authoritative but total is echoed", () => {
  const result = streamUsageAuthority(
    acc({
      promptTokens: 100,
      completionTokens: 50,
      reportedTotalTokens: 150,
      streamComplete: false,
    }),
  );
  expect(result.hasAuthoritativeUsage).toBe(false);
  expect(result.normalizedTotal).toBe(150);
  expect(result.usageOutcome).toEqual({
    status: "missing",
    reason: "stream_truncated",
  });
});

test("streamUsageAuthority: unsafe reported total fails closed as usage_overflow", () => {
  const result = streamUsageAuthority(
    acc({
      streamComplete: true,
      promptTokens: 10,
      completionTokens: 5,
      reportedTotalTokens: -1,
    }),
  );
  expect(result.hasAuthoritativeUsage).toBe(false);
  expect(result.normalizedTotal).toBeNull();
  expect(result.usageOutcome).toEqual({
    status: "missing",
    reason: "usage_overflow",
  });
});

test("streamUsageAuthority: complete zero-token stream is stream_usage_absent", () => {
  const result = streamUsageAuthority(acc({ streamComplete: true }));
  expect(result.hasAuthoritativeUsage).toBe(false);
  expect(result.normalizedTotal).toBe(0);
  expect(result.usageOutcome).toEqual({
    status: "missing",
    reason: "stream_usage_absent",
  });
});

test("emptyStreamUsage: protocol defaults for cache accounting and finish reason", () => {
  expect(emptyStreamUsage("openai")).toEqual({
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedTotalTokens: undefined,
    cacheAccounting: "subset",
    finishReason: "stop",
    streamComplete: false,
  });
  const anthropic = emptyStreamUsage("anthropic");
  expect(anthropic.cacheAccounting).toBe("additive");
  expect(anthropic.finishReason).toBe("end_turn");
});

// ---------------------------------------------------------------------------
// applyDoneUsage
// ---------------------------------------------------------------------------

test("applyDoneUsage: done chunk with streamComplete copies usage with zero defaults", () => {
  const state = acc({ cacheAccounting: "subset" });
  applyDoneUsage(state, {
    type: "done",
    streamComplete: true,
    finishReason: "length",
    usage: {
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    },
  });
  expect(state.promptTokens).toBe(7);
  expect(state.completionTokens).toBe(3);
  expect(state.reasoningTokens).toBe(0);
  expect(state.cacheReadTokens).toBe(0);
  expect(state.cacheWriteTokens).toBe(0);
  expect(state.reportedTotalTokens).toBe(10);
  // Chunk did not stamp cacheAccounting → accumulator keeps its protocol value.
  expect(state.cacheAccounting).toBe("subset");
  expect(state.streamComplete).toBe(true);
  expect(state.finishReason).toBe("length");
});

test("applyDoneUsage: later done chunk overwrites usage and only accepts subset/additive accounting", () => {
  const state = acc({ cacheAccounting: "subset" });
  applyDoneUsage(state, {
    type: "done",
    streamComplete: true,
    usage: {
      promptTokens: 20,
      completionTokens: 10,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      totalTokens: 30,
      cacheAccounting: "additive",
    },
  });
  expect(state.reasoningTokens).toBe(2);
  expect(state.cacheReadTokens).toBe(4);
  expect(state.cacheWriteTokens).toBe(1);
  expect(state.cacheAccounting).toBe("additive");
});

test("applyDoneUsage: non-complete done chunk never copies usage", () => {
  const state = acc({
    promptTokens: 1,
    completionTokens: 1,
    reportedTotalTokens: 99,
  });
  applyDoneUsage(state, {
    type: "done",
    streamComplete: false,
    usage: {
      promptTokens: 500,
      completionTokens: 500,
      totalTokens: 1000,
    },
  });
  expect(state.streamComplete).toBe(false);
  expect(state.promptTokens).toBe(1);
  expect(state.completionTokens).toBe(1);
  expect(state.reportedTotalTokens).toBe(99);
});

test("applyDoneUsage: non-done chunks and non-numeric totals are ignored", () => {
  const state = acc();
  const before: StreamUsageAccumulator = { ...state };
  applyDoneUsage(state, { type: "delta", delta: { content: "x" } });
  applyDoneUsage(state, {
    type: "error",
    error: { code: "boom", message: "boom" },
  });
  expect(state).toEqual(before);

  applyDoneUsage(state, {
    type: "done",
    streamComplete: true,
    usage: {
      promptTokens: 5,
      completionTokens: 5,
      totalTokens: undefined as unknown as number,
    },
  });
  expect(state.streamComplete).toBe(true);
  expect(state.promptTokens).toBe(5);
  expect(state.reportedTotalTokens).toBeUndefined();
});

// ---------------------------------------------------------------------------
// classifyGenerationFailure
// ---------------------------------------------------------------------------

test("classifyGenerationFailure: tagged AppError passes through untouched", () => {
  const tagged = new SystemError({
    code: "system_error",
    message: SAFE_MESSAGES.system_error,
  });
  expect(classifyGenerationFailure(tagged)).toBe(tagged);
});

test("classifyGenerationFailure: tagged ProviderError (4xx) passes through as-is, not re-wrapped", () => {
  const providerError = makeProviderError({
    message: "Invalid request payload",
    category: "http_4xx",
    phase: "request",
    httpStatus: 400,
  });
  const classified: unknown = classifyGenerationFailure(providerError);
  expect(classified).toBe(providerError);
});

test("classifyGenerationFailure: AbortError maps to SystemError with 'aborted' diagnostic", () => {
  const abort = new Error("operation was aborted");
  abort.name = "AbortError";
  const classified = classifyGenerationFailure(abort);
  expect(classified).toBeInstanceOf(SystemError);
  const system = classified as SystemError;
  expect(system.code).toBe("system_error");
  expect(system.message).toBe(SAFE_MESSAGES.system_error);
  expect(system.diagnostic).toBe("aborted");
});

test("classifyGenerationFailure: untagged abort-suffixed failure lands in ProviderRejected family", () => {
  const classified = classifyGenerationFailure(
    new Error("stream aborted after headers"),
  );
  expect(classified).toBeInstanceOf(ProviderRejectedError);
  const rejected = classified as ProviderRejectedError;
  expect(rejected.code).toBe("provider_rejected");
  expect(rejected.category).toBe("abort");
  expect(rejected.message).toBe(SAFE_MESSAGES.provider_rejected);
});

test("classifyGenerationFailure: network failure → ProviderUnavailableError; streamCommitted flips fallback classes", () => {
  const preCommit = classifyGenerationFailure(new TypeError("fetch failed"));
  expect(preCommit).toBeInstanceOf(ProviderUnavailableError);
  const unavailable = preCommit as ProviderUnavailableError;
  expect(unavailable.code).toBe("provider_unavailable");
  expect(unavailable.category).toBe("connection");
  expect(unavailable.phase).toBe("connect");
  expect(unavailable.message).toBe(SAFE_MESSAGES.provider_unavailable);
  expect(unavailable.fallbackClass).toBe("eligible");
  expect(unavailable.streamCommitClass).toBe("not_committed");

  const postCommit = classifyGenerationFailure(new TypeError("fetch failed"), {
    streamCommitted: true,
  });
  expect(postCommit).toBeInstanceOf(ProviderUnavailableError);
  const committed = postCommit as ProviderUnavailableError;
  // Message stays public-safe either way; only commit/fallback classes change.
  expect(committed.message).toBe(SAFE_MESSAGES.provider_unavailable);
  expect(committed.fallbackClass).toBe("ineligible");
  expect(committed.streamCommitClass).toBe("committed");
});

test("classifyGenerationFailure: plain Error maps to safe system_error without leaking raw message", () => {
  const classified = classifyGenerationFailure(
    new Error("ECONNRESET on sk-secret-key endpoint"),
  );
  expect(classified).toBeInstanceOf(SystemError);
  const system = classified as SystemError;
  expect(system.code).toBe("system_error");
  expect(system.message).toBe(SAFE_MESSAGES.internal_server_error);
  expect(system.message).not.toContain("sk-secret-key");
  expect(system.diagnostic).toBe("ECONNRESET on sk-secret-key endpoint");
});

// ---------------------------------------------------------------------------
// completeGeneration
// ---------------------------------------------------------------------------

test("completeGeneration: happy path settles reported usage for an unbilled playground actor", async () => {
  const seen: { ctx?: AdapterContext; req?: ChatRequest } = {};
  const inserts: UsageRecordDoc[] = [];
  const releases: ReleaseReservedParams[] = [];
  const counterWrites: unknown[] = [];

  const exit = await Effect.runPromiseExit(
    completeGeneration(
      genParams({
        deps: makeDeps({ adapter: okAdapter(seen) }),
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          onInsert: (doc) => inserts.push(doc),
          onBulkUpsert: (params) => counterWrites.push(params),
          onRelease: (params) => releases.push(params),
        }),
      ),
    ),
  );

  expect(exit._tag).toBe("Success");
  if (exit._tag !== "Success") throw new Error("expected success exit");
  const result = exit.value;

  // Result fields round-trip.
  expect(result.gatewayRequestId).toBe("gw_test_1");
  expect(result.charges).toEqual({
    costMicros: 0,
    priceMicros: 0,
    currency: "USD",
  });
  expect(result.durationMs).toBeGreaterThan(0);
  expect(result.settlement).toEqual({ settled: true });
  expect(result.response.id).toBe("resp_1");
  expect(result.entry.upstreamModelId).toBe("gpt-4o");
  expect(result.provider.name).toBe("OpenAI");

  // Adapter got the rewritten upstream model, gated reasoning, decrypted key.
  expect(seen.req?.model).toBe("gpt-4o");
  expect(seen.req?.reasoning).toBeUndefined();
  expect(seen.ctx?.apiKey).toBe("sk-live-abc");
  expect(seen.ctx?.baseUrl).toBe("https://api.openai.test/v1");

  // Usage settled exactly once, unbilled (playground), with provenance.
  const [usageRecord] = inserts;
  if (!usageRecord) throw new Error("expected one usage insert");
  expect(usageRecord.totalTokens).toBe(150);
  expect(usageRecord.priceMicros).toBe(0);
  expect(usageRecord.billed).toBe(false);
  expect(usageRecord.actorKind).toBe("playground");
  expect(usageRecord.gatewayRequestId).toBe("gw_test_1");
  expect(usageRecord.providerRequestId).toBe("prov_req_1");
  expect(usageRecord.modelAliasId).toBe("gpt-test");

  // Success never releases preflight holds.
  expect(releases).toHaveLength(0);
  expect(counterWrites).toHaveLength(0);
});

test("completeGeneration: adapter failure releases balance + limit holds and never settles", async () => {
  const releases: ReleaseReservedParams[] = [];
  const counterWrites: BulkUpsertCountersParams[] = [];
  const inserts: UsageRecordDoc[] = [];

  const customerId = new ObjectId();
  const organizationId = new ObjectId(orgId);
  const reservation: BalanceReservation = {
    reservedMicros: 5000,
    customerId,
    organizationId,
  };
  const limitReservation: LimitReservation = {
    organizationId,
    customerId,
    holds: [
      {
        ruleId: "r1",
        dimension: "tokens",
        windowSeconds: 60,
        bucketStart: new Date(0),
        scopeTarget: null,
        reserved: 1200,
        capValue: 8000,
      },
    ],
  };

  const failAdapter: ProviderAdapter = {
    sdkType: "openai-compatible",
    listModels: () => Effect.die("unused"),
    chatComplete: () =>
      Effect.fail(
        makeProviderError({
          message: "quota exceeded",
          category: "auth",
          phase: "request",
          httpStatus: 403,
        }),
      ),
    streamChat: async function* () {
      yield { type: "error", error: { code: "unused", message: "unused" } };
    },
  };

  const exit = await Effect.runPromiseExit(
    completeGeneration(
      genParams({
        reservation,
        limitReservation,
        deps: makeDeps({ adapter: failAdapter }),
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          onInsert: (doc) => inserts.push(doc),
          onBulkUpsert: (params) => counterWrites.push(params),
          onRelease: (params) => releases.push(params),
        }),
      ),
    ),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") throw new Error("expected failure exit");
  const err = Cause.squash(exit.cause) as ProviderRejectedError;
  expect(err).toBeInstanceOf(ProviderRejectedError);
  expect(err.code).toBe("provider_rejected");
  expect(err.httpStatus).toBe(403);
  expect(err.message).toBe("quota exceeded");

  // Balance hold released once with the reservation's exact parameters.
  expect(releases).toEqual([
    { customerId, organizationId, reservedMicros: 5000 },
  ]);
  // Limit hold released as a negative counter increment on the same bucket.
  const [counterWrite] = counterWrites;
  if (!counterWrite) throw new Error("expected one counter write");
  expect(counterWrite.organizationId).toEqual(organizationId);
  expect(counterWrite.customerId).toEqual(customerId);
  expect(counterWrite.entries).toEqual([
    {
      dimension: "tokens",
      windowSeconds: 60,
      bucketStart: new Date(0),
      scopeTarget: null,
      increment: -1200,
    },
  ]);
  // Failure path never reaches settlement.
  expect(inserts).toHaveLength(0);
});
