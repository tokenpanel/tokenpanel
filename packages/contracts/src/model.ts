/**
 * Cross-runtime model product contracts (browser-safe).
 *
 * Policy version: 2026-07-15
 * Owned by @tokenpanel/contracts. DB storage schemas consume these and add
 * ObjectId/timestamps; admin owns form state and user-facing errors.
 * Historical migrations MUST NOT import this module — keep frozen snapshots.
 *
 * Effect Schema live under `@tokenpanel/contracts/effect` and are re-exported
 * below for a single production validation path (§11).
 *
 * Metadata write policy is defined in `./safe-map.ts` (shared with headers
 * and customer/provider metadata families).
 */

// ---------------------------------------------------------------------------
// Modalities
// ---------------------------------------------------------------------------

export const MODEL_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
  "pdf",
] as const;

export type ModelModality = (typeof MODEL_MODALITIES)[number];

export type ModelModalities = {
  readonly input: readonly ModelModality[];
  readonly output: readonly ModelModality[];
};

// ---------------------------------------------------------------------------
// Lifecycle status
// ---------------------------------------------------------------------------

export const MODEL_STATUSES = [
  "alpha",
  "beta",
  "deprecated",
  "ga",
] as const;

export type ModelStatus = (typeof MODEL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Metadata write policy — re-export shared safe-map (model family)
// ---------------------------------------------------------------------------

export {
  MODEL_METADATA_POLICY,
  MODEL_METADATA_RESERVED_KEYS,
  isValidModelMetadataKey,
  isReservedModelMetadataKey,
  normalizeMetadataValueNewlines,
  SAFE_MAP_RESERVED_KEYS,
  PROVIDER_HEADERS_POLICY,
  CALLER_METADATA_POLICY,
  isValidSafeMapKey,
  isReservedSafeMapKey,
  isSafeJsonMapValue,
  isPlainObject,
  SAFE_JSON_MAP_MAX_DEPTH,
  SAFE_JSON_MAP_VALUE_MAX_CHARS,
} from "./safe-map.ts";

export type {
  ModelMetadataPolicy,
  ModelMetadataReservedKey,
  SafeMapPolicy,
  SafeMapReservedKey,
  ProviderHeadersPolicy,
  CallerMetadataPolicy,
} from "./safe-map.ts";
