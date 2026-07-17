import type {
  CatalogSource,
  CatalogSourceSummary,
  FetchedModel,
} from "./types.ts";
import { createModelsDevSource } from "./models-dev.ts";
import { DEFAULT_OPERATIONAL_CONFIG } from "../config/runtime.ts";
import {
  getApiRuntimeConfig,
  isApiRuntimeConfigSet,
} from "../config/state.ts";

/**
 * Catalog source registry. Mirrors the provider adapter registry pattern:
 * built-in sources auto-register on module load; future sources (or plugin
 * sources) register via `registerSource` and immediately appear in the API.
 *
 * Responses are cached in-memory with a TTL from runtime operational config
 * (CATALOG_CACHE_TTL_MS / catalogCacheTtlMs).
 */

const sources = new Map<string, CatalogSource>();
const cache = new Map<string, { data: FetchedModel[]; at: number }>();

function catalogCacheTtlMs(): number {
  if (isApiRuntimeConfigSet()) {
    return getApiRuntimeConfig().operational.catalogCacheTtlMs;
  }
  return DEFAULT_OPERATIONAL_CONFIG.catalogCacheTtlMs;
}

export function registerSource(source: CatalogSource): void {
  if (!source.id || source.id.length === 0) {
    throw new Error("registerSource: source.id is required");
  }
  sources.set(source.id, source);
}

export function getSource(id: string): CatalogSource | undefined {
  return sources.get(id);
}

export function listSources(): CatalogSourceSummary[] {
  return [...sources.values()].map((s) => ({
    id: s.id,
    displayName: s.displayName,
  }));
}

export function clearCache(id?: string): void {
  if (id) {
    cache.delete(id);
    return;
  }
  cache.clear();
}

export async function listModels(id: string): Promise<FetchedModel[]> {
  const source = sources.get(id);
  if (!source) return [];
  const cached = cache.get(id);
  const ttlMs = catalogCacheTtlMs();
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.data;
  }
  const data = await source.listModels();
  cache.set(id, { data, at: Date.now() });
  return data;
}

let initialized = false;
function ensureBuiltins(): void {
  if (initialized) return;
  initialized = true;
  if (!sources.has("models-dev")) {
    sources.set("models-dev", createModelsDevSource());
  }
}
ensureBuiltins();
