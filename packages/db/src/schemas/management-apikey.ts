/**
 * Management API key schemas — Effect Schema production path (§11).
 */
import {
  managementScope as ManagementScopeSchema,
  MANAGEMENT_SCOPES,
  ManagementApiKeyStatus as ManagementApiKeyStatusSchema,
  ManagementApiKeyDoc as ManagementApiKeyDocSchema,
  ManagementApiKeyCreateInput as ManagementApiKeyCreateInputSchema,
  ManagementApiKeyUpdateInput as ManagementApiKeyUpdateInputSchema,
} from "./effect/management-apikey.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export { MANAGEMENT_SCOPES };
export type { ManagementScope } from "./effect/management-apikey.ts";

export const managementScope = withParseApi(ManagementScopeSchema);
export const managementApiKeyStatus = withParseApi(ManagementApiKeyStatusSchema);
export const managementApiKeyDoc = withParseApi(ManagementApiKeyDocSchema);
export const managementApiKeyCreateInput = withParseApi(ManagementApiKeyCreateInputSchema);
export const managementApiKeyUpdateInput = withParseApi(ManagementApiKeyUpdateInputSchema);

export type ManagementApiKeyDoc = MutableDeep<Schema.Schema.Type<typeof ManagementApiKeyDocSchema>>;
export type ManagementApiKeyCreateInput = MutableDeep<Schema.Schema.Type<typeof ManagementApiKeyCreateInputSchema>>;
export type ManagementApiKeyUpdateInput = MutableDeep<Schema.Schema.Type<typeof ManagementApiKeyUpdateInputSchema>>;
