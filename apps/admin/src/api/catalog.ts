import { getJson } from "./client.ts";

export type FetchedModelStatus = "alpha" | "beta" | "deprecated" | "ga";

export type FetchedModelCost = {
  inputMinorPerMillion: number;
  outputMinorPerMillion: number;
  reasoningMinorPerMillion?: number;
  cacheReadMinorPerMillion?: number;
  cacheWriteMinorPerMillion?: number;
  inputAudioMinorPerMillion?: number;
  outputAudioMinorPerMillion?: number;
};

export type FetchedModel = {
  sourceId: string;
  upstreamModelId: string;
  displayName: string;
  subProvider?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  limits: { context: number; input?: number; output?: number };
  modalities: { input: string[]; output: string[] };
  status?: FetchedModelStatus;
  cost?: FetchedModelCost;
};

export type CatalogSourceSummary = {
  id: string;
  displayName: string;
};

export function listCatalogSources(): Promise<{ items: CatalogSourceSummary[] }> {
  return getJson<{ items: CatalogSourceSummary[] }>("/admin/catalog-sources");
}

export function listCatalogModels(sourceId: string): Promise<{ items: FetchedModel[] }> {
  return getJson<{ items: FetchedModel[] }>(`/admin/catalog-sources/${encodeURIComponent(sourceId)}/models`);
}
