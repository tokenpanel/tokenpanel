import { test, expect } from "bun:test";
import { Effect } from "effect";
import {
  registerAdapter,
  getAdapter,
  listAdapters,
  buildAdapterContext,
} from "../registry.ts";
import type { ProviderAdapter } from "../types.ts";

function fakeAdapter(sdkType: string): ProviderAdapter {
  return {
    sdkType,
    listModels: () => Effect.succeed([]),
    chatComplete: () =>
      Effect.succeed({
        id: "x",
        model: "x",
        choices: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    streamChat: async function* () {},
  };
}

test("builtin adapters auto-register on module load", () => {
  const list = listAdapters();
  expect(list).toContain("openai-compatible");
  expect(list).toContain("anthropic-compatible");
});

test("getAdapter returns registered adapter by sdkType", () => {
  expect(getAdapter("openai-compatible")?.sdkType).toBe("openai-compatible");
  expect(getAdapter("anthropic-compatible")?.sdkType).toBe("anthropic-compatible");
});

test("getAdapter returns undefined for unregistered sdkType", () => {
  expect(getAdapter("nonexistent")).toBeUndefined();
});

test("registerAdapter adds new adapter, getAdapter retrieves it", () => {
  const a = fakeAdapter("plugin:test-1");
  registerAdapter(a);
  expect(getAdapter("plugin:test-1")).toBe(a);
});

test("registerAdapter overwrites existing sdkType", () => {
  const a1 = fakeAdapter("plugin:test-2");
  const a2 = fakeAdapter("plugin:test-2");
  registerAdapter(a1);
  registerAdapter(a2);
  expect(getAdapter("plugin:test-2")).toBe(a2);
});

test("registerAdapter rejects empty sdkType", () => {
  expect(() => registerAdapter(fakeAdapter(""))).toThrow(/sdkType/);
});

test("buildAdapterContext omits undefined providerOrg + headers, includes when present", () => {
  const c1 = buildAdapterContext({ baseUrl: "https://x.com", apiKey: "k" });
  expect(c1.baseUrl).toBe("https://x.com");
  expect(c1.apiKey).toBe("k");
  expect("providerOrg" in c1).toBe(false);
  expect("headers" in c1).toBe(false);
  expect("timeoutMs" in c1).toBe(false);

  const c2 = buildAdapterContext({ baseUrl: "https://x.com", apiKey: "k", providerOrg: "org-1", headers: { "X-Custom": "v" } });
  expect(c2.providerOrg).toBe("org-1");
  expect(c2.headers).toEqual({ "X-Custom": "v" });

  const c3 = buildAdapterContext({ baseUrl: "https://x.com", apiKey: "k", providerOrg: null });
  expect(c3.providerOrg).toBeNull();

  const c4 = buildAdapterContext({
    baseUrl: "https://x.com",
    apiKey: "k",
    timeoutMs: 30_000,
  });
  expect(c4.timeoutMs).toBe(30_000);

  const c5 = buildAdapterContext({
    baseUrl: "https://x.com",
    apiKey: "k",
    timeoutMs: 0,
  });
  expect("timeoutMs" in c5).toBe(false);
});