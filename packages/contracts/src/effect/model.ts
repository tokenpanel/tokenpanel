/**
 * Effect Schema model product contracts (browser-safe, Requirements = never).
 * Constants remain single-sourced in safe-map.
 */
import { Schema } from "effect";
import {
  MODEL_MODALITIES,
  MODEL_STATUSES,
} from "../model.ts";
import {
  MODEL_METADATA_POLICY,
  isValidModelMetadataKey,
  normalizeMetadataValueNewlines,
} from "../safe-map.ts";

// Re-export product enums (policy helpers + ModelMetadataWrite live in ./safe-map.ts).
export {
  MODEL_MODALITIES,
  MODEL_STATUSES,
} from "../model.ts";
export type {
  ModelModality,
  ModelModalities,
  ModelStatus,
  ModelMetadataPolicy,
  ModelMetadataReservedKey,
} from "../model.ts";

// ---------------------------------------------------------------------------
// Modalities
// ---------------------------------------------------------------------------

export const ModelModalitySchema = Schema.Literal(...MODEL_MODALITIES);
export const modelModalitySchema = ModelModalitySchema;

export const ModelModalitiesSchema = Schema.Struct({
  input: Schema.Array(ModelModalitySchema),
  output: Schema.Array(ModelModalitySchema),
});
export const modelModalitiesSchema = ModelModalitiesSchema;

// ---------------------------------------------------------------------------
// Lifecycle status
// ---------------------------------------------------------------------------

export const ModelStatusSchema = Schema.Literal(...MODEL_STATUSES);
export const modelStatusSchema = ModelStatusSchema;

// ---------------------------------------------------------------------------
// Metadata write policy as Effect Schema
// ---------------------------------------------------------------------------

export const ModelMetadataKey = Schema.String.pipe(
  Schema.filter(
    (key): key is string => isValidModelMetadataKey(key),
    {
      message: () =>
        "metadata key must be 1–80 chars after trim, no control characters, no leading $, and not a reserved key (__proto__/prototype/constructor)",
    },
  ),
);

/** Metadata value: LF-normalized, length-capped. */
export const ModelMetadataValue = Schema.transform(
  Schema.String.pipe(Schema.maxLength(MODEL_METADATA_POLICY.valueMaxLen)),
  Schema.String,
  {
    strict: true,
    decode: (v) => normalizeMetadataValueNewlines(v),
    encode: (v) => v,
  },
);

