import { expect, test } from "bun:test";
import {
  PROVIDER_PRESETS,
  applyProviderPreset,
  getDefaultProviderPresetId,
  getProviderPreset,
  type ProviderPreset,
} from "../provider-presets.ts";

const BACKEND_SDK_TYPE_PATTERN =
  /^(openai-compatible|anthropic-compatible|plugin:[a-z0-9_-]+)$/;

const ALLOWED_CATEGORIES = new Set(["cloud", "router", "local", "custom"]);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

test("provider preset ids are unique and stable", () => {
  const ids = PROVIDER_PRESETS.map((preset) => preset.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id.length).toBeGreaterThan(0);
    expect(id === id.trim()).toBe(true);
    expect(/\s/.test(id)).toBe(false);
  }
});

test("provider presets map only to valid dialog-compatible values", () => {
  for (const preset of PROVIDER_PRESETS) {
    expect(preset.label.trim().length).toBeGreaterThan(0);
    expect(ALLOWED_CATEGORIES.has(preset.category)).toBe(true);
    expect(BACKEND_SDK_TYPE_PATTERN.test(preset.sdkType)).toBe(true);
    expect(preset.baseUrl.trim() === preset.baseUrl).toBe(true);
    expect(preset.baseUrl.endsWith("/")).toBe(false);
    expect(preset.baseUrl.includes("/chat/completions")).toBe(false);
    expect(preset.baseUrl.includes("/v1/messages")).toBe(false);

    if (preset.category === "custom") {
      expect(preset.baseUrl).toBe("");
    } else {
      expect(preset.defaultName.trim().length).toBeGreaterThan(0);
      expect(isHttpUrl(preset.baseUrl)).toBe(true);
    }
  }
});

test("expected famous providers remain available as presets", () => {
  const expected = [
    "openai",
    "anthropic",
    "google-gemini",
    "groq",
    "mistral",
    "deepseek",
    "xai",
    "cerebras",
    "together",
    "fireworks",
    "perplexity",
    "cohere",
    "ollama-cloud",
    "openrouter",
    "ollama-local",
    "lmstudio",
    "vllm",
    "custom-openai",
    "custom-anthropic",
  ];

  for (const id of expected) {
    const preset = getProviderPreset(id);
    expect(preset).toBeDefined();
    expect(preset?.id === id).toBe(true);
  }
});

test("getDefaultProviderPresetId prefers OpenAI, then non-custom, then first", () => {
  expect(getDefaultProviderPresetId(PROVIDER_PRESETS)).toBe("openai");
  expect(getDefaultProviderPresetId([])).toBe("");

  const withoutOpenAi = PROVIDER_PRESETS.filter(
    (preset) => preset.id !== "openai",
  );
  const fallback = getDefaultProviderPresetId(withoutOpenAi);
  expect(fallback.length).toBeGreaterThan(0);
  expect(getProviderPreset(fallback)?.category).not.toBe("custom");

  const customOnly = PROVIDER_PRESETS.filter(
    (preset) => preset.category === "custom",
  );
  expect(customOnly.length).toBeGreaterThan(0);
  const firstCustom = customOnly[0];
  expect(firstCustom).toBeDefined();
  expect(getDefaultProviderPresetId(customOnly) === firstCustom?.id).toBe(true);
});

test("applyProviderPreset writes known fields and preserves extra form fields", () => {
  const base = {
    name: "",
    sdkType: "",
    baseUrl: "",
    providerOrg: "",
    apiKey: "do-not-clear",
    headers: "{}",
    httpTimeoutMs: "",
    futureFormField: "keep-me",
  };

  const preset = getProviderPreset("ollama-cloud");
  expect(preset).toBeDefined();

  const next = applyProviderPreset(preset, base);

  expect(next.name).toBe("Ollama Cloud");
  expect(next.sdkType).toBe("openai-compatible");
  expect(next.baseUrl).toBe("https://ollama.com/v1");
  expect(next.providerOrg).toBe("");
  expect(next.apiKey).toBe("do-not-clear");
  expect(next.headers).toBe("{}");
  expect(next.httpTimeoutMs).toBe("");
  expect(next.futureFormField).toBe("keep-me");
});

test("applyProviderPreset silently drops invalid or unknown preset drift", () => {
  const drift = {
    id: "drift",
    label: "Drift",
    category: "cloud",
    sdkType: 123,
    baseUrl: null,
    defaultName: { not: "a string" },
    defaultProviderOrg: 42,
    futurePresetKey: true,
  } as unknown as ProviderPreset;

  const base = {
    name: "Existing",
    sdkType: "openai-compatible",
    baseUrl: "https://example.com/v1",
    providerOrg: "org",
    futureFormField: "keep-me",
  };

  const next = applyProviderPreset(drift, base);

  expect(next).toEqual(base);
});

test("applyProviderPreset returns base unchanged for unknown preset id", () => {
  const base = {
    name: "Existing",
    sdkType: "openai-compatible",
    baseUrl: "https://example.com/v1",
    providerOrg: "",
  };

  expect(applyProviderPreset(getProviderPreset("missing"), base)).toBe(base);
  expect(applyProviderPreset(undefined, base)).toBe(base);
});

test("applying every preset never throws and always yields a valid sdkType", () => {
  const base = {
    name: "",
    sdkType: "",
    baseUrl: "",
    providerOrg: "",
  };

  for (const preset of PROVIDER_PRESETS) {
    const next = applyProviderPreset(preset, base);
    expect(BACKEND_SDK_TYPE_PATTERN.test(next.sdkType)).toBe(true);
    expect(typeof next.baseUrl).toBe("string");
    if (preset.category !== "custom") {
      expect(isHttpUrl(next.baseUrl)).toBe(true);
    }
  }
});
