/**
 * Catalog sources are public/reference catalogs of AI model metadata
 * (e.g. models.dev). They are distinct from provider adapters: a provider
 * adapter talks to a live upstream the org has credentials for; a catalog
 * source is a read-only directory we map into our internal model shape so
 * admins can pre-fill the Add Model form without retyping specs/pricing.
 *
 * Each source adapter knows how to fetch its data and map it to
 * `FetchedModel[]`. New sources register via `registerSource` and immediately
 * appear in GET /admin/catalog-sources with no frontend changes.
 */

export type FetchedModelStatus = "alpha" | "beta" | "deprecated" | "ga";

export type FetchedModelCost = {
  inputUnitsPerMillion: number;
  outputUnitsPerMillion: number;
  reasoningUnitsPerMillion?: number | undefined;
  cacheReadUnitsPerMillion?: number | undefined;
  cacheWriteUnitsPerMillion?: number | undefined;
  inputAudioUnitsPerMillion?: number | undefined;
  outputAudioUnitsPerMillion?: number | undefined;
};

export type FetchedModel = {
  /** Source id, e.g. "models-dev". */
  sourceId: string;
  /** Model id on the source, e.g. "openai/gpt-5". */
  upstreamModelId: string;
  /** Human-readable name, e.g. "GPT-5". */
  displayName: string;
  /** Sub-provider/lab that serves this model on the source (models.dev has many). */
  subProvider?: string | undefined;
  reasoning?: boolean | undefined;
  toolCall?: boolean | undefined;
  structuredOutput?: boolean | undefined;
  temperature?: boolean | undefined;
  attachment?: boolean | undefined;
  limits: { context?: number | undefined; input?: number | undefined; output?: number | undefined };
  modalities: { input: string[]; output: string[] };
  status?: FetchedModelStatus | undefined;
  cost?: FetchedModelCost | undefined;
  /** Original payload for debugging/advanced mapping. */
  raw?: Record<string, unknown> | undefined;
};

export type CatalogSource = {
  /** Stable id used in URLs, e.g. "models-dev". */
  id: string;
  /** Display name for the Provider dropdown, e.g. "models.dev". */
  displayName: string;
  /** Fetch and map all models from this source. */
  listModels(): Promise<FetchedModel[]>;
};

export type CatalogSourceSummary = {
  id: string;
  displayName: string;
};
