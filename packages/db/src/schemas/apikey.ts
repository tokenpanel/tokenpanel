/**
 * Customer API key schemas — Effect Schema production path (§11).
 */
import {
  ApiKeyStatus as ApiKeyStatusSchema,
  ApiKeyDoc as ApiKeyDocSchema,
  ApiKeyCreateInput as ApiKeyCreateInputSchema,
  ApiKeyUpdateInput as ApiKeyUpdateInputSchema,
} from "./effect/apikey.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export const apiKeyStatus = withParseApi(ApiKeyStatusSchema);
export const apiKeyDoc = withParseApi(ApiKeyDocSchema);
export const apiKeyCreateInput = withParseApi(ApiKeyCreateInputSchema);
export const apiKeyUpdateInput = withParseApi(ApiKeyUpdateInputSchema);

export type ApiKeyDoc = MutableDeep<Schema.Schema.Type<typeof ApiKeyDocSchema>>;
export type ApiKeyCreateInput = MutableDeep<Schema.Schema.Type<typeof ApiKeyCreateInputSchema>>;
export type ApiKeyUpdateInput = MutableDeep<Schema.Schema.Type<typeof ApiKeyUpdateInputSchema>>;
