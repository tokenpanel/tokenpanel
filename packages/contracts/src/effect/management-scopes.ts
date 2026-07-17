/**
 * Effect Schema for management API key scopes (browser-safe).
 */
import { Schema } from "effect";
import {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  type ManagementScope,
  type ManagementScopeDefinition,
} from "../management-scopes.ts";

export {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
};
export type {
  ManagementScope,
  ManagementScopeDefinition,
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
