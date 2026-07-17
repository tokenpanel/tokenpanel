/**
 * Domain API client for /admin/models (+ provider catalog used by model forms).
 */
import { deleteJson, getJson, patchJson, postJson } from "./client.ts";

export type TokenPriceSchedule = {
  inputUnitsPerMillion: number;
  outputUnitsPerMillion: number;
  reasoningUnitsPerMillion?: number;
  cacheReadUnitsPerMillion?: number;
  cacheWriteUnitsPerMillion?: number;
  inputAudioUnitsPerMillion?: number;
  outputAudioUnitsPerMillion?: number;
};

export type ModelEntry = {
  id: string;
  providerId: string;
  upstreamModelId: string;
  cost?: TokenPriceSchedule;
  price?: TokenPriceSchedule;
  priority: number;
  active: boolean;
};

export type AdminModel = {
  _id: string;
  organizationId: string;
  aliasId: string;
  displayName: string;
  description: string | null;
  entries: ModelEntry[];
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  attachment: boolean;
  interleaved?: { field: "reasoning_content" | "reasoning_details" } | null;
  limits: { context: number; input?: number; output?: number };
  modalities: { input: string[]; output: string[] };
  status?: string;
  price: TokenPriceSchedule;
  marginBps: number;
  currency: string;
  active: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AdminProviderSummary = {
  _id: string;
  organizationId: string;
  name: string;
  sdkType?: string;
  active?: boolean;
};

export type ModelCatalogItem = {
  _id: string;
  upstreamModelId: string;
  displayName?: string;
};

export function listModels(): Promise<{ items: AdminModel[] }> {
  return getJson<{ items: AdminModel[] }>("/admin/models");
}

export function listProviders(): Promise<{ items: AdminProviderSummary[] }> {
  return getJson<{ items: AdminProviderSummary[] }>("/admin/providers");
}

export function createModel(body: unknown): Promise<AdminModel> {
  return postJson<AdminModel>("/admin/models", body);
}

export function updateModel(id: string, body: unknown): Promise<AdminModel> {
  return patchJson<AdminModel>(`/admin/models/${id}`, body);
}

export function deleteModel(id: string): Promise<unknown> {
  return deleteJson(`/admin/models/${id}`);
}

export function reorderFallbacks(
  modelId: string,
  payload: unknown,
): Promise<AdminModel> {
  return patchJson<AdminModel>(`/admin/models/${modelId}/fallbacks`, payload);
}

export function deleteModelEntry(
  modelId: string,
  entryId: string,
): Promise<AdminModel> {
  return deleteJson<AdminModel>(`/admin/models/${modelId}/entries/${entryId}`);
}

export function addModelEntry(
  modelId: string,
  body: unknown,
): Promise<AdminModel> {
  return postJson<AdminModel>(`/admin/models/${modelId}/entries`, body);
}

export function listProviderCatalog(
  providerId: string,
): Promise<{ items: ModelCatalogItem[] }> {
  return getJson<{ items: ModelCatalogItem[] }>(
    `/admin/providers/${providerId}/models`,
  );
}
