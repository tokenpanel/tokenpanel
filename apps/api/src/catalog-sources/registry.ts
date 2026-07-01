import type {
  CatalogSource,
  CatalogSourceSummary,
  FetchedModel,
} from "./types.ts";
import { createModelsDevSource } from "./models-dev.ts";

/**
 * Catalog source registry. Mirrors the provider adapter registry pattern:
 * built-in sources auto-register on module load; future sources (or plugin
 * sources) register via `registerSource` and immediately appear in the API.
 *
 * Responses are cached in-memory with a TTL so repeated dialog opens don't
 * re-fetch a multi-megabyte catalog every time, while still staying fresh.
 */

const TTL_MS = 10 * 60 * 1000;

const sources = new Map<string, CatalogSource>();
const cache = new Map<string, { data: FetchedModel[]; at: number }>();

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
  if (cached && Date.now() - cached.at < TTL_MS) {
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
