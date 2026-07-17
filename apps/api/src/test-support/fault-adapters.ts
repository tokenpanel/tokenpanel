/**
 * Reusable fault-injection test adapters (task 1.5).
 * Deterministic fakes for Mongo, provider fetch/streams, clock, crypto,
 * cancellation, and settlement/outbox failures — no process-global mutation
 * required by consumers (callers pass adapters explicitly).
 */

export type Clock = {
  nowMs: () => number;
  advanceMs: (delta: number) => void;
  setMs: (ms: number) => void;
};

/** Controllable clock starting at `startMs` (default fixed epoch). */
export function createFakeClock(startMs = Date.parse("2026-01-15T12:00:00.000Z")): Clock {
  let t = startMs;
  return {
    nowMs: () => t,
    advanceMs: (delta) => {
      t += delta;
    },
    setMs: (ms) => {
      t = ms;
    },
  };
}

export type AbortControllerHandle = {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
};

export function createCancellable(): AbortControllerHandle {
  const c = new AbortController();
  return {
    signal: c.signal,
    abort: (reason) => c.abort(reason),
  };
}

/** SSE / stream chunk for provider fakes. */
export type FakeSseEvent =
  | { kind: "data"; data: string }
  | { kind: "error"; status: number; body: string }
  | { kind: "throw"; error: Error }
  | { kind: "hang" };

/**
 * Build a Response body stream from ordered SSE data lines (without "data: " prefix).
 * Appends trailing newlines; empty lines become blank SSE separators.
 */
export function sseBodyFromDataLines(lines: string[]): string {
  return lines.map((l) => (l === "" ? "\n" : `data: ${l}\n\n`)).join("");
}

export type FakeFetchScript =
  | { type: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { type: "text"; status: number; body: string; headers?: Record<string, string> }
  | { type: "sse"; status?: number; dataLines: string[]; headers?: Record<string, string> }
  | { type: "network_error"; message: string }
  | { type: "abort" }
  | { type: "timeout"; afterMs: number };

/**
 * Scripted fetch implementation. Calls are consumed FIFO.
 * Remaining calls after scripts exhaust throw.
 */
export function createScriptedFetch(scripts: FakeFetchScript[]): typeof fetch {
  const queue = [...scripts];
  const impl = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const next = queue.shift();
    if (!next) {
      throw new Error("scripted fetch: no more scripts");
    }
    if (next.type === "network_error") {
      throw new TypeError(next.message);
    }
    if (next.type === "abort") {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (next.type === "timeout") {
      await new Promise((r) => setTimeout(r, next.afterMs));
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      throw new Error("scripted fetch: timeout");
    }
    if (next.type === "json") {
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: {
          "content-type": "application/json",
          ...(next.headers ?? {}),
        },
      });
    }
    if (next.type === "text") {
      return new Response(next.body, {
        status: next.status,
        headers: next.headers ?? {},
      });
    }
    // sse
    const body = sseBodyFromDataLines(next.dataLines);
    return new Response(body, {
      status: next.status ?? 200,
      headers: {
        "content-type": "text/event-stream",
        ...(next.headers ?? {}),
      },
    });
  }) as typeof fetch;
  return impl;
}

/** Install scripted fetch for the duration of `fn`, then restore. */
export async function withScriptedFetch<T>(
  scripts: FakeFetchScript[],
  fn: (fetchImpl: typeof fetch) => Promise<T>,
): Promise<T> {
  const prev = globalThis.fetch;
  const impl = createScriptedFetch(scripts);
  globalThis.fetch = impl;
  try {
    return await fn(impl);
  } finally {
    globalThis.fetch = prev;
  }
}

export type MongoFault =
  | { code: 11000; message?: string }
  | { code: 112; message?: string } // WriteConflict
  | { label: "TransientTransactionError"; message?: string }
  | { label: "UnknownTransactionCommitResult"; message?: string }
  | { kind: "timeout"; message?: string }
  | { kind: "unavailable"; message?: string }
  | { kind: "corrupt"; message?: string };

