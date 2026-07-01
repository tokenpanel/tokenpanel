import { z } from "zod";
import {
  objectId,
  objectIdFromString,
  timestampFields,
  tokenPriceSchedule,
  tokenLimits,
  modalities,
  modelStatus,
  modelCapabilities,
} from "./common.ts";

/**
 * Provider = an upstream AI service configuration an Organization connects to.
 * Holds credentials + endpoint; used by adapter registry to call upstream.
 *
 * `sdkType` selects the adapter:
 *   - "openai-compatible"     → /v1/chat/completions + /v1/models
 *   - "anthropic-compatible"  → /v1/messages + /v1/models
 *   - "plugin:<pluginId>"     → adapter registered by a plugin (future)
 *
 * Plugins register adapters at runtime; the sdkType string routes to them.
 */
export const providerSdkType = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^(openai-compatible|anthropic-compatible|plugin:[a-z0-9_-]+)$/,
    "sdkType must be openai-compatible, anthropic-compatible, or plugin:<id>",
  );

export const providerDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  name: z.string().min(1).max(120),
  /** Adapter selector. See providerSdkType. */
  sdkType: providerSdkType,
  /** API key encrypted at rest (never returned to clients in full). */
  apiKeyEncrypted: z.string().min(1),
  /** Base URL for the upstream API, e.g. https://api.openai.com/v1. */
  baseUrl: z.string().url().max(400),
  /** Optional provider-side organization header (e.g. OpenAI org id). */
  providerOrg: z.string().max(120).nullish(),
  /** Extra headers to send upstream. */
  headers: z.record(z.string(), z.string()).default(() => ({})),
  active: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default(() => ({})),
  ...timestampFields,
});

export const providerCreateInput = z.object({
  name: z.string().min(1).max(120),
  sdkType: providerSdkType,
  apiKey: z.string().min(1).max(400),
  baseUrl: z.string().url().max(400),
  providerOrg: z.string().max(120).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const providerUpdateInput = z.object({
  name: z.string().min(1).max(120).optional(),
  sdkType: providerSdkType.optional(),
  apiKey: z.string().min(1).max(400).optional(),
  baseUrl: z.string().url().max(400).optional(),
  providerOrg: z.string().max(120).nullish().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  active: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderDoc = z.infer<typeof providerDoc>;
export type ProviderCreateInput = z.infer<typeof providerCreateInput>;
export type ProviderUpdateInput = z.infer<typeof providerUpdateInput>;

/**
 * ModelCatalog = cached upstream model discovered via a Provider's listModels().
 * Refreshable. Used to populate the "choose model" dropdown when adding a
 * provider entry to a Model. Provider-agnostic facts come from upstream.
 */
export const modelCatalogDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  providerId: objectId,
  /** Upstream model id, e.g. "gpt-4o-mini" or "claude-sonnet-4-6". */
  upstreamModelId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  ...modelCapabilities.shape,
  limits: tokenLimits,
  modalities: modalities,
  status: modelStatus.optional(),
  /** Upstream cost schedule (per-million minor units) if reported. */
  cost: tokenPriceSchedule.optional(),
  /** Raw metadata from upstream for extras. */
  raw: z.record(z.string(), z.unknown()).default(() => ({})),
  discoveredAt: z.instanceof(Date),
  ...timestampFields,
});

export type ModelCatalogDoc = z.infer<typeof modelCatalogDoc>;

/**
 * Model = our custom alias ID wrapping one or more provider entries (fallback
 * chain). Customers request a model by its `aliasId`; we route through the
 * ordered `entries` trying primary first, failing over on error.
 *
 * Each entry binds a provider + upstream modelId and may override cost/price.
 * Cost = what the org pays upstream (tracked for profit). Price = what we charge
 * the customer. Margin derived.
 */
export const modelEntryDoc = z.object({
  /** Stable id within the entries array (for reorder ops). */
  id: z.string().min(1).max(40),
  providerId: objectId,
  /** Upstream model id on that provider. */
  upstreamModelId: z.string().min(1).max(160),
  /** Per-entry cost override (defaults to catalog/upstream cost). */
  cost: tokenPriceSchedule.optional(),
  /** Per-entry price override (defaults to model-level price). */
  price: tokenPriceSchedule.optional(),
  /** Weight/priority: lower = tried first. */
  priority: z.number().int().nonnegative().default(0),
  /** Whether this entry participates in failover. */
  active: z.boolean().default(true),
});

export const modelEntryInput = z.object({
  id: z.string().min(1).max(40).optional(),
  providerId: objectIdFromString,
  upstreamModelId: z.string().min(1).max(160),
  cost: tokenPriceSchedule.optional(),
  price: tokenPriceSchedule.optional(),
  priority: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

export const modelDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  /** Our custom alias id, e.g. "my-gpt" or "default-chat". */
  aliasId: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/),
  displayName: z.string().min(1).max(160),
  description: z.string().max(2000).nullish(),
  /** Ordered fallback chain. */
  entries: z.array(modelEntryDoc).min(1),
  /** Model-level capabilities (canonical; entries may override per-provider). */
  ...modelCapabilities.shape,
  limits: tokenLimits,
  modalities: modalities,
  status: modelStatus.optional(),
  /** Default price charged to customers (per-million minor units). */
  price: tokenPriceSchedule,
  /** Margin in basis points (100bp = 1%) applied over cost if price unset. */
  marginBps: z.number().int().min(0).default(0),
  /** Currency for cost/price minor units. */
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  active: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default(() => ({})),
  ...timestampFields,
});

export const modelCreateInput = z.object({
  aliasId: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/),
  displayName: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  entries: z.array(modelEntryInput).min(1),
  reasoning: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  temperature: z.boolean().optional(),
  attachment: z.boolean().optional(),
  limits: tokenLimits,
  modalities: modalities,
  status: modelStatus.optional(),
  price: tokenPriceSchedule,
  marginBps: z.number().int().min(0).optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const modelUpdateInput = z.object({
  aliasId: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/).optional(),
  displayName: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).nullish().optional(),
  entries: z.array(modelEntryInput).min(1).optional(),
  reasoning: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  temperature: z.boolean().optional(),
  attachment: z.boolean().optional(),
  limits: tokenLimits.optional(),
  modalities: modalities.optional(),
  status: modelStatus.optional(),
  price: tokenPriceSchedule.optional(),
  marginBps: z.number().int().min(0).optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
  active: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Shape for the fallback reorder endpoint. */
export const fallbackReorderInput = z.object({
  entries: z.array(
    z.object({
      id: z.string().min(1).max(40),
      priority: z.number().int().nonnegative(),
    }),
  ),
});

export type ModelDoc = z.infer<typeof modelDoc>;
export type ModelCreateInput = z.infer<typeof modelCreateInput>;
export type ModelUpdateInput = z.infer<typeof modelUpdateInput>;
export type ModelEntryDoc = z.infer<typeof modelEntryDoc>;
export type ModelEntryInput = z.infer<typeof modelEntryInput>;
export type FallbackReorderInput = z.infer<typeof fallbackReorderInput>;