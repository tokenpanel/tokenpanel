import { z } from "zod";

/**
 * Cross-runtime model product contracts (browser-safe).
 *
 * Policy version: 2026-07-13
 * Owned by @tokenpanel/contracts. DB storage schemas consume these and add
 * ObjectId/timestamps; admin owns form state and user-facing errors.
 * Historical migrations MUST NOT import this module — keep frozen snapshots.
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

export const modelModalitySchema = z.enum(MODEL_MODALITIES);

export const modelModalitiesSchema = z.object({
  input: z.array(modelModalitySchema),
  output: z.array(modelModalitySchema),
});

export type ModelModalities = z.infer<typeof modelModalitiesSchema>;

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

export const modelStatusSchema = z.enum(MODEL_STATUSES);

// ---------------------------------------------------------------------------
// Metadata write policy (immutable product contract)
// ---------------------------------------------------------------------------

/** Reserved keys that would mutate object prototypes if assigned naively. */
export const MODEL_METADATA_RESERVED_KEYS = [
  "__proto__",
  "prototype",
  "constructor",
] as const;

export type ModelMetadataReservedKey =
  (typeof MODEL_METADATA_RESERVED_KEYS)[number];

const reservedKeyLookup: ReadonlySet<string> = new Set(
  MODEL_METADATA_RESERVED_KEYS,
);

/**
 * Immutable metadata write-policy limits.
 * Change only with coordinated DB/admin/API tests; bump policy version comment.
 */
export const MODEL_METADATA_POLICY = Object.freeze({
  maxEntries: 50,
  keyMaxLen: 80,
  valueMaxLen: 2000,
  reservedKeys: MODEL_METADATA_RESERVED_KEYS,
} as const);

export type ModelMetadataPolicy = typeof MODEL_METADATA_POLICY;

/**
 * Validate a single already-trimmed metadata key against the write contract.
 * Rejects empty, overlong, NUL, CR/LF, leading `$`, and reserved prototype keys.
 */
export function isValidModelMetadataKey(key: string): boolean {
  if (key.length < 1 || key.length > MODEL_METADATA_POLICY.keyMaxLen) {
    return false;
  }
  if (key.includes("\0")) return false;
  if (/[\r\n]/.test(key)) return false;
  if (key.startsWith("$")) return false;
  if (reservedKeyLookup.has(key)) return false;
  return true;
}

/**
 * Contract-wide value newline normalization: `\r\n` / `\r` → `\n`.
 * Matches browser `<textarea>` behavior so UI round-trips are stable.
 */
export function normalizeMetadataValueNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True when `key` is a reserved prototype-pollution key. */
export function isReservedModelMetadataKey(key: string): boolean {
  return reservedKeyLookup.has(key);
}
