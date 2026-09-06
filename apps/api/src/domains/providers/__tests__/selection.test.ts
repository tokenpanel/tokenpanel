/**
 * Unit tests for provider selection + fallback workflows:
 * selectActiveEntries, decideFallback, callWithFallbackWorkflow,
 * streamWithFallbackWorkflow.
 */
import { test, expect } from "bun:test";
import { Cause, Effect } from "effect";
import { ObjectId } from "mongodb";
import type { ModelDoc, ModelEntryDoc, ProviderDoc } from "@tokenpanel/db";
import {
  callWithFallbackWorkflow,
  decideFallback,
  selectActiveEntries,
  streamWithFallbackWorkflow,
  type CallOutcome,
  type CallWithFallbackError,
  type LoadProviderDeps,
  type StreamAttemptEvent,
} from "../selection.ts";
import {
  makeProviderError,
  ProviderError,
} from "../../../providers/provider-errors.ts";
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  StreamChunk,
} from "../../../providers/types.ts";
import {
  ProviderUnavailableError,
  SystemError,
} from "../../../errors/families.ts";

const orgId = new ObjectId();

let providerSeq = 0;
function providerDoc(over: Partial<ProviderDoc> = {}): ProviderDoc {
  providerSeq += 1;
  return {
    _id: new ObjectId(),
    organizationId: orgId,
    name: `Provider ${providerSeq}`,
    sdkType: "openai-compatible",
    apiKeyEncrypted: "enc:secret-key",
    baseUrl: `https://upstream-${providerSeq}.example.com/v1`,
    providerOrg: null,
    headers: {},
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

let entrySeq = 0;
function entryDoc(over: Partial<ModelEntryDoc> = {}): ModelEntryDoc {
  entrySeq += 1;
  return {
    id: `e${entrySeq}`,
    providerId: new ObjectId(),
    upstreamModelId: `upstream-${entrySeq}`,
    priority: 0,
    active: true,
    ...over,
  };
}

function modelDoc(entries: ModelEntryDoc[]): ModelDoc {
  return {
    _id: new ObjectId(),
    organizationId: orgId,
    aliasId: "gpt-test",
    displayName: "Test model",
    description: null,
    entries,
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
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function chatRequest(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    ...over,
  };
}

function chatResponse(model: string): ChatResponse {
  return {
    id: "resp-1",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finishReason: "stop",
      },
    ],
    usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    usageStatus: "reported",
  };
}

function streamGen(
  chunks: StreamChunk[],
): AsyncGenerator<StreamChunk, void, void> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function emptyStream(): AsyncGenerator<StreamChunk, void, void> {
  return (async function* () {})();
}

function fakeAdapter(opts: {
  chat?: (req: ChatRequest) => Effect.Effect<ChatResponse, ProviderError>;
  stream?: (req: ChatRequest) => AsyncGenerator<StreamChunk, void, void>;
}): ProviderAdapter {
  return {
    sdkType: "openai-compatible",
    listModels: () => Effect.die("listModels unused"),
    chatComplete: (_ctx, req) =>
      opts.chat ? opts.chat(req) : Effect.die("chatComplete unused"),
    streamChat: (_ctx, req) => (opts.stream ? opts.stream(req) : emptyStream()),
  };
}

type DepsSpy = {
  readonly loadCalls: string[];
  readonly decryptCalls: string[];
  readonly contexts: { baseUrl: string; apiKey: string }[];
};

function fakeDeps(opts: {
  providerFor: (providerIdHex: string) => ProviderDoc;
  adapterFor: (sdkType: string) => ProviderAdapter | undefined;
  decrypt?: (encrypted: string) => string;
}): LoadProviderDeps & DepsSpy {
  const spy: DepsSpy = { loadCalls: [], decryptCalls: [], contexts: [] };
  const deps: LoadProviderDeps = {
    loadProvider: (_orgId, providerId) => {
      const hex = providerId.toHexString();
      spy.loadCalls.push(hex);
      return Promise.resolve(opts.providerFor(hex));
    },
    getAdapter: (sdkType) => opts.adapterFor(sdkType),
    decryptApiKey: (encrypted) => {
      spy.decryptCalls.push(encrypted);
      return opts.decrypt
        ? opts.decrypt(encrypted)
        : encrypted.replace(/^enc:/, "");
    },
    buildAdapterContext: (p) => {
      spy.contexts.push({ baseUrl: p.baseUrl, apiKey: p.apiKey });
      const ctx: AdapterContext = {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        ...(p.providerOrg !== undefined ? { providerOrg: p.providerOrg } : {}),
        ...(p.headers !== undefined ? { headers: p.headers } : {}),
        ...(p.signal !== undefined ? { signal: p.signal } : {}),
        ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
      };
      return ctx;
    },
  };
  return { ...deps, ...spy };
}

async function failureOf(
  effect: Effect.Effect<CallOutcome, CallWithFallbackError>,
): Promise<CallWithFallbackError> {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag !== "Failure") {
    throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`);
  }
  return Cause.squash(exit.cause) as CallWithFallbackError;
}

async function collectStream(
  params: Parameters<typeof streamWithFallbackWorkflow>[0],
): Promise<StreamAttemptEvent[]> {
  const events: StreamAttemptEvent[] = [];
  for await (const ev of streamWithFallbackWorkflow(params)) events.push(ev);
  return events;
}

// ---------------------------------------------------------------------------
// selectActiveEntries
// ---------------------------------------------------------------------------

test("selectActiveEntries: filters inactive entries and sorts priority ascending", () => {
  const high = entryDoc({ id: "high", priority: 7 });
  const off = entryDoc({ id: "off", priority: 0, active: false });
  const low = entryDoc({ id: "low", priority: 2 });
  const model = modelDoc([high, off, low]);
  const result = selectActiveEntries(model);
  expect(result.map((e) => e.id)).toEqual(["low", "high"]);
  // Source array is copied, never mutated.
  expect(model.entries.map((e) => e.id)).toEqual(["high", "off", "low"]);
});

test("selectActiveEntries: stable sort keeps original order for equal priority", () => {
  const a = entryDoc({ id: "a", priority: 1 });
  const b = entryDoc({ id: "b", priority: 1 });
  const c = entryDoc({ id: "c", priority: 0 });
  const result = selectActiveEntries(modelDoc([a, b, c]));
  expect(result.map((e) => e.id)).toEqual(["c", "a", "b"]);
});

// ---------------------------------------------------------------------------
// decideFallback
// ---------------------------------------------------------------------------

test("decideFallback: stream_committed blocks fallback even for eligible errors", () => {
  const eligible = new TypeError("fetch failed");
  expect(decideFallback({ err: eligible, streamCommitted: true })).toEqual({
    allow: false,
    reason: "stream_committed",
  });
});

test("decideFallback: fallback_eligible for pre-commit capacity and connect failures", () => {
  const capacity = makeProviderError({
    message: "overloaded",
    category: "capacity",
    phase: "headers",
    httpStatus: 429,
    fallbackEligible: true,
  });
  expect(decideFallback({ err: capacity, streamCommitted: false })).toEqual({
    allow: true,
    reason: "fallback_eligible",
  });
  expect(
    decideFallback({ err: new Error("fetch failed"), streamCommitted: false })
      .allow,
  ).toBe(true);
});

test("decideFallback: not_fallback_eligible for terminal 4xx failures", () => {
  const invalid = makeProviderError({
    message: "invalid_request_error",
    category: "validation",
    phase: "request",
    httpStatus: 400,
  });
  expect(decideFallback({ err: invalid, streamCommitted: false })).toEqual({
    allow: false,
    reason: "not_fallback_eligible",
  });
});

// ---------------------------------------------------------------------------
// callWithFallbackWorkflow
// ---------------------------------------------------------------------------

test("callWithFallbackWorkflow: fails no_active_entries when every entry is inactive", async () => {
  const off = entryDoc({ active: false });
  const deps = fakeDeps({
    providerFor: () => {
      throw new Error("must not load any provider");
    },
    adapterFor: () => fakeAdapter({}),
  });
  const err = await failureOf(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([off]),
      request: chatRequest(),
      deps,
    }),
  );
  if (!(err instanceof ProviderUnavailableError)) {
    throw new Error(`expected ProviderUnavailableError, got ${String(err)}`);
  }
  expect(err.code).toBe("no_active_entries");
  expect(deps.loadCalls).toEqual([]);
});

test("callWithFallbackWorkflow: success rewrites upstream model, uses decrypted key, no retry", async () => {
  const provider = providerDoc();
  const entry = entryDoc({
    providerId: provider._id,
    upstreamModelId: "gpt-4o-2024",
  });
  const seen: ChatRequest[] = [];
  const adapter = fakeAdapter({
    chat: (req) => {
      seen.push(req);
      return Effect.succeed(chatResponse(req.model));
    },
  });
  const deps = fakeDeps({ providerFor: () => provider, adapterFor: () => adapter });
  const exit = await Effect.runPromiseExit(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([entry]),
      request: chatRequest(),
      deps,
    }),
  );
  expect(exit._tag).toBe("Success");
  if (exit._tag !== "Success") throw new Error("expected success");
  expect(exit.value.entry.id).toBe(entry.id);
  expect(exit.value.provider._id.toHexString()).toBe(
    provider._id.toHexString(),
  );
  expect(exit.value.response.model).toBe("gpt-4o-2024");
  // Single attempt, model rewritten to the entry's upstream id.
  expect(seen).toHaveLength(1);
  expect(seen[0]!.model).toBe("gpt-4o-2024");
  expect(seen[0]!.messages).toEqual([{ role: "user", content: "hello" }]);
  expect(deps.contexts).toEqual([
    { baseUrl: provider.baseUrl, apiKey: "secret-key" },
  ]);
  expect(deps.decryptCalls).toEqual(["enc:secret-key"]);
});

test("callWithFallbackWorkflow: provider load failure wraps provider_unavailable and continues when eligible", async () => {
  const dead = providerDoc({ name: "dead" });
  const live = providerDoc({ name: "live" });
  const deadEntry = entryDoc({
    providerId: dead._id,
    upstreamModelId: "dead-up",
    priority: 0,
  });
  const liveEntry = entryDoc({
    providerId: live._id,
    upstreamModelId: "live-up",
    priority: 1,
  });
  const chatLog: string[] = [];
  const adapter = fakeAdapter({
    chat: (req) => {
      chatLog.push(req.model);
      return Effect.succeed(chatResponse(req.model));
    },
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === dead._id.toHexString()) {
        throw new Error("fetch failed: connect ECONNREFUSED");
      }
      return live;
    },
    adapterFor: () => adapter,
  });
  const exit = await Effect.runPromiseExit(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([deadEntry, liveEntry]),
      request: chatRequest(),
      deps,
    }),
  );
  expect(exit._tag).toBe("Success");
  if (exit._tag !== "Success") throw new Error("expected success");
  expect(exit.value.entry.id).toBe(liveEntry.id);
  // Wrapped provider_unavailable stayed fallback_eligible → second entry ran.
  expect(deps.loadCalls).toEqual([
    dead._id.toHexString(),
    live._id.toHexString(),
  ]);
  expect(chatLog).toEqual(["live-up"]);
});

test("callWithFallbackWorkflow: eligible provider_unavailable exhaustion reports wrapped message via all_providers_failed", async () => {
  const provider = providerDoc();
  const deps = fakeDeps({
    providerFor: () => {
      throw new Error("fetch failed");
    },
    adapterFor: () => fakeAdapter({}),
  });
  const err = await failureOf(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([entryDoc({ providerId: provider._id })]),
      request: chatRequest(),
      deps,
    }),
  );
  if (!(err instanceof ProviderUnavailableError)) {
    throw new Error(`expected ProviderUnavailableError, got ${String(err)}`);
  }
  expect(err.code).toBe("all_providers_failed");
  // lastErr is the provider_unavailable wrapper carrying the original message.
  expect(err.message).toBe("fetch failed");
});

test("callWithFallbackWorkflow: ineligible chat failure classifies and stops without trying next entry", async () => {
  const first = providerDoc({ name: "first" });
  const second = providerDoc({ name: "second" });
  const rejected = makeProviderError({
    message: "invalid api key",
    category: "auth",
    phase: "request",
    httpStatus: 401,
  });
  const adapter = fakeAdapter({
    chat: () => Effect.fail(rejected),
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === first._id.toHexString()) return first;
      throw new Error(`unexpected provider load ${hex}`);
    },
    adapterFor: () => adapter,
  });
  const err = await failureOf(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([
        entryDoc({ providerId: first._id, upstreamModelId: "first-up" }),
        entryDoc({ providerId: second._id, upstreamModelId: "second-up" }),
      ]),
      request: chatRequest(),
      deps,
    }),
  );
  if (err._tag !== "ProviderRejectedError") {
    throw new Error(`expected ProviderRejectedError, got ${err._tag}`);
  }
  // auth → ProviderRejectedError branch of the classifier.
  expect(err._tag).toBe("ProviderRejectedError");
  expect(err.code).toBe("provider_rejected");
  expect(err.category).toBe("auth");
  // Second entry never prepared.
  expect(deps.loadCalls).toEqual([first._id.toHexString()]);
});

test("callWithFallbackWorkflow: all eligible chat failures exhaust to all_providers_failed with last message", async () => {
  const first = providerDoc({ name: "first" });
  const second = providerDoc({ name: "second" });
  const adapter = fakeAdapter({
    chat: (req) =>
      Effect.fail(
        makeProviderError({
          message: `${req.model} overloaded`,
          category: "http_5xx",
          phase: "headers",
          httpStatus: 503,
          fallbackEligible: true,
        }),
      ),
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === first._id.toHexString()) return first;
      if (hex === second._id.toHexString()) return second;
      throw new Error(`unexpected provider load ${hex}`);
    },
    adapterFor: () => adapter,
  });
  const err = await failureOf(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([
        entryDoc({ providerId: first._id, upstreamModelId: "first-up" }),
        entryDoc({ providerId: second._id, upstreamModelId: "second-up" }),
      ]),
      request: chatRequest(),
      deps,
    }),
  );
  if (!(err instanceof ProviderUnavailableError)) {
    throw new Error(`expected ProviderUnavailableError, got ${String(err)}`);
  }
  expect(err.code).toBe("all_providers_failed");
  expect(err.message).toBe("second-up overloaded");
  expect(deps.loadCalls).toEqual([
    first._id.toHexString(),
    second._id.toHexString(),
  ]);
});

test("callWithFallbackWorkflow: missing adapter wraps adapter_missing and fails classified", async () => {
  const provider = providerDoc({ sdkType: "weird-sdk" });
  const deps = fakeDeps({
    providerFor: () => provider,
    adapterFor: () => undefined,
  });
  const err = await failureOf(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([entryDoc({ providerId: provider._id })]),
      request: chatRequest(),
      deps,
    }),
  );
  if (!(err instanceof SystemError)) {
    throw new Error(`expected SystemError, got ${String(err)}`);
  }
  expect(err._tag).toBe("SystemError");
  expect(err.diagnostic).toBe("No adapter for sdkType 'weird-sdk'");
  // Prepare aborted before credential decryption.
  expect(deps.decryptCalls).toEqual([]);
});

test("callWithFallbackWorkflow: decrypt failure wraps provider_unavailable and fails classified", async () => {
  const provider = providerDoc();
  const deps = fakeDeps({
    providerFor: () => provider,
    adapterFor: () => fakeAdapter({}),
    decrypt: () => {
      throw new Error("bad gcm tag");
    },
  });
  const err = await failureOf(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([entryDoc({ providerId: provider._id })]),
      request: chatRequest(),
      deps,
    }),
  );
  if (!(err instanceof SystemError)) {
    throw new Error(`expected SystemError, got ${String(err)}`);
  }
  expect(err.diagnostic).toBe("Failed to decrypt provider credentials");
  expect(deps.contexts).toEqual([]);
});

test("callWithFallbackWorkflow: ineligible provider load failure keeps original message in diagnostic", async () => {
  const provider = providerDoc();
  const deps = fakeDeps({
    providerFor: () => {
      throw new Error("replica set unreachable");
    },
    adapterFor: () => fakeAdapter({}),
  });
  const err = await failureOf(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([entryDoc({ providerId: provider._id })]),
      request: chatRequest(),
      deps,
    }),
  );
  if (!(err instanceof SystemError)) {
    throw new Error(`expected SystemError, got ${String(err)}`);
  }
  expect(err.diagnostic).toBe("replica set unreachable");
});

test("callWithFallbackWorkflow: attempts entries in priority order skipping inactive", async () => {
  const pFail = providerDoc({ name: "fail" });
  const pSkip = providerDoc({ name: "skip" });
  const pOk = providerDoc({ name: "ok" });
  const eInactive = entryDoc({
    id: "skip",
    providerId: pSkip._id,
    priority: 0,
    active: false,
  });
  const eFail = entryDoc({
    id: "fail",
    providerId: pFail._id,
    upstreamModelId: "fail-up",
    priority: 1,
  });
  const eOk = entryDoc({
    id: "ok",
    providerId: pOk._id,
    upstreamModelId: "ok-up",
    priority: 2,
  });
  const chatLog: string[] = [];
  const adapter = fakeAdapter({
    chat: (req) => {
      chatLog.push(req.model);
      return req.model === "fail-up"
        ? Effect.fail(
            makeProviderError({
              message: "fail-up 503",
              category: "http_5xx",
              phase: "headers",
              httpStatus: 503,
              fallbackEligible: true,
            }),
          )
        : Effect.succeed(chatResponse(req.model));
    },
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === pFail._id.toHexString()) return pFail;
      if (hex === pOk._id.toHexString()) return pOk;
      throw new Error(`unexpected provider load ${hex}`);
    },
    adapterFor: () => adapter,
  });
  const exit = await Effect.runPromiseExit(
    callWithFallbackWorkflow({
      orgId,
      model: modelDoc([eInactive, eFail, eOk]),
      request: chatRequest(),
      deps,
    }),
  );
  expect(exit._tag).toBe("Success");
  if (exit._tag !== "Success") throw new Error("expected success");
  expect(exit.value.entry.id).toBe("ok");
  expect(deps.loadCalls).toEqual([
    pFail._id.toHexString(),
    pOk._id.toHexString(),
  ]);
  expect(chatLog).toEqual(["fail-up", "ok-up"]);
});

// ---------------------------------------------------------------------------
// streamWithFallbackWorkflow
// ---------------------------------------------------------------------------

test("streamWithFallbackWorkflow: no active entries yields single synthetic terminal_fail", async () => {
  const off = entryDoc({ active: false });
  const deps = fakeDeps({
    providerFor: () => {
      throw new Error("must not load any provider");
    },
    adapterFor: () => fakeAdapter({}),
  });
  const events = await collectStream({
    orgId,
    model: modelDoc([off]),
    request: chatRequest(),
    deps,
  });
  expect(events).toHaveLength(1);
  const ev = events[0]!;
  expect(ev.kind).toBe("terminal_fail");
  if (ev.kind !== "terminal_fail") throw new Error("expected terminal_fail");
  expect(ev.provider).toBeNull();
  expect(ev.streamCommitted).toBe(false);
  expect(ev.entry).toEqual({
    id: "",
    providerId: orgId,
    upstreamModelId: "",
    priority: 0,
    active: false,
  });
  if (!(ev.err instanceof ProviderUnavailableError)) {
    throw new Error(`expected ProviderUnavailableError, got ${String(ev.err)}`);
  }
  expect(ev.err.code).toBe("no_active_entries");
  expect(deps.loadCalls).toEqual([]);
});

test("streamWithFallbackWorkflow: eligible error chunk fails over then streams next entry", async () => {
  const p1 = providerDoc({ name: "p1" });
  const p2 = providerDoc({ name: "p2" });
  const e1 = entryDoc({
    providerId: p1._id,
    upstreamModelId: "s1-up",
    priority: 0,
  });
  const e2 = entryDoc({
    providerId: p2._id,
    upstreamModelId: "s2-up",
    priority: 1,
  });
  const adapter = fakeAdapter({
    stream: (req) =>
      req.model === "s1-up"
        ? streamGen([
            {
              type: "error",
              error: { code: "overloaded", message: "ECONNREFUSED 10.0.0.1:443" },
            },
          ])
        : streamGen([
            { type: "delta", delta: { content: "he" } },
            {
              type: "done",
              finishReason: "stop",
              streamComplete: true,
              usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            },
          ]),
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === p1._id.toHexString()) return p1;
      if (hex === p2._id.toHexString()) return p2;
      throw new Error(`unexpected provider load ${hex}`);
    },
    adapterFor: () => adapter,
  });
  const events = await collectStream({
    orgId,
    model: modelDoc([e1, e2]),
    request: chatRequest(),
    deps,
  });
  expect(events).toHaveLength(3);
  const [failover, delta, done] = events as [
    StreamAttemptEvent & { kind: "failover" },
    StreamAttemptEvent & { kind: "chunk" },
    StreamAttemptEvent & { kind: "chunk" },
  ];
  expect(failover.kind).toBe("failover");
  expect(failover.entry.id).toBe(e1.id);
  expect(failover.reason).toBe("fallback_eligible");
  expect(delta.chunk.type).toBe("delta");
  expect(delta.entry.id).toBe(e2.id);
  expect(delta.provider?._id.toHexString()).toBe(p2._id.toHexString());
  expect(delta.streamCommitted).toBe(true);
  expect(done.chunk.type).toBe("done");
  expect(done.chunk.finishReason).toBe("stop");
  expect(done.streamCommitted).toBe(true);
  expect(deps.loadCalls).toEqual([p1._id.toHexString(), p2._id.toHexString()]);
});

test("streamWithFallbackWorkflow: ineligible error chunk yields error chunk then terminal_fail without failover", async () => {
  const p1 = providerDoc({ name: "p1" });
  const p2 = providerDoc({ name: "p2" });
  const e1 = entryDoc({
    providerId: p1._id,
    upstreamModelId: "s1-up",
    priority: 0,
  });
  const e2 = entryDoc({
    providerId: p2._id,
    upstreamModelId: "s2-up",
    priority: 1,
  });
  const adapter = fakeAdapter({
    stream: () =>
      streamGen([
        {
          type: "error",
          error: { code: "invalid_api_key", message: "invalid api key" },
        },
      ]),
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === p1._id.toHexString()) return p1;
      throw new Error(`unexpected provider load ${hex}`);
    },
    adapterFor: () => adapter,
  });
  const events = await collectStream({
    orgId,
    model: modelDoc([e1, e2]),
    request: chatRequest(),
    deps,
  });
  expect(events).toHaveLength(2);
  const [chunk, terminal] = events as [
    StreamAttemptEvent & { kind: "chunk" },
    StreamAttemptEvent & { kind: "terminal_fail" },
  ];
  expect(chunk.chunk.type).toBe("error");
  expect(chunk.chunk.error?.message).toBe("invalid api key");
  expect(chunk.provider?._id.toHexString()).toBe(p1._id.toHexString());
  expect(chunk.streamCommitted).toBe(false);
  expect(terminal.entry.id).toBe(e1.id);
  expect(terminal.provider?._id.toHexString()).toBe(p1._id.toHexString());
  expect(terminal.streamCommitted).toBe(false);
  expect((terminal.err as Error).message).toBe("invalid api key");
  // Second entry never prepared.
  expect(deps.loadCalls).toEqual([p1._id.toHexString()]);
});

test("streamWithFallbackWorkflow: committed stream blocks third fallback, terminal_fail streamCommitted true", async () => {
  const p1 = providerDoc({ name: "p1" });
  const p2 = providerDoc({ name: "p2" });
  const p3 = providerDoc({ name: "p3" });
  const e1 = entryDoc({
    providerId: p1._id,
    upstreamModelId: "s1-up",
    priority: 0,
  });
  const e2 = entryDoc({
    providerId: p2._id,
    upstreamModelId: "s2-up",
    priority: 1,
  });
  const e3 = entryDoc({
    providerId: p3._id,
    upstreamModelId: "s3-up",
    priority: 2,
  });
  // Would be fallback_eligible if the stream had not committed (429 capacity).
  const midStream = makeProviderError({
    message: "dropped mid-stream",
    category: "capacity",
    phase: "headers",
    httpStatus: 429,
    fallbackEligible: true,
  });
  const streamCalls: string[] = [];
  const adapter = fakeAdapter({
    stream: (req) => {
      streamCalls.push(req.model);
      if (req.model === "s1-up") {
        return streamGen([
          {
            type: "error",
            error: { code: "overloaded", message: "ECONNREFUSED" },
          },
        ]);
      }
      if (req.model === "s2-up") {
        return async function* (): AsyncGenerator<StreamChunk, void, void> {
          yield { type: "delta", delta: { content: "partial" } };
          throw midStream;
        }();
      }
      return streamGen([{ type: "delta", delta: { content: "never" } }]);
    },
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === p1._id.toHexString()) return p1;
      if (hex === p2._id.toHexString()) return p2;
      throw new Error(`unexpected provider load ${hex}`);
    },
    adapterFor: () => adapter,
  });
  const events = await collectStream({
    orgId,
    model: modelDoc([e1, e2, e3]),
    request: chatRequest(),
    deps,
  });
  const failovers = events.filter((ev) => ev.kind === "failover");
  expect(failovers).toHaveLength(1);
  expect(events).toHaveLength(3);
  const terminal = events[2]!;
  expect(terminal.kind).toBe("terminal_fail");
  if (terminal.kind !== "terminal_fail") {
    throw new Error("expected terminal_fail");
  }
  expect(terminal.entry.id).toBe(e2.id);
  expect(terminal.provider?._id.toHexString()).toBe(p2._id.toHexString());
  expect(terminal.err).toBe(midStream);
  expect(terminal.streamCommitted).toBe(true);
  // Third entry never prepared or streamed.
  expect(deps.loadCalls).toEqual([p1._id.toHexString(), p2._id.toHexString()]);
  expect(streamCalls).toEqual(["s1-up", "s2-up"]);
});

test("streamWithFallbackWorkflow: exhaustion after eligible errors yields terminal_fail with provider null", async () => {
  const p1 = providerDoc({ name: "p1" });
  const p2 = providerDoc({ name: "p2" });
  const e1 = entryDoc({
    providerId: p1._id,
    upstreamModelId: "s1-up",
    priority: 0,
  });
  const e2 = entryDoc({
    providerId: p2._id,
    upstreamModelId: "s2-up",
    priority: 1,
  });
  const adapter = fakeAdapter({
    stream: (req) =>
      req.model === "s1-up"
        ? streamGen([
            {
              type: "error",
              error: { code: "overloaded", message: "ECONNREFUSED one" },
            },
          ])
        : streamGen([
            {
              type: "error",
              error: { code: "overloaded", message: "ENOTFOUND api2.example.com" },
            },
          ]),
  });
  const deps = fakeDeps({
    providerFor: (hex) => {
      if (hex === p1._id.toHexString()) return p1;
      if (hex === p2._id.toHexString()) return p2;
      throw new Error(`unexpected provider load ${hex}`);
    },
    adapterFor: () => adapter,
  });
  const events = await collectStream({
    orgId,
    model: modelDoc([e1, e2]),
    request: chatRequest(),
    deps,
  });
  expect(events).toHaveLength(3);
  expect(events[0]!.kind).toBe("failover");
  expect(events[1]!.kind).toBe("failover");
  const terminal = events[2]!;
  expect(terminal.kind).toBe("terminal_fail");
  if (terminal.kind !== "terminal_fail") {
    throw new Error("expected terminal_fail");
  }
  // Last entry echoed, provider null, last error surfaced, nothing committed.
  expect(terminal.entry.id).toBe(e2.id);
  expect(terminal.provider).toBeNull();
  expect(terminal.streamCommitted).toBe(false);
  expect((terminal.err as Error).message).toBe("ENOTFOUND api2.example.com");
});

test("streamWithFallbackWorkflow: missing adapter surfaces adapter_missing wrapper on terminal_fail", async () => {
  const provider = providerDoc({ sdkType: "mystery" });
  const deps = fakeDeps({
    providerFor: () => provider,
    adapterFor: () => undefined,
  });
  const events = await collectStream({
    orgId,
    model: modelDoc([entryDoc({ providerId: provider._id })]),
    request: chatRequest(),
    deps,
  });
  expect(events).toHaveLength(1);
  const terminal = events[0]!;
  expect(terminal.kind).toBe("terminal_fail");
  if (terminal.kind !== "terminal_fail") {
    throw new Error("expected terminal_fail");
  }
  expect(terminal.provider).toBeNull();
  expect(terminal.streamCommitted).toBe(false);
  if (!(terminal.err instanceof ProviderUnavailableError)) {
    throw new Error(`expected ProviderUnavailableError, got ${String(terminal.err)}`);
  }
  expect(terminal.err.code).toBe("adapter_missing");
  expect(terminal.err.message).toBe("No adapter for sdkType 'mystery'");
  expect(deps.loadCalls).toEqual([provider._id.toHexString()]);
});

test("streamWithFallbackWorkflow: maybe-accepted pre-commit failure surfaces accepted_upstream_failed chunk then terminal_fail", async () => {
  const provider = providerDoc();
  const entry = entryDoc({ providerId: provider._id });
  const dropped = makeProviderError({
    message: "upstream dropped after accept",
    category: "capacity",
    phase: "headers",
    httpStatus: 429,
    fallbackEligible: false,
    maybeAcceptedUpstream: true,
  });
  const adapter = fakeAdapter({
    stream: async function* (): AsyncGenerator<StreamChunk, void, void> {
      throw dropped;
    },
  });
  const deps = fakeDeps({
    providerFor: () => provider,
    adapterFor: () => adapter,
  });
  const events = await collectStream({
    orgId,
    model: modelDoc([entry]),
    request: chatRequest(),
    deps,
  });
  expect(events).toHaveLength(2);
  const [chunk, terminal] = events as [
    StreamAttemptEvent & { kind: "chunk" },
    StreamAttemptEvent & { kind: "terminal_fail" },
  ];
  expect(chunk.chunk.type).toBe("error");
  expect(chunk.chunk.error?.code).toBe("accepted_upstream_failed");
  expect(chunk.chunk.error?.message).toBe(
    "provider failed after possible acceptance",
  );
  expect(chunk.streamCommitted).toBe(false);
  expect(terminal.provider?._id.toHexString()).toBe(provider._id.toHexString());
  expect(terminal.err).toBe(dropped);
  expect(terminal.streamCommitted).toBe(false);
});
