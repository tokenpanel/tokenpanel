/**
 * Provider / model / catalog / entry schemas — Effect Schema production path (§11).
 */
import {
  MODEL_METADATA_MAX_ENTRIES,
  MODEL_METADATA_KEY_MAX_LEN,
  MODEL_METADATA_VALUE_MAX_LEN,
  MODEL_METADATA_RESERVED_KEYS,
  isValidModelMetadataKey,
  normalizeMetadataValueNewlines,
  isPlainMetadataObject,
  createStringRecord,
  setStringRecordEntry,
  parseStringRecord,
  ModelMetadataInput as ModelMetadataInputSchema,
  ModelMetadataStored as ModelMetadataStoredSchema,
  ProviderSdkType as ProviderSdkTypeSchema,
  ProviderDoc as ProviderDocSchema,
  ProviderCreateInput as ProviderCreateInputSchema,
  ProviderUpdateInput as ProviderUpdateInputSchema,
  ModelCatalogDoc as ModelCatalogDocSchema,
  ModelCatalogCreateInput as ModelCatalogCreateInputSchema,
  ModelEntryDoc as ModelEntryDocSchema,
  ModelEntryInput as ModelEntryInputSchema,
  ModelDoc as ModelDocSchema,
  ModelCreateInput as ModelCreateInputSchema,
  ModelUpdateInput as ModelUpdateInputSchema,
  FallbackReorderInput as FallbackReorderInputSchema,
} from "./effect/model.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export {
  MODEL_METADATA_MAX_ENTRIES,
  MODEL_METADATA_KEY_MAX_LEN,
  MODEL_METADATA_VALUE_MAX_LEN,
  MODEL_METADATA_RESERVED_KEYS,
  isValidModelMetadataKey,
  normalizeMetadataValueNewlines,
  isPlainMetadataObject,
  createStringRecord,
  setStringRecordEntry,
  parseStringRecord,
};
export type { ParseStringRecordMode, ModelMetadata } from "./effect/model.ts";

export const modelMetadataInput = withParseApi(ModelMetadataInputSchema);
export const modelMetadataStored = withParseApi(ModelMetadataStoredSchema);
export const providerSdkType = withParseApi(ProviderSdkTypeSchema);
export const providerDoc = withParseApi(ProviderDocSchema);
export const providerCreateInput = withParseApi(ProviderCreateInputSchema);
export const providerUpdateInput = withParseApi(ProviderUpdateInputSchema);
export const modelCatalogDoc = withParseApi(ModelCatalogDocSchema);
export const modelCatalogCreateInput = withParseApi(ModelCatalogCreateInputSchema);
export const modelEntryDoc = withParseApi(ModelEntryDocSchema);
export const modelEntryInput = withParseApi(ModelEntryInputSchema);
export const modelDoc = withParseApi(ModelDocSchema);
export const modelCreateInput = withParseApi(ModelCreateInputSchema);
export const modelUpdateInput = withParseApi(ModelUpdateInputSchema);
export const fallbackReorderInput = withParseApi(FallbackReorderInputSchema);

export type ProviderDoc = MutableDeep<Schema.Schema.Type<typeof ProviderDocSchema>>;
export type ProviderCreateInput = MutableDeep<Schema.Schema.Type<typeof ProviderCreateInputSchema>>;
export type ProviderUpdateInput = MutableDeep<Schema.Schema.Type<typeof ProviderUpdateInputSchema>>;
export type ModelCatalogDoc = MutableDeep<Schema.Schema.Type<typeof ModelCatalogDocSchema>>;
export type ModelCatalogCreateInput = MutableDeep<Schema.Schema.Type<typeof ModelCatalogCreateInputSchema>>;
export type ModelEntryDoc = MutableDeep<Schema.Schema.Type<typeof ModelEntryDocSchema>>;
export type ModelEntryInput = MutableDeep<Schema.Schema.Type<typeof ModelEntryInputSchema>>;
export type ModelDoc = MutableDeep<Schema.Schema.Type<typeof ModelDocSchema>>;
export type ModelCreateInput = MutableDeep<Schema.Schema.Type<typeof ModelCreateInputSchema>>;
export type ModelUpdateInput = MutableDeep<Schema.Schema.Type<typeof ModelUpdateInputSchema>>;
export type FallbackReorderInput = MutableDeep<Schema.Schema.Type<typeof FallbackReorderInputSchema>>;
