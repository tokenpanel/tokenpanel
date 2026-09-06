import { test, expect } from "bun:test";
import { fetchModelsDev } from "../../catalog-sources/models-dev.ts";
import type { FetchedModel } from "../../catalog-sources/types.ts";
import { registerSource, listModels, clearCache } from "../../catalog-sources/registry.ts";
import { DEFAULT_OPERATIONAL_CONFIG } from "../../config/runtime.ts";

/**
 * Pure unit tests (no mongo): models.dev catalog fetch via a manual
 * globalThis.fetch mock, and the registry listModels TTL cache.
 */

// Bun's `typeof fetch` carries a required `preconnect` extension property,
// so mocks are declared as the plain callable shape and cast on install.
type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function installFetchMock(mock: FetchLike): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = mock as unknown as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

// Fixed base instant so Date.now mocking is fully deterministic.
const T0 = 1_700_000_000_000;
function withMockedNow<T>(now: () => number, run: () => Promise<T>): Promise<T> {
  const origNow = Date.now;
  Date.now = now;
  return run().finally(() => {
    Date.now = origNow;
  });
}

const CATALOG_FIXTURE = {
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-5": {
          id: "openai/gpt-5",
          name: "GPT-5",
          reasoning: true,
          tool_call: true,
          structured_output: true,
          temperature: false,
          attachment: true,
          status: "beta",
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 400_000, input: 100_000, output: 8_000 },
          cost: {
            input: 3,
            output: 15,
            reasoning: 12,
            cache_read: 0.3,
            cache_write: 3.75,
            input_audio: 6,
            output_audio: 24,
          },
        },
        // Missing id → dropped by mapModel.
        broken: { name: "no id here" },
      },
    },
    // No explicit provider id → subProvider falls back to the map key.
    "meta-labs": {
      name: "Meta",
      models: {
        small: {
          id: "meta/small",
          name: "",
          status: "ga", // not a real models.dev status → normalized to undefined
          limit: { context: 0 }, // zero context → omitted
          cost: { input: 0.005, output: 0.015 },
        },
      },
    },
    empty: { id: "empty", name: "Provider without models" },
  },
};

