/**
 * Static provider presets for the admin Add Provider dialog.
 *
 * These are UI-only defaults. They are not stored in the database and are
 * never fetched at runtime. The dialog applies only known form fields and
 * silently ignores invalid or unknown preset data, so future drift between
 * presets and the provider form cannot crash the dialog.
 */

export type ProviderPresetSdkType =
  | "openai-compatible"
  | "anthropic-compatible";

export type ProviderPresetCategory = "cloud" | "router" | "local" | "custom";

export type ProviderPreset = Readonly<{
  /** Stable value used by the preset dropdown. */
  id: string;
  /** Human-readable dropdown label. */
  label: string;
  /** Dropdown grouping. */
  category: ProviderPresetCategory;
  /** Maps to provider form "Adapter type". */
  sdkType: ProviderPresetSdkType;
  /**
   * Maps to provider form "Base URL". Empty for custom presets.
   *
   * openai-compatible adapters append `/chat/completions`, so this must not
   * include that suffix. anthropic-compatible adapters append `/v1/messages`,
   * so this must not include that suffix.
   */
  baseUrl: string;
  /** Maps to provider form "Name". Empty leaves the name untouched. */
  defaultName: string;
  /** Placeholder for the API key input. Never sets the API key value. */
  apiKeyPlaceholder?: string;
  /** Maps to provider form "Provider org" when present. */
  defaultProviderOrg?: string;
  /** Optional short hint shown with the preset selector. */
  hint?: string;
}>;

export const PROVIDER_PRESETS = Object.freeze(
  [
    {
      id: "openai",
      label: "OpenAI",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      defaultName: "OpenAI",
      apiKeyPlaceholder: "sk-…",
    },
    {
      id: "anthropic",
      label: "Anthropic",
      category: "cloud",
      sdkType: "anthropic-compatible",
      baseUrl: "https://api.anthropic.com",
      defaultName: "Anthropic",
      apiKeyPlaceholder: "sk-ant-…",
      hint: "Uses the Anthropic Messages API. The app appends /v1/messages.",
    },
    {
      id: "google-gemini",
      label: "Google Gemini",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      defaultName: "Google Gemini",
    },
    {
      id: "groq",
      label: "Groq",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      defaultName: "Groq",
    },
    {
      id: "mistral",
      label: "Mistral",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.mistral.ai/v1",
      defaultName: "Mistral",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      defaultName: "DeepSeek",
    },
    {
      id: "xai",
      label: "xAI / Grok",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.x.ai/v1",
      defaultName: "xAI",
    },
    {
      id: "cerebras",
      label: "Cerebras",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.cerebras.ai/v1",
      defaultName: "Cerebras",
    },
    {
      id: "together",
      label: "Together AI",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1",
      defaultName: "Together AI",
    },
    {
      id: "fireworks",
      label: "Fireworks AI",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      defaultName: "Fireworks AI",
    },
    {
      id: "perplexity",
      label: "Perplexity",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.perplexity.ai",
      defaultName: "Perplexity",
    },
    {
      id: "cohere",
      label: "Cohere",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://api.cohere.com/compatibility/v1",
      defaultName: "Cohere",
      hint: "Uses Cohere's OpenAI-compatible endpoint, not the native /v2 API.",
    },
    {
      id: "ollama-cloud",
      label: "Ollama Cloud",
      category: "cloud",
      sdkType: "openai-compatible",
      baseUrl: "https://ollama.com/v1",
      defaultName: "Ollama Cloud",
      apiKeyPlaceholder: "OLLAMA_API_KEY",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      category: "router",
      sdkType: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultName: "OpenRouter",
    },
    {
      id: "ollama-local",
      label: "Ollama (local)",
      category: "local",
      sdkType: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      defaultName: "Ollama",
      apiKeyPlaceholder: "ollama",
      hint: "Local Ollama usually accepts any non-empty placeholder API key.",
    },
    {
      id: "lmstudio",
      label: "LM Studio (local)",
      category: "local",
      sdkType: "openai-compatible",
      baseUrl: "http://localhost:1234/v1",
      defaultName: "LM Studio",
      apiKeyPlaceholder: "lm-studio",
    },
    {
      id: "vllm",
      label: "vLLM (self-hosted)",
      category: "local",
      sdkType: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      defaultName: "vLLM",
    },
    {
      id: "custom-openai",
      label: "Custom OpenAI-compatible",
      category: "custom",
      sdkType: "openai-compatible",
      baseUrl: "",
      defaultName: "",
    },
    {
      id: "custom-anthropic",
      label: "Custom Anthropic-compatible",
      category: "custom",
      sdkType: "anthropic-compatible",
      baseUrl: "",
      defaultName: "",
    },
  ] as const,
) satisfies readonly ProviderPreset[];

export const PROVIDER_PRESETS_BY_ID = Object.freeze(
  Object.fromEntries(
    PROVIDER_PRESETS.map(
      (preset): [string, ProviderPreset] => [preset.id, preset],
    ),
  ),
) as Readonly<Record<string, ProviderPreset>>;

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS_BY_ID[id];
}

export const DEFAULT_PROVIDER_PRESET_ID = "openai";

export const PROVIDER_PRESET_CATEGORY_ORDER = Object.freeze([
  "cloud",
  "router",
  "local",
  "custom",
] as const) satisfies readonly ProviderPresetCategory[];

export const PROVIDER_PRESET_CATEGORY_LABELS = Object.freeze({
  cloud: "Cloud",
  router: "Routers",
  local: "Local / self-hosted",
  custom: "Custom",
}) satisfies Readonly<Record<ProviderPresetCategory, string>>;

export function getDefaultProviderPresetId(
  presets: readonly ProviderPreset[],
): string {
  const preferred = presets.find(
    (preset) => preset.id === DEFAULT_PROVIDER_PRESET_ID,
  );
  if (preferred) return preferred.id;

  const nonCustom = presets.find((preset) => preset.category !== "custom");
  if (nonCustom) return nonCustom.id;

  return presets[0]?.id ?? "";
}

/**
 * Provider form fields that presets may safely write.
 *
 * The generic apply function preserves any extra fields on the form, so new
 * dialog fields are not lost when a preset is applied.
 */
export type ProviderPresetFormFields = {
  name: string;
  sdkType: string;
  baseUrl: string;
  providerOrg: string;
};

/**
 * Apply a preset to a provider form.
 *
 * Only known, valid preset fields are written. Missing or invalid fields are
 * dropped silently. Extra fields already present on the form are preserved.
 */
export function applyProviderPreset<T extends ProviderPresetFormFields>(
  preset: ProviderPreset | undefined,
  base: T,
): T {
  if (!preset) return base;

  const patch: Partial<ProviderPresetFormFields> = {};

  if (typeof preset.defaultName === "string") patch.name = preset.defaultName;
  if (typeof preset.sdkType === "string") patch.sdkType = preset.sdkType;
  if (typeof preset.baseUrl === "string") patch.baseUrl = preset.baseUrl;
  if (typeof preset.defaultProviderOrg === "string") {
    patch.providerOrg = preset.defaultProviderOrg;
  }

  return { ...base, ...patch } as T;
}
