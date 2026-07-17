import type { AdapterContext, ProviderAdapter } from "./types.ts";
import { createOpenAICompatibleAdapter } from "./openai-compatible.ts";
import { createAnthropicCompatibleAdapter } from "./anthropic-compatible.ts";

/**
 * Adapter registry. Built-in adapters (openai-compatible,
 * anthropic-compatible) auto-register on module load. Plugins register
 * additional adapters via `registerAdapter` with sdkType "plugin:<id>".
 */
const adapters = new Map<string, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  if (!adapter.sdkType || adapter.sdkType.length === 0) {
    throw new Error("registerAdapter: adapter.sdkType is required");
  }
  adapters.set(adapter.sdkType, adapter);
}

export function getAdapter(sdkType: string): ProviderAdapter | undefined {
  return adapters.get(sdkType);
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

export function buildAdapterContext(opts: {
  baseUrl: string;
  apiKey: string;
  providerOrg?: string | null | undefined;
  headers?: Record<string, string> | undefined;
}): AdapterContext {
  return {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    ...(opts.providerOrg !== undefined ? { providerOrg: opts.providerOrg } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  };
}

let initialized = false;
function ensureBuiltins(): void {
  if (initialized) return;
  initialized = true;
  if (!adapters.has("openai-compatible")) {
    adapters.set("openai-compatible", createOpenAICompatibleAdapter());
  }
  if (!adapters.has("anthropic-compatible")) {
    adapters.set("anthropic-compatible", createAnthropicCompatibleAdapter());
  }
}
ensureBuiltins();