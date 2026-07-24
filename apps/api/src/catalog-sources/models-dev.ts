import type { CatalogSource, FetchedModel, FetchedModelStatus } from "./types.ts";

/**
 * models.dev catalog source.
 *
 * Fetches https://models.dev/catalog.json and flattens the per-sub-provider
 * model entries (which include pricing) into a single `FetchedModel[]`.
 * models.dev stores provider-agnostic facts under a top-level `models` map
 * and per-provider serving details (pricing, status, limit overrides) under
 * `providers.<id>.models`; we use the per-provider entries because they carry
 * cost, which is what the Add Model form needs.
 *
 * Pricing on models.dev is USD per million tokens (float). We convert to
 * integer units per million (cents) by rounding `usd * 100`, matching
 * the form's "300 = $3.00/M" convention.
 */

const CATALOG_URL = "https://models.dev/catalog.json";

type ModelsDevCost = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  input_audio?: number;
  output_audio?: number;
};

type ModelsDevModel = {
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  status?: string;
  modalities?: { input?: unknown[]; output?: unknown[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: ModelsDevCost;
  [k: string]: unknown;
};

type ModelsDevProvider = {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
};

type CatalogJson = {
  providers?: Record<string, ModelsDevProvider>;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toUnits(usd: number | undefined): number | undefined {
  if (usd === undefined) return undefined;
  return Math.round(usd * 100);
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function normalizeStatus(s: string | undefined): FetchedModelStatus | undefined {
  if (!s) return undefined;
  if (s === "alpha" || s === "beta" || s === "deprecated") return s;
  // models.dev has no "ga" status (ga = absence of status); treat unknowns as
  // undefined so we don't invent lifecycle flags the source didn't assert.
  return undefined;
}

export function mapModel(subProviderId: string, m: ModelsDevModel): FetchedModel | null {
  const id = typeof m.id === "string" && m.id.length > 0 ? m.id : null;
  if (!id) return null;
  const ctx = num(m.limit?.context);
  const input = num(m.limit?.input);
  const output = num(m.limit?.output);
  const cost = m.cost;
  const inUnits = toUnits(cost?.input);
  const outUnits = toUnits(cost?.output);
  const fetchedCost = inUnits !== undefined && outUnits !== undefined
    ? {
        inputUnitsPerMillion: inUnits,
        outputUnitsPerMillion: outUnits,
        ...(toUnits(cost?.reasoning) !== undefined ? { reasoningUnitsPerMillion: toUnits(cost?.reasoning) } : {}),
        ...(toUnits(cost?.cache_read) !== undefined ? { cacheReadUnitsPerMillion: toUnits(cost?.cache_read) } : {}),
        ...(toUnits(cost?.cache_write) !== undefined ? { cacheWriteUnitsPerMillion: toUnits(cost?.cache_write) } : {}),
        ...(toUnits(cost?.input_audio) !== undefined ? { inputAudioUnitsPerMillion: toUnits(cost?.input_audio) } : {}),
        ...(toUnits(cost?.output_audio) !== undefined ? { outputAudioUnitsPerMillion: toUnits(cost?.output_audio) } : {}),
      }
    : undefined;
  return {
    sourceId: "models-dev",
    upstreamModelId: id,
    displayName: typeof m.name === "string" && m.name.length > 0 ? m.name : id,
    subProvider: subProviderId,
    reasoning: m.reasoning ?? false,
    toolCall: m.tool_call ?? false,
    ...(m.structured_output !== undefined ? { structuredOutput: m.structured_output } : {}),
    ...(m.temperature !== undefined ? { temperature: m.temperature } : {}),
    attachment: m.attachment ?? false,
    limits: {
      ...(ctx !== undefined && ctx > 0 ? { context: ctx } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    },
    modalities: {
      input: strArr(m.modalities?.input),
      output: strArr(m.modalities?.output),
    },
    ...(normalizeStatus(m.status) !== undefined ? { status: normalizeStatus(m.status) } : {}),
    ...(fetchedCost !== undefined ? { cost: fetchedCost } : {}),
    raw: m as Record<string, unknown>,
  };
}

export async function fetchModelsDev(): Promise<FetchedModel[]> {
  const res = await fetch(CATALOG_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`models.dev fetch ${res.status}: ${await safeText(res)}`);
  }
  const data = (await res.json()) as CatalogJson;
  const providers = data.providers ?? {};
  const out: FetchedModel[] = [];
  for (const subId of Object.keys(providers)) {
    const p = providers[subId];
    if (!p || !p.models) continue;
    const subProviderId = typeof p.id === "string" && p.id.length > 0 ? p.id : subId;
    for (const modelKey of Object.keys(p.models)) {
      const m = p.models[modelKey];
      if (!m) continue;
      const mapped = mapModel(subProviderId, m);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

export function createModelsDevSource(): CatalogSource {
  return {
    id: "models-dev",
    displayName: "models.dev",
    listModels: fetchModelsDev,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