test("fetchModelsDev: success flattens providers into FetchedModel[] with usd→units cost", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const restore = installFetchMock(async (input, init) => {
    if (init === undefined) {
      calls.push({ url: String(input) });
    } else {
      calls.push({ url: String(input), init });
    }
    return new Response(JSON.stringify(CATALOG_FIXTURE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const models = await fetchModelsDev();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://models.dev/catalog.json");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toEqual({ Accept: "application/json" });

    expect(models).toHaveLength(2);

    const gpt5 = models.find((m) => m.upstreamModelId === "openai/gpt-5");
    expect(gpt5).toBeDefined();
    expect(gpt5?.sourceId).toBe("models-dev");
    expect(gpt5?.displayName).toBe("GPT-5");
    expect(gpt5?.subProvider).toBe("openai");
    expect(gpt5?.reasoning).toBe(true);
    expect(gpt5?.toolCall).toBe(true);
    expect(gpt5?.structuredOutput).toBe(true);
    expect(gpt5?.temperature).toBe(false);
    expect(gpt5?.attachment).toBe(true);
    expect(gpt5?.status).toBe("beta");
    expect(gpt5?.limits).toEqual({ context: 400_000, input: 100_000, output: 8_000 });
    expect(gpt5?.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(gpt5?.cost).toEqual({
      inputUnitsPerMillion: 300,
      outputUnitsPerMillion: 1500,
      reasoningUnitsPerMillion: 1200,
      cacheReadUnitsPerMillion: 30,
      cacheWriteUnitsPerMillion: 375,
      inputAudioUnitsPerMillion: 600,
      outputAudioUnitsPerMillion: 2400,
    });
    // Original payload preserved for debugging.
    expect((gpt5?.raw as Record<string, unknown> | undefined)?.id).toBe("openai/gpt-5");

    const small = models.find((m) => m.upstreamModelId === "meta/small");
    expect(small?.subProvider).toBe("meta-labs"); // provider.id missing → map key
    expect(small?.displayName).toBe("meta/small"); // empty name → id fallback
    expect(small?.reasoning).toBe(false); // absent → default false
    expect(small?.status).toBeUndefined(); // "ga" is not asserted by the source
    expect(small?.limits).toEqual({}); // zero context omitted
    expect(small?.cost).toEqual({
      inputUnitsPerMillion: 1, // 0.005 usd * 100 → Math.round(0.5) = 1
      outputUnitsPerMillion: 2, // 0.015 usd * 100 → Math.round(1.5) = 2
    });
  } finally {
    restore();
  }
});

test("fetchModelsDev: non-200 → typed Error carrying status and body text", async () => {
  const restore = installFetchMock(
    async () => new Response("upstream exploded", { status: 503 }),
  );
  try {
    const err = await fetchModelsDev().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("models.dev fetch 503");
    expect((err as Error).message).toContain("upstream exploded");
  } finally {
    restore();
  }
});

test("fetchModelsDev: network rejection propagates the fetch error", async () => {
  const restore = installFetchMock(async () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND models.dev");
  });
  try {
    await expect(fetchModelsDev()).rejects.toThrow(/ENOTFOUND models\.dev/);
  } finally {
    restore();
  }
});

test("fetchModelsDev: malformed JSON body → SyntaxError rejection", async () => {
  const restore = installFetchMock(
    async () =>
      new Response('{"providers": { broken', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    await expect(fetchModelsDev()).rejects.toBeInstanceOf(SyntaxError);
  } finally {
    restore();
  }
});

test("listModels cache: first call fetches, within TTL hits cache, expired TTL refetches", async () => {
  const payload: FetchedModel[] = [
    {
      sourceId: "spy",
      upstreamModelId: "spy/m1",
      displayName: "Spy Model",
      limits: {},
      modalities: { input: [], output: [] },
    },
  ];
  let calls = 0;
  registerSource({
    id: "ttl-spy-source",
    displayName: "TTL Spy",
    listModels: async () => {
      calls += 1;
      return payload;
    },
  });
  const ttl = DEFAULT_OPERATIONAL_CONFIG.catalogCacheTtlMs;
  clearCache("ttl-spy-source");

  await withMockedNow(() => T0, async () => {
    // First call: cache miss → fetch.
    const first = await listModels("ttl-spy-source");
    expect(calls).toBe(1);
    expect(first).toBe(payload);

    // Second call inside the TTL window (T0 + ttl - 1 < ttl): served from cache.
    Date.now = () => T0 + ttl - 1;
    const second = await listModels("ttl-spy-source");
    expect(calls).toBe(1);
    expect(second).toBe(payload); // same array instance, no refetch

    // At exactly T0 + ttl the window has expired (`< ttl` is strict) → refetch.
    Date.now = () => T0 + ttl;
    const third = await listModels("ttl-spy-source");
    expect(calls).toBe(2);
    expect(third).toBe(payload);
  });
});

test("listModels cache: clearCache bypasses a still-fresh entry", async () => {
  const payload: FetchedModel[] = [];
  let calls = 0;
  registerSource({
    id: "bypass-spy-source",
    displayName: "Bypass Spy",
    listModels: async () => {
      calls += 1;
      return payload;
    },
  });
  const ttl = DEFAULT_OPERATIONAL_CONFIG.catalogCacheTtlMs;
  clearCache("bypass-spy-source");

  await withMockedNow(() => T0, async () => {
    await listModels("bypass-spy-source");
    expect(calls).toBe(1);

    // Fresh cache would hit…
    Date.now = () => T0 + ttl - 1;
    await listModels("bypass-spy-source");
    expect(calls).toBe(1);

    // …but clearCache is the exposed bypass: next call refetches despite freshness.
    clearCache("bypass-spy-source");
    await listModels("bypass-spy-source");
    expect(calls).toBe(2);
  });
});
