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

/** Max string key/value pairs on a model.metadata map. */
export const MODEL_METADATA_MAX_ENTRIES = 50;
/** Max length of a metadata key after edge trim. */
export const MODEL_METADATA_KEY_MAX_LEN = 80;
/** Max length of a metadata value (verbatim; empty allowed). */
export const MODEL_METADATA_VALUE_MAX_LEN = 2000;

/** Exact keys rejected to avoid prototype-pollution foot-guns. */
export const MODEL_METADATA_RESERVED_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Validate a single already-trimmed metadata key.
 * Rejects empty, overlong, NUL, CR/LF, leading `$`, and reserved prototype keys.
 * Dots are allowed: API replaces the whole metadata object, never interpolates
 * keys into Mongo update paths. Line breaks are rejected so single-line name
 * inputs remain faithful to the stored key.
 */
export function isValidModelMetadataKey(key: string): boolean {
  if (key.length < 1 || key.length > MODEL_METADATA_KEY_MAX_LEN) return false;
  if (key.includes("\0")) return false;
  if (/[\r\n]/.test(key)) return false;
  if (key.startsWith("$")) return false;
  if (MODEL_METADATA_RESERVED_KEYS.has(key)) return false;
  return true;
}

/**
 * Contract-wide value newline normalization: `\r\n` / `\r` → `\n`.
 * Matches browser `<textarea>` behavior so UI round-trips are stable.
 */
export function normalizeMetadataValueNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True for plain objects (`{}` / Object.create(null)); rejects Date/Map/RegExp/class. */
export function isPlainMetadataObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Build a string record without `__proto__` assignment foot-guns.
 * Returns a null-prototype object so reserved keys can exist as own props
 * if a caller intentionally stores them (migration round-trip).
 */
export function createStringRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export function setStringRecordEntry(
  target: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export type ParseStringRecordMode = "write" | "stored";

/**
 * Parse an unknown value into Record<string, string> without dropping own
 * `__proto__` (z.record assignment would invoke the prototype setter).
 *
 * Modes:
 * - **write**: full product contract (limits, reserved keys, trim, CR→LF)
 * - **stored**: plain object + string values only; no entry/length caps so
 *   pre-migration oversized legacy maps still rehydrate. Date/Map/class
 *   instances are rejected (not treated as empty maps).
 */
export function parseStringRecord(
  val: unknown,
  opts: { mode: ParseStringRecordMode },
):
  | { ok: true; data: Record<string, string> }
  | { ok: false; issues: { path: (string | number)[]; message: string }[] } {
  if (val === undefined) {
    return { ok: true, data: createStringRecord() };
  }
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: "metadata must be an object of string key/value pairs",
        },
      ],
    };
  }
  if (!isPlainMetadataObject(val)) {
    const kind =
      val instanceof Date
        ? "Date"
        : (val as { constructor?: { name?: string } }).constructor?.name ??
          typeof val;
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: `metadata must be a plain object (got ${kind})`,
        },
      ],
    };
  }
  const rawKeys = Reflect.ownKeys(val).filter(
    (k): k is string => typeof k === "string",
  );
  if (Reflect.ownKeys(val).some((k) => typeof k === "symbol")) {
    return {
      ok: false,
      issues: [{ path: [], message: "metadata keys must be strings" }],
    };
  }

  const write = opts.mode === "write";
  if (write && rawKeys.length > MODEL_METADATA_MAX_ENTRIES) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: `metadata may have at most ${MODEL_METADATA_MAX_ENTRIES} entries`,
        },
      ],
    };
  }
  const issues: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  const record = val as Record<string, unknown>;
  const out = createStringRecord();

  for (const rawKey of rawKeys) {
    const value = record[rawKey];
    if (typeof value !== "string") {
      issues.push({
        path: [rawKey],
        message: "metadata values must be strings",
      });
      continue;
    }
    const normalized = normalizeMetadataValueNewlines(value);
    if (write && normalized.length > MODEL_METADATA_VALUE_MAX_LEN) {
      issues.push({
        path: [rawKey],
        message: `metadata value must be at most ${MODEL_METADATA_VALUE_MAX_LEN} characters`,
      });
      continue;
    }
    if (write) {
      const key = rawKey.trim();
      if (!isValidModelMetadataKey(key)) {
        issues.push({
          path: [rawKey],
          message:
            "metadata key must be 1–80 chars after trim, no NUL/CR/LF, no leading $, and not a reserved key (__proto__/prototype/constructor)",
        });
        continue;
      }
      if (seen.has(key)) {
        issues.push({
          path: [rawKey],
          message: `duplicate metadata key after trim: ${key}`,
        });
        continue;
      }
      seen.add(key);
      setStringRecordEntry(out, key, normalized);
    } else {
      // Stored: preserve keys exactly; normalize newlines for textarea parity.
      setStringRecordEntry(out, rawKey, normalized);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data: out };
}

/**
 * Write contract for model.metadata: bounded Record<string, string>.
 * Keys are edge-trimmed; values use LF-normalized newlines (CR/CRLF → LF).
 * Rejects non-string values, blank/duplicate-normalized keys, reserved keys,
 * overlong keys/values, CR/LF in keys, and more than 50 entries.
 *
 * Implemented via z.unknown (not z.record) so reserved keys like `__proto__`
 * are rejected explicitly rather than silently dropped by object assignment.
 */
export const modelMetadataInput = z.unknown().transform((val, ctx) => {
  const parsed = parseStringRecord(val, { mode: "write" });
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
    return z.NEVER;
  }
  return parsed.data;
});

/**
 * Stored model.metadata shape (read path). Requires a plain/null-proto object
 * of string values; does **not** enforce write limits so oversized legacy
 * documents still rehydrate. Migration aborts on oversized maps so post-migrate
 * data matches the write contract. Own `__proto__` keys are preserved.
 */
export const modelMetadataStored = z.unknown().transform((val, ctx) => {
  if (val === undefined) return createStringRecord();
  const parsed = parseStringRecord(val, { mode: "stored" });
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
    return z.NEVER;
  }
  return parsed.data;
});

export type ModelMetadata = Record<string, string>;

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
  /**
   * Custom string key/value configuration for operators (not secret storage).
   * Whole-map replacement on write; empty object clears. Visible to org members
   * via authenticated admin model responses.
   */
  metadata: modelMetadataStored,
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
  metadata: modelMetadataInput.optional(),
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
  /**
   * Whole-map replacement when supplied. Omitted → keep existing map;
   * explicit empty object → clear. Never partial per-key patch.
   */
  metadata: modelMetadataInput.optional(),
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