/** Build an Error that mimics Mongo driver shapes used by classifiers. */
export function createMongoFault(fault: MongoFault): Error {
  if ("code" in fault) {
    const err = new Error(fault.message ?? `Mongo error ${fault.code}`);
    (err as Error & { code: number }).code = fault.code;
    err.name = "MongoServerError";
    return err;
  }
  if ("label" in fault) {
    const err = new Error(fault.message ?? fault.label);
    (err as Error & { errorLabels: string[] }).errorLabels = [fault.label];
    err.name = "MongoError";
    return err;
  }
  if (fault.kind === "timeout") {
    const err = new Error(fault.message ?? "operation timed out");
    err.name = "MongoNetworkTimeoutError";
    return err;
  }
  if (fault.kind === "unavailable") {
    const err = new Error(fault.message ?? "topology destroyed");
    err.name = "MongoServerSelectionError";
    return err;
  }
  const err = new Error(fault.message ?? "corrupt document");
  err.name = "PersistenceDataError";
  return err;
}

export type CryptoFaultMode = "ok" | "fail_sign" | "fail_verify" | "fail_encrypt";

export type FakeCrypto = {
  mode: CryptoFaultMode;
  setMode: (m: CryptoFaultMode) => void;
  sign: (payload: string) => string;
  verify: (token: string) => string;
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  hash: (value: string) => string;
};

/** Deterministic non-crypto stand-ins for unit tests. */
export function createFakeCrypto(): FakeCrypto {
  let mode: CryptoFaultMode = "ok";
  return {
    get mode() {
      return mode;
    },
    setMode: (m) => {
      mode = m;
    },
    sign: (payload) => {
      if (mode === "fail_sign") throw new Error("crypto sign failed");
      return `fake.${Buffer.from(payload).toString("base64url")}.sig`;
    },
    verify: (token) => {
      if (mode === "fail_verify") throw new Error("crypto verify failed");
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "fake") throw new Error("bad token");
      return Buffer.from(parts[1]!, "base64url").toString("utf8");
    },
    encrypt: (plain) => {
      if (mode === "fail_encrypt") throw new Error("crypto encrypt failed");
      return `enc:${Buffer.from(plain).toString("base64url")}`;
    },
    decrypt: (cipher) => {
      if (!cipher.startsWith("enc:")) throw new Error("bad cipher");
      return Buffer.from(cipher.slice(4), "base64url").toString("utf8");
    },
    hash: (value) => `hash:${value}`,
  };
}

export type SettlementFault =
  | "none"
  | "settle_throws"
  | "outbox_enqueue_throws"
  | "outbox_claim_conflict"
  | "outbox_lease_expired";

export type FakeSettlement = {
  fault: SettlementFault;
  setFault: (f: SettlementFault) => void;
  settleCalls: number;
  outboxEnqueues: number;
  settle: () => Promise<"settled" | "outbox">;
  enqueueOutbox: () => Promise<void>;
  claim: () => Promise<"claimed" | "conflict" | "empty">;
};

export function createFakeSettlement(): FakeSettlement {
  let fault: SettlementFault = "none";
  const state: FakeSettlement = {
    get fault() {
      return fault;
    },
    setFault: (f) => {
      fault = f;
    },
    settleCalls: 0,
    outboxEnqueues: 0,
    settle: async () => {
      state.settleCalls += 1;
      if (fault === "settle_throws") throw new Error("settle failed");
      if (fault === "outbox_enqueue_throws") {
        // settle path falls through to outbox
        state.outboxEnqueues += 1;
        throw new Error("outbox enqueue failed");
      }
      return "settled";
    },
    enqueueOutbox: async () => {
      state.outboxEnqueues += 1;
      if (fault === "outbox_enqueue_throws") throw new Error("outbox enqueue failed");
    },
    claim: async () => {
      if (fault === "outbox_claim_conflict") return "conflict";
      if (fault === "outbox_lease_expired") return "empty";
      return "claimed";
    },
  };
  return state;
}

/** OpenAI-compatible normal completion SSE script (includes [DONE]). */
export function openAiNormalStreamScript(usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
}): FakeFetchScript {
  return {
    type: "sse",
    dataLines: [
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      }),
      "[DONE]",
    ],
  };
}

/** OpenAI stream without [DONE] and without usage (committed failure / missing usage). */
export function openAiMissingUsageStreamScript(): FakeFetchScript {
  return {
    type: "sse",
    dataLines: [
      JSON.stringify({
        id: "chatcmpl-2",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "chatcmpl-2",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    ],
  };
}

/** OpenAI stream with malformed JSON event. */
export function openAiMalformedStreamScript(): FakeFetchScript {
  return {
    type: "sse",
    dataLines: [
      "{not-json",
      "[DONE]",
    ],
  };
}

/** Pre-commit failure: HTTP error before any stream body. */
export function providerPreCommitFailureScript(status = 503): FakeFetchScript {
  return {
    type: "json",
    status,
    body: { error: { message: "unavailable", type: "server_error" } },
  };
}
