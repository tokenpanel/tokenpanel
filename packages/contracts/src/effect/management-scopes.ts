/**
 * Effect Schema for management API key scopes (browser-safe).
 */
import { Schema } from "effect";
import {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  MANAGEMENT_SCOPES_META,
  type ManagementScope,
  type ManagementScopeDefinition,
  type ManagementScopeMeta,
} from "../management-scopes.ts";

export {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  MANAGEMENT_SCOPES_META,
};
export type {
  ManagementScope,
  ManagementScopeDefinition,
  ManagementScopeMeta,
};

/** Non-empty tuple of scope string literals for Schema.Literal. */
const scopeLiterals = MANAGEMENT_SCOPES as unknown as [
  ManagementScope,
  ...ManagementScope[],
];

export const ManagementScopeSchema = Schema.Literal(...scopeLiterals);
export type ManagementScopeType = Schema.Schema.Type<
  typeof ManagementScopeSchema
>;

/** Lowercase alias for camelCase import sites. */
export const managementScopeSchema = ManagementScopeSchema;
